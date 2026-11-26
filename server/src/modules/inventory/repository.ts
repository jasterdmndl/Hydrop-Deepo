import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "../../db/database.js";
import {
  BUILT_IN_POS_SECTIONS,
  type ContainerShape,
  type FaucetReportingType,
  formatManilaIso,
  type InventoryCategory,
  type InventoryItemView,
  type InventoryStockHoldView,
  type PendingSaleActionStockReviewView,
  type PosSection,
  type PosSectionView,
  type StockReconciliationView,
} from "./inventory.js";

export interface InventoryItemDbRow {
  id: string;
  code: string;
  name: string;
  category: InventoryCategory;
  containerShape: ContainerShape | null;
  description: string | null;
  unit: string;
  unitPriceCentavos: number | string | null;
  showInPos: boolean;
  posSection: PosSection | null;
  lowStockLevel: number | string | null;
  faucetReportingType: FaucetReportingType | null;
  currentQuantity: number | string | null;
  activeCommitted: number | string;
  heldQty: number | string;
  heldReducingQty: number | string;
  stockRevision: number | string;
  archivedAt: Date | string | null;
  archivedByUsername: string | null;
  createdByUsername: string | null;
  createdAt: Date | string;
  openingQuantity: number | string | null;
  openingUnit: string | null;
  recordedByUsername: string | null;
  recordedAt: Date | string | null;
  latestRecId: string | null;
  latestRecBalanceBefore: number | string | null;
  latestRecPhysicalCount: number | string | null;
  latestRecQuantityDelta: number | string | null;
  latestRecBalanceAfter: number | string | null;
  latestRecUnit: string | null;
  latestRecReason: string | null;
  latestRecRecordedBy: string | null;
  latestRecRecordedAt: Date | string | null;
}

interface PosSectionDbRow {
  code: string;
  name: string;
  isBuiltIn: boolean;
  sortOrder: number | string;
  createdByUsername: string | null;
  createdAt: Date | string;
}

interface ReconciliationDbRow {
  id: string;
  itemId: string;
  requestKey: string | null;
  balanceBefore: number | string;
  physicalCount: number | string;
  quantityDelta: number | string;
  balanceAfter: number | string;
  unit: string;
  reason: string;
  recordedByUsername: string;
  recordedAt: Date | string;
}

interface LockedItemRow {
  id: string;
  code: string;
  name: string;
  category: InventoryCategory;
  containerShape: ContainerShape | null;
  unit: string;
  currentQuantity: number | string | null;
  stockRevision: number | string;
  archivedAt: Date | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toOptionalInt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function toPosSectionView(row: PosSectionDbRow): PosSectionView {
  return {
    code: row.code,
    name: row.name,
    isBuiltIn: Boolean(row.isBuiltIn),
    sortOrder: Number(row.sortOrder),
    createdBy: row.createdByUsername ?? null,
    createdAt: formatManilaIso(toDate(row.createdAt)),
  };
}

function toReconciliationView(row: ReconciliationDbRow): StockReconciliationView {
  return {
    id: row.id,
    itemId: row.itemId,
    balanceBefore: Number(row.balanceBefore),
    physicalCount: Number(row.physicalCount),
    quantityDelta: Number(row.quantityDelta),
    balanceAfter: Number(row.balanceAfter),
    unit: row.unit,
    reason: row.reason,
    recordedBy: row.recordedByUsername,
    recordedAt: formatManilaIso(toDate(row.recordedAt)),
  };
}

export function toInventoryItemView(
  row: InventoryItemDbRow,
  activeHolds: InventoryStockHoldView[] = [],
  pendingStockReviews: PendingSaleActionStockReviewView[] = [],
): InventoryItemView {
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

  const currentQuantity = openingStock ? toOptionalInt(row.currentQuantity) : null;
  const activeCommitted = Number(row.activeCommitted ?? 0);
  const heldQuantity = Number(row.heldQty ?? 0);
  const heldReducingQty = Number(row.heldReducingQty ?? 0);
  const availableQuantity =
    currentQuantity === null
      ? null
      : Math.max(0, currentQuantity - activeCommitted - heldReducingQty);

  const latestReconciliation: StockReconciliationView | null =
    row.latestRecId !== null &&
    row.latestRecBalanceBefore !== null &&
    row.latestRecPhysicalCount !== null &&
    row.latestRecQuantityDelta !== null &&
    row.latestRecBalanceAfter !== null &&
    row.latestRecUnit !== null &&
    row.latestRecReason !== null &&
    row.latestRecRecordedBy !== null &&
    row.latestRecRecordedAt !== null
      ? {
          id: row.latestRecId,
          itemId: row.id,
          balanceBefore: Number(row.latestRecBalanceBefore),
          physicalCount: Number(row.latestRecPhysicalCount),
          quantityDelta: Number(row.latestRecQuantityDelta),
          balanceAfter: Number(row.latestRecBalanceAfter),
          unit: row.latestRecUnit,
          reason: row.latestRecReason,
          recordedBy: row.latestRecRecordedBy,
          recordedAt: formatManilaIso(toDate(row.latestRecRecordedAt)),
        }
      : null;

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    shape: row.containerShape,
    description: row.description ?? null,
    unit: row.unit,
    unitPriceCentavos: toOptionalInt(row.unitPriceCentavos),
    showInPos: Boolean(row.showInPos),
    posSection: row.posSection ?? null,
    lowStockLevel: toOptionalInt(row.lowStockLevel),
    faucetReportingType: row.faucetReportingType ?? null,
    status: openingStock ? "INITIALIZED" : "NOT_SET",
    currentQuantity,
    heldQuantity,
    availableQuantity,
    activeHolds,
    pendingStockReviews,
    stockRevision: Number(row.stockRevision ?? 0),
    openingStock,
    latestReconciliation,
    archivedAt: row.archivedAt ? formatManilaIso(toDate(row.archivedAt)) : null,
    archivedBy: row.archivedByUsername ?? null,
    createdBy: row.createdByUsername ?? null,
    createdAt: formatManilaIso(toDate(row.createdAt)),
  };
}

