import type { Database, Queryable } from "../../db/database.js";
import { type ContainerShape, formatManilaIso, type InventoryItemView } from "./inventory.js";

export interface InventoryItemDbRow {
  id: string;
  code: string;
  name: string;
  category: "CONTAINER";
  containerShape: ContainerShape;
  unit: string;
  currentQuantity: number | string | null;
  openingQuantity: number | string | null;
  openingUnit: string | null;
  recordedByUsername: string | null;
  recordedAt: Date | string | null;
}

interface LockedItemRow {
  id: string;
  code: string;
  name: string;
  unit: string;
  currentQuantity: number | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toOptionalInt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export function toInventoryItemView(row: InventoryItemDbRow): InventoryItemView {
  const hasOpening =
    row.openingQuantity !== null &&
    row.openingUnit !== null &&
    row.recordedByUsername !== null &&
    row.recordedAt !== null;

  const openingStock = hasOpening
    ? {
        quantity: Number(row.openingQuantity),
        unit: row.openingUnit!,
        recordedBy: row.recordedByUsername!,
        recordedAt: formatManilaIso(toDate(row.recordedAt!)),
      }
    : null;

  return {
    code: row.code,
    name: row.name,
    category: row.category,
    shape: row.containerShape,
    unit: row.unit,
    status: openingStock ? "INITIALIZED" : "NOT_SET",
    currentQuantity: openingStock ? toOptionalInt(row.currentQuantity) : null,
    openingStock,
  };
}

const ITEM_SELECT = `
  SELECT i.id,
         i.code,
         i.name,
         i.category,
         i.container_shape AS "containerShape",
         i.unit,
         i.current_quantity AS "currentQuantity",
         oc.quantity AS "openingQuantity",
         oc.unit AS "openingUnit",
         u.username AS "recordedByUsername",
         oc.recorded_at AS "recordedAt"
    FROM inventory_items i
    LEFT JOIN inventory_opening_counts oc ON oc.item_id = i.id
    LEFT JOIN app_users u ON u.id = oc.recorded_by_user_id`;

export type RecordOpeningStockResult =
  | { kind: "created"; item: InventoryItemView }
  | { kind: "already-set"; item: InventoryItemView }
  | { kind: "not-found" };

async function findContainerItemByShape(db: Queryable, shape: ContainerShape): Promise<InventoryItemView | undefined> {
  const { rows } = await db.query<InventoryItemDbRow>(
    `${ITEM_SELECT}
      WHERE i.category = 'CONTAINER' AND i.container_shape = $1`,
    [shape],
  );
  return rows[0] ? toInventoryItemView(rows[0]) : undefined;
}

/** PostgreSQL persistence adapter for Inventory container opening stock. */
export const inventoryRepository = {
  async listContainerItems(db: Queryable): Promise<InventoryItemView[]> {
    const { rows } = await db.query<InventoryItemDbRow>(
      `${ITEM_SELECT}
        WHERE i.category = 'CONTAINER'
        ORDER BY CASE i.container_shape WHEN 'ROUND' THEN 1 WHEN 'SLIM' THEN 2 ELSE 3 END, i.code ASC`,
    );
    return rows.map(toInventoryItemView);
  },

  async recordOpeningStock(
    db: Database,
    input: {
      shape: ContainerShape;
      quantity: number;
      recordedByUserId: string;
      recordedAt: Date;
    },
  ): Promise<RecordOpeningStockResult> {
    try {
      return await db.transaction(async (tx) => {
        const { rows: lockedRows } = await tx.query<LockedItemRow>(
          `SELECT id,
                  code,
                  name,
                  unit,
                  current_quantity AS "currentQuantity"
             FROM inventory_items
            WHERE category = 'CONTAINER' AND container_shape = $1
            FOR UPDATE`,
          [input.shape],
        );
        const locked = lockedRows[0];
        if (!locked) {
          return { kind: "not-found" as const };
        }

        const { rows: existingCounts } = await tx.query<{ id: string }>(
          `SELECT id FROM inventory_opening_counts WHERE item_id = $1`,
          [locked.id],
        );

        if (existingCounts.length > 0 || locked.currentQuantity !== null) {
          const current = await findContainerItemByShape(tx, input.shape);
          if (!current) return { kind: "not-found" as const };
          return { kind: "already-set" as const, item: current };
        }

        await tx.query(
          `INSERT INTO inventory_opening_counts
             (item_id, quantity, unit, recorded_by_user_id, recorded_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [locked.id, input.quantity, locked.unit, input.recordedByUserId, input.recordedAt],
        );

        await tx.query(
          `UPDATE inventory_items SET current_quantity = $1 WHERE id = $2`,
          [input.quantity, locked.id],
        );

        const created = await findContainerItemByShape(tx, input.shape);
        if (!created) {
          return { kind: "not-found" as const };
        }
        return { kind: "created" as const, item: created };
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "23505") {
        const current = await findContainerItemByShape(db, input.shape);
        if (current) {
          return { kind: "already-set", item: current };
        }
      }
      throw error;
    }
  },
};
