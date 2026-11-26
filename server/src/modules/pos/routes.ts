import { Router, type Request } from "express";
import { z } from "zod";
import type { Database } from "../../db/database.js";
import { sendError } from "../../shared/http.js";
import { requireRole } from "../auth/guards.js";
import {
  buildSaleActionMerchandisePlan,
  canConfirmPendingSaleAction,
  computeSaleActionFinancials,
  extractAddedDemandMap,
  type SaleActionStockDispositionInput,
  validateConfirmCashSettlement,
} from "./saleActions.js";
import {
  type LockedMerchandiseItem,
  posRepository as repo,
  toCheckoutView,
  toClosedDayView,
  toDayViewWithSummary,
  toSaleActionRequestView,
} from "./repository.js";
import {
  aggregateFilledContainerDemand,
  aggregateMerchandiseDemand,
  buildValidatedQuote,
  type CatalogRefill,
  type CheckoutView,
  classifyCheckoutComposition,
  CONTAINER_PACKAGE_DEFINITIONS,
  type ContainerPackageCode,
  containerShapeFromPackageCode,
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
  type PosContainerPackageItem,
  type PosMerchandiseItem,
  type QuoteLineItem,
  submittedItemsMatchQuote,
  type WaterType,
} from "./sales.js";

function hasMissingContainerGripo(items: QuoteLineItem[]): boolean {
  return items.some(
    (item) =>
      item.kind === "CONTAINER_PACKAGE" &&
      item.includedGripo !== "PUSH_TYPE" &&
      item.includedGripo !== "TWIST_TYPE",
  );
}

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

const merchandiseItemSchema = z
  .object({
    kind: z.literal("MERCHANDISE"),
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
  })
  .strict();

const correctMerchandiseItemSchema = merchandiseItemSchema.extend({
  originalLineIndex: z.number().int().min(0).max(MAX_ITEMS_PER_SALE - 1).optional(),
});

const containerPackageItemSchema = z
  .object({
    kind: z.literal("CONTAINER_PACKAGE"),
    packageCode: z.enum([
      "ROUND_EMPTY",
      "ROUND_PURIFIED",
      "ROUND_ALKALINE",
      "SLIM_EMPTY",
      "SLIM_PURIFIED",
      "SLIM_ALKALINE",
    ]),
    includedGripo: z.enum(["PUSH_TYPE", "TWIST_TYPE"]),
    quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
  })
  .strict();

const confirmContainerPackageItemSchema = containerPackageItemSchema.extend({
  includedGripo: z.enum(["PUSH_TYPE", "TWIST_TYPE"]).optional(),
});

const cartItemSchema = z.discriminatedUnion("kind", [
  standardItemSchema,
  customItemSchema,
  merchandiseItemSchema,
  containerPackageItemSchema,
]);

const correctCartItemSchema = z.discriminatedUnion("kind", [
  standardItemSchema,
  customItemSchema,
  correctMerchandiseItemSchema,
  containerPackageItemSchema,
]);

const confirmCartItemSchema = z.discriminatedUnion("kind", [
  standardItemSchema,
  customItemSchema,
  merchandiseItemSchema,
  confirmContainerPackageItemSchema,
]);

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
    items: z.array(confirmCartItemSchema).min(1).max(MAX_ITEMS_PER_SALE).optional(),
    expectedTotalCentavos: z.number().int().min(1).max(MAX_TOTAL_CENTAVOS).optional(),
  })
  .strict();

const beginPaymentBody = z.object({}).strict();

const heldItemInputSchema = z
  .object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
    reason: z.string().trim().min(1).max(240),
  })
  .strict();

const cancelCheckoutBody = z
  .object({
    reason: z.string().trim().min(1).max(200).optional(),
    confirmNoCashTaken: z.boolean().optional(),
    noFilledUnitsHeldConfirmed: z.boolean().optional(),
    heldItems: z.array(heldItemInputSchema).max(MAX_ITEMS_PER_SALE).optional(),
  })
  .strict();

const settlePriorDayCheckoutBody = z
  .object({
    paymentKeptConfirmed: z.boolean(),
    refillDeliveredConfirmed: z.boolean().optional(),
    itemsHandedOverConfirmed: z.boolean().optional(),
    cashReceivedCentavos: z.number().int().min(1).max(MAX_CASH_CENTAVOS).optional(),
    note: z.string().trim().max(240).optional(),
  })
  .strict();

const resolveCheckoutBody = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("NO_CASH_CANCELLED"),
      noCashReceivedConfirmed: z.boolean(),
      noFilledUnitsHeldConfirmed: z.boolean().optional(),
      reason: z.string().trim().min(1).max(200).optional(),
      note: z.string().trim().max(240).optional(),
      heldItems: z.array(heldItemInputSchema).max(MAX_ITEMS_PER_SALE).optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("FULL_REFUND"),
      undeliveredConfirmed: z.boolean(),
      fullRefundConfirmed: z.boolean(),
      noFilledUnitsHeldConfirmed: z.boolean().optional(),
      cashReceivedCentavos: z.number().int().min(1).max(MAX_CASH_CENTAVOS).optional(),
      changeAlreadyGiven: z.boolean(),
      refundedAmountCentavos: z.number().int().min(1).max(MAX_CASH_CENTAVOS).optional(),
      reason: z.string().trim().min(1).max(200).optional(),
      note: z.string().trim().max(240).optional(),
      heldItems: z.array(heldItemInputSchema).max(MAX_ITEMS_PER_SALE).optional(),
    })
    .strict(),
]);

type HeldItemInput = z.infer<typeof heldItemInputSchema>;

function normalizeHoldKey(items: ReadonlyArray<{ productId: string; quantity: number }>): string {
  return items
    .map((h) => `${h.productId}:${h.quantity}`)
    .sort()
    .join("|");
}

async function validateAndLockCheckoutHolds(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  checkoutId: string,
  items: QuoteLineItem[],
  requestedHolds: ReadonlyArray<HeldItemInput>,
  noFilledUnitsHeldConfirmed: boolean | undefined,
): Promise<
  | {
      ok: true;
      heldItems: Array<{ productId: string; quantity: number; unit: string; reason: string }>;
    }
  | {
      ok: false;
      kind: "validation-failed";
      message: string;
    }
  | {
      ok: false;
      kind: "insufficient-stock";
      message: string;
    }
  | {
      ok: false;
      kind: "not-resolvable";
      message: string;
    }
