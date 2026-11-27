import { Router, type Response } from "express";
import type { Database } from "../../db/database.js";
import { sendError } from "../../shared/http.js";
import { requireRole } from "../auth/guards.js";
import {
  BUILT_IN_POS_SECTIONS,
  type FaucetReportingType,
  formatManilaDate,
  inventoryPermissions,
  isUuid,
  MAX_OPENING_QUANTITY,
  type MovementCoverageMode,
  parseContainerShape,
  parseCoverageMode,
  parseFaucetReportingType,
  parseLowStockLevel,
  parseManilaDate,
  parseMovementNote,
  parseOpeningQuantity,
  parsePhysicalCount,
  parsePosSectionCode,
  parsePosSectionName,
  parseProductDescription,
  parseProductName,
  parseQuantity,
  parseReconciliationReason,
  parseRequestKey,
  parseStockUnit,
  parseStoredBalanceBaseline,
  parseUnitPriceCentavos,
  type PosSection,
} from "./inventory.js";
import {
  inventoryRepository as repo,
  type LateCoverageSelectionInput,
  type MovementCorrectionActionResult,
  type OpeningStockTarget,
  redactItemForEmployee,
} from "./repository.js";

const CREATE_PRODUCT_KEYS = new Set([
  "category",
  "name",
  "description",
  "unit",
  "unitConfirmed",
  "allowDecimalQuantity",
  "unitPriceCentavos",
  "showInPos",
  "posSection",
  "lowStockLevel",
  "faucetReportingType",
]);

const UPDATE_PRODUCT_KEYS = new Set([
  "name",
  "description",
  "unitPriceCentavos",
  "showInPos",
  "posSection",
  "lowStockLevel",
  "faucetReportingType",
]);

const CREATE_SECTION_KEYS = new Set(["name"]);
const CONTAINER_SETTINGS_KEYS = new Set(["showInPos", "lowStockLevel"]);
const RECONCILE_KEYS = new Set([
  "physicalCount",
  "reason",
  "expectedRevision",
  "expectedCurrentQuantity",
  "requestKey",
]);
const RECEIVING_KEYS = new Set([
  "quantity",
  "effectiveDate",
  "note",
  "expectedRevision",
  "expectedCurrentQuantity",
  "requestKey",
  "coverageMode",
  "coveredQuantity",
  "supportingReconciliationId",
  "coveredByOpeningCount",
  "reviewNote",
  "expectedLatestReconciliationId",
  "expectedOpeningCountCoversDate",
]);
const USAGE_KEYS = new Set([
  "quantity",
  "purpose",
  "effectiveDate",
  "expectedRevision",
  "expectedCurrentQuantity",
  "requestKey",
  "coverageMode",
  "coveredQuantity",
  "supportingReconciliationId",
  "coveredByOpeningCount",
  "reviewNote",
  "expectedLatestReconciliationId",
  "expectedOpeningCountCoversDate",
]);
const RESOLVE_REVIEW_KEYS = new Set([
  "coverageMode",
  "coveredQuantity",
  "supportingReconciliationId",
  "coveredByOpeningCount",
  "reviewNote",
  "expectedRevision",
  "expectedCurrentQuantity",
  "expectedLatestReconciliationId",
  "expectedOpeningCountCoversDate",
  "requestKey",
]);
const CANCEL_MOVEMENT_KEYS = new Set(["itemKey", "movementType"]);
const COVERAGE_FIELD_KEYS = new Set([
  "coverageMode",
  "coveredQuantity",
  "supportingReconciliationId",
  "coveredByOpeningCount",
  "reviewNote",
  "expectedLatestReconciliationId",
  "expectedOpeningCountCoversDate",
]);
const CORRECT_QUANTITY_KEYS = new Set([
  "newQuantity",
  "reason",
  "expectedCorrectionVersion",
  "expectedRevision",
  "expectedCurrentQuantity",
  "requestKey",
  ...COVERAGE_FIELD_KEYS,
]);
const CANCEL_SAVED_MOVEMENT_KEYS = new Set([
  "reason",
  "expectedCorrectionVersion",
  "expectedRevision",
  "expectedCurrentQuantity",
  "requestKey",
  ...COVERAGE_FIELD_KEYS,
]);
const CORRECT_ITEM_KEYS = new Set([
  "newItemKey",
  "reason",
  "expectedCorrectionVersion",
  "expectedPrimaryRevision",
  "expectedPrimaryQuantity",
  "expectedSecondaryRevision",
  "expectedSecondaryQuantity",
  "primaryCoverage",
  "secondaryCoverage",
  "differentUnitReconciliation",
  "requestKey",
]);
const CORRECT_METADATA_KEYS = new Set([
  "effectiveDate",
  "note",
  "reason",
  "expectedCorrectionVersion",
  "expectedRevision",
  "expectedCurrentQuantity",
  "requestKey",
  ...COVERAGE_FIELD_KEYS,
]);
const RESOLVE_CORRECTION_KEYS = new Set([
  "expectedPrimaryRevision",
  "expectedPrimaryQuantity",
  "expectedSecondaryRevision",
  "expectedSecondaryQuantity",
  "primaryCoverage",
  "secondaryCoverage",
  "requestKey",
  ...COVERAGE_FIELD_KEYS,
  "expectedRevision",
  "expectedCurrentQuantity",
]);

function parseNestedCoverageObject(
  raw: unknown,
  options: { requireMode: boolean; requireSnapshot: boolean },
):
  | { ok: true; value: LateCoverageSelectionInput }
  | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Provide valid count-coverage review details." };
  }
  const obj = raw as Record<string, unknown>;
  const extraKeys = Object.keys(obj).filter((k) => !COVERAGE_FIELD_KEYS.has(k));
  if (extraKeys.length > 0) {
    return { ok: false, message: "Unexpected count-coverage fields provided." };
  }
  const parsed = parseCoverageRequestFields(obj, options);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

function sendCorrectionOutcome(
  res: Response,
  outcome: MovementCorrectionActionResult,
  successStatus = 200,
): void {
  if (outcome.kind === "not-found") {
    sendError(res, 404, "NOT_FOUND", "Inventory entry or item not found.");
    return;
  }
  if (outcome.kind === "key-conflict") {
    sendError(
      res,
      409,
      "REQUEST_KEY_CONFLICT",
      "This correction request key was already used for another change.",
    );
    return;
  }
  if (outcome.kind === "already-cancelled") {
    sendError(
      res,
      409,
      "MOVEMENT_ALREADY_CANCELLED",
      "This stock entry has already been cancelled.",
    );
    return;
  }
  if (outcome.kind === "pending-conflict") {
    sendError(res, 409, "MOVEMENT_CORRECTION_PENDING", outcome.message);
    return;
  }
  if (outcome.kind === "already-resolved") {
    res.status(409).json({
      error: {
        code: "CORRECTION_ALREADY_RESOLVED",
        message: "This pending inventory correction has already been resolved.",
      },
      primaryItem: outcome.primaryItem,
      secondaryItem: outcome.secondaryItem,
      movement: outcome.movement,
      correction: outcome.correction,
    });
    return;
  }
  if (outcome.kind === "archived") {
    sendError(res, 409, "PRODUCT_ARCHIVED", outcome.message);
    return;
  }
  if (outcome.kind === "not-set") {
    sendError(res, 409, "OPENING_STOCK_NOT_SET", outcome.message);
    return;
  }
  if (outcome.kind === "invalid-target" || outcome.kind === "invalid-coverage") {
    sendError(
      res,
      400,
      "VALIDATION_FAILED",
      outcome.message,
    );
    return;
  }
  if (outcome.kind === "invalid-quantity") {
    sendError(
      res,
      400,
      "VALIDATION_FAILED",
      `Enter a positive whole number of ${outcome.unit}.`,
    );
    return;
  }
  if (outcome.kind === "invalid-quantity-unchanged") {
    sendError(
      res,
      400,
      "VALIDATION_FAILED",
      `Enter a new quantity different from the current saved value (${outcome.currentQuantityValue}).`,
    );
    return;
  }
  if (outcome.kind === "invalid-baseline") {
    sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
    return;
  }
  if (outcome.kind === "stale-movement") {
    res.status(409).json({
      error: {
        code: "STALE_MOVEMENT",
        message: "This stock entry was updated while you were reviewing it. Refresh history and try again.",
      },
      primaryItem: outcome.primaryItem,
      secondaryItem: outcome.secondaryItem,
      movement: outcome.movement,
    });
    return;
  }
  if (outcome.kind === "stale-stock") {
    res.status(409).json({
      error: {
        code: "STALE_STOCK_BALANCE",
        message: `Recorded stock for ${outcome.primaryItem.name} changed while confirming. Review the refreshed balance and confirm again.`,
      },
      item: outcome.primaryItem,
      primaryItem: outcome.primaryItem,
      secondaryItem: outcome.secondaryItem,
      movement: outcome.movement,
    });
    return;
  }
  if (outcome.kind === "stale-review") {
    res.status(409).json({
      error: {
        code: "STALE_REVIEW_CONTEXT",
        message: `New physical-count history was recorded for ${outcome.primaryItem.name}. Review the updated counts before confirming.`,
      },
      item: outcome.primaryItem,
      primaryItem: outcome.primaryItem,
      secondaryItem: outcome.secondaryItem,
      movement: outcome.movement,
      applicableReconciliations: outcome.primaryApplicableReconciliations,
      openingCountCoversDate: outcome.primaryOpeningCountCoversDate,
      primaryApplicableReconciliations: outcome.primaryApplicableReconciliations,
      primaryOpeningCountCoversDate: outcome.primaryOpeningCountCoversDate,
      secondaryApplicableReconciliations: outcome.secondaryApplicableReconciliations,
      secondaryOpeningCountCoversDate: outcome.secondaryOpeningCountCoversDate,
    });
    return;
  }
  if (outcome.kind === "count-required-negative") {
    res.status(409).json({
      error: {
        code: "COUNT_REQUIRED_BEFORE_NEGATIVE_STOCK",
        message: `This correction would put ${outcome.item.name} below zero (${outcome.item.currentQuantity} ${outcome.item.unit}). Count and reconcile ${outcome.item.name} first (INV-009).`,
      },
      item: outcome.item,
      attemptedDelta: outcome.attemptedDelta,
    });
    return;
  }
  if (outcome.kind === "count-required-unclear") {
    res.status(409).json({
      error: {
        code: "INTERVENING_COUNT_REVIEW_REQUIRED",
        message: `Record a new physical-count reconciliation (INV-009) for ${outcome.item.name} after this pending correction was created before resolving it with 0 further stock effect.`,
      },
      item: outcome.item,
    });
    return;
  }
  if (outcome.kind === "different-unit-quantity-unrecorded") {
    res.status(409).json({
      error: {
        code: "DIFFERENT_UNIT_RECONCILIATION_REQUIRED",
        message: `This entry was reconciled across units (originally ${outcome.originalUnit}) without recording a quantity in ${outcome.item.unit}. Count and reconcile ${outcome.item.name} directly instead of adjusting stock from ${outcome.originalUnit}.`,
      },
      item: outcome.item,
    });
    return;
  }
  if (outcome.kind === "different-unit-reconciliation-required") {
    res.status(409).json({
      error: {
        code: "DIFFERENT_UNIT_RECONCILIATION_REQUIRED",
        message: `${outcome.primaryItem.name} (${outcome.primaryItem.unit}) and ${outcome.secondaryItem.name} (${outcome.secondaryItem.unit}) use different units. Count and reconcile both in their own units first, then select both supporting counts.`,
      },
      primaryItem: outcome.primaryItem,
      secondaryItem: outcome.secondaryItem,
      primaryApplicableReconciliations: outcome.primaryApplicableReconciliations,
      secondaryApplicableReconciliations: outcome.secondaryApplicableReconciliations,
    });
    return;
  }

  res.status(outcome.kind === "replayed" ? 200 : successStatus).json({
    item: outcome.primaryItem,
    primaryItem: outcome.primaryItem,
    secondaryItem: outcome.secondaryItem,
    movement: outcome.movement,
    correction: outcome.correction,
    replayed: outcome.kind === "replayed",
  });
}

