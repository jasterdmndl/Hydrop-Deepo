import { Router } from "express";
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
  parseContainerShape,
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
import { inventoryRepository as repo, type OpeningStockTarget } from "./repository.js";

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
]);
const USAGE_KEYS = new Set([
  "quantity",
  "purpose",
  "effectiveDate",
  "expectedRevision",
  "expectedCurrentQuantity",
  "requestKey",
]);
const CANCEL_MOVEMENT_KEYS = new Set(["itemKey", "movementType"]);

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
    const includeArchived = req.query.includeArchived === "true";
    const [items, posSections] = await Promise.all([
      repo.listItems(db, { includeArchived }),
      repo.listPosSections(db),
    ]);
    const pendingStockReviews = items.flatMap((item) => item.pendingStockReviews ?? []);
    res.json({
      permissions: inventoryPermissions(req.auth!.user.role),
      items,
      posSections,
      pendingStockReviews,
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

  router.get("/items/:itemKey/reconciliations", async (req, res) => {
    const rawKey = typeof req.params.itemKey === "string" ? req.params.itemKey.trim() : "";
    const target = resolveItemTarget(rawKey);
    if (!target) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid Inventory item.");
      return;
    }

    const result = await repo.listReconciliations(db, target);
    if (!result.found) {
      sendError(res, 404, "NOT_FOUND", "Inventory item not found.");
      return;
    }

    res.json({ reconciliations: result.reconciliations });
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
    if (outcome.kind === "late-date-not-enabled") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Late Stock Received entries require count-coverage review, which is not yet enabled.",
      );
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
      recordedAt: req.now,
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
    if (outcome.kind === "late-date-not-enabled") {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Late Stock Used entries require count-coverage review, which is not yet enabled.",
      );
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

  return router;
}