const ITEM_SELECT = `
  SELECT i.id,
         i.code,
         i.name,
         i.category,
         i.container_shape AS "containerShape",
         i.description,
         i.unit,
         i.unit_price_centavos AS "unitPriceCentavos",
         i.show_in_pos AS "showInPos",
         i.pos_section AS "posSection",
         i.low_stock_level AS "lowStockLevel",
         i.faucet_reporting_type AS "faucetReportingType",
         i.current_quantity AS "currentQuantity",
         COALESCE(c.committed_qty, 0) AS "activeCommitted",
         COALESCE(h.held_qty, 0) AS "heldQty",
         COALESCE(h.held_reducing_qty, 0) AS "heldReducingQty",
         i.stock_revision AS "stockRevision",
         i.archived_at AS "archivedAt",
         archiver.username AS "archivedByUsername",
         creator.username AS "createdByUsername",
         i.created_at AS "createdAt",
         oc.quantity AS "openingQuantity",
         oc.unit AS "openingUnit",
         u.username AS "recordedByUsername",
         oc.recorded_at AS "recordedAt",
         rec.id AS "latestRecId",
         rec.balance_before AS "latestRecBalanceBefore",
         rec.physical_count AS "latestRecPhysicalCount",
         rec.quantity_delta AS "latestRecQuantityDelta",
         rec.balance_after AS "latestRecBalanceAfter",
         rec.unit AS "latestRecUnit",
         rec.reason AS "latestRecReason",
         rec.recorded_by_username AS "latestRecRecordedBy",
         rec.recorded_at AS "latestRecRecordedAt"
    FROM inventory_items i
    LEFT JOIN app_users creator ON creator.id = i.created_by_user_id
    LEFT JOIN app_users archiver ON archiver.id = i.archived_by_user_id
    LEFT JOIN inventory_opening_counts oc ON oc.item_id = i.id
    LEFT JOIN app_users u ON u.id = oc.recorded_by_user_id
    LEFT JOIN inventory_pos_sections ps ON ps.code = i.pos_section
    LEFT JOIN (
      SELECT item_id, SUM(quantity)::integer AS committed_qty
        FROM (
          SELECT item_id, quantity
            FROM pos_checkout_stock_commitments
           WHERE status = 'ACTIVE'
          UNION ALL
          SELECT item_id, quantity
            FROM pos_sale_action_stock_commitments
           WHERE status = 'ACTIVE'
        ) all_commitments
       GROUP BY item_id
    ) c ON c.item_id = i.id
    LEFT JOIN (
      SELECT item_id,
             SUM(quantity)::integer AS held_qty,
             SUM(CASE WHEN reduces_availability THEN quantity ELSE 0 END)::integer AS held_reducing_qty
        FROM inventory_stock_holds
       WHERE status = 'ACTIVE'
       GROUP BY item_id
    ) h ON h.item_id = i.id
    LEFT JOIN (
      SELECT DISTINCT ON (r.item_id)
             r.item_id,
             r.id,
             r.balance_before,
             r.physical_count,
             r.quantity_delta,
             r.balance_after,
             r.unit,
             r.reason,
             ru.username AS recorded_by_username,
             r.recorded_at
        FROM inventory_reconciliations r
        JOIN app_users ru ON ru.id = r.actor_user_id
       ORDER BY r.item_id, r.recorded_at DESC, r.id DESC
    ) rec ON rec.item_id = i.id`;