> {
  const seenProductIds = new Set<string>();
  const requestedHoldMap = new Map<string, number>();
  for (const hold of requestedHolds) {
    if (seenProductIds.has(hold.productId)) {
      return {
        ok: false,
        kind: "validation-failed",
        message: "Combine held quantities for the same product into a single entry.",
      };
    }
    seenProductIds.add(hold.productId);
    requestedHoldMap.set(hold.productId, hold.quantity);
  }

  const demandMap = aggregateMerchandiseDemand(items);
  for (const hold of requestedHolds) {
    const orderedQty = demandMap.get(hold.productId) ?? 0;
    if (orderedQty <= 0 || hold.quantity > orderedQty) {
      return {
        ok: false,
        kind: "validation-failed",
        message:
          "Held quantity must match a merchandise or container item on this checkout and cannot exceed its ordered quantity.",
      };
    }
  }

  const filledDemand = aggregateFilledContainerDemand(items);
  for (const [productId, filledQty] of filledDemand.entries()) {
    const heldQty = requestedHoldMap.get(productId) ?? 0;
    if (heldQty < filledQty && noFilledUnitsHeldConfirmed !== true) {
      return {
        ok: false,
        kind: "validation-failed",
        message:
          "This checkout includes filled container packages. Record held units for any filled containers still at the station, or confirm that unheld units were never filled.",
      };
    }
  }

  if (requestedHolds.length === 0) {
    return { ok: true, heldItems: [] };
  }

  const lockedMerchandise = await repo.lockMerchandiseItemsForUpdate(
    tx,
    requestedHolds.map((h) => h.productId),
    checkoutId,
  );
  const validatedHolds: Array<{
    productId: string;
    quantity: number;
    unit: string;
    reason: string;
  }> = [];

  for (const hold of requestedHolds) {
    const locked = lockedMerchandise.get(hold.productId);
    if (!locked) {
      return {
        ok: false,
        kind: "not-resolvable",
        message: "One or more held merchandise items no longer exist.",
      };
    }
    if (locked.currentQuantity === null) {
      return {
        ok: false,
        kind: "insufficient-stock",
        message: `Opening stock for ${locked.name} is not set yet.`,
      };
    }
    const available = Math.max(
      0,
      locked.currentQuantity - locked.otherActiveCommitted - locked.activeHeld,
    );
    if (available < hold.quantity) {
      return {
        ok: false,
        kind: "insufficient-stock",
        message: `Insufficient stock to hold ${locked.name} (${available} ${locked.unit} available).`,
      };
    }
    validatedHolds.push({
      productId: hold.productId,
      quantity: hold.quantity,
      unit: locked.unit,
      reason: hold.reason.trim(),
    });
  }

  return { ok: true, heldItems: validatedHolds };
}

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
    const [items, merchandise, containerPackages, posSections] = await Promise.all([
      repo.listActiveCatalog(db),
      repo.listVisiblePosMerchandise(db),
      repo.listVisiblePosContainerPackages(db),
      repo.listPosSections(db),
    ]);
    res.json({ items, merchandise, containerPackages, posSections });
  });

  router.get("/day", async (req, res) => {
    const todayDate = formatManilaDate(req.now);
    const snapshot = await db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const [openRow, todayRow, closedPriorDayRows] = await Promise.all([
        repo.findOpenDay(tx),
        repo.findDayByDate(tx, todayDate),
        repo.listClosedPriorDayReviewCheckouts(tx, todayDate),
      ]);

      const [liveSummary, nonTerminal, pendingSaleActions] = openRow
        ? await Promise.all([
            repo.computeLiveDaySummary(tx, openRow.id, openRow.businessDate),
            repo.listNonTerminalCheckoutsForDay(tx, openRow.id),
            repo.listPendingSaleActionsForDay(tx, openRow.id),
          ])
        : [null, [], []];

      return {
        openRow,
        todayRow,
        closedPriorDayRows,
        liveSummary,
        nonTerminal,
        pendingSaleActions,
      };
    });

    const openDayView =
      snapshot.openRow && snapshot.liveSummary
        ? toDayViewWithSummary(snapshot.openRow, snapshot.liveSummary)
        : null;

    const todayClosedView =
      snapshot.todayRow && snapshot.todayRow.closedAt !== null
        ? toClosedDayView(snapshot.todayRow)
        : null;
    const status = deriveDayStatus(openDayView, todayClosedView, todayDate);

    const unresolvedCheckouts: CheckoutView[] = [];
    const unpaidDrafts: CheckoutView[] = [];

    if (snapshot.openRow) {
      for (const row of snapshot.nonTerminal) {
        const ownedByCurrentUser = row.createdByUserId === req.auth!.user.id;
        if (row.status === "REVIEW_REQUIRED") {
          unresolvedCheckouts.push({ ...toCheckoutView(row), ownedByCurrentUser });
        } else if (row.status === "PAYMENT_PENDING") {
          const active = inFlight.get(row.reference);
          unresolvedCheckouts.push({
            ...(active ? active.checkoutView : toCheckoutView(row)),
            ownedByCurrentUser: active ? active.createdByUserId === req.auth!.user.id : ownedByCurrentUser,
          });
        } else if (row.status === "DRAFT") {
          const active = inFlight.get(row.reference);
          if (active) {
            unresolvedCheckouts.push({
              ...active.checkoutView,
              ownedByCurrentUser: active.createdByUserId === req.auth!.user.id,
            });
          } else {
            const view = toCheckoutView(row);
            if (aggregateFilledContainerDemand(view.items).size > 0) {
              unresolvedCheckouts.push({ ...view, ownedByCurrentUser });
            } else {
              unpaidDrafts.push(view);
            }
          }
        }
      }
    }

    res.json({
      ...status,
      unresolvedCheckouts,
      unpaidDrafts,
      pendingSaleActions: snapshot.pendingSaleActions,
      priorDayReviewCheckouts: snapshot.closedPriorDayRows.map((row) => ({
        ...toCheckoutView(row),
        ownedByCurrentUser: row.createdByUserId === req.auth!.user.id,
      })),
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
    const closedPriorDayRows = await repo.listClosedPriorDayReviewCheckouts(db, todayDate);
    res.status(replayed ? 200 : 201).json({
      ...status,
      replayed,
      unresolvedCheckouts: [],
      unpaidDrafts: [],
      priorDayReviewCheckouts: closedPriorDayRows.map(toCheckoutView),
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
      const unpaidDraftIds: string[] = [];
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
            const view = toCheckoutView(row);
            if (aggregateFilledContainerDemand(view.items).size > 0) {
              blockingCheckouts.push(view);
              seenBlockingRefs.add(row.reference);
            } else {
              unpaidDrafts.push(view);
              unpaidDraftIds.push(row.id);
            }
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

      const pendingSaleActions = await repo.lockPendingSaleActionsForDay(tx, openDay.id);
      if (pendingSaleActions.length > 0) {
        return { kind: "unresolved-sale-actions" as const, blockingSaleActions: pendingSaleActions };
      }

      if (unpaidDrafts.length > 0 && !clearUnpaidDrafts) {
        return { kind: "unpaid-drafts" as const, unpaidDrafts };
      }

      const clearedDraftReferences =
        unpaidDraftIds.length > 0
          ? await repo.clearUnpaidDraftsForDay(tx, openDay.id, unpaidDraftIds, req.now)
          : [];

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
    if (outcome.kind === "unresolved-sale-actions") {
      res.status(409).json({
        error: {
          code: "UNRESOLVED_SALE_ACTIONS",
          message: "Confirm or cancel pending Void / Correct sale actions before closing the day.",
        },
        blockingSaleActions: outcome.blockingSaleActions,
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
    const merchandiseIds = parsed.data.items
      .filter(
        (item): item is { kind: "MERCHANDISE"; productId: string; quantity: number } =>
          item.kind === "MERCHANDISE",
      )
      .map((item) => item.productId);
    const containerShapes = parsed.data.items
      .filter(
        (item): item is Extract<typeof item, { kind: "CONTAINER_PACKAGE" }> =>
          item.kind === "CONTAINER_PACKAGE",
      )
      .map((item) => containerShapeFromPackageCode(item.packageCode));

    const outcome = await db.transaction(async (tx) => {
      if (prepareKey) {
        const existing = await repo.findCheckoutByPrepareKey(tx, prepareKey);
        if (existing) {
          if (existing.createdByUserId !== req.auth!.user.id) {
            return { kind: "forbidden" as const };
          }
          const existingView = toCheckoutView(existing);
          if (!submittedItemsMatchQuote(parsed.data.items, existingView.items)) {
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

      const catalog = await repo.listActiveCatalog(tx);
      const catalogByWaterType = new Map<WaterType, CatalogRefill>(
        catalog.map((item) => [item.waterType, item]),
      );

      const merchandiseById = new Map<string, PosMerchandiseItem>();
      const containerPackagesByCode = new Map<ContainerPackageCode, PosContainerPackageItem>();
      const lockedById = new Map<string, LockedMerchandiseItem>();

      if (merchandiseIds.length > 0) {
        const lockedMerchandise = await repo.lockMerchandiseItemsForUpdate(tx, merchandiseIds);
        for (const [id, item] of lockedMerchandise.entries()) {
          lockedById.set(id, item);
          if (
            item.category !== "MERCHANDISE" ||
            !item.showInPos ||
            item.archivedAt !== null ||
            !item.posSection ||
            item.unitPriceCentavos === null
          ) {
            continue;
          }
          const available =
            item.currentQuantity === null
              ? null
              : Math.max(0, item.currentQuantity - item.otherActiveCommitted - item.activeHeld);
          merchandiseById.set(id, {
            id: item.id,
            code: item.code,
            name: item.name,
            description: item.description,
            unit: item.unit,
            unitPriceCentavos: item.unitPriceCentavos,
            posSection: item.posSection,
            faucetReportingType: item.faucetReportingType,
            stockStatus:
              item.currentQuantity === null
                ? "NOT_SET"
                : available === 0
                  ? "OUT_OF_STOCK"
                  : "IN_STOCK",
            currentQuantity: item.currentQuantity,
            availableQuantity: available,
          });
        }
      }

      if (containerShapes.length > 0) {
        const lockedContainers = await repo.lockPublishedContainerShapesForUpdate(tx, containerShapes);
        for (const item of lockedContainers.values()) {
          lockedById.set(item.id, item);
          if (!item.showInPos || item.archivedAt !== null || !item.containerShape) continue;
          const available =
            item.currentQuantity === null
              ? null
              : Math.max(0, item.currentQuantity - item.otherActiveCommitted - item.activeHeld);
          const stockStatus =
            item.currentQuantity === null
              ? "NOT_SET"
              : available === 0
                ? "OUT_OF_STOCK"
                : "IN_STOCK";
          for (const def of CONTAINER_PACKAGE_DEFINITIONS) {
            if (def.shape !== item.containerShape) continue;
            containerPackagesByCode.set(def.packageCode, {
              packageCode: def.packageCode,
              shape: def.shape,
              productId: item.id,
              name: def.name,
              description: def.description,
              unit: item.unit,
              waterType: def.waterType,
              unitVolumeMl: def.unitVolumeMl,
              unitVolumeLiters: def.unitVolumeLiters,
              unitPriceCentavos: def.unitPriceCentavos,
              posSection: "CONTAINERS",
              stockStatus,
              currentQuantity: item.currentQuantity,
              availableQuantity: available,
            });
          }
        }
      }

      const quoteResult = buildValidatedQuote(
        parsed.data.items,
        catalogByWaterType,
        merchandiseById,
        containerPackagesByCode,
      );
      if (!quoteResult.ok) {
        if (quoteResult.code === "PRODUCT_UNAVAILABLE") {
          return { kind: "product-unavailable" as const, message: quoteResult.message };
        }
        return { kind: "validation-failed" as const, message: quoteResult.message };
      }
      const quote = quoteResult.quote;

      const demandMap = aggregateMerchandiseDemand(quote.items);
      for (const [productId, demandedQty] of demandMap.entries()) {
        const locked = lockedById.get(productId);
        if (!locked || !locked.showInPos || locked.archivedAt !== null) {
          return {
            kind: "product-unavailable" as const,
            message: "One or more selected merchandise items are unavailable in POS.",
          };
        }
        if (locked.currentQuantity === null) {
          return {
            kind: "insufficient-stock" as const,
            message: `Opening stock for ${locked.name} is not set yet.`,
          };
        }
        const available = Math.max(
          0,
          locked.currentQuantity - locked.otherActiveCommitted - locked.activeHeld,
        );
        if (available < demandedQty) {
          return {
            kind: "insufficient-stock" as const,
            message: `Insufficient stock for ${locked.name} (${available} ${locked.unit} available).`,
          };
        }
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

    if (outcome.kind === "validation-failed") {
      sendError(res, 400, "VALIDATION_FAILED", outcome.message);
      return;
    }
    if (outcome.kind === "product-unavailable") {
      sendError(res, 400, "PRODUCT_UNAVAILABLE", outcome.message);
      return;
    }
    if (outcome.kind === "insufficient-stock") {
      sendError(res, 409, "INSUFFICIENT_STOCK", outcome.message);
      return;
    }

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
      if (checkoutRow.status === "SETTLED_PRIOR_DAY") {
        return { kind: "already-settled" as const };
      }
      if (
        checkoutRow.status === "CANCELLED_NO_CASH" ||
        checkoutRow.status === "REFUNDED_UNSAVED"
      ) {
        return { kind: "already-resolved" as const };
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

      const checkoutView = toCheckoutView(checkoutRow);
      if (hasMissingContainerGripo(checkoutView.items)) {
        return { kind: "missing-gripo-choice" as const };
      }
      const demandMap = aggregateMerchandiseDemand(checkoutView.items);
      if (demandMap.size > 0) {
        const lockedMerchandise = await repo.lockMerchandiseItemsForUpdate(
          tx,
          Array.from(demandMap.keys()),
          checkoutRow.id,
        );
        for (const [productId, demandedQty] of demandMap.entries()) {
          const locked = lockedMerchandise.get(productId);
          if (!locked || locked.archivedAt !== null) {
            return {
              kind: "product-unavailable" as const,
              message: locked
                ? `${locked.name} has been archived and cannot enter cash payment.`
                : "One or more selected merchandise items are no longer available.",
            };
          }
          if (locked.currentQuantity === null) {
            return {
              kind: "insufficient-stock" as const,
              message: `Opening stock for ${locked.name} is not set yet.`,
            };
          }
          const available = Math.max(
            0,
            locked.currentQuantity - locked.otherActiveCommitted - locked.activeHeld,
          );
          if (available < demandedQty) {
            return {
              kind: "insufficient-stock" as const,
              message: `Insufficient stock for ${locked.name} (${available} ${locked.unit} available).`,
            };
          }
        }
        await repo.upsertActiveCommitments(tx, checkoutRow.id, demandMap, req.now);
      }

      const updated = await repo.markCheckoutPaymentPending(tx, {
        checkoutId: checkoutRow.id,
        reference,
        now: req.now,
      });
      return { kind: "started" as const, checkout: toCheckoutView(updated) };
    });

    if (outcome.kind === "missing-gripo-choice") {
      sendError(
        res,
        409,
        "GRIPO_CHOICE_REQUIRED",
        "Select Push-Type or Twist-Type gripo before starting cash payment. Return to selection to update this unpaid draft.",
      );
      return;
    }
    if (outcome.kind === "product-unavailable") {
      sendError(res, 409, "PRODUCT_UNAVAILABLE", outcome.message);
      return;
    }
    if (outcome.kind === "insufficient-stock") {
      sendError(res, 409, "INSUFFICIENT_STOCK", outcome.message);
      return;
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
        "Only the operator who prepared this checkout can start cash payment.",
      );
      return;
    }
    if (outcome.kind === "already-saved") {
      sendError(res, 409, "CHECKOUT_ALREADY_SAVED", "This checkout is already saved.");
      return;
    }
    if (outcome.kind === "already-settled") {
      sendError(
        res,
        409,
        "CHECKOUT_ALREADY_SETTLED",
        "This prior-day checkout has already been settled.",
      );
      return;
    }
    if (outcome.kind === "already-resolved") {
      sendError(
        res,
        409,
        "CHECKOUT_ALREADY_RESOLVED",
        "This checkout has already been resolved.",
      );
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

    const [sale, settlement, resolution] = await Promise.all([
      row.status === "SAVED" ? repo.findSaleByCheckoutId(db, row.id) : Promise.resolve(undefined),
      row.status === "SETTLED_PRIOR_DAY"
        ? repo.findPriorDaySettlementByCheckoutId(db, row.id)
        : Promise.resolve(undefined),
      row.status === "CANCELLED_NO_CASH" || row.status === "REFUNDED_UNSAVED"
        ? repo.findCheckoutResolutionByCheckoutId(db, row.id)
        : Promise.resolve(undefined),
    ]);

    const lookup = deriveCheckoutLookup({
      checkout: toCheckoutView(row),
      checkoutOwnerUserId: row.createdByUserId,
      dayClosedAt: toIsoOrNull(row.dayClosedAt),
      cancellationOrigin: row.cancellationOrigin,
      sale: sale ?? null,
      settlement: settlement ?? null,
      resolution: resolution ?? null,
      todayDate: formatManilaDate(req.now),
      currentUserId: req.auth!.user.id,
      currentUserRole: req.auth!.user.role,
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

        if (checkoutRow.status === "SETTLED_PRIOR_DAY") {
          const existingSettlement = await repo.findPriorDaySettlementByCheckoutId(tx, checkoutRow.id);
          return {
            kind: "already-settled" as const,
            checkout: checkoutView,
            settlement: existingSettlement ?? null,
          };
        }

        if (
          checkoutRow.status === "CANCELLED_NO_CASH" ||
          checkoutRow.status === "REFUNDED_UNSAVED"
        ) {
          const existingResolution = await repo.findCheckoutResolutionByCheckoutId(tx, checkoutRow.id);
          return {
            kind: "already-resolved" as const,
            checkout: checkoutView,
            resolution: existingResolution ?? null,
          };
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

        const isAutoEndDayClear =
          checkoutRow.cancellationOrigin === "AUTO_END_DAY" ||
          (checkoutRow.cancellationOrigin === null &&
            checkoutRow.resolutionReason === "CLEARED_ON_END_DAY");
        if (checkoutRow.status === "CANCELLED_DRAFT" && !isAutoEndDayClear) {
          return { kind: "cancelled" as const };
        }

        if (
          (checkoutRow.status === "DRAFT" || checkoutRow.status === "CANCELLED_DRAFT") &&
          hasMissingContainerGripo(checkoutView.items)
        ) {
          return { kind: "missing-gripo-choice" as const };
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

        const demandMap = aggregateMerchandiseDemand(checkoutView.items);
        let lockedMerchandise:
          | Awaited<ReturnType<typeof repo.lockMerchandiseItemsForUpdate>>
          | undefined;
        if (demandMap.size > 0) {
          lockedMerchandise = await repo.lockMerchandiseItemsForUpdate(
            tx,
            Array.from(demandMap.keys()),
            checkoutRow.id,
          );
          for (const [productId, demandedQty] of demandMap.entries()) {
            const locked = lockedMerchandise.get(productId);
            if (!locked) {
              return {
                kind: "product-unavailable" as const,
                message: "One or more selected merchandise items are no longer available.",
              };
            }
            if (checkoutRow.status === "DRAFT" && locked.archivedAt !== null) {
              return {
                kind: "product-unavailable" as const,
                message: `${locked.name} has been archived and cannot be sold from an unpaid draft.`,
              };
            }
            if (locked.currentQuantity === null) {
              return {
                kind: "insufficient-stock" as const,
                message: `Opening stock for ${locked.name} is not set yet.`,
              };
            }
            const available = Math.max(
              0,
              locked.currentQuantity - locked.otherActiveCommitted - locked.activeHeld,
            );
            if (available < demandedQty) {
              return {
                kind: "insufficient-stock" as const,
                message: `Insufficient stock for ${locked.name} (${available} ${locked.unit} available).`,
              };
            }
          }
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
          lockedMerchandise,
          now: req.now,
        });

        return { kind: "saved" as const, sale: saved.sale, checkout: saved.checkout };
      });
    } finally {
      inFlight.leave(reference);
    }

    if (outcome.kind === "missing-gripo-choice") {
      sendError(
        res,
        409,
        "GRIPO_CHOICE_REQUIRED",
        "Select Push-Type or Twist-Type gripo before confirming payment. Return to selection to update this unpaid draft.",
      );
      return;
    }
    if (outcome.kind === "product-unavailable") {
      sendError(res, 409, "PRODUCT_UNAVAILABLE", outcome.message);
      return;
    }
    if (outcome.kind === "insufficient-stock") {
      sendError(res, 409, "INSUFFICIENT_STOCK", outcome.message);
      return;
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
    if (outcome.kind === "already-settled") {
      res.status(409).json({
        error: {
          code: "CHECKOUT_ALREADY_SETTLED",
          message: "This prior-day checkout has already been settled and cannot be saved again.",
        },
        checkout: outcome.checkout,
        settlement: outcome.settlement,
      });
      return;
    }
    if (outcome.kind === "already-resolved") {
      res.status(409).json({
        error: {
          code: "CHECKOUT_ALREADY_RESOLVED",
          message: "This checkout has already been resolved and cannot be saved again.",
        },
        checkout: outcome.checkout,
        resolution: outcome.resolution,
      });
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
        const existingHolds = await repo.listHoldsForCheckout(tx, checkoutRow.id);
        const existingHoldKey = normalizeHoldKey(
          existingHolds.map((h) => ({ productId: h.itemId, quantity: h.quantity })),
        );
        const requestedHoldKey = normalizeHoldKey(parsed.data.heldItems ?? []);
        if (
          (parsed.data.heldItems !== undefined || existingHolds.length > 0) &&
          existingHoldKey !== requestedHoldKey
        ) {
          return {
            kind: "not-cancellable" as const,
            message: "This checkout was already cancelled with different held items.",
          };
        }
        return {
          kind: "replayed" as const,
          checkout: toCheckoutView(checkoutRow),
          heldItems: existingHolds,
        };
      }

      if (
        checkoutRow.status === "CANCELLED_NO_CASH" ||
        checkoutRow.status === "REFUNDED_UNSAVED"
      ) {
        return {
          kind: "not-cancellable" as const,
          message: "This checkout has already been resolved.",
        };
      }

      if (day.closedAt !== null) {
        return { kind: "not-cancellable" as const };
      }

      const checkoutView = toCheckoutView(checkoutRow);

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
        const holdResult = await validateAndLockCheckoutHolds(
          tx,
          checkoutRow.id,
          checkoutView.items,
          parsed.data.heldItems ?? [],
          parsed.data.noFilledUnitsHeldConfirmed,
        );
        if (!holdResult.ok) {
          return holdResult;
        }
        const updated = await repo.markCheckoutCancelled(tx, {
          checkoutId: checkoutRow.id,
          reference,
          reason: parsed.data.reason ?? "NO_CASH_TAKEN_CANCELLED",
          now: req.now,
          actorUserId: req.auth!.user.id,
          heldItems: holdResult.heldItems,
        });
        const heldItems =
          holdResult.heldItems.length > 0 ? await repo.listHoldsForCheckout(tx, checkoutRow.id) : [];
        return { kind: "cancelled" as const, checkout: toCheckoutView(updated), heldItems };
      }

      if (checkoutRow.status !== "DRAFT") {
        return { kind: "not-cancellable" as const };
      }

      const holdResult = await validateAndLockCheckoutHolds(
        tx,
        checkoutRow.id,
        checkoutView.items,
        parsed.data.heldItems ?? [],
        parsed.data.noFilledUnitsHeldConfirmed,
      );
      if (!holdResult.ok) {
        return holdResult;
      }
      const updated = await repo.markCheckoutCancelled(tx, {
        checkoutId: checkoutRow.id,
        reference,
        reason: parsed.data.reason ?? "CANCELLED_BY_OPERATOR",
        now: req.now,
        actorUserId: req.auth!.user.id,
        heldItems: holdResult.heldItems,
      });
      const heldItems =
        holdResult.heldItems.length > 0 ? await repo.listHoldsForCheckout(tx, checkoutRow.id) : [];
      return { kind: "cancelled" as const, checkout: toCheckoutView(updated), heldItems };
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
    if (outcome.kind === "validation-failed") {
      sendError(res, 400, "VALIDATION_FAILED", outcome.message);
      return;
    }
    if (outcome.kind === "insufficient-stock") {
      sendError(res, 409, "INSUFFICIENT_STOCK", outcome.message);
      return;
    }
    if (outcome.kind === "not-resolvable" || outcome.kind === "not-cancellable") {
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
      heldItems: outcome.heldItems,
      replayed: outcome.kind === "replayed",
    });
  });

  router.post("/checkouts/:reference/settle", requireRole("OWNER"), async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    const parsed = settlePriorDayCheckoutBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid prior-day settlement request.");
      return;
    }

    const body = parsed.data;
    if (
      !body.paymentKeptConfirmed ||
      (!body.refillDeliveredConfirmed && !body.itemsHandedOverConfirmed)
    ) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Confirm both that payment was kept and that all items were delivered or handed over. Leave all other outcomes pending.",
      );
      return;
    }

    const preCheck = await repo.findCheckoutByReference(db, reference);
    if (!preCheck) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    if (inFlight.has(reference)) {
      sendError(
        res,
        409,
        "CHECKOUT_NOT_SETTLABLE",
        "Wait for the in-progress save attempt to finish before settling this checkout.",
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

      if (inFlight.has(reference)) {
        return {
          kind: "not-settlable" as const,
          message: "Wait for the in-progress save attempt to finish before settling this checkout.",
        };
      }

      const checkoutView = toCheckoutView(checkoutRow);
      const composition = classifyCheckoutComposition(checkoutView.items);

      if (
        composition === "MIXED" &&
        (!body.refillDeliveredConfirmed || !body.itemsHandedOverConfirmed)
      ) {
        return {
          kind: "validation-failed" as const,
          message:
            "Confirm that payment was kept, all refills were delivered, and all merchandise items were handed over. Leave all other outcomes pending.",
        };
      }

      if (composition === "REFILL_ONLY" && !body.refillDeliveredConfirmed) {
        return {
          kind: "validation-failed" as const,
          message:
            "Confirm both that payment was kept and that the refill was delivered. Leave all other outcomes pending.",
        };
      }

      if (composition === "MERCHANDISE_ONLY" && !body.itemsHandedOverConfirmed) {
        return {
          kind: "validation-failed" as const,
          message:
            "Confirm both that payment was kept and that all items were handed over. Leave all other outcomes pending.",
        };
      }

      if (checkoutRow.status === "SAVED") {
        const existingSale = await repo.findSaleByCheckoutId(tx, checkoutRow.id);
        return {
          kind: "already-saved" as const,
          sale: existingSale ?? null,
          checkout: checkoutView,
        };
      }

      const existingSale = await repo.findSaleByCheckoutId(tx, checkoutRow.id);
      if (existingSale) {
        return {
          kind: "already-saved" as const,
          sale: existingSale,
          checkout: checkoutView,
        };
      }

      if (checkoutRow.status === "SETTLED_PRIOR_DAY") {
        const existingSettlement = await repo.findPriorDaySettlementByCheckoutId(tx, checkoutRow.id);
        if (
          body.cashReceivedCentavos !== undefined &&
          existingSettlement?.cashReceivedCentavos !== null &&
          existingSettlement?.cashReceivedCentavos !== undefined &&
          body.cashReceivedCentavos !== existingSettlement.cashReceivedCentavos
        ) {
          return { kind: "payload-mismatch" as const };
        }
        return {
          kind: "replayed-settled" as const,
          settlement: existingSettlement!,
          checkout: checkoutView,
        };
      }

      const existingSettlement = await repo.findPriorDaySettlementByCheckoutId(tx, checkoutRow.id);
      if (existingSettlement) {
        return {
          kind: "replayed-settled" as const,
          settlement: existingSettlement,
          checkout: checkoutView,
        };
      }

      if (
        checkoutRow.status === "CANCELLED_NO_CASH" ||
        checkoutRow.status === "REFUNDED_UNSAVED"
      ) {
        const existingResolution = await repo.findCheckoutResolutionByCheckoutId(tx, checkoutRow.id);
        return {
          kind: "already-resolved" as const,
          checkout: checkoutView,
          resolution: existingResolution ?? null,
        };
      }

      const existingResolution = await repo.findCheckoutResolutionByCheckoutId(tx, checkoutRow.id);
      if (existingResolution) {
        return {
          kind: "already-resolved" as const,
          checkout: checkoutView,
          resolution: existingResolution,
        };
      }

      if (checkoutRow.businessDate >= todayDate) {
        return {
          kind: "not-settlable" as const,
          message: "Only prior-day checkouts can be recorded as a prior-day settlement.",
        };
      }

      if (checkoutRow.status !== "REVIEW_REQUIRED" && checkoutRow.status !== "PAYMENT_PENDING") {
        return {
          kind: "not-settlable" as const,
          message:
            checkoutRow.status === "DRAFT"
              ? "Unpaid draft checkouts without payment cannot be settled as paid and delivered."
              : "Cancelled checkout drafts cannot be settled.",
        };
      }

      const recordedCash =
        checkoutRow.cashReceivedCentavos !== null ? Number(checkoutRow.cashReceivedCentavos) : null;
      if (
        recordedCash !== null &&
        body.cashReceivedCentavos !== undefined &&
        body.cashReceivedCentavos !== recordedCash
      ) {
        return { kind: "payload-mismatch" as const };
      }

      const effectiveCash = recordedCash ?? body.cashReceivedCentavos ?? null;
      if (effectiveCash !== null && effectiveCash < checkoutView.totalCentavos) {
        return { kind: "insufficient-cash" as const };
      }
      const effectiveChange =
        effectiveCash !== null ? effectiveCash - checkoutView.totalCentavos : null;

      let lockedMerchandise:
        | Awaited<ReturnType<typeof repo.lockMerchandiseItemsForUpdate>>
        | undefined;
      if (composition === "MERCHANDISE_ONLY" || composition === "MIXED") {
        const demandMap = aggregateMerchandiseDemand(checkoutView.items);
        if (demandMap.size > 0) {
          lockedMerchandise = await repo.lockMerchandiseItemsForUpdate(
            tx,
            Array.from(demandMap.keys()),
            checkoutRow.id,
          );
          for (const [productId, demandedQty] of demandMap.entries()) {
            const locked = lockedMerchandise.get(productId);
            if (!locked) {
              return {
                kind: "not-settlable" as const,
                message: "One or more merchandise items on this checkout no longer exist.",
              };
            }
            if (locked.currentQuantity === null) {
              return {
                kind: "insufficient-stock" as const,
                message: `Opening stock for ${locked.name} is not set yet.`,
              };
            }
            const available = Math.max(
              0,
              locked.currentQuantity - locked.otherActiveCommitted - locked.activeHeld,
            );
            if (available < demandedQty) {
              return {
                kind: "insufficient-stock" as const,
                message: `Insufficient stock to settle ${locked.name} (${available} ${locked.unit} available).`,
              };
            }
          }
        }
      }

      const originalPaymentStartedAt = checkoutRow.paymentStartedAt
        ? checkoutRow.paymentStartedAt instanceof Date
          ? checkoutRow.paymentStartedAt
          : new Date(checkoutRow.paymentStartedAt)
        : null;
      const originalPaymentRecordedAt = checkoutRow.paymentRecordedAt
        ? checkoutRow.paymentRecordedAt instanceof Date
          ? checkoutRow.paymentRecordedAt
          : new Date(checkoutRow.paymentRecordedAt)
        : null;

      const settled = await repo.insertPriorDaySettlementAtomic(tx, {
        checkoutId: checkoutRow.id,
        checkoutReference: checkoutRow.reference,
        originalBusinessDayId: checkoutRow.businessDayId,
        originalBusinessDate: checkoutRow.businessDate,
        settlementDate: todayDate,
        netAmountKeptCentavos: checkoutView.totalCentavos,
        cashReceivedCentavos: effectiveCash,
        changeCentavos: effectiveChange,
        totalContainers: checkoutView.totalContainers,
        totalVolumeMl: checkoutView.totalVolumeMl,
        items: checkoutView.items,
        originalActorUserId: checkoutRow.createdByUserId,
        originalPaymentStartedAt,
        originalPaymentRecordedAt,
        itemsHandedOverConfirmed: composition !== "REFILL_ONLY",
        settledByUserId: req.auth!.user.id,
        settledAt: req.now,
        note: body.note?.trim() || null,
        lockedMerchandise,
      });

      return {
        kind: "settled" as const,
        settlement: settled.settlement,
        checkout: settled.checkout,
      };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }
    if (outcome.kind === "validation-failed") {
      sendError(res, 400, "VALIDATION_FAILED", outcome.message);
      return;
    }
    if (outcome.kind === "insufficient-stock") {
      sendError(res, 409, "INSUFFICIENT_STOCK", outcome.message);
      return;
    }
    if (outcome.kind === "not-settlable") {
      sendError(res, 409, "CHECKOUT_NOT_SETTLABLE", outcome.message);
      return;
    }
    if (outcome.kind === "payload-mismatch") {
      sendError(
        res,
        409,
        "PAYLOAD_MISMATCH",
        "Submitted cash amount does not match the recorded checkout payment.",
      );
      return;
    }
    if (outcome.kind === "insufficient-cash") {
      sendError(res, 400, "INSUFFICIENT_CASH", "Cash received must cover the net amount kept.");
      return;
    }
    if (outcome.kind === "already-saved") {
      res.status(200).json({
        outcome: "ALREADY_SAVED" as const,
        replayed: true,
        sale: outcome.sale,
        settlement: null,
        checkout: outcome.checkout,
      });
      return;
    }
    if (outcome.kind === "already-resolved") {
      res.status(409).json({
        error: {
          code: "CHECKOUT_ALREADY_RESOLVED",
          message: "This checkout has already been resolved and cannot be settled.",
        },
        checkout: outcome.checkout,
        resolution: outcome.resolution,
      });
      return;
    }

    const replayed = outcome.kind === "replayed-settled";
    res.status(replayed ? 200 : 201).json({
      outcome: "SETTLED" as const,
      replayed,
      settlement: outcome.settlement,
      sale: null,
      checkout: outcome.checkout,
    });
  });

  router.post("/checkouts/:reference/resolve", requireRole("OWNER"), async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    const parsed = resolveCheckoutBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid checkout resolution request.");
      return;
    }

    const body = parsed.data;
    if (body.outcome === "NO_CASH_CANCELLED" && body.noCashReceivedConfirmed !== true) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Confirm that no cash was received before cancelling this checkout. Leave uncertain outcomes pending.",
      );
      return;
    }
    if (
      body.outcome === "FULL_REFUND" &&
      (body.undeliveredConfirmed !== true || body.fullRefundConfirmed !== true)
    ) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Confirm both that the order was undelivered and that a full refund was given. Leave partial or uncertain outcomes pending.",
      );
      return;
    }

    if (body.heldItems && body.heldItems.length > 0) {
      const seenProductIds = new Set<string>();
      for (const hold of body.heldItems) {
        if (seenProductIds.has(hold.productId)) {
          sendError(
            res,
            400,
            "VALIDATION_FAILED",
            "Combine held quantities for the same product into a single entry.",
          );
          return;
        }
        seenProductIds.add(hold.productId);
      }
    }

    const preCheck = await repo.findCheckoutByReference(db, reference);
    if (!preCheck) {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }

    if (inFlight.has(reference)) {
      sendError(
        res,
        409,
        "CHECKOUT_NOT_RESOLVABLE",
        "Wait for the in-progress save attempt to finish before resolving this checkout.",
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

      if (inFlight.has(reference)) {
        return {
          kind: "not-resolvable" as const,
          message: "Wait for the in-progress save attempt to finish before resolving this checkout.",
        };
      }

      const checkoutView = toCheckoutView(checkoutRow);

      if (checkoutRow.status === "SAVED") {
        const existingSale = await repo.findSaleByCheckoutId(tx, checkoutRow.id);
        return {
          kind: "already-saved" as const,
          sale: existingSale ?? null,
          checkout: checkoutView,
        };
      }

      const existingSale = await repo.findSaleByCheckoutId(tx, checkoutRow.id);
      if (existingSale) {
        return {
          kind: "already-saved" as const,
          sale: existingSale,
          checkout: checkoutView,
        };
      }

      if (checkoutRow.status === "SETTLED_PRIOR_DAY") {
        const existingSettlement = await repo.findPriorDaySettlementByCheckoutId(tx, checkoutRow.id);
        return {
          kind: "already-settled" as const,
          settlement: existingSettlement ?? null,
          checkout: checkoutView,
        };
      }

      const existingSettlement = await repo.findPriorDaySettlementByCheckoutId(tx, checkoutRow.id);
      if (existingSettlement) {
        return {
          kind: "already-settled" as const,
          settlement: existingSettlement,
          checkout: checkoutView,
        };
      }

      const existingResolution = await repo.findCheckoutResolutionByCheckoutId(tx, checkoutRow.id);
      if (
        checkoutRow.status === "CANCELLED_NO_CASH" ||
        checkoutRow.status === "REFUNDED_UNSAVED" ||
        existingResolution
      ) {
        if (existingResolution && existingResolution.outcome === body.outcome) {
          const existingHoldKey = normalizeHoldKey(
            existingResolution.heldItems.map((h) => ({ productId: h.itemId, quantity: h.quantity })),
          );
          const requestedHoldKey = normalizeHoldKey(body.heldItems ?? []);
          if (body.outcome === "NO_CASH_CANCELLED") {
            if (
              (body.heldItems === undefined && existingResolution.heldItems.length === 0) ||
              existingHoldKey === requestedHoldKey
            ) {
              return {
                kind: "replayed-resolved" as const,
                resolution: existingResolution,
                checkout: checkoutView,
              };
            }
            return {
              kind: "already-resolved" as const,
              resolution: existingResolution,
              checkout: checkoutView,
            };
          }
          const sameCash =
            body.cashReceivedCentavos === undefined ||
            body.cashReceivedCentavos === existingResolution.cashReceivedCentavos;
          const sameChangeFlag = body.changeAlreadyGiven === existingResolution.changeAlreadyGiven;
          const sameRefund =
            body.refundedAmountCentavos === undefined ||
            body.refundedAmountCentavos === existingResolution.refundedAmountCentavos;
          if (sameCash && sameChangeFlag && sameRefund && existingHoldKey === requestedHoldKey) {
            return {
              kind: "replayed-resolved" as const,
              resolution: existingResolution,
              checkout: checkoutView,
            };
          }
        }
        return {
          kind: "already-resolved" as const,
          resolution: existingResolution ?? null,
          checkout: checkoutView,
        };
      }

      if (checkoutRow.status === "DRAFT" || checkoutRow.status === "CANCELLED_DRAFT") {
        return {
          kind: "not-resolvable" as const,
          message:
            checkoutRow.status === "DRAFT"
              ? "Unpaid draft checkouts cannot be resolved through payment recovery."
              : "Cancelled draft checkouts cannot be resolved here.",
        };
      }

      if (body.outcome === "NO_CASH_CANCELLED") {
        if (checkoutRow.businessDate >= todayDate) {
          return {
            kind: "not-resolvable" as const,
            message:
              "Same-day unpaid checkouts use normal cancellation. Prior-day no-cash resolution applies only to checkouts from an earlier date.",
          };
        }
        if (
          checkoutRow.status !== "PAYMENT_PENDING" ||
          checkoutRow.cashReceivedCentavos !== null ||
          checkoutRow.paymentRecordedAt !== null
        ) {
          return {
            kind: "not-resolvable" as const,
            message:
              "This checkout already has recorded cash details and cannot be cancelled as no cash received.",
          };
        }

        const holdResult = await validateAndLockCheckoutHolds(
          tx,
          checkoutRow.id,
          checkoutView.items,
          body.heldItems ?? [],
          body.noFilledUnitsHeldConfirmed,
        );
        if (!holdResult.ok) {
          return holdResult;
        }

        const resolved = await repo.insertCheckoutResolutionAtomic(tx, {
          checkoutId: checkoutRow.id,
          checkoutReference: checkoutRow.reference,
          originalBusinessDayId: checkoutRow.businessDayId,
          originalBusinessDate: checkoutRow.businessDate,
          resolutionDate: todayDate,
          outcome: "NO_CASH_CANCELLED",
          quoteTotalCentavos: checkoutView.totalCentavos,
          cashReceivedCentavos: null,
          changeAlreadyGiven: null,
          changeGivenCentavos: null,
          refundedAmountCentavos: null,
          items: checkoutView.items,
          originalActorUserId: checkoutRow.createdByUserId,
          resolvedByUserId: req.auth!.user.id,
          resolvedAt: req.now,
          reason: body.reason?.trim() || "PRIOR_DAY_NO_CASH_CANCELLED",
          note: body.note?.trim() || null,
          heldItems: holdResult.heldItems,
        });

        return {
          kind: "resolved" as const,
          resolution: resolved.resolution,
          checkout: resolved.checkout,
        };
      }

      // FULL_REFUND path (DEC-097, DEC-103)
      if (checkoutRow.status !== "PAYMENT_PENDING" && checkoutRow.status !== "REVIEW_REQUIRED") {
        return {
          kind: "not-resolvable" as const,
          message: "Only pending or review-required checkouts can be resolved as a full refund.",
        };
      }

      const recordedCash =
        checkoutRow.cashReceivedCentavos !== null ? Number(checkoutRow.cashReceivedCentavos) : null;
      if (
        recordedCash !== null &&
        body.cashReceivedCentavos !== undefined &&
        body.cashReceivedCentavos !== recordedCash
      ) {
        return { kind: "payload-mismatch" as const };
      }

      const effectiveCash = recordedCash ?? body.cashReceivedCentavos ?? null;
      if (effectiveCash === null) {
        return {
          kind: "validation-failed" as const,
          message: "Enter the cash received from the customer to record the full refund.",
        };
      }

      if (body.changeAlreadyGiven && effectiveCash < checkoutView.totalCentavos) {
        return {
          kind: "validation-failed" as const,
          message: "Cash received must cover the quote total when change was already given.",
        };
      }

      const changeGivenCentavos = body.changeAlreadyGiven
        ? effectiveCash - checkoutView.totalCentavos
        : 0;
      const refundedAmountCentavos = effectiveCash - changeGivenCentavos;

      if (
        body.refundedAmountCentavos !== undefined &&
        body.refundedAmountCentavos !== refundedAmountCentavos
      ) {
        return {
          kind: "validation-failed" as const,
          message:
            "Submitted refund amount does not match the cash actually retained after any change given.",
        };
      }

      const holdResult = await validateAndLockCheckoutHolds(
        tx,
        checkoutRow.id,
        checkoutView.items,
        body.heldItems ?? [],
        body.noFilledUnitsHeldConfirmed,
      );
      if (!holdResult.ok) {
        return holdResult;
      }

      const resolved = await repo.insertCheckoutResolutionAtomic(tx, {
        checkoutId: checkoutRow.id,
        checkoutReference: checkoutRow.reference,
        originalBusinessDayId: checkoutRow.businessDayId,
        originalBusinessDate: checkoutRow.businessDate,
        resolutionDate: todayDate,
        outcome: "FULL_REFUND",
        quoteTotalCentavos: checkoutView.totalCentavos,
        cashReceivedCentavos: effectiveCash,
        changeAlreadyGiven: body.changeAlreadyGiven,
        changeGivenCentavos,
        refundedAmountCentavos,
        items: checkoutView.items,
        originalActorUserId: checkoutRow.createdByUserId,
        resolvedByUserId: req.auth!.user.id,
        resolvedAt: req.now,
        reason: body.reason?.trim() || "UNDELIVERED_FULL_REFUND",
        note: body.note?.trim() || null,
        heldItems: holdResult.heldItems,
      });

      return {
        kind: "resolved" as const,
        resolution: resolved.resolution,
        checkout: resolved.checkout,
      };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Checkout reference not found.");
      return;
    }
    if (outcome.kind === "validation-failed") {
      sendError(res, 400, "VALIDATION_FAILED", outcome.message);
      return;
    }
    if (outcome.kind === "insufficient-stock") {
      sendError(res, 409, "INSUFFICIENT_STOCK", outcome.message);
      return;
    }
    if (outcome.kind === "not-resolvable") {
      sendError(res, 409, "CHECKOUT_NOT_RESOLVABLE", outcome.message);
      return;
    }
    if (outcome.kind === "payload-mismatch") {
      sendError(
        res,
        409,
        "PAYLOAD_MISMATCH",
        "Submitted cash amount does not match the recorded checkout payment.",
      );
      return;
    }
    if (outcome.kind === "already-saved") {
      res.status(409).json({
        error: {
          code: "CHECKOUT_ALREADY_SAVED",
          message: "This checkout was already saved as a sale and cannot be resolved here.",
        },
        sale: outcome.sale,
        checkout: outcome.checkout,
      });
      return;
    }
    if (outcome.kind === "already-settled") {
      res.status(409).json({
        error: {
          code: "CHECKOUT_ALREADY_SETTLED",
          message: "This prior-day checkout has already been settled.",
        },
        settlement: outcome.settlement,
        checkout: outcome.checkout,
      });
      return;
    }
    if (outcome.kind === "already-resolved") {
      res.status(409).json({
        error: {
          code: "CHECKOUT_ALREADY_RESOLVED",
          message: "This checkout has already been resolved with a different outcome or details.",
        },
        resolution: outcome.resolution,
        checkout: outcome.checkout,
      });
      return;
    }

    const replayed = outcome.kind === "replayed-resolved";
    res.status(replayed ? 200 : 201).json({
      outcome: "RESOLVED" as const,
      replayed,
      resolution: outcome.resolution,
      sale: null,
      settlement: null,
      checkout: outcome.checkout,
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

    const [sales, priorDaySettlements] = await Promise.all([
      repo.listSales(db, {
        businessDate: rawDate,
        status: rawStatus,
        referenceQuery,
      }),
      repo.listPriorDaySettlements(db, {
        settlementDate: rawDate,
        referenceQuery,
      }),
    ]);

    res.json({
      businessDate: rawDate,
      status: rawStatus,
      query: referenceQuery.trim(),
      sales,
      priorDaySettlements,
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

  const stockDispositionSchema = z
    .object({
      productId: z.string().uuid(),
      exchangedQuantity: z.number().int().min(0).max(MAX_QUANTITY_PER_LINE).optional(),
      eligibleReturnedQuantity: z.number().int().min(0).max(MAX_QUANTITY_PER_LINE).optional(),
      heldQuantity: z.number().int().min(0).max(MAX_QUANTITY_PER_LINE).optional(),
      notReturnedQuantity: z.number().int().min(0).max(MAX_QUANTITY_PER_LINE).optional(),
      holdReason: z.string().trim().min(1).max(240).optional(),
      countCoverage: z.enum(["COVERED_BY_COUNT", "UNCOVERED", "UNCLEAR", "PARTIAL"]).optional(),
      uncoveredReturnedQuantity: z.number().int().min(0).max(MAX_QUANTITY_PER_LINE).optional(),
      coveredByCountQuantity: z.number().int().min(0).max(MAX_QUANTITY_PER_LINE).optional(),
      unclearCoverageQuantity: z.number().int().min(0).max(MAX_QUANTITY_PER_LINE).optional(),
    })
    .strict();

  const prepareSaleActionBody = z.discriminatedUnion("actionType", [
    z
      .object({
        actionType: z.literal("VOID"),
        reason: z.string().trim().min(1).max(240),
        prepareKey: z.string().trim().min(1).max(128).optional(),
        stockDispositions: z.array(stockDispositionSchema).max(MAX_ITEMS_PER_SALE).optional(),
      })
      .strict(),
    z
      .object({
        actionType: z.literal("CORRECT"),
        reason: z.string().trim().min(1).max(240),
        items: z.array(correctCartItemSchema).min(1).max(MAX_ITEMS_PER_SALE),
        prepareKey: z.string().trim().min(1).max(128).optional(),
        stockDispositions: z.array(stockDispositionSchema).max(MAX_ITEMS_PER_SALE).optional(),
      })
      .strict(),
  ]);

  const confirmSaleActionBody = z
    .object({
      cashConfirmed: z.boolean().optional(),
      cashTenderedCentavos: z.number().int().min(1).max(MAX_CASH_CENTAVOS).optional(),
      stockDispositions: z.array(stockDispositionSchema).max(MAX_ITEMS_PER_SALE).optional(),
    })
    .strict();

  const cancelSaleActionBody = z
    .object({
      noCashExchangedConfirmed: z.boolean().optional(),
      reason: z.string().trim().min(1).max(240).optional(),
    })
    .strict();

  function submittedDispositionsMatchPlan(
    dispositions: readonly SaleActionStockDispositionInput[] | undefined,
    planItems: ReadonlyArray<{
      productId: string;
      exchangedQuantity: number;
      returningFromSaleQuantity: number;
      eligibleReturnedQuantity?: number;
      notReturnedQuantity?: number;
      restoredQuantity: number;
      heldQuantity: number;
      holdReason: string | null;
      countCoveredQuantity: number;
      unclearCoverageQuantity: number;
      countCoverage: "COVERED_BY_COUNT" | "UNCOVERED" | "UNCLEAR" | "PARTIAL" | null;
    }>,
  ): boolean {
    const byProduct = new Map<string, SaleActionStockDispositionInput>();
    for (const d of dispositions ?? []) {
      byProduct.set(d.productId, d);
    }
    for (const item of planItems) {
      const sub = byProduct.get(item.productId);
      const subExchanged = sub?.exchangedQuantity ?? 0;
      const subHeld = sub?.heldQuantity ?? 0;
      const subNotReturned = sub?.notReturnedQuantity ?? 0;
      const itemEligible =
        item.eligibleReturnedQuantity ??
        item.restoredQuantity + item.countCoveredQuantity + item.unclearCoverageQuantity;
      const itemNotReturned = item.notReturnedQuantity ?? 0;
      const subReason = sub?.holdReason?.trim().replace(/\s+/g, " ") || null;
      const subCoverage = sub?.countCoverage ?? null;
      if (item.returningFromSaleQuantity > 0 && !sub) {
        return false;
      }
      if (
        subExchanged !== item.exchangedQuantity ||
        subHeld !== item.heldQuantity ||
        subNotReturned !== itemNotReturned ||
        subReason !== (item.holdReason ?? null) ||
        subCoverage !== (item.countCoverage ?? null)
      ) {
        return false;
      }
      if (sub && (sub.eligibleReturnedQuantity ?? 0) !== itemEligible) {
        return false;
      }
      if (subCoverage === "PARTIAL") {
        if (
          (sub?.uncoveredReturnedQuantity ?? 0) !== item.restoredQuantity ||
          (sub?.coveredByCountQuantity ?? 0) !== item.countCoveredQuantity ||
          (sub?.unclearCoverageQuantity ?? 0) !== item.unclearCoverageQuantity
        ) {
          return false;
        }
      }
      byProduct.delete(item.productId);
    }
    for (const extra of byProduct.values()) {
      if (
        (extra.exchangedQuantity ?? 0) !== 0 ||
        (extra.heldQuantity ?? 0) !== 0 ||
        (extra.notReturnedQuantity ?? 0) !== 0 ||
        (extra.eligibleReturnedQuantity ?? 0) !== 0 ||
        extra.holdReason ||
        extra.countCoverage !== undefined
      ) {
        return false;
      }
    }
    return true;
  }

  function submittedCorrectedItemsMatchSaved(
    submittedItems: z.infer<typeof correctCartItemSchema>[],
    savedItems: QuoteLineItem[],
    savedSubmittedMerchandiseLines?: ReadonlyArray<{
      productId: string;
      quantity: number;
      originalLineIndex: number | null;
    }>,
  ): boolean {
    if (savedSubmittedMerchandiseLines !== undefined) {
      const submittedMerch = submittedItems
        .filter((item): item is z.infer<typeof correctMerchandiseItemSchema> => item.kind === "MERCHANDISE")
        .map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          originalLineIndex: item.originalLineIndex ?? null,
        }));
      if (submittedMerch.length !== savedSubmittedMerchandiseLines.length) {
        return false;
      }
      for (let i = 0; i < submittedMerch.length; i += 1) {
        const sub = submittedMerch[i]!;
        const saved = savedSubmittedMerchandiseLines[i]!;
        if (
          sub.productId !== saved.productId ||
          sub.quantity !== saved.quantity ||
          sub.originalLineIndex !== saved.originalLineIndex
        ) {
          return false;
        }
      }
    }

    const strippedSubmitted: z.infer<typeof cartItemSchema>[] = submittedItems.map((item) =>
      item.kind === "MERCHANDISE"
        ? { kind: "MERCHANDISE", productId: item.productId, quantity: item.quantity }
        : item,
    );

    if (submittedItemsMatchQuote(strippedSubmitted, savedItems)) {
      return true;
    }
    // Collapse consecutive MERCHANDISE lines with same productId so retained/added splits match identically.
    const collapsedSaved: QuoteLineItem[] = [];
    for (const line of savedItems) {
      const prev = collapsedSaved[collapsedSaved.length - 1];
      if (
        line.kind === "MERCHANDISE" &&
        prev &&
        prev.kind === "MERCHANDISE" &&
        prev.productId === line.productId
      ) {
        collapsedSaved[collapsedSaved.length - 1] = {
          ...prev,
          quantity: prev.quantity + line.quantity,
        };
      } else {
        collapsedSaved.push(line);
      }
    }
    const collapsedSubmitted: z.infer<typeof cartItemSchema>[] = [];
    for (const item of strippedSubmitted) {
      const prev = collapsedSubmitted[collapsedSubmitted.length - 1];
      if (
        item.kind === "MERCHANDISE" &&
        prev &&
        prev.kind === "MERCHANDISE" &&
        prev.productId === item.productId
      ) {
        collapsedSubmitted[collapsedSubmitted.length - 1] = {
          ...prev,
          quantity: prev.quantity + item.quantity,
        };
      } else {
        collapsedSubmitted.push(item);
      }
    }
    return submittedItemsMatchQuote(collapsedSubmitted, collapsedSaved);
  }

  router.post("/sales/:reference/actions", requireRole("OWNER"), async (req, res) => {
    const saleReference = paramReference(req.params.reference);
    if (!saleReference) {
      sendError(res, 404, "NOT_FOUND", "Sale not found.");
      return;
    }

    const parsed = prepareSaleActionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid sale action request.");
      return;
    }

    const body = parsed.data;
    const keyResult = resolveOptionalRequestKey(body.prepareKey, req);
    if (!keyResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid prepareKey.");
      return;
    }
    const prepareKey = keyResult.key;
    const todayDate = formatManilaDate(req.now);
    const preSale = await repo.findSaleDayIdByReference(db, saleReference);
    if (!preSale) {
      sendError(res, 404, "NOT_FOUND", "Sale not found.");
      return;
    }

    const outcome = await db.transaction(async (tx) => {
      const day = await repo.lockDayById(tx, preSale.businessDayId);
      const saleRow = await repo.lockSaleRawByReference(tx, saleReference);
      if (!day || !saleRow) {
        return { kind: "not-found" as const };
      }

      if (prepareKey) {
        const existingByKey = await repo.findSaleActionByPrepareKey(tx, prepareKey);
        if (existingByKey) {
          const existingView = toSaleActionRequestView(existingByKey);
          const itemsMatch =
            body.actionType === "VOID"
              ? existingView.correctedItems === null
              : existingView.correctedItems !== null &&
                submittedCorrectedItemsMatchSaved(
                  body.items,
                  existingView.correctedItems,
                  existingView.merchandisePlan.submittedMerchandiseLines,
                );
          const sameRequest =
            existingByKey.originalSaleId === saleRow.id &&
            existingByKey.actionType === body.actionType &&
            existingByKey.reason.trim() === body.reason.trim() &&
            itemsMatch &&
            submittedDispositionsMatchPlan(
              body.stockDispositions,
              existingView.merchandisePlan.items,
            );
          if (!sameRequest) {
            return { kind: "payload-mismatch" as const };
          }
          return {
            kind: "replayed" as const,
            action: existingByKey,
          };
        }
      }

      if (saleRow.status !== "ACTIVE") {
        return { kind: "sale-not-active" as const };
      }
      if (day.closedAt !== null) {
        return { kind: "day-closed" as const };
      }
      if (saleRow.businessDate !== todayDate) {
        return { kind: "prior-day-blocked" as const };
      }

      const existingPending = await repo.findPendingSaleActionForSale(tx, saleRow.id);
      if (existingPending) {
        return { kind: "already-pending" as const, action: existingPending };
      }

      // Gather all original and submitted inventory item IDs and lock in canonical ORDER BY id ASC.
      const origDemandById = aggregateMerchandiseDemand(saleRow.items);
      const origMerchLinesById = new Map<string, QuoteLineItem[]>();
      const origMerchByLineIndex = new Map<number, QuoteLineItem>();
      for (const origLine of saleRow.items) {
        if (origLine.kind === "MERCHANDISE" && origLine.productId) {
          origMerchByLineIndex.set(origLine.lineIndex, origLine);
          const bucket = origMerchLinesById.get(origLine.productId);
          if (bucket) bucket.push(origLine);
          else origMerchLinesById.set(origLine.productId, [origLine]);
        }
      }

      const submittedMerchIds: string[] = [];
      const submittedContainerShapes: Array<"ROUND" | "SLIM"> = [];
      if (body.actionType === "CORRECT") {
        for (const item of body.items) {
          if (item.kind === "MERCHANDISE") {
            submittedMerchIds.push(item.productId);
          } else if (item.kind === "CONTAINER_PACKAGE") {
            submittedContainerShapes.push(containerShapeFromPackageCode(item.packageCode));
          }
        }
      }
      const containerIdsByShape = await repo.listContainerItemIdsByShape(tx, submittedContainerShapes);
      const allItemIds = Array.from(
        new Set([
          ...origDemandById.keys(),
          ...submittedMerchIds,
          ...containerIdsByShape.values(),
        ]),
      ).sort();

      const lockedById = await repo.lockMerchandiseItemsForUpdate(tx, allItemIds);

      const exchangedById = new Map<string, number>();
      for (const disp of body.stockDispositions ?? []) {
        if (disp.exchangedQuantity !== undefined) {
          exchangedById.set(disp.productId, disp.exchangedQuantity);
        }
      }

      let correctedItems: QuoteLineItem[] | null = null;
      let correctedTotalCentavos = 0;

      if (body.actionType === "CORRECT") {
        const catalog = await repo.listActiveCatalog(tx);
        const catalogByWaterType = new Map<WaterType, CatalogRefill>(
          catalog.map((item) => [item.waterType, item]),
        );

        const seenOrigLineIndexes = new Set<number>();
        const submittedMerchQtyById = new Map<string, number>();
        const submittedShapeQty = new Map<"ROUND" | "SLIM", number>();
        for (const item of body.items) {
          if (item.kind === "MERCHANDISE") {
            if (item.originalLineIndex !== undefined) {
              if (seenOrigLineIndexes.has(item.originalLineIndex)) {
                return {
                  kind: "validation-failed" as const,
                  message: "Duplicate saved line selection in corrected merchandise items.",
                };
              }
              const origLine = origMerchByLineIndex.get(item.originalLineIndex);
              if (!origLine || origLine.productId !== item.productId) {
                return {
                  kind: "validation-failed" as const,
                  message: "Selected saved merchandise line does not belong to this sale.",
                };
              }
              seenOrigLineIndexes.add(item.originalLineIndex);
            }
            submittedMerchQtyById.set(
              item.productId,
              (submittedMerchQtyById.get(item.productId) ?? 0) + item.quantity,
            );
          } else if (item.kind === "CONTAINER_PACKAGE") {
            const shape = containerShapeFromPackageCode(item.packageCode);
            submittedShapeQty.set(shape, (submittedShapeQty.get(shape) ?? 0) + item.quantity);
          }
        }

        type MerchChunk = {
          quantity: number;
          unitPriceCentavos: number;
          displayLabel: string;
          stockUnit: string;
          posSection: QuoteLineItem["posSection"];
          faucetReportingType: QuoteLineItem["faucetReportingType"];
        };

        const merchandiseById = new Map<string, PosMerchandiseItem>();
        const remainingRetainedBudget = new Map<string, number>();

        for (const [productId, subQty] of submittedMerchQtyById.entries()) {
          const locked = lockedById.get(productId);
          const origQty = origDemandById.get(productId) ?? 0;
          const exchangedQty = exchangedById.get(productId) ?? 0;
          const retainedTarget = Math.max(0, Math.min(origQty, subQty) - exchangedQty);
          const addedTarget = subQty - retainedTarget;
          const isLivePosEligible = Boolean(
            locked &&
              locked.category === "MERCHANDISE" &&
              locked.showInPos &&
              locked.archivedAt === null &&
              locked.posSection &&
              locked.unitPriceCentavos !== null,
          );

          if (!locked || (addedTarget > 0 && !isLivePosEligible) || (origQty === 0 && !isLivePosEligible)) {
            return {
              kind: "product-unavailable" as const,
              message: `${locked?.name ?? "One or more selected merchandise items"} is unavailable for new quantities in POS.`,
            };
          }
          remainingRetainedBudget.set(productId, retainedTarget);
        }

        const remainingOrigLineQty = new Map<number, number>();
        for (const [lineIdx, origLine] of origMerchByLineIndex.entries()) {
          remainingOrigLineQty.set(lineIdx, origLine.quantity);
        }
        const perSubmittedItemChunks: MerchChunk[][] = body.items.map(() => []);
        const unallocatedBySubmittedIdx = body.items.map((item) => item.quantity);

        // Pass 1: Honor explicitly selected originalLineIndex lines first so removed sibling lines cannot steal retained snapshots.
        for (let i = 0; i < body.items.length; i += 1) {
          const item = body.items[i]!;
          if (item.kind !== "MERCHANDISE" || item.originalLineIndex === undefined) continue;
          const origLine = origMerchByLineIndex.get(item.originalLineIndex)!;
          const locked = lockedById.get(item.productId)!;
          const availOnLine = remainingOrigLineQty.get(item.originalLineIndex) ?? 0;
          const budget = remainingRetainedBudget.get(item.productId) ?? 0;
          const take = Math.min(unallocatedBySubmittedIdx[i]!, availOnLine, budget);
          if (take > 0) {
            perSubmittedItemChunks[i]!.push({
              quantity: take,
              unitPriceCentavos: origLine.unitPriceCentavos,
              displayLabel: origLine.displayLabel,
              stockUnit: origLine.stockUnit ?? locked.unit,
              posSection: origLine.posSection ?? locked.posSection ?? "TAKIP_ACCESSORIES",
              faucetReportingType: origLine.faucetReportingType ?? null,
            });
            unallocatedBySubmittedIdx[i]! -= take;
            remainingOrigLineQty.set(item.originalLineIndex, availOnLine - take);
            remainingRetainedBudget.set(item.productId, budget - take);
          }
        }

        // Pass 2: Allocate remaining retained budget FIFO onto unpinned MERCHANDISE lines.
        for (let i = 0; i < body.items.length; i += 1) {
          const item = body.items[i]!;
          if (item.kind !== "MERCHANDISE" || item.originalLineIndex !== undefined) continue;
          for (const origLine of origMerchLinesById.get(item.productId) ?? []) {
            const need = unallocatedBySubmittedIdx[i]!;
            const budget = remainingRetainedBudget.get(item.productId) ?? 0;
            const availOnLine = remainingOrigLineQty.get(origLine.lineIndex) ?? 0;
            if (need <= 0 || budget <= 0) break;
            if (availOnLine <= 0) continue;
            const locked = lockedById.get(item.productId)!;
            const take = Math.min(need, availOnLine, budget);
            perSubmittedItemChunks[i]!.push({
              quantity: take,
              unitPriceCentavos: origLine.unitPriceCentavos,
              displayLabel: origLine.displayLabel,
              stockUnit: origLine.stockUnit ?? locked.unit,
              posSection: origLine.posSection ?? locked.posSection ?? "TAKIP_ACCESSORIES",
              faucetReportingType: origLine.faucetReportingType ?? null,
            });
            unallocatedBySubmittedIdx[i]! -= take;
            remainingOrigLineQty.set(origLine.lineIndex, availOnLine - take);
            remainingRetainedBudget.set(item.productId, budget - take);
          }
        }

        // Pass 3: Allocate any newly added or exchanged units using the live product snapshot.
        for (let i = 0; i < body.items.length; i += 1) {
          const item = body.items[i]!;
          const need = unallocatedBySubmittedIdx[i]!;
          if (item.kind !== "MERCHANDISE" || need <= 0) continue;
          const locked = lockedById.get(item.productId)!;
          perSubmittedItemChunks[i]!.push({
            quantity: need,
            unitPriceCentavos: locked.unitPriceCentavos!,
            displayLabel: locked.name,
            stockUnit: locked.unit,
            posSection: locked.posSection!,
            faucetReportingType: locked.faucetReportingType ?? null,
          });
          unallocatedBySubmittedIdx[i] = 0;
        }

        for (let i = 0; i < body.items.length; i += 1) {
          const item = body.items[i]!;
          if (item.kind !== "MERCHANDISE" || merchandiseById.has(item.productId)) continue;
          const locked = lockedById.get(item.productId)!;
          const firstChunk = perSubmittedItemChunks[i]![0]!;
          const available =
            locked.currentQuantity === null
              ? null
              : Math.max(0, locked.currentQuantity - locked.otherActiveCommitted - locked.activeHeld);
          merchandiseById.set(item.productId, {
            id: locked.id,
            code: locked.code,
            name: firstChunk.displayLabel,
            description: locked.description,
            unit: firstChunk.stockUnit,
            unitPriceCentavos: firstChunk.unitPriceCentavos,
            posSection: firstChunk.posSection ?? "TAKIP_ACCESSORIES",
            faucetReportingType: firstChunk.faucetReportingType ?? null,
            stockStatus:
              locked.currentQuantity === null
                ? "NOT_SET"
                : available === 0
                  ? "OUT_OF_STOCK"
                  : "IN_STOCK",
            currentQuantity: locked.currentQuantity,
            availableQuantity: available,
          });
        }

        const containerPackagesByCode = new Map<ContainerPackageCode, PosContainerPackageItem>();
        for (const [shape, subQty] of submittedShapeQty.entries()) {
          const containerId = containerIdsByShape.get(shape);
          const locked = containerId ? lockedById.get(containerId) : undefined;
          if (!locked) {
            return {
              kind: "product-unavailable" as const,
              message: `Container product for ${shape} is unavailable.`,
            };
          }
          const origQty = origDemandById.get(locked.id) ?? 0;
          const exchangedQty = exchangedById.get(locked.id) ?? 0;
          const addedQty = Math.max(0, subQty - origQty) + exchangedQty;
          const isLivePosEligible = locked.showInPos && locked.archivedAt === null;
          if ((addedQty > 0 && !isLivePosEligible) || (origQty === 0 && !isLivePosEligible)) {
            return {
              kind: "product-unavailable" as const,
              message: `${locked.name} is unavailable for new container sales in POS.`,
            };
          }
          if (locked.currentQuantity === null) {
            return {
              kind: "opening-stock-not-set" as const,
              message: `Opening stock for ${locked.name} is not set yet.`,
            };
          }
          const available = Math.max(
            0,
            locked.currentQuantity - locked.otherActiveCommitted - locked.activeHeld,
          );
          const stockStatus = available === 0 ? "OUT_OF_STOCK" : "IN_STOCK";
          for (const def of CONTAINER_PACKAGE_DEFINITIONS) {
            if (def.shape !== shape) continue;
            containerPackagesByCode.set(def.packageCode, {
              packageCode: def.packageCode,
              shape: def.shape,
              productId: locked.id,
              name: def.name,
              description: def.description,
              unit: locked.unit,
              waterType: def.waterType,
              unitVolumeMl: def.unitVolumeMl,
              unitVolumeLiters: def.unitVolumeLiters,
              unitPriceCentavos: def.unitPriceCentavos,
              posSection: "CONTAINERS",
              stockStatus,
              currentQuantity: locked.currentQuantity,
              availableQuantity: available,
            });
          }
        }

        const strippedItems = body.items.map((item) =>
          item.kind === "MERCHANDISE"
            ? { kind: "MERCHANDISE" as const, productId: item.productId, quantity: item.quantity }
            : item,
        );
        const quoted = buildValidatedQuote(
          strippedItems,
          catalogByWaterType,
          merchandiseById,
          containerPackagesByCode,
        );
        if (!quoted.ok) {
          if (quoted.code === "PRODUCT_UNAVAILABLE") {
            return { kind: "product-unavailable" as const, message: quoted.message };
          }
          return { kind: "validation-failed" as const, message: quoted.message };
        }

        const resolvedItems: QuoteLineItem[] = [];
        let nextTotal = 0;
        for (let i = 0; i < quoted.quote.items.length; i += 1) {
          const line = quoted.quote.items[i]!;
          if (line.kind === "MERCHANDISE" && line.productId) {
            for (const chunk of perSubmittedItemChunks[i]!) {
              const chunkTotal = chunk.quantity * chunk.unitPriceCentavos;
              nextTotal += chunkTotal;
              const prevResolved = resolvedItems[resolvedItems.length - 1];
              if (
                prevResolved &&
                prevResolved.kind === "MERCHANDISE" &&
                prevResolved.productId === line.productId &&
                prevResolved.unitPriceCentavos === chunk.unitPriceCentavos &&
                prevResolved.displayLabel === chunk.displayLabel &&
                (prevResolved.stockUnit ?? null) === chunk.stockUnit &&
                (prevResolved.posSection ?? null) === (chunk.posSection ?? null) &&
                (prevResolved.faucetReportingType ?? null) === (chunk.faucetReportingType ?? null)
              ) {
                resolvedItems[resolvedItems.length - 1] = {
                  ...prevResolved,
                  quantity: prevResolved.quantity + chunk.quantity,
                  lineTotalCentavos: prevResolved.lineTotalCentavos + chunkTotal,
                };
              } else {
                resolvedItems.push({
                  ...line,
                  lineIndex: resolvedItems.length,
                  displayLabel: chunk.displayLabel,
                  stockUnit: chunk.stockUnit,
                  posSection: chunk.posSection,
                  faucetReportingType: chunk.faucetReportingType,
                  unitPriceCentavos: chunk.unitPriceCentavos,
                  quantity: chunk.quantity,
                  lineTotalCentavos: chunkTotal,
                });
              }
            }
          } else {
            nextTotal += line.lineTotalCentavos;
            resolvedItems.push({ ...line, lineIndex: resolvedItems.length });
          }
        }
        correctedItems = resolvedItems;
        correctedTotalCentavos = nextTotal;
      }

      const productMetaById = new Map<string, { name: string; unit: string }>();
      for (const [id, locked] of lockedById.entries()) {
        productMetaById.set(id, { name: locked.name, unit: locked.unit });
      }
      const corrDemandById = correctedItems
        ? aggregateMerchandiseDemand(correctedItems)
        : new Map<string, number>();
      const returningProductIds: string[] = [];
      for (const [id, origQty] of origDemandById.entries()) {
        const corrQty = corrDemandById.get(id) ?? 0;
        const retained = Math.max(0, Math.min(origQty, corrQty) - (exchangedById.get(id) ?? 0));
        if (origQty - retained > 0) {
          returningProductIds.push(id);
        }
      }

      const interveningCountByProductId = await repo.listLatestReconciliationsSince(
        tx,
        returningProductIds,
        saleRow.createdAt instanceof Date ? saleRow.createdAt : new Date(saleRow.createdAt),
      );

      const planResult = buildSaleActionMerchandisePlan({
        originalItems: saleRow.items,
        correctedItems,
        productMetaById,
        interveningCountByProductId,
        stockDispositions: body.stockDispositions,
      });
      if (!planResult.ok) {
        if (planResult.kind === "intervening-count-review-required") {
          return planResult;
        }
        return { kind: "validation-failed" as const, message: planResult.message };
      }
      const merchandisePlan =
        body.actionType === "CORRECT"
          ? {
              ...planResult.plan,
              submittedMerchandiseLines: body.items
                .filter(
                  (item): item is z.infer<typeof correctMerchandiseItemSchema> =>
                    item.kind === "MERCHANDISE",
                )
                .map((item) => ({
                  productId: item.productId,
                  quantity: item.quantity,
                  originalLineIndex: item.originalLineIndex ?? null,
                })),
            }
          : planResult.plan;
      const addedDemand = extractAddedDemandMap(merchandisePlan);

      for (const [itemId, addedQty] of addedDemand.entries()) {
        const locked = lockedById.get(itemId);
        if (!locked || locked.currentQuantity === null) {
          return {
            kind: "opening-stock-not-set" as const,
            message: `Opening stock for ${locked?.name ?? "selected item"} is not set yet.`,
          };
        }
        const available = Math.max(
          0,
          locked.currentQuantity - locked.otherActiveCommitted - locked.activeHeld,
        );
        if (available < addedQty) {
          return {
            kind: "insufficient-stock" as const,
            message: `Insufficient available stock for ${locked.name} (${available} ${locked.unit} available, ${addedQty} needed).`,
          };
        }
      }

      const financials = computeSaleActionFinancials(
        Number(saleRow.totalCentavos),
        body.actionType,
        correctedTotalCentavos,
      );
      const actionReference = await repo.allocateNextActionReference(
        tx,
        saleRow.businessDayId,
        saleRow.businessDate,
      );

      const created = await repo.insertSaleActionRequest(tx, {
        reference: actionReference,
        prepareKey,
        originalSaleId: saleRow.id,
        originalSaleReference: saleRow.reference,
        originalBusinessDayId: saleRow.businessDayId,
        originalBusinessDate: saleRow.businessDate,
        actionType: body.actionType,
        reason: body.reason.trim(),
        originalTotalCentavos: Number(saleRow.totalCentavos),
        originalCashReceivedCentavos: Number(saleRow.cashReceivedCentavos),
        originalChangeCentavos: Number(saleRow.changeCentavos),
        correctedTotalCentavos: financials.correctedTotalCentavos,
        cashDifferenceCentavos: financials.cashDifferenceCentavos,
        correctedItems,
        merchandisePlan,
        addedStockDemand: addedDemand,
        createdByUserId: req.auth!.user.id,
        now: req.now,
      });

      return { kind: "created" as const, action: created };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Sale not found.");
      return;
    }
    if (outcome.kind === "product-unavailable") {
      sendError(res, 409, "PRODUCT_UNAVAILABLE", outcome.message);
      return;
    }
    if (outcome.kind === "opening-stock-not-set") {
      sendError(res, 409, "OPENING_STOCK_NOT_SET", outcome.message);
      return;
    }
    if (outcome.kind === "insufficient-stock") {
      sendError(res, 409, "INSUFFICIENT_STOCK", outcome.message);
      return;
    }
    if (outcome.kind === "intervening-count-review-required") {
      res.status(409).json({
        error: {
          code: "INTERVENING_COUNT_REVIEW_REQUIRED",
          message: outcome.message,
        },
        affectedItems: outcome.affectedItems,
      });
      return;
    }
    if (outcome.kind === "validation-failed") {
      sendError(res, 400, "VALIDATION_FAILED", outcome.message);
      return;
    }
    if (outcome.kind === "payload-mismatch") {
      sendError(
        res,
        409,
        "PAYLOAD_MISMATCH",
        "This prepareKey was already used for a different sale action.",
      );
      return;
    }
    if (outcome.kind === "sale-not-active") {
      sendError(
        res,
        409,
        "SALE_NOT_ACTIVE",
        "Only Active sales can be voided or corrected.",
      );
      return;
    }
    if (outcome.kind === "day-closed") {
      sendError(
        res,
        409,
        "DAY_CLOSED",
        "Closed business days cannot be modified by a sale action.",
      );
      return;
    }
    if (outcome.kind === "prior-day-blocked") {
      sendError(
        res,
        409,
        "PRIOR_DAY_ACTION_BLOCKED",
        "Starting a new void or correction on a previous-day sale is blocked.",
      );
      return;
    }
    if (outcome.kind === "already-pending") {
      res.status(409).json({
        error: {
          code: "SALE_ACTION_ALREADY_PENDING",
          message: "An unresolved sale action is already in progress for this sale.",
        },
        action: outcome.action,
      });
      return;
    }
    if (outcome.kind === "replayed") {
      res.status(200).json({
        action: toSaleActionRequestView(outcome.action),
        replayed: true,
      });
      return;
    }

    res.status(201).json({
      action: outcome.action,
      replayed: false,
    });
  });

  router.get("/sale-actions/:reference", requireRole("OWNER"), async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Sale action reference not found.");
      return;
    }

    const row = await repo.findSaleActionRowByReference(db, reference);
    if (!row) {
      sendError(res, 404, "NOT_FOUND", "Sale action reference not found.");
      return;
    }

    const action = toSaleActionRequestView(row);
    const [originalSale, replacementSale] = await Promise.all([
      repo.findSaleByReference(db, row.originalSaleReference),
      row.replacementSaleReference
        ? repo.findSaleByReference(db, row.replacementSaleReference)
        : Promise.resolve(undefined),
    ]);

    const todayDate = formatManilaDate(req.now);
    const canConfirm = canConfirmPendingSaleAction({
      status: row.status,
      originalBusinessDate: row.originalBusinessDate,
      cashDifferenceCentavos: Number(row.cashDifferenceCentavos),
      dayClosedAt: row.dayClosedAt,
      todayDate,
    });
    const canCancelNoCash = row.status === "PENDING" && row.dayClosedAt === null;
    res.json({
      action,
      originalSale: originalSale ?? null,
      replacementSale: replacementSale ?? null,
      canConfirm,
      canCancelNoCash,
    });
  });

  router.post("/sale-actions/:reference/confirm", requireRole("OWNER"), async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Sale action reference not found.");
      return;
    }

    const parsed = confirmSaleActionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid sale action confirmation payload.");
      return;
    }

    const body = parsed.data;
    const todayDate = formatManilaDate(req.now);
    const preAction = await repo.findSaleActionRowByReference(db, reference);
    if (!preAction) {
      sendError(res, 404, "NOT_FOUND", "Sale action reference not found.");
      return;
    }

    const outcome = await db.transaction(async (tx) => {
      const day = await repo.lockDayById(tx, preAction.originalBusinessDayId);
      const saleRow = await repo.lockSaleRawByReference(tx, preAction.originalSaleReference);
      const actionRow = await repo.lockSaleActionRowByReference(tx, reference);
      if (!day || !saleRow || !actionRow) {
        return { kind: "not-found" as const };
      }

      if (actionRow.status === "COMPLETED") {
        if (
          Number(actionRow.cashDifferenceCentavos) > 0 &&
          body.cashTenderedCentavos !== undefined &&
          Number(actionRow.cashTenderedCentavos) !== body.cashTenderedCentavos
        ) {
          return { kind: "payload-mismatch" as const };
        }
        const [originalSale, replacementSale] = await Promise.all([
          repo.findSaleByReference(tx, actionRow.originalSaleReference),
          actionRow.replacementSaleReference
            ? repo.findSaleByReference(tx, actionRow.replacementSaleReference)
            : Promise.resolve(undefined),
        ]);
        return {
          kind: "replayed-completed" as const,
          action: toSaleActionRequestView(actionRow),
          originalSale: originalSale!,
          replacementSale: replacementSale ?? null,
        };
      }

      if (actionRow.status === "CANCELLED_NO_CASH") {
        const originalSale = await repo.findSaleByReference(tx, actionRow.originalSaleReference);
        return {
          kind: "already-cancelled" as const,
          action: toSaleActionRequestView(actionRow),
          originalSale: originalSale!,
        };
      }

      if (day.closedAt !== null) {
        return { kind: "day-closed" as const };
      }
      if (saleRow.status !== "ACTIVE") {
        return { kind: "sale-not-active" as const };
      }
      if (
        actionRow.originalBusinessDate < todayDate &&
        Number(actionRow.cashDifferenceCentavos) === 0
      ) {
        return { kind: "prior-day-zero-cash" as const };
      }

      const cashResult = validateConfirmCashSettlement(
        Number(actionRow.cashDifferenceCentavos),
        body,
      );
      if (!cashResult.ok) {
        return { kind: "validation-failed" as const, message: cashResult.message };
      }

      const actionView = toSaleActionRequestView(actionRow);
      let effectiveMerchandisePlan = actionView.merchandisePlan;
      const allPlanItemIds = (actionView.merchandisePlan.items ?? []).map((item) => item.productId);
      if (allPlanItemIds.length > 0) {
        const lockedById = await repo.lockMerchandiseItemsForUpdate(
          tx,
          allPlanItemIds,
          undefined,
          actionRow.id,
        );
        const productMetaById = new Map<string, { name: string; unit: string }>();
        for (const [id, locked] of lockedById.entries()) {
          productMetaById.set(id, { name: locked.name, unit: locked.unit });
        }

        const returningNeedingCheck = (actionView.merchandisePlan.items ?? [])
          .filter(
            (item) =>
              (item.eligibleReturnedQuantity ??
                item.restoredQuantity + item.countCoveredQuantity + item.unclearCoverageQuantity) >
              0,
          )
          .map((item) => item.productId);

        if (returningNeedingCheck.length > 0) {
          const latestCounts = await repo.listLatestReconciliationsSince(
            tx,
            returningNeedingCheck,
            saleRow.createdAt instanceof Date ? saleRow.createdAt : new Date(saleRow.createdAt),
          );
          let hasCountChange = false;
          const affectedItems: Array<{
            productId: string;
            productName: string;
            unit: string;
            returningQuantity: number;
            reconciliationId: string;
            recordedAt: string;
            physicalCount: number;
          }> = [];
          for (const planItem of actionView.merchandisePlan.items) {
            const eligibleQty =
              planItem.eligibleReturnedQuantity ??
              planItem.restoredQuantity +
                planItem.countCoveredQuantity +
                planItem.unclearCoverageQuantity;
            if (eligibleQty <= 0) continue;
            const latest = latestCounts.get(planItem.productId);
            if (
              (planItem.interveningReconciliationId === null && latest !== undefined) ||
              (planItem.interveningReconciliationId !== null &&
                latest !== undefined &&
                latest.reconciliationId !== planItem.interveningReconciliationId)
            ) {
              hasCountChange = true;
            }
            if (latest) {
              affectedItems.push({
                productId: planItem.productId,
                productName: planItem.productName,
                unit: planItem.unit,
                returningQuantity: eligibleQty,
                reconciliationId: latest.reconciliationId,
                recordedAt: latest.recordedAt,
                physicalCount: latest.physicalCount,
              });
            }
          }

          if (hasCountChange) {
            if (!body.stockDispositions || body.stockDispositions.length === 0) {
              return {
                kind: "intervening-count-review-required" as const,
                staleStockCount: true,
                message:
                  "Physical stock was reconciled after this sale action was prepared. Confirm count coverage on this same pending reference to complete saving.",
                affectedItems,
              };
            }

            const dispById = new Map(body.stockDispositions.map((d) => [d.productId, d]));
            const mergedDispositions: SaleActionStockDispositionInput[] = [];
            for (const planItem of actionView.merchandisePlan.items) {
              const incoming = dispById.get(planItem.productId);
              if (
                incoming?.exchangedQuantity !== undefined &&
                incoming.exchangedQuantity !== planItem.exchangedQuantity
              ) {
                return {
                  kind: "validation-failed" as const,
                  message: `Cannot change exchanged quantity for ${planItem.productName} while confirming an existing pending action.`,
                };
              }
              if (planItem.returningFromSaleQuantity > 0) {
                if (!incoming) {
                  return {
                    kind: "validation-failed" as const,
                    message: `Confirm stock return coverage for ${planItem.productName}.`,
                  };
                }
                mergedDispositions.push({
                  ...incoming,
                  exchangedQuantity: planItem.exchangedQuantity,
                });
              }
            }
            const replanned = buildSaleActionMerchandisePlan({
              originalItems: saleRow.items,
              correctedItems: actionView.correctedItems,
              productMetaById,
              interveningCountByProductId: latestCounts,
              stockDispositions: mergedDispositions,
            });
            if (!replanned.ok) {
              if (replanned.kind === "intervening-count-review-required") {
                return {
                  kind: "intervening-count-review-required" as const,
                  staleStockCount: true,
                  message: replanned.message,
                  affectedItems: replanned.affectedItems,
                };
              }
              return { kind: "validation-failed" as const, message: replanned.message };
            }

            const prevAdded = extractAddedDemandMap(actionView.merchandisePlan);
            const nextAdded = extractAddedDemandMap(replanned.plan);
            const sameAdded =
              prevAdded.size === nextAdded.size &&
              Array.from(prevAdded.entries()).every(([k, v]) => nextAdded.get(k) === v);
            if (!sameAdded) {
              return {
                kind: "validation-failed" as const,
                message: "Cannot alter added merchandise demand while confirming a prepared action.",
              };
            }
            effectiveMerchandisePlan = replanned.plan;
          }
        }

        const addedDemand = extractAddedDemandMap(effectiveMerchandisePlan);
        for (const [itemId, addedQty] of addedDemand.entries()) {
          const locked = lockedById.get(itemId);
          if (!locked || locked.currentQuantity === null) {
            return {
              kind: "opening-stock-not-set" as const,
              message: `Opening stock for ${locked?.name ?? "selected item"} is not set yet.`,
            };
          }
          const available = Math.max(
            0,
            locked.currentQuantity - locked.otherActiveCommitted - locked.activeHeld,
          );
          if (available < addedQty) {
            return {
              kind: "insufficient-stock" as const,
              message: `Insufficient available stock for ${locked.name} (${available} ${locked.unit} available, ${addedQty} needed).`,
            };
          }
        }
      }

      const completed = await repo.completeSaleActionAtomic(tx, {
        actionId: actionRow.id,
        actionReference: actionRow.reference,
        actionType: actionRow.actionType,
        reason: actionRow.reason,
        originalSaleId: saleRow.id,
        originalSaleReference: saleRow.reference,
        originalBusinessDayId: actionRow.originalBusinessDayId,
        originalBusinessDate: actionRow.originalBusinessDate,
        correctedItems: actionView.correctedItems,
        merchandisePlan: effectiveMerchandisePlan,
        correctedTotalCentavos: Number(actionRow.correctedTotalCentavos),
        cashTenderedCentavos: cashResult.cashTenderedCentavos,
        cashChangeCentavos: cashResult.cashChangeCentavos,
        cashRefundedCentavos: cashResult.cashRefundedCentavos,
        completedByUserId: req.auth!.user.id,
        now: req.now,
      });

      return { kind: "completed" as const, ...completed };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Sale action reference not found.");
      return;
    }
    if (outcome.kind === "payload-mismatch") {
      sendError(
        res,
        409,
        "PAYLOAD_MISMATCH",
        "Cash tendered does not match the already saved sale action.",
      );
      return;
    }
    if (outcome.kind === "already-cancelled") {
      res.status(409).json({
        error: {
          code: "SALE_ACTION_ALREADY_CANCELLED",
          message: "This sale action was already cancelled with no cash exchanged.",
        },
        action: outcome.action,
        originalSale: outcome.originalSale,
      });
      return;
    }
    if (outcome.kind === "day-closed") {
      sendError(res, 409, "DAY_CLOSED", "The original station business day is already closed.");
      return;
    }
    if (outcome.kind === "sale-not-active") {
      sendError(res, 409, "SALE_NOT_ACTIVE", "This sale is no longer Active.");
      return;
    }
    if (outcome.kind === "validation-failed") {
      sendError(res, 400, "VALIDATION_FAILED", outcome.message);
      return;
    }
    if (outcome.kind === "intervening-count-review-required") {
      res.status(409).json({
        error: {
          code: "INTERVENING_COUNT_REVIEW_REQUIRED",
          message: outcome.message,
        },
        affectedItems: outcome.affectedItems,
        staleStockCount: outcome.staleStockCount,
      });
      return;
    }
    if (outcome.kind === "opening-stock-not-set") {
      sendError(res, 409, "OPENING_STOCK_NOT_SET", outcome.message);
      return;
    }
    if (outcome.kind === "insufficient-stock") {
      sendError(res, 409, "INSUFFICIENT_STOCK", outcome.message);
      return;
    }
    if (outcome.kind === "prior-day-zero-cash") {
      sendError(
        res,
        409,
        "PRIOR_DAY_ACTION_BLOCKED",
        "An unsaved zero-cash correction cannot be confirmed after Manila midnight. Cancel it with no cash exchanged instead.",
      );
      return;
    }

    const replayed = outcome.kind === "replayed-completed";
    res.status(replayed ? 200 : 201).json({
      outcome: "COMPLETED" as const,
      replayed,
      action: outcome.action,
      originalSale: outcome.originalSale,
      replacementSale: outcome.replacementSale,
    });
  });

  router.post("/sale-actions/:reference/cancel", requireRole("OWNER"), async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Sale action reference not found.");
      return;
    }

    const parsed = cancelSaleActionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid sale action cancel request.");
      return;
    }

    const body = parsed.data;
    const preAction = await repo.findSaleActionRowByReference(db, reference);
    if (!preAction) {
      sendError(res, 404, "NOT_FOUND", "Sale action reference not found.");
      return;
    }

    const outcome = await db.transaction(async (tx) => {
      const day = await repo.lockDayById(tx, preAction.originalBusinessDayId);
      await repo.lockSaleRawByReference(tx, preAction.originalSaleReference);
      const actionRow = await repo.lockSaleActionRowByReference(tx, reference);
      if (!day || !actionRow) {
        return { kind: "not-found" as const };
      }

      if (actionRow.status === "CANCELLED_NO_CASH") {
        const originalSale = await repo.findSaleByReference(tx, actionRow.originalSaleReference);
        return {
          kind: "replayed-cancelled" as const,
          action: toSaleActionRequestView(actionRow),
          originalSale: originalSale!,
        };
      }

      if (actionRow.status === "COMPLETED") {
        const [originalSale, replacementSale] = await Promise.all([
          repo.findSaleByReference(tx, actionRow.originalSaleReference),
          actionRow.replacementSaleReference
            ? repo.findSaleByReference(tx, actionRow.replacementSaleReference)
            : Promise.resolve(undefined),
        ]);
        return {
          kind: "already-completed" as const,
          action: toSaleActionRequestView(actionRow),
          originalSale: originalSale!,
          replacementSale: replacementSale ?? null,
        };
      }

      if (day.closedAt !== null) {
        return { kind: "day-closed" as const };
      }

      if (body.noCashExchangedConfirmed !== true) {
        return {
          kind: "validation-failed" as const,
          message:
            "Confirm that no cash changed hands before cancelling this pending sale action.",
        };
      }

      const cancelled = await repo.cancelSaleActionNoCash(tx, {
        actionId: actionRow.id,
        actionReference: actionRow.reference,
        originalSaleReference: actionRow.originalSaleReference,
        cancelledByUserId: req.auth!.user.id,
        cancelReason: body.reason?.trim() || "Cancelled by Owner (no cash exchanged)",
        now: req.now,
      });

      return { kind: "cancelled" as const, ...cancelled };
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Sale action reference not found.");
      return;
    }
    if (outcome.kind === "already-completed") {
      res.status(409).json({
        error: {
          code: "SALE_ACTION_ALREADY_COMPLETED",
          message: "This sale action was already completed and cannot be cancelled.",
        },
        action: outcome.action,
        originalSale: outcome.originalSale,
        replacementSale: outcome.replacementSale,
      });
      return;
    }
    if (outcome.kind === "day-closed") {
      sendError(res, 409, "DAY_CLOSED", "The original station business day is already closed.");
      return;
    }
    if (outcome.kind === "validation-failed") {
      sendError(res, 400, "VALIDATION_FAILED", outcome.message);
      return;
    }

    const replayed = outcome.kind === "replayed-cancelled";
    res.status(200).json({
      outcome: "CANCELLED_NO_CASH" as const,
      replayed,
      action: outcome.action,
      originalSale: outcome.originalSale,
    });
  });

  router.get("/settlements", async (req, res) => {
    const rawDate =
      typeof req.query.date === "string" && req.query.date.trim().length > 0
        ? req.query.date.trim()
        : formatManilaDate(req.now);

    if (!isValidCalendarDate(rawDate)) {
      sendError(res, 400, "VALIDATION_FAILED", "Use YYYY-MM-DD for the settlement date filter.");
      return;
    }

    let originalBusinessDate: string | undefined;
    if (typeof req.query.originalDate === "string" && req.query.originalDate.trim().length > 0) {
      originalBusinessDate = req.query.originalDate.trim();
      if (!isValidCalendarDate(originalBusinessDate)) {
        sendError(res, 400, "VALIDATION_FAILED", "Use YYYY-MM-DD for originalDate.");
        return;
      }
    }

    const referenceQuery =
      typeof req.query.q === "string"
        ? req.query.q
        : typeof req.query.reference === "string"
          ? req.query.reference
          : "";

    const settlements = await repo.listPriorDaySettlements(db, {
      settlementDate: rawDate,
      originalBusinessDate,
      referenceQuery,
    });

    res.json({
      settlementDate: rawDate,
      query: referenceQuery.trim(),
      settlements,
    });
  });

  router.get("/settlements/:reference", async (req, res) => {
    const reference = paramReference(req.params.reference);
    if (!reference) {
      sendError(res, 404, "NOT_FOUND", "Prior-day settlement not found.");
      return;
    }

    const settlement = await repo.findPriorDaySettlementByReference(db, reference);
    if (!settlement) {
      sendError(res, 404, "NOT_FOUND", "Prior-day settlement not found.");
      return;
    }

    res.json({ ...settlement, settlement });
  });

  return router;
}