function parseCoverageRequestFields(
  body: Record<string, unknown>,
  options: { requireMode: boolean; requireSnapshot?: boolean },
):
  | { ok: true; value: LateCoverageSelectionInput; hasCoverageFields: boolean }
  | { ok: false; message: string } {
  const hasCoverageFields =
    body.coverageMode !== undefined ||
    body.coveredQuantity !== undefined ||
    body.supportingReconciliationId !== undefined ||
    body.coveredByOpeningCount !== undefined ||
    body.reviewNote !== undefined ||
    body.expectedLatestReconciliationId !== undefined ||
    body.expectedOpeningCountCoversDate !== undefined;

  let coverageMode: MovementCoverageMode | null | undefined = undefined;
  if (body.coverageMode !== undefined && body.coverageMode !== null) {
    const parsed = parseCoverageMode(body.coverageMode);
    if (!parsed) {
      return { ok: false, message: "Choose a valid count-coverage option." };
    }
    coverageMode = parsed;
  } else if (options.requireMode) {
    return { ok: false, message: "Choose a valid count-coverage option." };
  }

  let coveredQuantity: number | null | undefined = undefined;
  if (body.coveredQuantity !== undefined && body.coveredQuantity !== null) {
    const parsed = parseQuantity(body.coveredQuantity, { allowDecimal: true, allowZero: false });
    if (parsed === null) {
      return { ok: false, message: "Enter a positive covered quantity (up to 4 decimals)." };
    }
    coveredQuantity = parsed;
  }

  let supportingReconciliationId: string | null | undefined = undefined;
  if (
    body.supportingReconciliationId !== undefined &&
    body.supportingReconciliationId !== null &&
    body.supportingReconciliationId !== ""
  ) {
    if (
      typeof body.supportingReconciliationId !== "string" ||
      !isUuid(body.supportingReconciliationId.trim())
    ) {
      return { ok: false, message: "Choose a valid supporting physical count." };
    }
    supportingReconciliationId = body.supportingReconciliationId.trim();
  } else if (body.supportingReconciliationId === null) {
    supportingReconciliationId = null;
  }

  let coveredByOpeningCount: boolean | undefined = undefined;
  if (body.coveredByOpeningCount !== undefined) {
    if (typeof body.coveredByOpeningCount !== "boolean") {
      return { ok: false, message: "Invalid opening-count coverage flag." };
    }
    coveredByOpeningCount = body.coveredByOpeningCount;
  }

  const reviewNoteResult = parseMovementNote(body.reviewNote, { required: false });
  if (!reviewNoteResult.ok) {
    return { ok: false, message: "Review note must be 240 characters or fewer." };
  }

  let expectedLatestReconciliationId: string | null | undefined = undefined;
  if (body.expectedLatestReconciliationId !== undefined) {
    if (body.expectedLatestReconciliationId === null) {
      expectedLatestReconciliationId = null;
    } else if (
      typeof body.expectedLatestReconciliationId === "string" &&
      isUuid(body.expectedLatestReconciliationId.trim())
    ) {
      expectedLatestReconciliationId = body.expectedLatestReconciliationId.trim();
    } else {
      return { ok: false, message: "Invalid count-review revision reference." };
    }
  } else if (options.requireSnapshot) {
    return {
      ok: false,
      message: "Missing count-review revision reference. Refresh the pending review and try again.",
    };
  }

  let expectedOpeningCountCoversDate: boolean | undefined = undefined;
  if (body.expectedOpeningCountCoversDate !== undefined) {
    if (typeof body.expectedOpeningCountCoversDate !== "boolean") {
      return { ok: false, message: "Invalid opening-count review reference." };
    }
    expectedOpeningCountCoversDate = body.expectedOpeningCountCoversDate;
  } else if (options.requireSnapshot) {
    return {
      ok: false,
      message: "Missing opening-count review reference. Refresh the pending review and try again.",
    };
  }

  return {
    ok: true,
    hasCoverageFields,
    value: {
      coverageMode,
      coveredQuantity,
      supportingReconciliationId,
      coveredByOpeningCount,
      reviewNote: reviewNoteResult.value,
      expectedLatestReconciliationId,
      expectedOpeningCountCoversDate,
    },
  };
}

function resolveItemTarget(rawKey: string): OpeningStockTarget | null {
  const shape = parseContainerShape(rawKey);
  if (shape) {
    return { kind: "shape", shape };
  }
  if (isUuid(rawKey)) {
    return { kind: "id", id: rawKey };
  }
  return null;
}

/**
 * Inventory HTTP endpoints, mounted at /api/inventory behind the shared
 * module-access guards. Both roles can view; only OWNER can manage products,
 * custom POS sections, container visibility, archiving, opening stock, and
 * INV-009 physical-count reconciliations.
 */