const RECONCILIATION_SELECT = `
  SELECT r.id,
         r.item_id AS "itemId",
         r.request_key AS "requestKey",
         r.balance_before AS "balanceBefore",
         r.physical_count AS "physicalCount",
         r.quantity_delta AS "quantityDelta",
         r.balance_after AS "balanceAfter",
         r.unit,
         r.reason,
         u.username AS "recordedByUsername",
         r.recorded_at AS "recordedAt"
    FROM inventory_reconciliations r
    JOIN app_users u ON u.id = r.actor_user_id`;

export type OpeningStockTarget =
  | { kind: "shape"; shape: ContainerShape }
  | { kind: "id"; id: string };

export type RecordOpeningStockResult =
  | { kind: "created"; item: InventoryItemView }
  | { kind: "already-set"; item: InventoryItemView }
  | { kind: "archived" }
  | { kind: "not-found" };

export type CreateMerchandiseResult =
  | { kind: "created"; item: InventoryItemView }
  | { kind: "duplicate-name" };

export type UpdateMerchandiseResult =
  | { kind: "updated"; item: InventoryItemView }
  | { kind: "not-found" }
  | { kind: "archived" }
  | { kind: "duplicate-name" }
  | { kind: "invalid-pos-visibility" };

export type CreatePosSectionResult =
  | { kind: "created"; section: PosSectionView }
  | { kind: "duplicate-name" };

export type ArchiveMerchandiseResult =
  | { kind: "archived"; item: InventoryItemView }
  | { kind: "not-found" }
  | { kind: "cannot-archive-container" }
  | { kind: "already-archived" };

export type ReconcileStockResult =
  | { kind: "created"; item: InventoryItemView; reconciliation: StockReconciliationView }
  | { kind: "replayed"; item: InventoryItemView; reconciliation: StockReconciliationView }
  | { kind: "key-conflict" }
  | { kind: "not-found" }
  | { kind: "archived" }
  | { kind: "not-set" }
  | { kind: "stale"; item: InventoryItemView }
  | { kind: "active-commitment"; activeCommitted: number; item: InventoryItemView }
  | {
      kind: "active-hold";
      activeCommitted: number;
      activeHeld: number;
      item: InventoryItemView;
    }
  | {
      kind: "pending-sale-action";
      saleActionReference: string;
      item: InventoryItemView;
    };

async function loadActiveHoldsByItemIds(
  db: Queryable,
  itemIds: string[],
): Promise<Map<string, InventoryStockHoldView[]>> {
  const byItem = new Map<string, InventoryStockHoldView[]>();
  if (itemIds.length === 0) return byItem;

  const { rows } = await db.query<{
    id: string;
    itemId: string;
    quantity: number | string;
    unit: string;
    reason: string;
    sourceKind: "CHECKOUT_REFUND" | "CHECKOUT_CANCEL" | "SALE_ACTION";
    reducesAvailability: boolean;
    posReference: string;
    recordedBy: string;
    recordedAt: Date | string;
  }>(
    `SELECT h.id,
            h.item_id AS "itemId",
            h.quantity,
            h.unit,
            h.reason,
            h.source_kind AS "sourceKind",
            h.reduces_availability AS "reducesAvailability",
            h.pos_reference AS "posReference",
            u.username AS "recordedBy",
            h.recorded_at AS "recordedAt"
       FROM inventory_stock_holds h
       JOIN app_users u ON u.id = h.actor_user_id
      WHERE h.item_id = ANY($1::uuid[])
        AND h.status = 'ACTIVE'
      ORDER BY h.recorded_at DESC, h.id DESC`,
    [itemIds],
  );

  for (const row of rows) {
    const view: InventoryStockHoldView = {
      id: row.id,
      itemId: row.itemId,
      quantity: Number(row.quantity),
      unit: row.unit,
      reason: row.reason,
      sourceKind: row.sourceKind,
      reducesAvailability: Boolean(row.reducesAvailability),
      posReference: row.posReference,
      recordedBy: row.recordedBy,
      recordedAt: formatManilaIso(toDate(row.recordedAt)),
    };
    const bucket = byItem.get(row.itemId);
    if (bucket) bucket.push(view);
    else byItem.set(row.itemId, [view]);
  }
  return byItem;
}

