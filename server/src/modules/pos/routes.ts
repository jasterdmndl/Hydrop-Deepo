import { Router, type Request } from "express";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { sendError } from "../../shared/http.js";
import { requireRole } from "../auth/guards.js";
import {
  posRepository as repo,
  toCheckoutView,
  toClosedDayView,
  toDayViewWithSummary,
} from "./repository.js";
import {
  buildValidatedQuote,
  type CatalogRefill,
  type CheckoutView,
  deriveCheckoutLookup,
  deriveDayStatus,
  formatManilaDate,
  formatManilaIso,
  InFlightCheckoutTracker,
  isValidCalendarDate,
  MAX_CASH_CENTAVOS,
  MAX_ITEMS_PER_SALE,
  MAX_QUANTITY_PER_LINE,
  MAX_TOTAL_CENTAVOS,
  MAX_UNIT_PRICE_CENTAVOS,
  MIN_UNIT_PRICE_CENTAVOS,
  submittedItemsMatchQuote,
  type WaterType,
} from "./sales.js";

const standardItemSchema = z
  .object({
    kind: z.literal("STANDARD"),
    waterType: z.enum(["PURIFIED", "ALKALINE"]),
    quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
  })
  .strict();

const customItemSchema = z
  .object({
    kind: z.literal("CUSTOM"),
    waterType: z.enum(["PURIFIED", "ALKALINE"]),
    unitVolumeLiters: z.number().finite(),
    unitPriceCentavos: z.number().int().min(MIN_UNIT_PRICE_CENTAVOS).max(MAX_UNIT_PRICE_CENTAVOS),
    quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
  })
  .strict();

const cartItemSchema = z.discriminatedUnion("kind", [standardItemSchema, customItemSchema]);

