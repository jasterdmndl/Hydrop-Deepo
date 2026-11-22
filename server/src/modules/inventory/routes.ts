import { Router } from "express";
import type { Database } from "../../db/database.js";
import { sendError } from "../../shared/http.js";
import { requireRole } from "../auth/guards.js";
import { inventoryPermissions, parseContainerShape, parseOpeningQuantity } from "./inventory.js";
import { inventoryRepository as repo } from "./repository.js";

/**
 * Inventory HTTP endpoints, mounted at /api/inventory behind the shared
 * module-access guards. Both roles can view; only OWNER can initialize
 * Round and Slim opening stock once per shape (DEC-065, INV-005).
 */
export function inventoryRoutes(db: Database): Router {
  const router = Router();

  router.get("/access", (req, res) => {
    res.json(inventoryPermissions(req.auth!.user.role));
  });

  router.get("/items", async (req, res) => {
    const items = await repo.listContainerItems(db);
    res.json({
      permissions: inventoryPermissions(req.auth!.user.role),
      items,
    });
  });

  router.post("/items/:shape/opening-stock", requireRole("OWNER"), async (req, res) => {
    const shape = parseContainerShape(req.params.shape);
    if (!shape) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose Round or Slim container.");
      return;
    }

    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a whole number of containers (0 or more).");
      return;
    }

    const extraKeys = Object.keys(body).filter((key) => key !== "quantity");
    if (extraKeys.length > 0) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a whole number of containers (0 or more).");
      return;
    }

    const quantity = parseOpeningQuantity(body.quantity);
    if (quantity === null) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter a whole number of containers (0 or more).");
      return;
    }

    const outcome = await repo.recordOpeningStock(db, {
      shape,
      quantity,
      recordedByUserId: req.auth!.user.id,
      recordedAt: req.now,
    });

    if (outcome.kind === "not-found") {
      sendError(res, 404, "NOT_FOUND", "Container item not found.");
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

  return router;
}