async function loadPendingSaleActionReviewsByItemIds(
  db: Queryable,
  rows: ReadonlyArray<{ id: string; latestRecRecordedAt: Date | string | null }>,
): Promise<Map<string, PendingSaleActionStockReviewView[]>> {
  const byItem = new Map<string, PendingSaleActionStockReviewView[]>();
  if (rows.length === 0) return byItem;

  const latestRecByItem = new Map<string, number>();
  const targetItemIds = new Set<string>();
  for (const row of rows) {
    targetItemIds.add(row.id);
    if (row.latestRecRecordedAt) {
      latestRecByItem.set(row.id, toDate(row.latestRecRecordedAt).getTime());
    }
  }

  const { rows: actionRows } = await db.query<{
    saleActionReference: string;
    originalSaleReference: string;
    actionType: "VOID" | "CORRECT";
    completedAt: Date | string;
    merchandisePlan: {
      items?: Array<{
        productId?: string;
        productName?: string;
        unit?: string;
        unclearCoverageQuantity?: number;
        interveningReconciliationAt?: string | null;
      }>;
    } | null;
  }>(
    `SELECT r.reference AS "saleActionReference",
            r.original_sale_reference AS "originalSaleReference",
            r.action_type AS "actionType",
            r.completed_at AS "completedAt",
            r.merchandise_plan AS "merchandisePlan"
       FROM pos_sale_action_requests r
      WHERE r.status = 'COMPLETED'
        AND r.completed_at IS NOT NULL
        AND COALESCE((r.merchandise_plan->>'requiresInventoryReview')::boolean, false) = true
      ORDER BY r.completed_at DESC, r.reference DESC`,
  );

  for (const action of actionRows) {
    const completedAtDate = toDate(action.completedAt);
    const completedAtMs = completedAtDate.getTime();
    const completedAtIso = formatManilaIso(completedAtDate);
    for (const planItem of action.merchandisePlan?.items ?? []) {
      const itemId = planItem.productId;
      const unclearQty = Number(planItem.unclearCoverageQuantity ?? 0);
      if (!itemId || !targetItemIds.has(itemId) || unclearQty <= 0) {
        continue;
      }
      const latestRecMs = latestRecByItem.get(itemId);
      // Resolved once an INV-009 physical-count reconciliation occurs at or after the action completed.
      if (latestRecMs !== undefined && latestRecMs >= completedAtMs) {
        continue;
      }
      const review: PendingSaleActionStockReviewView = {
        saleActionReference: action.saleActionReference,
        originalSaleReference: action.originalSaleReference,
        actionType: action.actionType,
        itemId,
        itemName: planItem.productName ?? "Inventory item",
        unclearQuantity: unclearQty,
        unit: planItem.unit ?? "pcs",
        interveningReconciliationAt: planItem.interveningReconciliationAt ?? null,
        completedAt: completedAtIso,
      };
      const bucket = byItem.get(itemId);
      if (bucket) bucket.push(review);
      else byItem.set(itemId, [review]);
    }
  }
  return byItem;
}