export function inventoryRoutes(db: Database): Router {
  const router = Router();

  router.get("/access", (req, res) => {
    res.json(inventoryPermissions(req.auth!.user.role));
  });

  router.get("/items", async (req, res) => {
    const role = req.auth!.user.role;
    const includeArchived = role === "OWNER" && req.query.includeArchived === "true";
    const [rawItems, posSections, pendingMovementReviewsCount, pendingCorrectionReviewsCount] =
      await Promise.all([
        repo.listItems(db, { includeArchived }),
        repo.listPosSections(db),
        role === "OWNER" ? repo.countPendingMovementReviews(db) : Promise.resolve(0),
        role === "OWNER" ? repo.countPendingCorrectionReviews(db) : Promise.resolve(0),
      ]);
    const items = role === "OWNER" ? rawItems : rawItems.map(redactItemForEmployee);
    const pendingStockReviews =
      role === "OWNER" ? items.flatMap((item) => item.pendingStockReviews ?? []) : [];
    res.json({
      permissions: inventoryPermissions(role),
      items,
      posSections,
      pendingStockReviews,
      pendingMovementReviewsCount,
      pendingCorrectionReviewsCount,
    });
  });

  router.get("/movements/by-request-key/:requestKey", async (req, res) => {
    const rawKey = typeof req.params.requestKey === "string" ? req.params.requestKey : "";
    const parsedKey = parseRequestKey(rawKey);
    if (!parsedKey.ok || !parsedKey.value) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid movement request key.");
      return;
    }

    const found = await repo.findStockMovementByRequestKey(db, {
      requestKey: parsedKey.value,
      actorUserId: req.auth!.user.id,
      actorRole: req.auth!.user.role,
    });
    if (found.status === "NOT_FOUND") {
      res.json({ status: "NOT_FOUND" });
      return;
    }
    if (found.status === "CANCELLED") {
      res.json({ status: "CANCELLED" });
      return;
    }

    res.json({
      status: "SAVED",
      item: found.item,
      movement: found.movement,
    });
  });

  router.post("/movements/by-request-key/:requestKey/cancel", async (req, res) => {
    const rawKey = typeof req.params.requestKey === "string" ? req.params.requestKey : "";
    const parsedKey = parseRequestKey(rawKey);
    if (!parsedKey.ok || !parsedKey.value) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid movement request key.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid movement cancellation details.");
      return;
    }

    const extraKeys = Object.keys(body).filter((key) => !CANCEL_MOVEMENT_KEYS.has(key));
    if (extraKeys.length > 0) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected movement cancellation fields provided.");
      return;
    }

    if (body.movementType !== "STOCK_RECEIVED" && body.movementType !== "STOCK_USED") {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid movement type to cancel.");
      return;
    }
    if (body.movementType === "STOCK_RECEIVED" && req.auth!.user.role !== "OWNER") {
      sendError(res, 403, "FORBIDDEN", "Only the Owner can cancel a Stock Received submission.");
      return;
    }

    const rawItemKey = typeof body.itemKey === "string" ? body.itemKey.trim() : "";
    const target = resolveItemTarget(rawItemKey);
    if (!target) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid Inventory item.");
      return;
    }

    const outcome = await repo.cancelPendingMovementRequest(db, {
      target,
      movementType: body.movementType,
      requestKey: parsedKey.value,
      actorUserId: req.auth!.user.id,
      actorRole: req.auth!.user.role,
      cancelledAt: req.now,
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Inventory item not found.");
      return;
    }
    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This movement request key was already used for a different entry or account.",
      );
      return;
    }
    if (outcome.kind === "already-saved") {
      res.json({
        status: "SAVED",
        item: outcome.item,
        movement: outcome.movement,
      });
      return;
    }

    res.json({ status: "CANCELLED" });
  });

  router.post("/pos-sections", requireRole("OWNER"), async (req, res) => {
    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid POS section name.");
      return;
    }

    const extraKeys = Object.keys(body).filter((key) => !CREATE_SECTION_KEYS.has(key));
    if (extraKeys.length > 0) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected POS section fields provided.");
      return;
    }

    const name = parsePosSectionName(body.name);
    if (!name) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a POS section name (1 to 60 characters).");
      return;
    }

    const outcome = await repo.createPosSection(db, {
      name,
      createdByUserId: req.auth!.user.id,
      createdAt: req.now,
    });

    if (outcome.kind === "duplicate-name") {
      sendError(res, 409, "SECTION_ALREADY_EXISTS", `A POS section named "${name}" already exists.`);
      return;
    }

    res.status(201).json({ section: outcome.section });
  });

  router.post("/products", requireRole("OWNER"), async (req, res) => {
    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid product details.");
      return;
    }

    const extraKeys = Object.keys(body).filter((key) => !CREATE_PRODUCT_KEYS.has(key));
    if (extraKeys.length > 0) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected product fields provided.");
      return;
    }

    const rawCategory = body.category === undefined ? "MERCHANDISE" : body.category;
    if (rawCategory !== "MERCHANDISE" && rawCategory !== "OPERATING_SUPPLY") {
      sendError(res, 400, "VALIDATION_FAILED", "Choose Merchandise or Operating Supply.");
      return;
    }
    const category = rawCategory;

    const allowDecimalQuantity =
      body.allowDecimalQuantity === undefined ? false : body.allowDecimalQuantity;
    if (typeof allowDecimalQuantity !== "boolean") {
      sendError(res, 400, "VALIDATION_FAILED", "Allow decimal quantities must be checked or unchecked.");
      return;
    }
    if (category === "MERCHANDISE" && allowDecimalQuantity) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Merchandise sold in POS must use whole-piece stock quantities.",
      );
      return;
    }

    const name = parseProductName(body.name);
    if (!name) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a product name (1 to 80 characters).");
      return;
    }

    const descResult = parseProductDescription(body.description);
    if (!descResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", "Description must be 160 characters or fewer.");
      return;
    }

    const unit = parseStockUnit(body.unit);
    if (!unit) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter the confirmed stock unit (e.g. pcs).");
      return;
    }

    if (body.unitConfirmed !== true) {
      sendError(res, 400, "VALIDATION_FAILED", "Confirm the stock recording unit before saving.");
      return;
    }

    let unitPriceCentavos: number | null = null;
    let showInPos = false;
    let validatedSection: string | null = null;
    let faucetReportingType: FaucetReportingType | null = null;

    if (category === "OPERATING_SUPPLY") {
      if (
        (body.unitPriceCentavos !== undefined && body.unitPriceCentavos !== null) ||
        body.showInPos === true ||
        (body.posSection !== undefined && body.posSection !== null && body.posSection !== "") ||
        (body.faucetReportingType !== undefined &&
          body.faucetReportingType !== null &&
          body.faucetReportingType !== "")
      ) {
        sendError(
          res,
          400,
          "VALIDATION_FAILED",
          "Operating supplies do not use POS selling prices, POS sections, or faucet tags.",
        );
        return;
      }
      if (body.showInPos !== undefined && typeof body.showInPos !== "boolean") {
        sendError(res, 400, "VALIDATION_FAILED", "Show in POS must be checked or unchecked.");
        return;
      }
    } else {
      unitPriceCentavos = parseUnitPriceCentavos(body.unitPriceCentavos);
      if (unitPriceCentavos === null) {
        sendError(res, 400, "VALIDATION_FAILED", "Enter a valid positive selling price.");
        return;
      }

      const rawShowInPos = body.showInPos === undefined ? false : body.showInPos;
      if (typeof rawShowInPos !== "boolean") {
        sendError(res, 400, "VALIDATION_FAILED", "Show in POS must be checked or unchecked.");
        return;
      }
      showInPos = rawShowInPos;

      const sectionResult = parsePosSectionCode(body.posSection);
      if (!sectionResult.ok) {
        sendError(res, 400, "VALIDATION_FAILED", "Choose a valid POS section for this product.");
        return;
      }

      validatedSection = sectionResult.value;
      if (validatedSection !== null) {
        if (validatedSection === BUILT_IN_POS_SECTIONS.CONTAINERS) {
          sendError(
            res,
            400,
            "VALIDATION_FAILED",
            "The Containers POS section is reserved for Round and Slim containers.",
          );
          return;
        }
        const foundSection = await repo.findPosSectionByCode(db, validatedSection);
        if (!foundSection) {
          sendError(res, 400, "VALIDATION_FAILED", "Choose a valid POS section for this product.");
          return;
        }
        validatedSection = foundSection.code;
      }

      if (showInPos && !validatedSection) {
        sendError(
          res,
          400,
          "VALIDATION_FAILED",
          "Choose a POS section when Show in POS is enabled.",
        );
        return;
      }

      if (body.faucetReportingType !== undefined) {
        const faucetResult = parseFaucetReportingType(body.faucetReportingType);
        if (!faucetResult.ok) {
          sendError(
            res,
            400,
            "VALIDATION_FAILED",
            "Choose Push-Type, Twist-Type, or Not classified for faucet reporting type.",
          );
          return;
        }
        faucetReportingType = faucetResult.value;
      }
    }

    let lowStockLevel: number | null = null;
    if (body.lowStockLevel !== undefined) {
      const lowStockResult = parseLowStockLevel(body.lowStockLevel, allowDecimalQuantity);
      if (!lowStockResult.ok) {
        sendError(
          res,
          400,
          "VALIDATION_FAILED",
          allowDecimalQuantity
            ? "Low stock alert level must be a positive quantity (up to 4 decimals, max 1,000,000), or cleared."
            : "Low stock alert level must be a positive whole number (1 to 1,000,000), or cleared.",
        );
        return;
      }
      lowStockLevel = lowStockResult.value;
    }

    const outcome = await repo.createInventoryProduct(db, {
      category,
      name,
      description: descResult.value,
      unit,
      allowDecimalQuantity,
      unitPriceCentavos,
      showInPos,
      posSection: validatedSection,
      lowStockLevel,
      faucetReportingType,
      createdByUserId: req.auth!.user.id,
      createdAt: req.now,
    });

    if (outcome.kind === "duplicate-name") {
      sendError(res, 409, "PRODUCT_ALREADY_EXISTS", `A product named "${name}" already exists.`);
      return;
    }

    res.status(201).json({ item: outcome.item });
  });

  router.patch("/products/:id", requireRole("OWNER"), async (req, res) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!isUuid(id)) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid product identifier.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid product changes.");
      return;
    }

    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((key) => !UPDATE_PRODUCT_KEYS.has(key))) {
      sendError(res, 400, "VALIDATION_FAILED", "Provide valid product fields to update.");
      return;
    }

    const existing = await repo.findEditableProductById(db, id);
    if (!existing) {
      sendError(res, 404, "NOT_FOUND", "Inventory product not found.");
      return;
    }
    if (existing.archivedAt !== null) {
      sendError(
        res,
        409,
        "PRODUCT_ARCHIVED",
        "Archived products cannot be edited in active Inventory.",
      );
      return;
    }

    if (
      existing.category === "OPERATING_SUPPLY" &&
      ("unitPriceCentavos" in body ||
        "showInPos" in body ||
        "posSection" in body ||
        "faucetReportingType" in body)
    ) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Operating supplies do not use POS selling prices, POS sections, or faucet tags.",
      );
      return;
    }

    const patch: {
      id: string;
      name?: string;
      description?: string | null;
      unitPriceCentavos?: number;
      showInPos?: boolean;
      posSection?: PosSection | null;
      lowStockLevel?: number | null;
      faucetReportingType?: FaucetReportingType | null;
    } = { id };

    if ("name" in body) {
      const parsedName = parseProductName(body.name);
      if (!parsedName) {
        sendError(res, 400, "VALIDATION_FAILED", "Enter a product name (1 to 80 characters).");
        return;
      }
      patch.name = parsedName;
    }

    if ("description" in body) {
      const parsedDesc = parseProductDescription(body.description);
      if (!parsedDesc.ok) {
        sendError(res, 400, "VALIDATION_FAILED", "Description must be 160 characters or fewer.");
        return;
      }
      patch.description = parsedDesc.value;
    }

    if ("unitPriceCentavos" in body) {
      const parsedPrice = parseUnitPriceCentavos(body.unitPriceCentavos);
      if (parsedPrice === null) {
        sendError(res, 400, "VALIDATION_FAILED", "Enter a valid positive selling price.");
        return;
      }
      patch.unitPriceCentavos = parsedPrice;
    }

    if ("showInPos" in body) {
      if (typeof body.showInPos !== "boolean") {
        sendError(res, 400, "VALIDATION_FAILED", "Show in POS must be checked or unchecked.");
        return;
      }
      patch.showInPos = body.showInPos;
    }

    if ("posSection" in body) {
      const parsedSection = parsePosSectionCode(body.posSection);
      if (!parsedSection.ok) {
        sendError(res, 400, "VALIDATION_FAILED", "Choose a valid POS section for this product.");
        return;
      }
      if (parsedSection.value === null) {
        patch.posSection = null;
      } else {
        if (parsedSection.value === BUILT_IN_POS_SECTIONS.CONTAINERS) {
          sendError(
            res,
            400,
            "VALIDATION_FAILED",
            "The Containers POS section is reserved for Round and Slim containers.",
          );
          return;
        }
        const foundSection = await repo.findPosSectionByCode(db, parsedSection.value);
        if (!foundSection) {
          sendError(res, 400, "VALIDATION_FAILED", "Choose a valid POS section for this product.");
          return;
        }
        patch.posSection = foundSection.code;
      }
    }

    if ("lowStockLevel" in body) {
      const lowStockResult = parseLowStockLevel(body.lowStockLevel, existing.allowDecimalQuantity);
      if (!lowStockResult.ok) {
        sendError(
          res,
          400,
          "VALIDATION_FAILED",
          existing.allowDecimalQuantity
            ? "Low stock alert level must be a positive quantity (up to 4 decimals, max 1,000,000), or cleared."
            : "Low stock alert level must be a positive whole number (1 to 1,000,000), or cleared.",
        );
        return;
      }
      patch.lowStockLevel = lowStockResult.value;
    }

    if ("faucetReportingType" in body) {
      const faucetResult = parseFaucetReportingType(body.faucetReportingType);
      if (!faucetResult.ok) {
        sendError(
          res,
          400,
          "VALIDATION_FAILED",
          "Choose Push-Type, Twist-Type, or Not classified for faucet reporting type.",
        );
        return;
      }
      patch.faucetReportingType = faucetResult.value;
    }

    const outcome = await repo.updateInventoryProduct(db, patch);

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Inventory product not found.");
      return;
    }
    if (outcome.kind === "archived") {
      sendError(
        res,
        409,
        "PRODUCT_ARCHIVED",
        "Archived products cannot be edited in active Inventory.",
      );
      return;
    }
    if (outcome.kind === "invalid-supply-fields") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Operating supplies do not use POS selling prices, POS sections, or faucet tags.",
      );
      return;
    }
    if (outcome.kind === "invalid-low-stock") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        outcome.allowDecimalQuantity
          ? "Low stock alert level must be a positive quantity (up to 4 decimals, max 1,000,000), or cleared."
          : "Low stock alert level must be a positive whole number (1 to 1,000,000), or cleared.",
      );
      return;
    }
    if (outcome.kind === "invalid-pos-visibility") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Choose a valid POS section and selling price before showing this product in POS.",
      );
      return;
    }
    if (outcome.kind === "duplicate-name") {
      sendError(
        res,
        409,
        "PRODUCT_ALREADY_EXISTS",
        `A product named "${patch.name ?? existing.name}" already exists.`,
      );
      return;
    }

    res.json({ item: outcome.item });
  });

  router.patch("/containers/:shape", requireRole("OWNER"), async (req, res) => {
    const rawShape = typeof req.params.shape === "string" ? req.params.shape : "";
    const shape = parseContainerShape(rawShape);
    if (!shape) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid container shape (ROUND or SLIM).");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Provide valid container settings.");
      return;
    }

    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((key) => !CONTAINER_SETTINGS_KEYS.has(key))) {
      sendError(res, 400, "VALIDATION_FAILED", "Provide valid container settings.");
      return;
    }

    const containerPatch: {
      shape: typeof shape;
      showInPos?: boolean;
      lowStockLevel?: number | null;
    } = { shape };

    if ("showInPos" in body) {
      if (typeof body.showInPos !== "boolean") {
        sendError(res, 400, "VALIDATION_FAILED", "Show in POS must be checked or unchecked.");
        return;
      }
      containerPatch.showInPos = body.showInPos;
    }

    if ("lowStockLevel" in body) {
      const lowStockResult = parseLowStockLevel(body.lowStockLevel);
      if (!lowStockResult.ok) {
        sendError(
          res,
          400,
          "VALIDATION_FAILED",
          "Low stock alert level must be a positive whole number (1 to 1,000,000), or cleared.",
        );
        return;
      }
      containerPatch.lowStockLevel = lowStockResult.value;
    }

    const updated = await repo.updateContainerSettings(db, containerPatch);
    if (!updated) {
      sendError(res, 404, "NOT_FOUND", "Container product not found.");
      return;
    }

    res.json({ item: updated });
  });

  router.post("/products/:id/archive", requireRole("OWNER"), async (req, res) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!isUuid(id)) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid product identifier.");
      return;
    }

    const outcome = await repo.archiveInventoryProduct(db, {
      id,
      archivedByUserId: req.auth!.user.id,
      archivedAt: req.now,
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Inventory product not found.");
      return;
    }
    if (outcome.kind === "cannot-archive-container") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Round and Slim containers cannot be archived.",
      );
      return;
    }
    if (outcome.kind === "already-archived") {
      sendError(
        res,
        409,
        "PRODUCT_ALREADY_ARCHIVED",
        "This product has already been archived.",
      );
      return;
    }

    res.json({ item: outcome.item });
  });

  router.post("/items/:itemKey/opening-stock", requireRole("OWNER"), async (req, res) => {
    const rawKey = typeof req.params.itemKey === "string" ? req.params.itemKey.trim() : "";
    const target = resolveItemTarget(rawKey);
    if (!target) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid Inventory item.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid opening count (0 or more).");
      return;
    }

    const extraKeys = Object.keys(body).filter((key) => key !== "quantity");
    if (extraKeys.length > 0) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid opening count (0 or more).");
      return;
    }

    const quantity = parseOpeningQuantity(body.quantity, true);
    if (quantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid opening count (0 or more).");
      return;
    }

    const outcome = await repo.recordOpeningStock(db, {
      target,
      quantity,
      recordedByUserId: req.auth!.user.id,
      recordedAt: req.now,
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Inventory item not found.");
      return;
    }
    if (outcome.kind === "invalid-quantity") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        `Enter a whole number of ${outcome.unit} (0 or more).`,
      );
      return;
    }
    if (outcome.kind === "archived") {
      sendError(
        res,
        409,
        "PRODUCT_ARCHIVED",
        "Archived products cannot record new opening counts.",
      );
      return;
    }

    if (outcome.kind === "already-set") {
      res.status(409).json({
        error: {
          code: "OPENING_STOCK_ALREADY_SET",
          message: `Opening stock for ${outcome.item.name} is already set.`,
        },
        item: outcome.item,
      });
      return;
    }

    res.status(201).json({ item: outcome.item });
  });

  router.get("/items/:itemKey/reconciliations", requireRole("OWNER"), async (req, res) => {
    const rawKey = typeof req.params.itemKey === "string" ? req.params.itemKey.trim() : "";
    const target = resolveItemTarget(rawKey);
    if (!target) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid Inventory item.");
      return;
    }

    let sinceDate: string | undefined = undefined;
    if (req.query.sinceDate !== undefined) {
      const parsed = parseManilaDate(req.query.sinceDate);
      if (!parsed) {
        sendError(res, 400, "VALIDATION_FAILED", "Enter a valid date (YYYY-MM-DD).");
        return;
      }
      sinceDate = parsed;
    }

    const result = await repo.listReconciliations(db, target, { sinceDate });
    if (!result.found) {
      sendError(res, 404, "NOT_FOUND", "Inventory item not found.");
      return;
    }

    res.json({
      reconciliations: result.reconciliations,
      openingCountCoversDate: result.openingCountCoversDate,
    });
  });

  router.get("/items/:itemKey/history", async (req, res) => {
    const rawKey = typeof req.params.itemKey === "string" ? req.params.itemKey.trim() : "";
    const target = resolveItemTarget(rawKey);
    if (!target) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid Inventory item.");
      return;
    }

    const history = await repo.listItemHistory(db, {
      target,
      role: req.auth!.user.role,
      actorUserId: req.auth!.user.id,
    });
    if (!history) {
      sendError(res, 404, "NOT_FOUND", "Inventory item not found.");
      return;
    }

    res.json(history);
  });

  router.get("/pending-reviews", requireRole("OWNER"), async (_req, res) => {
    const reviews = await repo.listPendingMovementReviews(db);
    res.json({ reviews });
  });

  router.post("/pending-reviews/:entryId/resolve", requireRole("OWNER"), async (req, res) => {
    const rawEntryId = typeof req.params.entryId === "string" ? req.params.entryId.trim() : "";
    if (!isUuid(rawEntryId)) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid pending inventory entry.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid count-coverage details.");
      return;
    }

    const extraKeys = Object.keys(body).filter((key) => !RESOLVE_REVIEW_KEYS.has(key));
    if (extraKeys.length > 0) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected pending-review fields provided.");
      return;
    }

    const coverageParsed = parseCoverageRequestFields(body, {
      requireMode: true,
      requireSnapshot: true,
    });
    if (!coverageParsed.ok) {
      sendError(res, 400, "VALIDATION_FAILED", coverageParsed.message);
      return;
    }

    if (
      typeof body.expectedRevision !== "number" ||
      !Number.isInteger(body.expectedRevision) ||
      body.expectedRevision < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid stock revision baseline.");
      return;
    }

    const expectedCurrentQuantity = parseStoredBalanceBaseline(body.expectedCurrentQuantity, {
      allowDecimal: true,
      allowNegative: true,
    });
    if (expectedCurrentQuantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }

    const requestKeyResult = parseRequestKey(body.requestKey);
    if (!requestKeyResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid review confirmation request key.");
      return;
    }

    const outcome = await repo.resolvePendingMovementReview(db, {
      entryId: rawEntryId,
      expectedRevision: body.expectedRevision,
      expectedCurrentQuantity,
      requestKey: requestKeyResult.value,
      reviewerUserId: req.auth!.user.id,
      reviewedAt: req.now,
      coverage: coverageParsed.value,
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Pending inventory entry not found.");
      return;
    }
    if (outcome.kind === "already-resolved") {
      res.status(409).json({
        error: {
          code: "MOVEMENT_ALREADY_RESOLVED",
          message: "This pending inventory entry has already been resolved.",
        },
        item: outcome.item,
        movement: outcome.movement,
      });
      return;
    }
    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This review confirmation request key was already used for another entry.",
      );
      return;
    }
    if (outcome.kind === "invalid-coverage") {
      sendError(res, 400, "VALIDATION_FAILED", outcome.message);
      return;
    }
    if (outcome.kind === "invalid-baseline") {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }
    if (outcome.kind === "stale-review") {
      res.status(409).json({
        error: {
          code: "STALE_REVIEW_CONTEXT",
          message: `New physical-count history was recorded for ${outcome.item.name}. Review the updated counts before confirming coverage.`,
        },
        item: outcome.item,
        entry: outcome.entry,
        applicableReconciliations: outcome.applicableReconciliations,
        openingCountCoversDate: outcome.openingCountCoversDate,
      });
      return;
    }
    if (outcome.kind === "stale") {
      res.status(409).json({
        error: {
          code: "STALE_STOCK_BALANCE",
          message: `Recorded stock for ${outcome.item.name} changed to ${outcome.item.currentQuantity} ${outcome.item.unit} before confirming. Review the refreshed balance and confirm again.`,
        },
        item: outcome.item,
        entry: outcome.entry,
        applicableReconciliations: outcome.applicableReconciliations,
        openingCountCoversDate: outcome.openingCountCoversDate,
      });
      return;
    }

    res.json({
      item: outcome.item,
      movement: outcome.movement,
      replayed: outcome.kind === "replayed",
    });
  });

  router.post("/items/:itemKey/reconciliations", requireRole("OWNER"), async (req, res) => {
    const rawKey = typeof req.params.itemKey === "string" ? req.params.itemKey.trim() : "";
    const target = resolveItemTarget(rawKey);
    if (!target) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid Inventory item.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid physical count and reason.");
      return;
    }

    const extraKeys = Object.keys(body).filter((key) => !RECONCILE_KEYS.has(key));
    if (extraKeys.length > 0) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected stock correction fields provided.");
      return;
    }

    const physicalCount = parsePhysicalCount(body.physicalCount, true);
    if (physicalCount === null) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        `Enter a valid physical count from 0 to ${MAX_OPENING_QUANTITY.toLocaleString("en-US")}.`,
      );
      return;
    }

    const reason = parseReconciliationReason(body.reason);
    if (!reason) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Enter a factual reason for the physical count (1 to 240 characters).",
      );
      return;
    }

    if (
      typeof body.expectedRevision !== "number" ||
      !Number.isInteger(body.expectedRevision) ||
      body.expectedRevision < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid stock revision baseline.");
      return;
    }

    const expectedCurrentQuantity = parseStoredBalanceBaseline(body.expectedCurrentQuantity, {
      allowDecimal: true,
      allowNegative: true,
    });
    if (expectedCurrentQuantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }

    const requestKeyResult = parseRequestKey(body.requestKey);
    if (!requestKeyResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid reconciliation request key.");
      return;
    }

    const outcome = await repo.recordPhysicalCountReconciliation(db, {
      target,
      physicalCount,
      reason,
      expectedRevision: body.expectedRevision,
      expectedCurrentQuantity,
      requestKey: requestKeyResult.value,
      actorUserId: req.auth!.user.id,
      recordedAt: req.now,
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Inventory item not found.");
      return;
    }
    if (outcome.kind === "invalid-quantity") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        `Enter a whole physical count of ${outcome.unit} (0 or more).`,
      );
      return;
    }
    if (outcome.kind === "invalid-baseline") {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }
    if (outcome.kind === "archived") {
      sendError(
        res,
        409,
        "PRODUCT_ARCHIVED",
        "Archived products cannot receive stock reconciliations.",
      );
      return;
    }
    if (outcome.kind === "not-set") {
      sendError(
        res,
        409,
        "OPENING_STOCK_NOT_SET",
        "Record an opening stock count before correcting current stock.",
      );
      return;
    }
    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This reconciliation request key was already used for a different physical count.",
      );
      return;
    }
    if (outcome.kind === "stale") {
      res.status(409).json({
        error: {
          code: "STALE_STOCK_COUNT",
          message: `Recorded stock for ${outcome.item.name} changed to ${outcome.item.currentQuantity} ${outcome.item.unit} during counting. Refresh and confirm a new physical recount.`,
        },
        item: outcome.item,
      });
      return;
    }
    if (outcome.kind === "active-commitment") {
      res.status(409).json({
        error: {
          code: "ACTIVE_PAYMENT_COMMITMENT",
          message: `Cannot set stock for ${outcome.item.name} to ${physicalCount} ${outcome.item.unit} while ${outcome.activeCommitted} ${outcome.item.unit} are reserved by an in-progress POS cash payment. Finish or cancel the pending checkout first.`,
        },
        activeCommitted: outcome.activeCommitted,
        item: outcome.item,
      });
      return;
    }
    if (outcome.kind === "active-hold") {
      res.status(409).json({
        error: {
          code: "ACTIVE_STOCK_HOLD",
          message: `Cannot set stock for ${outcome.item.name} to ${physicalCount} ${outcome.item.unit} while ${outcome.activeHeld} ${outcome.item.unit} are held/unavailable from cancelled POS orders${outcome.activeCommitted > 0 ? ` and ${outcome.activeCommitted} ${outcome.item.unit} are reserved by an in-progress POS cash payment` : ""}.`,
        },
        activeCommitted: outcome.activeCommitted,
        activeHeld: outcome.activeHeld,
        item: outcome.item,
      });
      return;
    }
    if (outcome.kind === "pending-sale-action") {
      res.status(409).json({
        error: {
          code: "UNRESOLVED_SALE_ACTIONS",
          message: `Cannot run a physical count for ${outcome.item.name} while POS sale action ${outcome.saleActionReference} is pending. Finish or cancel the pending void/correction first.`,
        },
        saleActionReference: outcome.saleActionReference,
        item: outcome.item,
      });
      return;
    }

    res.status(outcome.kind === "replayed" ? 200 : 201).json({
      item: outcome.item,
      reconciliation: outcome.reconciliation,
      replayed: outcome.kind === "replayed",
    });
  });

  router.post("/items/:itemKey/receiving", requireRole("OWNER"), async (req, res) => {
    const rawKey = typeof req.params.itemKey === "string" ? req.params.itemKey.trim() : "";
    const target = resolveItemTarget(rawKey);
    if (!target) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid Inventory item.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid received quantity.");
      return;
    }

    const extraKeys = Object.keys(body).filter((key) => !RECEIVING_KEYS.has(key));
    if (extraKeys.length > 0) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected Stock Received fields provided.");
      return;
    }

    const quantity = parseQuantity(body.quantity, { allowDecimal: true, allowZero: false });
    if (quantity === null) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Enter a positive received quantity (up to 4 decimals, max 1,000,000).",
      );
      return;
    }

    const todayManila = formatManilaDate(req.now);
    let effectiveDate = todayManila;
    if (body.effectiveDate !== undefined && body.effectiveDate !== null) {
      const parsedDate = parseManilaDate(body.effectiveDate);
      if (!parsedDate) {
        sendError(res, 400, "VALIDATION_FAILED", "Enter a valid delivery date (YYYY-MM-DD).");
        return;
      }
      if (parsedDate > todayManila) {
        sendError(res, 400, "VALIDATION_FAILED", "Delivery date cannot be in the future.");
        return;
      }
      effectiveDate = parsedDate;
    }

    const noteResult = parseMovementNote(body.note, { required: false });
    if (!noteResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", "Delivery note must be 240 characters or fewer.");
      return;
    }

    if (
      typeof body.expectedRevision !== "number" ||
      !Number.isInteger(body.expectedRevision) ||
      body.expectedRevision < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid stock revision baseline.");
      return;
    }

    const expectedCurrentQuantity = parseStoredBalanceBaseline(body.expectedCurrentQuantity, {
      allowDecimal: true,
      allowNegative: true,
    });
    if (expectedCurrentQuantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }

    const requestKeyResult = parseRequestKey(body.requestKey);
    if (!requestKeyResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid Stock Received request key.");
      return;
    }

    const coverageParsed = parseCoverageRequestFields(body, { requireMode: false });
    if (!coverageParsed.ok) {
      sendError(res, 400, "VALIDATION_FAILED", coverageParsed.message);
      return;
    }

    const outcome = await repo.recordStockReceived(db, {
      target,
      quantity,
      effectiveDate,
      todayManila,
      note: noteResult.value,
      expectedRevision: body.expectedRevision,
      expectedCurrentQuantity,
      requestKey: requestKeyResult.value,
      actorUserId: req.auth!.user.id,
      recordedAt: req.now,
      coverage: coverageParsed.value,
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Inventory item not found.");
      return;
    }
    if (outcome.kind === "invalid-quantity") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        `Enter a positive whole number of ${outcome.unit}.`,
      );
      return;
    }
    if (outcome.kind === "invalid-baseline") {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }
    if (outcome.kind === "invalid-coverage") {
      sendError(res, 400, "VALIDATION_FAILED", outcome.message);
      return;
    }
    if (outcome.kind === "stale-review") {
      res.status(409).json({
        error: {
          code: "STALE_REVIEW_CONTEXT",
          message: `New physical-count history was recorded for ${outcome.item.name}. Review the updated counts before confirming coverage.`,
        },
        item: outcome.item,
        applicableReconciliations: outcome.applicableReconciliations,
        openingCountCoversDate: outcome.openingCountCoversDate,
      });
      return;
    }
    if (outcome.kind === "archived") {
      sendError(
        res,
        409,
        "PRODUCT_ARCHIVED",
        "Archived products cannot record Stock Received.",
      );
      return;
    }
    if (outcome.kind === "not-set") {
      sendError(
        res,
        409,
        "OPENING_STOCK_NOT_SET",
        "Record an opening stock count before recording Stock Received.",
      );
      return;
    }
    if (outcome.kind === "not-operating-supply") {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid Stock Received item category.");
      return;
    }
    if (outcome.kind === "cancelled") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CANCELLED",
        "This Stock Received submission was cancelled before saving. Review the current stock balance before submitting a new entry.",
      );
      return;
    }
    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This Stock Received request key was already used for a different entry.",
      );
      return;
    }
    if (outcome.kind === "stale") {
      res.status(409).json({
        error: {
          code: "STALE_STOCK_BALANCE",
          message: `Recorded stock for ${outcome.item.name} changed to ${outcome.item.currentQuantity} ${outcome.item.unit} before saving. Review the refreshed balance and confirm again.`,
        },
        item: outcome.item,
      });
      return;
    }

    res.status(outcome.kind === "replayed" ? 200 : 201).json({
      item: outcome.item,
      movement: outcome.movement,
      replayed: outcome.kind === "replayed",
    });
  });

  router.post("/items/:itemKey/usage", async (req, res) => {
    const rawKey = typeof req.params.itemKey === "string" ? req.params.itemKey.trim() : "";
    const target = resolveItemTarget(rawKey);
    if (!target) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid Inventory item.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a valid quantity used and purpose.");
      return;
    }

    const extraKeys = Object.keys(body).filter((key) => !USAGE_KEYS.has(key));
    if (extraKeys.length > 0) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected Stock Used fields provided.");
      return;
    }

    const quantity = parseQuantity(body.quantity, { allowDecimal: true, allowZero: false });
    if (quantity === null) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Enter a positive quantity used (up to 4 decimals, max 1,000,000).",
      );
      return;
    }

    const purposeResult = parseMovementNote(body.purpose, { required: true });
    if (!purposeResult.ok || !purposeResult.value) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Enter a short purpose note for Stock Used (1 to 240 characters).",
      );
      return;
    }

    const todayManila = formatManilaDate(req.now);
    let effectiveDate = todayManila;
    if (body.effectiveDate !== undefined && body.effectiveDate !== null) {
      const parsedDate = parseManilaDate(body.effectiveDate);
      if (!parsedDate) {
        sendError(res, 400, "VALIDATION_FAILED", "Enter a valid use date (YYYY-MM-DD).");
        return;
      }
      if (parsedDate > todayManila) {
        sendError(res, 400, "VALIDATION_FAILED", "Use date cannot be in the future.");
        return;
      }
      effectiveDate = parsedDate;
    }

    if (
      typeof body.expectedRevision !== "number" ||
      !Number.isInteger(body.expectedRevision) ||
      body.expectedRevision < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid stock revision baseline.");
      return;
    }

    const expectedCurrentQuantity = parseStoredBalanceBaseline(body.expectedCurrentQuantity, {
      allowDecimal: true,
      allowNegative: true,
    });
    if (expectedCurrentQuantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }

    const requestKeyResult = parseRequestKey(body.requestKey);
    if (!requestKeyResult.ok) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid Stock Used request key.");
      return;
    }

    const coverageParsed = parseCoverageRequestFields(body, { requireMode: false });
    if (!coverageParsed.ok) {
      sendError(res, 400, "VALIDATION_FAILED", coverageParsed.message);
      return;
    }

    if (req.auth!.user.role !== "OWNER" && coverageParsed.hasCoverageFields) {
      sendError(
        res,
        403,
        "FORBIDDEN",
        "Only the Owner can confirm count coverage for late Stock Used entries.",
      );
      return;
    }

    const outcome = await repo.recordStockUsed(db, {
      target,
      quantity,
      effectiveDate,
      todayManila,
      purpose: purposeResult.value,
      expectedRevision: body.expectedRevision,
      expectedCurrentQuantity,
      requestKey: requestKeyResult.value,
      actorUserId: req.auth!.user.id,
      actorRole: req.auth!.user.role,
      recordedAt: req.now,
      coverage: coverageParsed.value,
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Inventory item not found.");
      return;
    }
    if (outcome.kind === "not-operating-supply") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Stock Used can only be recorded for operating supplies.",
      );
      return;
    }
    if (outcome.kind === "invalid-quantity") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        `Enter a positive whole number of ${outcome.unit}.`,
      );
      return;
    }
    if (outcome.kind === "invalid-baseline") {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }
    if (outcome.kind === "invalid-coverage") {
      sendError(res, 400, "VALIDATION_FAILED", outcome.message);
      return;
    }
    if (outcome.kind === "stale-review") {
      res.status(409).json({
        error: {
          code: "STALE_REVIEW_CONTEXT",
          message: `New physical-count history was recorded for ${outcome.item.name}. Review the updated counts before confirming coverage.`,
        },
        item: outcome.item,
        applicableReconciliations: outcome.applicableReconciliations,
        openingCountCoversDate: outcome.openingCountCoversDate,
      });
      return;
    }
    if (outcome.kind === "archived") {
      sendError(
        res,
        409,
        "PRODUCT_ARCHIVED",
        "Archived supplies cannot record Stock Used.",
      );
      return;
    }
    if (outcome.kind === "not-set") {
      sendError(
        res,
        409,
        "OPENING_STOCK_NOT_SET",
        "Record an opening stock count before recording Stock Used.",
      );
      return;
    }
    if (outcome.kind === "cancelled") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CANCELLED",
        "This Stock Used submission was cancelled before saving. Review the current stock balance before submitting a new entry.",
      );
      return;
    }
    if (outcome.kind === "key-conflict") {
      sendError(
        res,
        409,
        "REQUEST_KEY_CONFLICT",
        "This Stock Used request key was already used for a different entry.",
      );
      return;
    }
    if (outcome.kind === "stale") {
      res.status(409).json({
        error: {
          code: "STALE_STOCK_BALANCE",
          message: `Recorded stock for ${outcome.item.name} changed to ${outcome.item.currentQuantity} ${outcome.item.unit} before saving. Review the refreshed balance and confirm again.`,
        },
        item: outcome.item,
      });
      return;
    }

    res.status(outcome.kind === "replayed" ? 200 : 201).json({
      item: outcome.item,
      movement: outcome.movement,
      replayed: outcome.kind === "replayed",
    });
  });

  // Task 3 (INV-010..043): Owner-only correction, cancellation, receipt-item switch, metadata fix, and pending correction resolution.

  router.get("/pending-corrections", requireRole("OWNER"), async (_req, res) => {
    const corrections = await repo.listPendingCorrectionReviews(db);
    res.json({ corrections });
  });

  router.post("/movements/:movementId/correct-quantity", requireRole("OWNER"), async (req, res) => {
    const movementId = typeof req.params.movementId === "string" ? req.params.movementId.trim() : "";
    if (!isUuid(movementId)) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid stock entry.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid quantity correction details.");
      return;
    }
    if (Object.keys(body).some((k) => !CORRECT_QUANTITY_KEYS.has(k))) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected quantity correction fields provided.");
      return;
    }

    const newQuantity = parseQuantity(body.newQuantity, { allowDecimal: true, allowZero: false });
    if (newQuantity === null) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Enter a positive corrected quantity (up to 4 decimals, max 1,000,000).",
      );
      return;
    }

    const reason = parseReconciliationReason(body.reason);
    if (!reason) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Enter a factual reason for this correction (1 to 240 characters).",
      );
      return;
    }

    if (
      typeof body.expectedCorrectionVersion !== "number" ||
      !Number.isInteger(body.expectedCorrectionVersion) ||
      body.expectedCorrectionVersion < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid entry correction version.");
      return;
    }
    if (
      typeof body.expectedRevision !== "number" ||
      !Number.isInteger(body.expectedRevision) ||
      body.expectedRevision < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid stock revision baseline.");
      return;
    }
    const expectedCurrentQuantity = parseStoredBalanceBaseline(body.expectedCurrentQuantity, {
      allowDecimal: true,
      allowNegative: true,
    });
    if (expectedCurrentQuantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }

    const requestKeyResult = parseRequestKey(body.requestKey);
    if (!requestKeyResult.ok || !requestKeyResult.value) {
      sendError(res, 400, "VALIDATION_FAILED", "Correction request key is required.");
      return;
    }

    const coverageParsed = parseCoverageRequestFields(body, {
      requireMode: false,
      requireSnapshot: true,
    });
    if (!coverageParsed.ok) {
      sendError(res, 400, "VALIDATION_FAILED", coverageParsed.message);
      return;
    }

    const outcome = await repo.correctMovementQuantity(db, {
      movementId,
      newQuantity,
      reason,
      expectedCorrectionVersion: body.expectedCorrectionVersion,
      expectedRevision: body.expectedRevision,
      expectedCurrentQuantity,
      requestKey: requestKeyResult.value,
      actorUserId: req.auth!.user.id,
      correctedAt: req.now,
      coverage: coverageParsed.value,
    });

    sendCorrectionOutcome(res, outcome);
  });

  router.post("/movements/:movementId/cancel", requireRole("OWNER"), async (req, res) => {
    const movementId = typeof req.params.movementId === "string" ? req.params.movementId.trim() : "";
    if (!isUuid(movementId)) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid stock entry.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid cancellation details.");
      return;
    }
    if (Object.keys(body).some((k) => !CANCEL_SAVED_MOVEMENT_KEYS.has(k))) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected movement cancellation fields provided.");
      return;
    }

    const reason = parseReconciliationReason(body.reason);
    if (!reason) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Enter a factual reason for cancelling this entry (1 to 240 characters).",
      );
      return;
    }

    if (
      typeof body.expectedCorrectionVersion !== "number" ||
      !Number.isInteger(body.expectedCorrectionVersion) ||
      body.expectedCorrectionVersion < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid entry correction version.");
      return;
    }
    if (
      typeof body.expectedRevision !== "number" ||
      !Number.isInteger(body.expectedRevision) ||
      body.expectedRevision < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid stock revision baseline.");
      return;
    }
    const expectedCurrentQuantity = parseStoredBalanceBaseline(body.expectedCurrentQuantity, {
      allowDecimal: true,
      allowNegative: true,
    });
    if (expectedCurrentQuantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }

    const requestKeyResult = parseRequestKey(body.requestKey);
    if (!requestKeyResult.ok || !requestKeyResult.value) {
      sendError(res, 400, "VALIDATION_FAILED", "Cancellation request key is required.");
      return;
    }

    const coverageParsed = parseCoverageRequestFields(body, {
      requireMode: false,
      requireSnapshot: true,
    });
    if (!coverageParsed.ok) {
      sendError(res, 400, "VALIDATION_FAILED", coverageParsed.message);
      return;
    }

    const outcome = await repo.cancelSavedMovement(db, {
      movementId,
      reason,
      expectedCorrectionVersion: body.expectedCorrectionVersion,
      expectedRevision: body.expectedRevision,
      expectedCurrentQuantity,
      requestKey: requestKeyResult.value,
      actorUserId: req.auth!.user.id,
      cancelledAt: req.now,
      coverage: coverageParsed.value,
    });

    sendCorrectionOutcome(res, outcome);
  });

  router.post("/movements/:movementId/correct-item", requireRole("OWNER"), async (req, res) => {
    const movementId = typeof req.params.movementId === "string" ? req.params.movementId.trim() : "";
    if (!isUuid(movementId)) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid stock receipt entry.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid receipt item correction details.");
      return;
    }
    if (Object.keys(body).some((k) => !CORRECT_ITEM_KEYS.has(k))) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected receipt item correction fields provided.");
      return;
    }

    const newItemKey = typeof body.newItemKey === "string" ? body.newItemKey.trim() : "";
    const newItemTarget = resolveItemTarget(newItemKey);
    if (!newItemTarget) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid destination Inventory item.");
      return;
    }

    const reason = parseReconciliationReason(body.reason);
    if (!reason) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Enter a factual reason for switching the receipt item (1 to 240 characters).",
      );
      return;
    }

    if (
      typeof body.expectedCorrectionVersion !== "number" ||
      !Number.isInteger(body.expectedCorrectionVersion) ||
      body.expectedCorrectionVersion < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid entry correction version.");
      return;
    }
    if (
      typeof body.expectedPrimaryRevision !== "number" ||
      !Number.isInteger(body.expectedPrimaryRevision) ||
      body.expectedPrimaryRevision < 0 ||
      typeof body.expectedSecondaryRevision !== "number" ||
      !Number.isInteger(body.expectedSecondaryRevision) ||
      body.expectedSecondaryRevision < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid stock revision baseline.");
      return;
    }

    const expectedPrimaryQuantity = parseStoredBalanceBaseline(body.expectedPrimaryQuantity, {
      allowDecimal: true,
      allowNegative: true,
    });
    const expectedSecondaryQuantity = parseStoredBalanceBaseline(body.expectedSecondaryQuantity, {
      allowDecimal: true,
      allowNegative: true,
    });
    if (expectedPrimaryQuantity === null || expectedSecondaryQuantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }

    const requestKeyResult = parseRequestKey(body.requestKey);
    if (!requestKeyResult.ok || !requestKeyResult.value) {
      sendError(res, 400, "VALIDATION_FAILED", "Receipt correction request key is required.");
      return;
    }

    let primaryCoverage: LateCoverageSelectionInput = {};
    let secondaryCoverage: LateCoverageSelectionInput = {};
    let differentUnitReconciliation:
      | { primarySupportingReconciliationId: string | null; secondarySupportingReconciliationId: string | null }
      | undefined = undefined;

    if (body.differentUnitReconciliation !== undefined && body.differentUnitReconciliation !== null) {
      if (
        typeof body.differentUnitReconciliation !== "object" ||
        Array.isArray(body.differentUnitReconciliation)
      ) {
        sendError(res, 400, "VALIDATION_FAILED", "Invalid supporting reconciliation selection.");
        return;
      }
      const dur = body.differentUnitReconciliation as Record<string, unknown>;
      const pRec =
        typeof dur.primarySupportingReconciliationId === "string" &&
        isUuid(dur.primarySupportingReconciliationId.trim())
          ? dur.primarySupportingReconciliationId.trim()
          : null;
      const sRec =
        typeof dur.secondarySupportingReconciliationId === "string" &&
        isUuid(dur.secondarySupportingReconciliationId.trim())
          ? dur.secondarySupportingReconciliationId.trim()
          : null;
      differentUnitReconciliation = {
        primarySupportingReconciliationId: pRec,
        secondarySupportingReconciliationId: sRec,
      };
    } else {
      const pCovParsed = parseNestedCoverageObject(body.primaryCoverage, {
        requireMode: false,
        requireSnapshot: true,
      });
      if (!pCovParsed.ok) {
        sendError(res, 400, "VALIDATION_FAILED", pCovParsed.message);
        return;
      }
      const sCovParsed = parseNestedCoverageObject(body.secondaryCoverage, {
        requireMode: false,
        requireSnapshot: true,
      });
      if (!sCovParsed.ok) {
        sendError(res, 400, "VALIDATION_FAILED", sCovParsed.message);
        return;
      }
      primaryCoverage = pCovParsed.value;
      secondaryCoverage = sCovParsed.value;
    }

    const outcome = await repo.correctReceiptItem(db, {
      movementId,
      newItemTarget,
      reason,
      expectedCorrectionVersion: body.expectedCorrectionVersion,
      expectedPrimaryRevision: body.expectedPrimaryRevision,
      expectedPrimaryQuantity,
      expectedSecondaryRevision: body.expectedSecondaryRevision,
      expectedSecondaryQuantity,
      requestKey: requestKeyResult.value,
      actorUserId: req.auth!.user.id,
      correctedAt: req.now,
      primaryCoverage,
      secondaryCoverage,
      differentUnitReconciliation,
    });

    sendCorrectionOutcome(res, outcome);
  });

  router.post("/movements/:movementId/correct-metadata", requireRole("OWNER"), async (req, res) => {
    const movementId = typeof req.params.movementId === "string" ? req.params.movementId.trim() : "";
    if (!isUuid(movementId)) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid stock entry.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid date or note correction details.");
      return;
    }
    if (Object.keys(body).some((k) => !CORRECT_METADATA_KEYS.has(k))) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected date/note correction fields provided.");
      return;
    }

    const todayManila = formatManilaDate(req.now);
    const effectiveDateProvided = body.effectiveDate !== undefined;
    let newEffectiveDate: string | null = null;
    if (effectiveDateProvided) {
      if (body.effectiveDate === null || body.effectiveDate === "") {
        sendError(res, 400, "VALIDATION_FAILED", "Enter a valid actual date (YYYY-MM-DD).");
        return;
      }
      const parsedDate = parseManilaDate(body.effectiveDate);
      if (!parsedDate) {
        sendError(res, 400, "VALIDATION_FAILED", "Enter a valid actual date (YYYY-MM-DD).");
        return;
      }
      if (parsedDate > todayManila) {
        sendError(res, 400, "VALIDATION_FAILED", "Actual date cannot be in the future.");
        return;
      }
      newEffectiveDate = parsedDate;
    }

    const noteProvided = body.note !== undefined;
    let newNote: string | null = null;
    if (noteProvided) {
      const noteParsed = parseMovementNote(body.note, { required: false });
      if (!noteParsed.ok) {
        sendError(res, 400, "VALIDATION_FAILED", "Note / purpose must be 240 characters or fewer.");
        return;
      }
      newNote = noteParsed.value;
    }

    if (!effectiveDateProvided && !noteProvided) {
      sendError(res, 400, "VALIDATION_FAILED", "Provide a corrected date or note.");
      return;
    }

    const reason = parseReconciliationReason(body.reason);
    if (!reason) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Enter a factual reason for this correction (1 to 240 characters).",
      );
      return;
    }

    if (
      typeof body.expectedCorrectionVersion !== "number" ||
      !Number.isInteger(body.expectedCorrectionVersion) ||
      body.expectedCorrectionVersion < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid entry correction version.");
      return;
    }
    if (
      typeof body.expectedRevision !== "number" ||
      !Number.isInteger(body.expectedRevision) ||
      body.expectedRevision < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid stock revision baseline.");
      return;
    }
    const expectedCurrentQuantity = parseStoredBalanceBaseline(body.expectedCurrentQuantity, {
      allowDecimal: true,
      allowNegative: true,
    });
    if (expectedCurrentQuantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }

    const requestKeyResult = parseRequestKey(body.requestKey);
    if (!requestKeyResult.ok || !requestKeyResult.value) {
      sendError(res, 400, "VALIDATION_FAILED", "Correction request key is required.");
      return;
    }

    const coverageParsed = parseCoverageRequestFields(body, {
      requireMode: false,
      requireSnapshot: false,
    });
    if (!coverageParsed.ok) {
      sendError(res, 400, "VALIDATION_FAILED", coverageParsed.message);
      return;
    }

    const outcome = await repo.correctMovementMetadata(db, {
      movementId,
      effectiveDateProvided,
      newEffectiveDate,
      noteProvided,
      newNote,
      reason,
      expectedCorrectionVersion: body.expectedCorrectionVersion,
      expectedRevision: body.expectedRevision,
      expectedCurrentQuantity,
      requestKey: requestKeyResult.value,
      actorUserId: req.auth!.user.id,
      correctedAt: req.now,
      coverage: coverageParsed.hasCoverageFields ? coverageParsed.value : undefined,
    });

    sendCorrectionOutcome(res, outcome);
  });

  router.post("/movement-corrections/:correctionId/resolve", requireRole("OWNER"), async (req, res) => {
    const correctionId =
      typeof req.params.correctionId === "string" ? req.params.correctionId.trim() : "";
    if (!isUuid(correctionId)) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid pending correction.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter valid correction resolution details.");
      return;
    }
    if (Object.keys(body).some((k) => !RESOLVE_CORRECTION_KEYS.has(k))) {
      sendError(res, 400, "VALIDATION_FAILED", "Unexpected correction resolution fields provided.");
      return;
    }

    const rawPrimaryRevision =
      body.expectedPrimaryRevision !== undefined ? body.expectedPrimaryRevision : body.expectedRevision;
    const rawPrimaryQuantity =
      body.expectedPrimaryQuantity !== undefined
        ? body.expectedPrimaryQuantity
        : body.expectedCurrentQuantity;

    if (
      typeof rawPrimaryRevision !== "number" ||
      !Number.isInteger(rawPrimaryRevision) ||
      rawPrimaryRevision < 0
    ) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid stock revision baseline.");
      return;
    }
    const expectedPrimaryQuantity = parseStoredBalanceBaseline(rawPrimaryQuantity, {
      allowDecimal: true,
      allowNegative: true,
    });
    if (expectedPrimaryQuantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Invalid recorded stock baseline.");
      return;
    }

    let expectedSecondaryRevision: number | undefined = undefined;
    let expectedSecondaryQuantity: number | undefined = undefined;
    if (body.expectedSecondaryRevision !== undefined) {
      if (
        typeof body.expectedSecondaryRevision !== "number" ||
        !Number.isInteger(body.expectedSecondaryRevision) ||
        body.expectedSecondaryRevision < 0
      ) {
        sendError(res, 400, "VALIDATION_FAILED", "Invalid destination item revision baseline.");
        return;
      }
      expectedSecondaryRevision = body.expectedSecondaryRevision;
    }
    if (body.expectedSecondaryQuantity !== undefined) {
      const parsedSec = parseStoredBalanceBaseline(body.expectedSecondaryQuantity, {
        allowDecimal: true,
        allowNegative: true,
      });
      if (parsedSec === null) {
        sendError(res, 400, "VALIDATION_FAILED", "Invalid destination item stock baseline.");
        return;
      }
      expectedSecondaryQuantity = parsedSec;
    }

    const requestKeyResult = parseRequestKey(body.requestKey);
    if (!requestKeyResult.ok || !requestKeyResult.value) {
      sendError(res, 400, "VALIDATION_FAILED", "Review confirmation request key is required.");
      return;
    }

    let primaryCoverage: LateCoverageSelectionInput;
    if (body.primaryCoverage !== undefined) {
      const parsed = parseNestedCoverageObject(body.primaryCoverage, {
        requireMode: true,
        requireSnapshot: true,
      });
      if (!parsed.ok) {
        sendError(res, 400, "VALIDATION_FAILED", parsed.message);
        return;
      }
      primaryCoverage = parsed.value;
    } else {
      const parsed = parseCoverageRequestFields(body, {
        requireMode: true,
        requireSnapshot: true,
      });
      if (!parsed.ok) {
        sendError(res, 400, "VALIDATION_FAILED", parsed.message);
        return;
      }
      primaryCoverage = parsed.value;
    }

    let secondaryCoverage: LateCoverageSelectionInput | undefined = undefined;
    if (body.secondaryCoverage !== undefined && body.secondaryCoverage !== null) {
      const parsed = parseNestedCoverageObject(body.secondaryCoverage, {
        requireMode: true,
        requireSnapshot: true,
      });
      if (!parsed.ok) {
        sendError(res, 400, "VALIDATION_FAILED", parsed.message);
        return;
      }
      secondaryCoverage = parsed.value;
    }

    const outcome = await repo.resolvePendingMovementCorrection(db, {
      correctionId,
      expectedPrimaryRevision: rawPrimaryRevision,
      expectedPrimaryQuantity,
      expectedSecondaryRevision,
      expectedSecondaryQuantity,
      requestKey: requestKeyResult.value,
      reviewerUserId: req.auth!.user.id,
      reviewedAt: req.now,
      primaryCoverage,
      secondaryCoverage,
    });

    sendCorrectionOutcome(res, outcome);
  });

  return router;
}