const startDayBody = z
  .object({
    requestKey: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const endDayBody = z
  .object({
    requestKey: z.string().trim().min(1).max(128).optional(),
    clearUnpaidDrafts: z.boolean().optional(),
    expectedBusinessDate: z.string().trim().optional(),
  })
  .strict();

const prepareCheckoutBody = z
  .object({
    prepareKey: z.string().trim().min(1).max(128).optional(),
    requestKey: z.string().trim().min(1).max(128).optional(),
    items: z.array(cartItemSchema).min(1).max(MAX_ITEMS_PER_SALE),
  })
  .strict();

const confirmCheckoutBody = z
  .object({
    cashReceivedCentavos: z.number().int().min(1).max(MAX_CASH_CENTAVOS),
    items: z.array(cartItemSchema).min(1).max(MAX_ITEMS_PER_SALE).optional(),
    expectedTotalCentavos: z.number().int().min(1).max(MAX_TOTAL_CENTAVOS).optional(),
  })
  .strict();

const beginPaymentBody = z.object({}).strict();

const cancelCheckoutBody = z
  .object({
    reason: z.string().trim().min(1).max(200).optional(),
    confirmNoCashTaken: z.boolean().optional(),
  })
  .strict();

function paramReference(raw: string | string[] | undefined): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

function resolveOptionalRequestKey(
  bodyKey: string | undefined,
  req: Request,
): { ok: true; key: string | null } | { ok: false } {
  if (bodyKey !== undefined) {
    return { ok: true, key: bodyKey };
  }
  const headerRaw = req.get("idempotency-key") ?? req.get("x-request-key");
  if (headerRaw === undefined) {
    return { ok: true, key: null };
  }
  const trimmed = headerRaw.trim();
  if (!trimmed || trimmed.length > 128) {
    return { ok: false };
  }
  return { ok: true, key: trimmed };
}

function toIsoOrNull(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return formatManilaIso(date);
}

/**
 * Refill-only POS HTTP endpoints, mounted at /api/pos behind the shared
 * module-access guards. Accessible to both OWNER and CASHIER roles.
 */
export function posRoutes(db: Database): Router {
  const router = Router();
  const inFlight = new InFlightCheckoutTracker();

  router.use(requireRole("OWNER", "CASHIER"));

  router.get("/catalog", async (_req, res) => {
    const items = await repo.listActiveCatalog(db);
    res.json({ items });
  });

  router.get("/day", async (req, res) => {
    const todayDate = formatManilaDate(req.now);
    const [openRow, todayRow] = await Promise.all([
      repo.findOpenDay(db),
      repo.findDayByDate(db, todayDate),
    ]);

    const openDayView = openRow
      ? toDayViewWithSummary(
          openRow,
          await repo.computeLiveDaySummary(db, openRow.id, openRow.businessDate),
        )
      : null;

    const todayClosedView = todayRow && todayRow.closedAt !== null ? toClosedDayView(todayRow) : null;
    const status = deriveDayStatus(openDayView, todayClosedView, todayDate);

    const unresolvedCheckouts: CheckoutView[] = [];
    const unpaidDrafts: CheckoutView[] = [];

    if (openRow) {
      const nonTerminal = await repo.listNonTerminalCheckoutsForDay(db, openRow.id);
      for (const row of nonTerminal) {
        if (row.status === "REVIEW_REQUIRED") {
          unresolvedCheckouts.push(toCheckoutView(row));
        } else if (row.status === "PAYMENT_PENDING") {
          const active = inFlight.get(row.reference);
          unresolvedCheckouts.push(active ? active.checkoutView : toCheckoutView(row));
        } else if (row.status === "DRAFT") {
          const active = inFlight.get(row.reference);
          if (active) {
            unresolvedCheckouts.push(active.checkoutView);
          } else {
            unpaidDrafts.push(toCheckoutView(row));
          }
        }
      }
    }

    res.json({
      ...status,
      unresolvedCheckouts,
      unpaidDrafts,
    });
  });

  router.post("/day/start", async (req, res) => {
    const parsed = startDayBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid start-day request.");
      return;
    }

    const keyResult = resolveOptionalRequestKey(parsed.data.requestKey, req);
    if (!keyResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid request key.");
      return;
    }

    const requestKey = keyResult.key;
    const todayDate = formatManilaDate(req.now);

    const outcome = await db.transaction(async (tx) => {
      await repo.lockDaysTable(tx);

      if (requestKey) {
        const existingByKey = await repo.findDayByStartKey(tx, requestKey);
        if (existingByKey) {
          if (existingByKey.businessDate !== todayDate) {
            return { kind: "key-conflict" as const };
          }
          if (existingByKey.closedAt !== null) {
            return { kind: "already-closed" as const };
          }
          const summary = await repo.computeLiveDaySummary(
            tx,
            existingByKey.id,
            existingByKey.businessDate,
          );
          return { kind: "replayed" as const, dayRow: existingByKey, summary };
        }
      }

      const openDay = await repo.findOpenDay(tx);
      if (openDay) {
        if (openDay.businessDate === todayDate) {
          return { kind: "already-open" as const };
        }
        return { kind: "previous-day-open" as const };
      }

      const todayRow = await repo.findDayByDate(tx, todayDate);
      if (todayRow && todayRow.closedAt !== null) {
        return { kind: "already-closed" as const };
      }

      const created = await repo.insertOpenDay(tx, {
        businessDate: todayDate,
        startedByUserId: req.auth!.user.id,
        startedAt: req.now,
        startRequestKey: requestKey,
      });
      const summary = await repo.computeLiveDaySummary(tx, created.id, created.businessDate);
      return { kind: "started" as const, dayRow: created, summary };
    });

    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This start-day request key was already used for a different business date.",
      );
      return;
    }
    if (outcome.kind === "previous-day-open") {
      sendError(
        res,
        409,
        "PREVIOUS_DAY_OPEN",
        "Close the previous open business day before starting today's sales.",
      );
      return;
    }
    if (outcome.kind === "already-open") {
      sendError(res, 409, "DAY_ALREADY_OPEN", "Today's business day is already open.");
      return;
    }
    if (outcome.kind === "already-closed") {
      sendError(
        res,
        409,
        "DAY_ALREADY_CLOSED",
        "Today's business day is already closed and cannot be reopened.",
      );
      return;
    }

    const dayView = toDayViewWithSummary(outcome.dayRow, outcome.summary);
    const status = deriveDayStatus(dayView, null, todayDate);
    const replayed = outcome.kind === "replayed";
    res.status(replayed ? 200 : 201).json({
      ...status,
      replayed,
      unresolvedCheckouts: [],
      unpaidDrafts: [],
    });
  });

  router.post("/day/end", async (req, res) => {
    const parsed = endDayBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid end-day request.");
      return;
    }

    const expectedDate = parsed.data.expectedBusinessDate;
    if (expectedDate !== undefined && !isValidCalendarDate(expectedDate)) {
      sendError(res, 400, "VALIDATION_FAILED", "Use YYYY-MM-DD for expectedBusinessDate.");
      return;
    }

    const keyResult = resolveOptionalRequestKey(parsed.data.requestKey, req);
    if (!keyResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid request key.");
      return;
    }

    const requestKey = keyResult.key;
    const clearUnpaidDrafts = parsed.data.clearUnpaidDrafts === true;
    const todayDate = formatManilaDate(req.now);

    const outcome = await db.transaction(async (tx) => {
      if (requestKey) {
        const existingByKey = await repo.findDayByCloseKey(tx, requestKey);
        if (existingByKey) {
          if (expectedDate && existingByKey.businessDate !== expectedDate) {
            return { kind: "day-mismatch" as const };
          }
          return {
            kind: "replayed" as const,
            dayRow: existingByKey,
            clearedDraftReferences: [] as string[],
          };
        }
      }

      const openDay = await repo.lockOpenDay(tx);
      if (!openDay) {
        const todayRow = await repo.findDayByDate(tx, todayDate);
        if (todayRow && todayRow.closedAt !== null) {
          return { kind: "already-closed" as const };
        }
        return { kind: "not-open" as const };
      }

      if (expectedDate && openDay.businessDate !== expectedDate) {
        return { kind: "day-mismatch" as const };
      }

      const nonTerminal = await repo.lockNonTerminalCheckoutsForDay(tx, openDay.id);
      const inFlightEntries = inFlight.listForDay(openDay.id);
      const inFlightByRef = new Map(inFlightEntries.map((entry) => [entry.reference, entry]));

      const blockingCheckouts: CheckoutView[] = [];
      const unpaidDrafts: CheckoutView[] = [];
      const seenBlockingRefs = new Set<string>();

      for (const row of nonTerminal) {
        if (row.status === "REVIEW_REQUIRED") {
          blockingCheckouts.push(toCheckoutView(row));
          seenBlockingRefs.add(row.reference);
        } else if (row.status === "PAYMENT_PENDING") {
          const active = inFlightByRef.get(row.reference);
          blockingCheckouts.push(active ? active.checkoutView : toCheckoutView(row));
          seenBlockingRefs.add(row.reference);
        } else if (row.status === "DRAFT") {
          const active = inFlightByRef.get(row.reference);
          if (active) {
            blockingCheckouts.push(active.checkoutView);
            seenBlockingRefs.add(row.reference);
          } else {
            unpaidDrafts.push(toCheckoutView(row));
          }
        }
      }

      for (const entry of inFlightEntries) {
        if (!seenBlockingRefs.has(entry.reference)) {
          blockingCheckouts.push(entry.checkoutView);
        }
      }

      if (blockingCheckouts.length > 0) {
        return { kind: "unresolved-checkouts" as const, blockingCheckouts };
      }

      if (unpaidDrafts.length > 0 && !clearUnpaidDrafts) {
        return { kind: "unpaid-drafts" as const, unpaidDrafts };
      }

      const clearedDraftReferences =
        unpaidDrafts.length > 0 ? await repo.clearUnpaidDraftsForDay(tx, openDay.id, req.now) : [];

      const summary = await repo.computeLiveDaySummary(tx, openDay.id, openDay.businessDate);
      const closedRow = await repo.closeDay(tx, {
        dayId: openDay.id,
        closedByUserId: req.auth!.user.id,
        closedAt: req.now,
        closeRequestKey: requestKey,
        summary,
      });

      return { kind: "closed" as const, dayRow: closedRow, clearedDraftReferences };
    });

    if (outcome.kind === "day-mismatch") {
      sendError(
        res,
        409,
        "DAY_MISMATCH",
        "The open business day does not match the expected date.",
      );
      return;
    }
    if (outcome.kind === "already-closed") {
      sendError(res, 409, "DAY_ALREADY_CLOSED", "Today's business day is already closed.");
      return;
    }
    if (outcome.kind === "not-open") {
      sendError(res, 409, "DAY_NOT_OPEN", "No open business day was found to close.");
      return;
    }
    if (outcome.kind === "unresolved-checkouts") {
      res.status(409).json({
        error: {
          code: "UNRESOLVED_CHECKOUTS",
          message: "Resolve saving or review-required transactions before closing the day.",
        },
        blockingCheckouts: outcome.blockingCheckouts,
      });
      return;
    }
    if (outcome.kind === "unpaid-drafts") {
      res.status(409).json({
        error: {
          code: "UNPAID_DRAFTS_PRESENT",
          message: "Clear or cancel unpaid checkout drafts before closing the day.",
        },
        unpaidDrafts: outcome.unpaidDrafts,
      });
      return;
    }

    const dayView = toClosedDayView(outcome.dayRow);
    res.status(200).json({
      state: "CLOSED" as const,
      day: dayView,
      summary: dayView.summary,
      clearedDraftReferences: outcome.clearedDraftReferences,
      replayed: outcome.kind === "replayed",
    });
  });

  router.post("/checkouts", async (req, res) => {
    const parsed = prepareCheckoutBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid refill items before checkout.");
      return;
    }

    const keyResult = resolveOptionalRequestKey(
      parsed.data.prepareKey ?? parsed.data.requestKey,
      req,
    );
    if (!keyResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid checkout prepare key.");
      return;
    }

    const prepareKey = keyResult.key;
    const todayDate = formatManilaDate(req.now);
    const catalog = await repo.listActiveCatalog(db);
    const catalogByWaterType = new Map<WaterType, CatalogRefill>(
      catalog.map((item) => [item.waterType, item]),
    );

    const quoteResult = buildValidatedQuote(parsed.data.items, catalogByWaterType);
    if (!quoteResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", quoteResult.message);
      return;
    }
    const quote = quoteResult.quote;

    const outcome = await db.transaction(async (tx) => {
      if (prepareKey) {
        const existing = await repo.findCheckoutByPrepareKey(tx, prepareKey);
        if (existing) {
          if (existing.createdByUserId !== req.auth!.user.id) {
            return { kind: "forbidden" as const };
          }
          if (existing.quoteHash !== quote.quoteHash) {
            return { kind: "key-conflict" as const };
          }
          return { kind: "replayed" as const, row: existing };
        }
      }

      const openDay = await repo.lockOpenDay(tx);
      if (!openDay) {
        const todayRow = await repo.findDayByDate(tx, todayDate);
        if (todayRow && todayRow.closedAt !== null) {
          return { kind: "day-closed" as const };
        }
        return { kind: "day-not-open" as const };
      }

      if (openDay.businessDate !== todayDate) {
        return { kind: "previous-day-open" as const };
      }

      const reference = await repo.allocateNextReference(tx, openDay.id, openDay.businessDate);
      const created = await repo.insertCheckout(tx, {
        reference,
        prepareKey,
        businessDayId: openDay.id,
        businessDate: openDay.businessDate,
        createdByUserId: req.auth!.user.id,
        items: quote.items,
        quoteHash: quote.quoteHash,
        totalCentavos: quote.totalCentavos,
        totalContainers: quote.totalContainers,
        totalVolumeMl: quote.totalVolumeMl,
        now: req.now,
      });
      return { kind: "created" as const, row: created };
    });

    if (outcome.kind === "forbidden") {
      sendError(
        res,
        403,
        "FORBIDDEN",
        "This checkout reference belongs to a different operator account.",
      );
      return;
    }
    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This prepare key was already used for a different cart.",
      );
      return;
    }
    if (outcome.kind === "day-closed") {
      sendError(
        res,
        409,
        "DAY_ALREADY_CLOSED",
        "Today's business day is already closed.",
      );
      return;
    }
    if (outcome.kind === "day-not-open") {
      sendError(
        res,
        409,
        "DAY_NOT_OPEN",
        "Start the business day before preparing a sale.",
      );
      return;
    }
    if (outcome.kind === "previous-day-open") {
      sendError(
        res,
        409,
        "PREVIOUS_DAY_OPEN",
        "Close the previous open business day before starting today's sales.",
      );
      return;
    }

    const replayed = outcome.kind === "replayed";
    res.status(replayed ? 200 : 201).json({
      checkout: toCheckoutView(outcome.row),
      replayed,
    });
  });

  router.post("/checkouts/:reference/begin-payment", async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    const parsed = beginPaymentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid start-payment request.");
      return;
    }

    const preCheck = await repo.findCheckoutByReference(db, reference);
    if (!preCheck) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    if (preCheck.createdByUserId !== req.auth!.user.id) {
      sendError(
        res,
        403,
        "FORBIDDEN",
        "Only the operator who prepared this checkout can start cash payment.",
      );
      return;
    }

    const todayDate = formatManilaDate(req.now);
    const outcome = await db.transaction(async (tx) => {
      const day = await repo.lockDayById(tx, preCheck.businessDayId);
      const checkoutRow = await repo.lockCheckoutByReference(tx, reference);
      if (!day || !checkoutRow) {
        return { kind: "not-found" as const };
      }

      if (checkoutRow.createdByUserId !== req.auth!.user.id) {
        return { kind: "forbidden" as const };
      }

      if (checkoutRow.status === "SAVED") {
        return { kind: "already-saved" as const };
      }
      if (checkoutRow.status === "CANCELLED_DRAFT") {
        return { kind: "cancelled" as const };
      }
      if (checkoutRow.status === "REVIEW_REQUIRED") {
        return { kind: "review-required" as const, checkout: toCheckoutView(checkoutRow) };
      }
      if (day.closedAt !== null) {
        return { kind: "day-closed" as const };
      }
      if (day.businessDate !== todayDate) {
        return { kind: "previous-day-open" as const };
      }
      if (checkoutRow.status === "PAYMENT_PENDING") {
        return { kind: "replayed" as const, checkout: toCheckoutView(checkoutRow) };
      }

      const updated = await repo.markCheckoutPaymentPending(tx, {
        checkoutId: checkoutRow.id,
        reference,
        now: req.now,
      });
      return { kind: "started" as const, checkout: toCheckoutView(updated) };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }
    if (outcome.kind === "forbidden") {
      sendError(
        res,
        403,
        "FORBIDDEN",
        "Only the operator who prepared this checkout can start cash payment.",
      );
      return;
    }
    if (outcome.kind === "already-saved") {
      sendError(res, 409, "CHECKOUT_ALREADY_SAVED", "This checkout is already saved.");
      return;
    }
    if (outcome.kind === "cancelled") {
      sendError(res, 409, "CHECKOUT_CANCELLED", "This checkout draft was already cancelled.");
      return;
    }
    if (outcome.kind === "review-required") {
      res.status(409).json({
        error: {
          code: "CHECKOUT_REVIEW_REQUIRED",
          message: "This checkout requires Owner review and cannot accept new cash payment.",
        },
        checkout: outcome.checkout,
      });
      return;
    }
    if (outcome.kind === "day-closed") {
      sendError(res, 409, "DAY_ALREADY_CLOSED", "Today's business day is already closed.");
      return;
    }
    if (outcome.kind === "previous-day-open") {
      sendError(
        res,
        409,
        "PREVIOUS_DAY_OPEN",
        "Close the previous open business day before accepting payment for a new sale.",
      );
      return;
    }

    res.status(200).json({
      checkout: outcome.checkout,
      replayed: outcome.kind === "replayed",
    });
  });

  router.get("/checkouts/:reference", async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    const row = await repo.findCheckoutByReference(db, reference);
    if (!row) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    const sale =
      row.status === "SAVED" ? (await repo.findSaleByCheckoutId(db, row.id)) ?? null : null;

    const lookup = deriveCheckoutLookup({
      checkout: toCheckoutView(row),
      checkoutOwnerUserId: row.createdByUserId,
      dayClosedAt: toIsoOrNull(row.dayClosedAt),
      sale,
      todayDate: formatManilaDate(req.now),
      currentUserId: req.auth!.user.id,
      checkedAt: formatManilaIso(req.now),
      inFlightEntry: inFlight.get(reference),
    });

    res.json(lookup);
  });

  router.post("/checkouts/:reference/confirm", async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    const parsed = confirmCheckoutBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid cash amount.");
      return;
    }

    const body = parsed.data;
    const preCheck = await repo.findCheckoutByReference(db, reference);
    if (!preCheck) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    if (preCheck.createdByUserId !== req.auth!.user.id) {
      sendError(
        res,
        403,
        "FORBIDDEN",
        "Only the operator who prepared this checkout can confirm payment.",
      );
      return;
    }

    const preCheckoutView = toCheckoutView(preCheck);
    if (body.items !== undefined && !submittedItemsMatchQuote(body.items, preCheckoutView.items)) {
      sendError(
        res,
        409,
        "PAYLOAD_MISMATCH",
        "Submitted cart items do not match the prepared checkout.",
      );
      return;
    }

    if (
      body.expectedTotalCentavos !== undefined &&
      body.expectedTotalCentavos !== preCheckoutView.totalCentavos
    ) {
      sendError(
        res,
        409,
        "PAYLOAD_MISMATCH",
        "Submitted total does not match the prepared checkout.",
      );
      return;
    }

    if (
      (preCheck.status === "DRAFT" || preCheck.status === "PAYMENT_PENDING") &&
      body.cashReceivedCentavos < preCheckoutView.totalCentavos
    ) {
      sendError(res, 400, "INSUFFICIENT_CASH", "Cash received must cover the total sale amount.");
      return;
    }

    const preChangeCentavos = body.cashReceivedCentavos - preCheckoutView.totalCentavos;
    inFlight.enter({
      reference,
      businessDayId: preCheck.businessDayId,
      createdByUserId: preCheck.createdByUserId,
      checkoutView: preCheckoutView,
      cashReceivedCentavos: body.cashReceivedCentavos,
      changeCentavos: preChangeCentavos,
      attemptedAt: formatManilaIso(req.now),
    });

    let outcome;
    try {
      const todayDate = formatManilaDate(req.now);
      outcome = await db.transaction(async (tx) => {
        const day = await repo.lockDayById(tx, preCheck.businessDayId);
        const checkoutRow = await repo.lockCheckoutByReference(tx, reference);
        if (!day || !checkoutRow) {
          return { kind: "not-found" as const };
        }

        if (checkoutRow.createdByUserId !== req.auth!.user.id) {
          return { kind: "forbidden" as const };
        }

        const checkoutView = toCheckoutView(checkoutRow);
        if (body.items !== undefined && !submittedItemsMatchQuote(body.items, checkoutView.items)) {
          return { kind: "payload-mismatch" as const };
        }

        if (
          body.expectedTotalCentavos !== undefined &&
          body.expectedTotalCentavos !== checkoutView.totalCentavos
        ) {
          return { kind: "payload-mismatch" as const };
        }

        if (checkoutRow.status === "SAVED") {
          if (Number(checkoutRow.cashReceivedCentavos) !== body.cashReceivedCentavos) {
            return { kind: "payload-mismatch" as const };
          }
          const existingSale = await repo.findSaleByCheckoutId(tx, checkoutRow.id);
          return { kind: "replayed" as const, sale: existingSale!, checkout: checkoutView };
        }

        if (checkoutRow.status === "REVIEW_REQUIRED") {
          if (
            checkoutRow.cashReceivedCentavos !== null &&
            Number(checkoutRow.cashReceivedCentavos) !== body.cashReceivedCentavos
          ) {
            return { kind: "payload-mismatch" as const };
          }
          return { kind: "review-required" as const, checkout: checkoutView };
        }

        if (body.cashReceivedCentavos < checkoutView.totalCentavos) {
          return { kind: "insufficient-cash" as const };
        }

        const changeCentavos = body.cashReceivedCentavos - checkoutView.totalCentavos;

        if (day.closedAt !== null) {
          const updated = await repo.markCheckoutReviewRequired(tx, {
            checkoutId: checkoutRow.id,
            reference,
            reason: "DAY_CLOSED",
            cashReceivedCentavos: body.cashReceivedCentavos,
            changeCentavos,
            now: req.now,
          });
          return { kind: "review-required" as const, checkout: toCheckoutView(updated) };
        }

        if (day.businessDate !== todayDate) {
          const updated = await repo.markCheckoutReviewRequired(tx, {
            checkoutId: checkoutRow.id,
            reference,
            reason: "BUSINESS_DATE_CROSSED",
            cashReceivedCentavos: body.cashReceivedCentavos,
            changeCentavos,
            now: req.now,
          });
          return { kind: "review-required" as const, checkout: toCheckoutView(updated) };
        }

        if (checkoutRow.status === "CANCELLED_DRAFT") {
          return { kind: "cancelled" as const };
        }

        const saved = await repo.insertSaleAtomic(tx, {
          reference,
          checkoutId: checkoutRow.id,
          businessDayId: day.id,
          businessDate: day.businessDate,
          totalCentavos: checkoutView.totalCentavos,
          cashReceivedCentavos: body.cashReceivedCentavos,
          changeCentavos,
          totalContainers: checkoutView.totalContainers,
          totalVolumeMl: checkoutView.totalVolumeMl,
          createdByUserId: req.auth!.user.id,
          items: checkoutView.items,
          now: req.now,
        });

        return { kind: "saved" as const, sale: saved.sale, checkout: saved.checkout };
      });
    } finally {
      inFlight.leave(reference);
    }

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }
    if (outcome.kind === "forbidden") {
      sendError(
        res,
        403,
        "FORBIDDEN",
        "Only the operator who prepared this checkout can confirm payment.",
      );
      return;
    }
    if (outcome.kind === "payload-mismatch") {
      sendError(
        res,
        409,
        "PAYLOAD_MISMATCH",
        "This checkout reference cannot be confirmed with different items or payment.",
      );
      return;
    }
    if (outcome.kind === "insufficient-cash") {
      sendError(res, 400, "INSUFFICIENT_CASH", "Cash received must cover the total sale amount.");
      return;
    }
    if (outcome.kind === "cancelled") {
      sendError(
        res,
        409,
        "CHECKOUT_CANCELLED",
        "This checkout draft was already cancelled.",
      );
      return;
    }
    if (outcome.kind === "review-required") {
      res.status(409).json({
        error: {
          code: "CHECKOUT_REVIEW_REQUIRED",
          message:
            "This checkout cannot be saved automatically because the station day closed or the business date changed. Owner review is required.",
        },
        checkout: outcome.checkout,
      });
      return;
    }

    const replayed = outcome.kind === "replayed";
    res.status(replayed ? 200 : 201).json({
      sale: outcome.sale,
      checkout: outcome.checkout,
      replayed,
    });
  });

  router.post("/checkouts/:reference/cancel", async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    const parsed = cancelCheckoutBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid checkout cancellation request.");
      return;
    }

    const preCheck = await repo.findCheckoutByReference(db, reference);
    if (!preCheck) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    if (preCheck.createdByUserId !== req.auth!.user.id) {
      sendError(
        res,
        403,
        "FORBIDDEN",
        "Only the operator who prepared this checkout can cancel it.",
      );
      return;
    }

    if (inFlight.has(reference)) {
      sendError(
        res,
        409,
        "CHECKOUT_NOT_CANCELLABLE",
        "This checkout cannot be cancelled while a payment save is in progress.",
      );
      return;
    }

    const todayDate = formatManilaDate(req.now);
    const outcome = await db.transaction(async (tx) => {
      const day = await repo.lockDayById(tx, preCheck.businessDayId);
      const checkoutRow = await repo.lockCheckoutByReference(tx, reference);
      if (!day || !checkoutRow) {
        return { kind: "not-found" as const };
      }

      if (checkoutRow.createdByUserId !== req.auth!.user.id) {
        return { kind: "forbidden" as const };
      }

      if (inFlight.has(reference)) {
        return { kind: "not-cancellable" as const };
      }

      if (checkoutRow.status === "CANCELLED_DRAFT") {
        return { kind: "replayed" as const, checkout: toCheckoutView(checkoutRow) };
      }

      if (day.closedAt !== null) {
        return { kind: "not-cancellable" as const };
      }

      if (checkoutRow.status === "PAYMENT_PENDING") {
        if (day.businessDate !== todayDate) {
          return {
            kind: "not-cancellable" as const,
            message: "Prior-day payment-protected checkouts cannot be cancelled and require Owner review.",
          };
        }
        if (parsed.data.confirmNoCashTaken !== true) {
          return {
            kind: "not-cancellable" as const,
            message:
              "Confirm that no cash was received from the customer before cancelling a checkout in cash collection.",
          };
        }
        const updated = await repo.markCheckoutCancelled(tx, {
          checkoutId: checkoutRow.id,
          reference,
          reason: parsed.data.reason ?? "NO_CASH_TAKEN_CANCELLED",
          now: req.now,
        });
        return { kind: "cancelled" as const, checkout: toCheckoutView(updated) };
      }

      if (checkoutRow.status !== "DRAFT") {
        return { kind: "not-cancellable" as const };
      }

      const updated = await repo.markCheckoutCancelled(tx, {
        checkoutId: checkoutRow.id,
        reference,
        reason: parsed.data.reason ?? "CANCELLED_BY_OPERATOR",
        now: req.now,
      });
      return { kind: "cancelled" as const, checkout: toCheckoutView(updated) };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }
    if (outcome.kind === "forbidden") {
      sendError(
        res,
        403,
        "FORBIDDEN",
        "Only the operator who prepared this checkout can cancel it.",
      );
      return;
    }
    if (outcome.kind === "not-cancellable") {
      sendError(
        res,
        409,
        "CHECKOUT_NOT_CANCELLABLE",
        outcome.message ?? "This checkout can no longer be cancelled.",
      );
      return;
    }

    res.status(200).json({
      checkout: outcome.checkout,
      replayed: outcome.kind === "replayed",
    });
  });

  router.get("/sales", async (req, res) => {
    const rawDate =
      typeof req.query.date === "string" && req.query.date.trim().length > 0
        ? req.query.date.trim()
        : formatManilaDate(req.now);

    if (!isValidCalendarDate(rawDate)) {
      sendError(res, 400, "VALIDATION_FAILED", "Use YYYY-MM-DD for the date filter.");
      return;
    }

    const rawStatus =
      typeof req.query.status === "string" && req.query.status.trim().length > 0
        ? req.query.status.trim().toUpperCase()
        : "ALL";

    if (rawStatus !== "ACTIVE" && rawStatus !== "VOIDED" && rawStatus !== "ALL") {
      sendError(res, 400, "VALIDATION_FAILED", "Use ACTIVE, VOIDED, or ALL for status.");
      return;
    }

    const referenceQuery =
      typeof req.query.q === "string"
        ? req.query.q
        : typeof req.query.reference === "string"
          ? req.query.reference
          : "";

    const sales = await repo.listSales(db, {
      businessDate: rawDate,
      status: rawStatus,
      referenceQuery,
    });

    res.json({
      businessDate: rawDate,
      status: rawStatus,
      query: referenceQuery.trim(),
      sales,
    });
  });

  router.get("/sales/:reference", async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Sale not found.");
      return;
    }

    const sale = await repo.findSaleByReference(db, reference);
    if (!sale) {
      sendError(res, 404, "NOT_FOUND", "Sale not found.");
      return;
    }

    res.json({ ...sale, sale });
  });

  return router;
}