async function findItemById(db: Queryable, id: string): Promise<InventoryItemView | undefined> {
  const { rows } = await db.query<InventoryItemDbRow>(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
  if (!rows[0]) return undefined;
  const [holdsByItem, reviewsByItem] = await Promise.all([
    loadActiveHoldsByItemIds(db, [rows[0].id]),
    loadPendingSaleActionReviewsByItemIds(db, [rows[0]]),
  ]);
  return toInventoryItemView(
    rows[0],
    holdsByItem.get(rows[0].id) ?? [],
    reviewsByItem.get(rows[0].id) ?? [],
  );
}

async function findItemByTarget(db: Queryable, target: OpeningStockTarget): Promise<InventoryItemView | undefined> {
  if (target.kind === "shape") {
    const { rows } = await db.query<InventoryItemDbRow>(
      `${ITEM_SELECT} WHERE i.category = 'CONTAINER' AND i.container_shape = $1`,
      [target.shape],
    );
    if (!rows[0]) return undefined;
    const [holdsByItem, reviewsByItem] = await Promise.all([
      loadActiveHoldsByItemIds(db, [rows[0].id]),
      loadPendingSaleActionReviewsByItemIds(db, [rows[0]]),
    ]);
    return toInventoryItemView(
      rows[0],
      holdsByItem.get(rows[0].id) ?? [],
      reviewsByItem.get(rows[0].id) ?? [],
    );
  }
  return findItemById(db, target.id);
}

/** PostgreSQL persistence adapter for Inventory containers, merchandise, sections, archiving, and INV-009 reconciliations. */
export const inventoryRepository = {
  async listPosSections(db: Queryable): Promise<PosSectionView[]> {
    const { rows } = await db.query<PosSectionDbRow>(
      `SELECT s.code,
              s.name,
              s.is_built_in AS "isBuiltIn",
              s.sort_order AS "sortOrder",
              u.username AS "createdByUsername",
              s.created_at AS "createdAt"
         FROM inventory_pos_sections s
         LEFT JOIN app_users u ON u.id = s.created_by_user_id
        ORDER BY s.sort_order ASC, LOWER(s.name) ASC, s.created_at ASC`,
    );
    return rows.map(toPosSectionView);
  },

  async findPosSectionByCode(db: Queryable, code: string): Promise<PosSectionView | undefined> {
    const { rows } = await db.query<PosSectionDbRow>(
      `SELECT s.code,
              s.name,
              s.is_built_in AS "isBuiltIn",
              s.sort_order AS "sortOrder",
              u.username AS "createdByUsername",
              s.created_at AS "createdAt"
         FROM inventory_pos_sections s
         LEFT JOIN app_users u ON u.id = s.created_by_user_id
        WHERE s.code = $1`,
      [code],
    );
    return rows[0] ? toPosSectionView(rows[0]) : undefined;
  },

  async createPosSection(
    db: Database,
    input: {
      name: string;
      createdByUserId: string;
      createdAt: Date;
    },
  ): Promise<CreatePosSectionResult> {
    const code = `CUSTOM_${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    try {
      await db.query(
        `INSERT INTO inventory_pos_sections (code, name, is_built_in, sort_order, created_by_user_id, created_at)
         VALUES ($1, $2, false, 100, $3, $4)`,
        [code, input.name, input.createdByUserId, input.createdAt],
      );
      const created = await this.findPosSectionByCode(db, code);
      return { kind: "created", section: created! };
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "23505") {
        return { kind: "duplicate-name" };
      }
      throw error;
    }
  },

  async listItems(
    db: Queryable,
    options: { includeArchived?: boolean } = {},
  ): Promise<InventoryItemView[]> {
    const whereClause = options.includeArchived ? "" : "WHERE i.archived_at IS NULL";
    const { rows } = await db.query<InventoryItemDbRow>(
      `${ITEM_SELECT}
        ${whereClause}
        ORDER BY CASE WHEN i.archived_at IS NULL THEN 1 ELSE 2 END,
                 CASE i.category WHEN 'CONTAINER' THEN 1 ELSE 2 END,
                 CASE i.container_shape WHEN 'ROUND' THEN 1 WHEN 'SLIM' THEN 2 ELSE 3 END,
                 COALESCE(ps.sort_order, 999) ASC,
                 LOWER(COALESCE(ps.name, '')) ASC,
                 LOWER(i.name) ASC,
                 i.created_at ASC`,
    );
    const [holdsByItem, reviewsByItem] = await Promise.all([
      loadActiveHoldsByItemIds(db, rows.map((r) => r.id)),
      loadPendingSaleActionReviewsByItemIds(db, rows),
    ]);
    return rows.map((row) =>
      toInventoryItemView(
        row,
        holdsByItem.get(row.id) ?? [],
        reviewsByItem.get(row.id) ?? [],
      ),
    );
  },

  async findMerchandiseById(db: Queryable, id: string): Promise<InventoryItemView | undefined> {
    const { rows } = await db.query<InventoryItemDbRow>(
      `${ITEM_SELECT} WHERE i.id = $1 AND i.category = 'MERCHANDISE'`,
      [id],
    );
    if (!rows[0]) return undefined;
    const [holdsByItem, reviewsByItem] = await Promise.all([
      loadActiveHoldsByItemIds(db, [rows[0].id]),
      loadPendingSaleActionReviewsByItemIds(db, [rows[0]]),
    ]);
    return toInventoryItemView(
      rows[0],
      holdsByItem.get(rows[0].id) ?? [],
      reviewsByItem.get(rows[0].id) ?? [],
    );
  },

  async createMerchandiseProduct(
    db: Database,
    input: {
      name: string;
      description: string | null;
      unit: string;
      unitPriceCentavos: number;
      showInPos: boolean;
      posSection: PosSection | null;
      lowStockLevel: number | null;
      faucetReportingType: FaucetReportingType | null;
      createdByUserId: string;
      createdAt: Date;
    },
  ): Promise<CreateMerchandiseResult> {
    const code = `MERCH-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO inventory_items (
           code, name, category, container_shape, description, unit,
           unit_price_centavos, show_in_pos, pos_section, low_stock_level,
           faucet_reporting_type, current_quantity, created_by_user_id, created_at
         )
         VALUES ($1, $2, 'MERCHANDISE', NULL, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11)
         RETURNING id`,
        [
          code,
          input.name,
          input.description,
          input.unit,
          input.unitPriceCentavos,
          input.showInPos,
          input.posSection,
          input.lowStockLevel,
          input.faucetReportingType,
          input.createdByUserId,
          input.createdAt,
        ],
      );
      const created = await findItemById(db, rows[0]!.id);
      return { kind: "created", item: created! };
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "23505") {
        return { kind: "duplicate-name" };
      }
      throw error;
    }
  },

  async updateMerchandiseProduct(
    db: Database,
    input: {
      id: string;
      name?: string;
      description?: string | null;
      unitPriceCentavos?: number;
      showInPos?: boolean;
      posSection?: PosSection | null;
      lowStockLevel?: number | null;
      faucetReportingType?: FaucetReportingType | null;
    },
  ): Promise<UpdateMerchandiseResult> {
    try {
      return await db.transaction(async (tx) => {
        const { rows: lockedRows } = await tx.query<{
          id: string;
          category: InventoryCategory;
          name: string;
          description: string | null;
          unitPriceCentavos: number | string | null;
          showInPos: boolean;
          posSection: PosSection | null;
          lowStockLevel: number | string | null;
          faucetReportingType: FaucetReportingType | null;
          archivedAt: Date | string | null;
        }>(
          `SELECT id,
                  category,
                  name,
                  description,
                  unit_price_centavos AS "unitPriceCentavos",
                  show_in_pos AS "showInPos",
                  pos_section AS "posSection",
                  low_stock_level AS "lowStockLevel",
                  faucet_reporting_type AS "faucetReportingType",
                  archived_at AS "archivedAt"
             FROM inventory_items
            WHERE id = $1 AND category = 'MERCHANDISE'
            FOR UPDATE`,
          [input.id],
        );
        const locked = lockedRows[0];
        if (!locked) {
          return { kind: "not-found" as const };
        }
        if (locked.archivedAt !== null) {
          return { kind: "archived" as const };
        }

        const nextName = input.name !== undefined ? input.name : locked.name;
        const nextDescription =
          input.description !== undefined ? input.description : locked.description;
        const nextPrice =
          input.unitPriceCentavos !== undefined
            ? input.unitPriceCentavos
            : toOptionalInt(locked.unitPriceCentavos);
        const nextShowInPos =
          input.showInPos !== undefined ? input.showInPos : Boolean(locked.showInPos);
        const nextPosSection =
          input.posSection !== undefined ? input.posSection : locked.posSection;
        const nextLowStockLevel =
          input.lowStockLevel !== undefined
            ? input.lowStockLevel
            : toOptionalInt(locked.lowStockLevel);
        const nextFaucetReportingType =
          input.faucetReportingType !== undefined
            ? input.faucetReportingType
            : locked.faucetReportingType;

        if (nextShowInPos && (!nextPosSection || nextPrice === null || nextPrice <= 0)) {
          return { kind: "invalid-pos-visibility" as const };
        }

        await tx.query(
          `UPDATE inventory_items
              SET name = $2,
                  description = $3,
                  unit_price_centavos = $4,
                  show_in_pos = $5,
                  pos_section = $6,
                  low_stock_level = $7,
                  faucet_reporting_type = $8
            WHERE id = $1`,
          [
            input.id,
            nextName,
            nextDescription,
            nextPrice,
            nextShowInPos,
            nextPosSection,
            nextLowStockLevel,
            nextFaucetReportingType,
          ],
        );
        const updated = await findItemById(tx, input.id);
        return updated ? { kind: "updated" as const, item: updated } : { kind: "not-found" as const };
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "23505") {
        return { kind: "duplicate-name" };
      }
      throw error;
    }
  },

  async updateContainerSettings(
    db: Database,
    input: {
      shape: ContainerShape;
      showInPos?: boolean;
      lowStockLevel?: number | null;
    },
  ): Promise<InventoryItemView | undefined> {
    return db.transaction(async (tx) => {
      const { rows: lockedRows } = await tx.query<{
        id: string;
        showInPos: boolean;
        posSection: PosSection | null;
        lowStockLevel: number | string | null;
      }>(
        `SELECT id,
                show_in_pos AS "showInPos",
                pos_section AS "posSection",
                low_stock_level AS "lowStockLevel"
           FROM inventory_items
          WHERE category = 'CONTAINER'
            AND container_shape = $1
            AND archived_at IS NULL
          FOR UPDATE`,
        [input.shape],
      );
      const locked = lockedRows[0];
      if (!locked) return undefined;

      const nextShowInPos =
        input.showInPos !== undefined ? input.showInPos : Boolean(locked.showInPos);
      const nextPosSection = nextShowInPos
        ? BUILT_IN_POS_SECTIONS.CONTAINERS
        : locked.posSection;
      const nextLowStockLevel =
        input.lowStockLevel !== undefined
          ? input.lowStockLevel
          : toOptionalInt(locked.lowStockLevel);

      await tx.query(
        `UPDATE inventory_items
            SET show_in_pos = $2,
                pos_section = $3,
                low_stock_level = $4
          WHERE id = $1`,
        [locked.id, nextShowInPos, nextPosSection, nextLowStockLevel],
      );
      return findItemById(tx, locked.id);
    });
  },

  async archiveMerchandiseProduct(
    db: Database,
    input: {
      id: string;
      archivedByUserId: string;
      archivedAt: Date;
    },
  ): Promise<ArchiveMerchandiseResult> {
    return db.transaction(async (tx) => {
      const { rows: lockedRows } = await tx.query<{
        id: string;
        category: InventoryCategory;
        archivedAt: Date | string | null;
      }>(
        `SELECT id, category, archived_at AS "archivedAt"
           FROM inventory_items
          WHERE id = $1
          FOR UPDATE`,
        [input.id],
      );
      const locked = lockedRows[0];
      if (!locked) {
        return { kind: "not-found" as const };
      }
      if (locked.category !== "MERCHANDISE") {
        return { kind: "cannot-archive-container" as const };
      }
      if (locked.archivedAt !== null) {
        return { kind: "already-archived" as const };
      }

      await tx.query(
        `UPDATE inventory_items
            SET archived_at = $2,
                archived_by_user_id = $3,
                show_in_pos = false
          WHERE id = $1`,
        [locked.id, input.archivedAt, input.archivedByUserId],
      );
      const updated = await findItemById(tx, locked.id);
      return updated ? { kind: "archived" as const, item: updated } : { kind: "not-found" as const };
    });
  },

  async recordOpeningStock(
    db: Database,
    input: {
      target: OpeningStockTarget;
      quantity: number;
      recordedByUserId: string;
      recordedAt: Date;
    },
  ): Promise<RecordOpeningStockResult> {
    try {
      return await db.transaction(async (tx) => {
        const whereSql =
          input.target.kind === "shape"
            ? `category = 'CONTAINER' AND container_shape = $1`
            : `id = $1`;
        const whereParam = input.target.kind === "shape" ? input.target.shape : input.target.id;

        const { rows: lockedRows } = await tx.query<LockedItemRow>(
          `SELECT id,
                  code,
                  name,
                  category,
                  container_shape AS "containerShape",
                  unit,
                  current_quantity AS "currentQuantity",
                  stock_revision AS "stockRevision",
                  archived_at AS "archivedAt"
             FROM inventory_items
            WHERE ${whereSql}
            FOR UPDATE`,
          [whereParam],
        );
        const locked = lockedRows[0];
        if (!locked) {
          return { kind: "not-found" as const };
        }
        if (locked.archivedAt !== null) {
          return { kind: "archived" as const };
        }

        const { rows: existingCounts } = await tx.query<{ id: string }>(
          `SELECT id FROM inventory_opening_counts WHERE item_id = $1`,
          [locked.id],
        );

        if (existingCounts.length > 0 || locked.currentQuantity !== null) {
          const current = await findItemById(tx, locked.id);
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
          `UPDATE inventory_items
              SET current_quantity = $1,
                  stock_revision = stock_revision + 1
            WHERE id = $2`,
          [input.quantity, locked.id],
        );

        const created = await findItemById(tx, locked.id);
        if (!created) {
          return { kind: "not-found" as const };
        }
        return { kind: "created" as const, item: created };
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "23505") {
        const current = await findItemByTarget(db, input.target);
        if (current) {
          return { kind: "already-set", item: current };
        }
      }
      throw error;
    }
  },

  async recordPhysicalCountReconciliation(
    db: Database,
    input: {
      target: OpeningStockTarget;
      physicalCount: number;
      reason: string;
      expectedRevision: number;
      expectedCurrentQuantity: number;
      requestKey: string | null;
      actorUserId: string;
      recordedAt: Date;
    },
  ): Promise<ReconcileStockResult> {
    return db.transaction(async (tx) => {
      const whereSql =
        input.target.kind === "shape"
          ? `category = 'CONTAINER' AND container_shape = $1`
          : `id = $1`;
      const whereParam = input.target.kind === "shape" ? input.target.shape : input.target.id;

      const { rows: lockedRows } = await tx.query<LockedItemRow>(
        `SELECT id,
                code,
                name,
                category,
                container_shape AS "containerShape",
                unit,
                current_quantity AS "currentQuantity",
                stock_revision AS "stockRevision",
                archived_at AS "archivedAt"
           FROM inventory_items
          WHERE ${whereSql}
          FOR UPDATE`,
        [whereParam],
      );
      const locked = lockedRows[0];
      if (!locked) {
        return { kind: "not-found" as const };
      }

      if (input.requestKey) {
        const { rows: existingRecRows } = await tx.query<ReconciliationDbRow>(
          `${RECONCILIATION_SELECT} WHERE r.request_key = $1`,
          [input.requestKey],
        );
        const existingRec = existingRecRows[0];
        if (existingRec) {
          if (
            existingRec.itemId !== locked.id ||
            Number(existingRec.physicalCount) !== input.physicalCount ||
            existingRec.reason !== input.reason
          ) {
            return { kind: "key-conflict" as const };
          }
          const currentItem = await findItemById(tx, locked.id);
          return {
            kind: "replayed" as const,
            item: currentItem!,
            reconciliation: toReconciliationView(existingRec),
          };
        }
      }

      if (locked.archivedAt !== null) {
        return { kind: "archived" as const };
      }

      const { rows: openingRows } = await tx.query<{ id: string }>(
        `SELECT id FROM inventory_opening_counts WHERE item_id = $1`,
        [locked.id],
      );

      if (openingRows.length === 0 || locked.currentQuantity === null) {
        return { kind: "not-set" as const };
      }

      const currentQuantity = Number(locked.currentQuantity);
      const stockRevision = Number(locked.stockRevision);
      if (
        stockRevision !== input.expectedRevision ||
        currentQuantity !== input.expectedCurrentQuantity
      ) {
        const latestItem = await findItemById(tx, locked.id);
        return { kind: "stale" as const, item: latestItem! };
      }

      const [{ rows: committedRows }, { rows: heldRows }] = await Promise.all([
        tx.query<{ activeCommitted: number | string }>(
          `SELECT COALESCE(SUM(quantity), 0)::integer AS "activeCommitted"
             FROM (
               SELECT quantity
                 FROM pos_checkout_stock_commitments
                WHERE item_id = $1
                  AND status = 'ACTIVE'
               UNION ALL
               SELECT quantity
                 FROM pos_sale_action_stock_commitments
                WHERE item_id = $1
                  AND status = 'ACTIVE'
             ) active_commitments`,
          [locked.id],
        ),
        tx.query<{ activeHeldReducing: number | string }>(
          `SELECT COALESCE(SUM(CASE WHEN reduces_availability THEN quantity ELSE 0 END), 0)::integer AS "activeHeldReducing"
             FROM inventory_stock_holds
            WHERE item_id = $1
              AND status = 'ACTIVE'`,
          [locked.id],
        ),
      ]);
      const activeCommitted = Number(committedRows[0]?.activeCommitted ?? 0);
      const activeHeldReducing = Number(heldRows[0]?.activeHeldReducing ?? 0);
      if (input.physicalCount < activeCommitted) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "active-commitment" as const,
          activeCommitted,
          item: latestItem!,
        };
      }
      if (input.physicalCount < activeCommitted + activeHeldReducing) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "active-hold" as const,
          activeCommitted,
          activeHeld: activeHeldReducing,
          item: latestItem!,
        };
      }

      const { rows: pendingActionRows } = await tx.query<{ reference: string }>(
        `SELECT reference
           FROM pos_sale_action_requests
          WHERE status = 'PENDING'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(merchandise_plan->'items', '[]'::jsonb)) elem
               WHERE elem->>'productId' = $1
            )
          ORDER BY created_at ASC
          LIMIT 1`,
        [locked.id],
      );
      if (pendingActionRows[0]) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "pending-sale-action" as const,
          saleActionReference: pendingActionRows[0].reference,
          item: latestItem!,
        };
      }

      const quantityDelta = input.physicalCount - currentQuantity;

      const { rows: insertedRec } = await tx.query<{ id: string }>(
        `INSERT INTO inventory_reconciliations (
           item_id, request_key, balance_before, physical_count, quantity_delta,
           balance_after, unit, reason, actor_user_id, recorded_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          locked.id,
          input.requestKey,
          currentQuantity,
          input.physicalCount,
          quantityDelta,
          input.physicalCount,
          locked.unit,
          input.reason,
          input.actorUserId,
          input.recordedAt,
        ],
      );
      const reconciliationId = insertedRec[0]!.id;

      if (quantityDelta !== 0) {
        await tx.query(
          `INSERT INTO inventory_stock_movements (
             item_id, movement_type, quantity_delta, balance_before, balance_after,
             unit, reconciliation_id, note, actor_user_id, recorded_at
           )
           VALUES ($1, 'PHYSICAL_COUNT_RECONCILIATION', $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            locked.id,
            quantityDelta,
            currentQuantity,
            input.physicalCount,
            locked.unit,
            reconciliationId,
            input.reason,
            input.actorUserId,
            input.recordedAt,
          ],
        );
      }

      await tx.query(
        `UPDATE inventory_items
            SET current_quantity = $2,
                stock_revision = stock_revision + 1
          WHERE id = $1`,
        [locked.id, input.physicalCount],
      );

      const [{ rows: recRows }, updatedItem] = await Promise.all([
        tx.query<ReconciliationDbRow>(`${RECONCILIATION_SELECT} WHERE r.id = $1`, [reconciliationId]),
        findItemById(tx, locked.id),
      ]);

      return {
        kind: "created" as const,
        item: updatedItem!,
        reconciliation: toReconciliationView(recRows[0]!),
      };
    });
  },

  async listReconciliations(
    db: Queryable,
    target: OpeningStockTarget,
  ): Promise<{ found: boolean; reconciliations: StockReconciliationView[] }> {
    const item = await findItemByTarget(db, target);
    if (!item) {
      return { found: false, reconciliations: [] };
    }
    const { rows } = await db.query<ReconciliationDbRow>(
      `${RECONCILIATION_SELECT}
        WHERE r.item_id = $1
        ORDER BY r.recorded_at DESC, r.id DESC`,
      [item.id],
    );
    return {
      found: true,
      reconciliations: rows.map(toReconciliationView),
    };
  },
};
