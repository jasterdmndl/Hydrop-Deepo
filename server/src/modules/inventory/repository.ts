import { randomUUID } from "node:crypto";
import type { Role } from "../auth/policy.js";
import type { Database, Queryable } from "../../db/database.js";
import {
  addQuantities,
  BUILT_IN_POS_SECTIONS,
  type ContainerShape,
  type CorrectionCoverageMode,
  type FaucetReportingType,
  formatManilaDate,
  formatManilaIso,
  type InventoryCategory,
  type InventoryItemHistoryView,
  type InventoryItemView,
  type InventoryStockHoldView,
  type MovementCorrectionKind,
  type MovementCorrectionStatus,
  type MovementCorrectionView,
  type MovementCoverageMode,
  type MovementEntryStatus,
  parseOpeningQuantity,
  parsePhysicalCount,
  parseQuantity,
  parseStoredBalanceBaseline,
  type PendingCorrectionReviewView,
  type PendingMovementReviewView,
  type PendingSaleActionStockReviewView,
  type PosSection,
  type PosSectionView,
  quantitiesEqual,
  type StockMovementType,
  type StockMovementView,
  type StockReconciliationView,
  subtractQuantities,
  type SupportingReconciliationSummary,
} from "./inventory.js";

export interface InventoryItemDbRow {
  id: string;
  code: string;
  name: string;
  category: InventoryCategory;
  containerShape: ContainerShape | null;
  description: string | null;
  unit: string;
  allowDecimalQuantity: boolean;
  needsReconciliation: boolean;
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

interface StockMovementDbRow {
  id: string;
  itemId: string;
  movementType: StockMovementType;
  entryStatus: MovementEntryStatus;
  enteredQuantity: number | string | null;
  quantityDelta: number | string;
  balanceBefore: number | string;
  balanceAfter: number | string;
  unit: string;
  effectiveDate: Date | string | null;
  note: string | null;
  coverageMode: MovementCoverageMode | null;
  coveredQuantity: number | string;
  supportingReconciliationId: string | null;
  coveredByOpeningCount: boolean;
  posReference: string | null;
  requestKey: string | null;
  reviewRequestKey: string | null;
  actorUserId: string;
  actorUsername: string;
  recordedAt: Date | string;
  reviewedByUsername: string | null;
  reviewedAt: Date | string | null;
  reviewNote: string | null;
  supportingRecPhysicalCount: number | string | null;
  supportingRecQuantityDelta: number | string | null;
  supportingRecUnit: string | null;
  supportingRecReason: string | null;
  supportingRecRecordedBy: string | null;
  supportingRecRecordedAt: Date | string | null;
  isCancelled: boolean;
  cancelledAt: Date | string | null;
  cancelledByUsername: string | null;
  currentQuantityValue: number | string | null;
  currentItemId: string | null;
  currentItemName: string | null;
  currentItemUnit: string | null;
  currentEffectiveDate: Date | string | null;
  currentNote: string | null;
  correctionVersion: number | string;
  sourceCorrectionId: string | null;
}

interface LockedItemRow {
  id: string;
  code: string;
  name: string;
  category: InventoryCategory;
  containerShape: ContainerShape | null;
  unit: string;
  allowDecimalQuantity: boolean;
  needsReconciliation: boolean;
  currentQuantity: number | string | null;
  stockRevision: number | string;
  archivedAt: Date | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toOptionalNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function toOptionalDateString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : formatManilaDate(new Date(value));
  }
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(
    value.getUTCDate(),
  ).padStart(2, "0")}`;
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

function toStockMovementView(row: StockMovementDbRow): StockMovementView {
  const delta = Number(row.quantityDelta);
  const appliedQuantity = Math.abs(delta);
  const enteredQuantity =
    row.enteredQuantity !== null && row.enteredQuantity !== undefined
      ? Number(row.enteredQuantity)
      : row.movementType === "STOCK_RECEIVED" || row.movementType === "STOCK_USED"
        ? appliedQuantity
        : null;
  const supportingReconciliation: SupportingReconciliationSummary | null =
    row.supportingReconciliationId &&
    row.supportingRecPhysicalCount !== null &&
    row.supportingRecQuantityDelta !== null &&
    row.supportingRecUnit !== null &&
    row.supportingRecReason !== null &&
    row.supportingRecRecordedBy !== null &&
    row.supportingRecRecordedAt !== null
      ? {
          id: row.supportingReconciliationId,
          physicalCount: Number(row.supportingRecPhysicalCount),
          quantityDelta: Number(row.supportingRecQuantityDelta),
          unit: row.supportingRecUnit,
          reason: row.supportingRecReason,
          recordedBy: row.supportingRecRecordedBy,
          recordedAt: formatManilaIso(toDate(row.supportingRecRecordedAt)),
        }
      : null;

  return {
    id: row.id,
    itemId: row.itemId,
    movementType: row.movementType,
    entryStatus: row.entryStatus,
    quantity: enteredQuantity ?? appliedQuantity,
    enteredQuantity,
    appliedQuantity,
    quantityDelta: delta,
    balanceBefore: Number(row.balanceBefore),
    balanceAfter: Number(row.balanceAfter),
    unit: row.unit,
    effectiveDate: toOptionalDateString(row.effectiveDate),
    note: row.note ?? null,
    coverageMode: row.coverageMode ?? null,
    coveredQuantity: Number(row.coveredQuantity ?? 0),
    supportingReconciliationId: row.supportingReconciliationId ?? null,
    supportingReconciliation,
    coveredByOpeningCount: Boolean(row.coveredByOpeningCount),
    posReference: row.posReference ?? null,
    recordedBy: row.actorUsername,
    recordedAt: formatManilaIso(toDate(row.recordedAt)),
    reviewedBy: row.reviewedByUsername ?? null,
    reviewedAt: row.reviewedAt ? formatManilaIso(toDate(row.reviewedAt)) : null,
    reviewNote: row.reviewNote ?? null,
    isCancelled: Boolean(row.isCancelled),
    cancelledAt: row.cancelledAt ? formatManilaIso(toDate(row.cancelledAt)) : null,
    cancelledBy: row.cancelledByUsername ?? null,
    currentQuantityValue:
      row.currentQuantityValue !== null && row.currentQuantityValue !== undefined
        ? Number(row.currentQuantityValue)
        : row.movementType === "STOCK_RECEIVED" || row.movementType === "STOCK_USED"
          ? Boolean(row.isCancelled)
            ? 0
            : row.currentItemId !== null && row.currentItemId !== row.itemId
              ? null
              : (enteredQuantity ?? appliedQuantity)
          : null,
    currentItemId: row.currentItemId ?? row.itemId,
    currentItemName: row.currentItemName ?? null,
    currentItemUnit: row.currentItemUnit ?? null,
    currentEffectiveDate:
      toOptionalDateString(row.currentEffectiveDate) ?? toOptionalDateString(row.effectiveDate),
    currentNote: row.currentNote !== undefined ? (row.currentNote ?? null) : (row.note ?? null),
    correctionVersion: Number(row.correctionVersion ?? 0),
    sourceCorrectionId: row.sourceCorrectionId ?? null,
  };
}

interface MovementCorrectionDbRow {
  id: string;
  movementId: string;
  correctionKind: MovementCorrectionKind;
  status: MovementCorrectionStatus;
  reason: string;
  requestKey: string;
  reviewRequestKey: string | null;
  previousQuantity: number | string | null;
  newQuantity: number | string | null;
  previousItemId: string | null;
  previousItemName: string | null;
  newItemId: string | null;
  newItemName: string | null;
  previousUnit: string | null;
  newUnit: string | null;
  previousEffectiveDate: Date | string | null;
  newEffectiveDate: Date | string | null;
  previousNote: string | null;
  newNote: string | null;
  primaryItemId: string;
  primaryItemName: string;
  primaryItemUnit: string;
  primaryRawDelta: number | string;
  primaryCoverageMode: CorrectionCoverageMode | null;
  primaryCoveredQuantity: number | string;
  primaryAppliedDelta: number | string;
  primarySupportingReconciliationId: string | null;
  primaryCoveredByOpeningCount: boolean;
  primaryRecPhysicalCount: number | string | null;
  primaryRecQuantityDelta: number | string | null;
  primaryRecUnit: string | null;
  primaryRecReason: string | null;
  primaryRecRecordedBy: string | null;
  primaryRecRecordedAt: Date | string | null;
  secondaryItemId: string | null;
  secondaryItemName: string | null;
  secondaryItemUnit: string | null;
  secondaryRawDelta: number | string;
  secondaryCoverageMode: CorrectionCoverageMode | null;
  secondaryCoveredQuantity: number | string;
  secondaryAppliedDelta: number | string;
  secondarySupportingReconciliationId: string | null;
  secondaryCoveredByOpeningCount: boolean;
  secondaryRecPhysicalCount: number | string | null;
  secondaryRecQuantityDelta: number | string | null;
  secondaryRecUnit: string | null;
  secondaryRecReason: string | null;
  secondaryRecRecordedBy: string | null;
  secondaryRecRecordedAt: Date | string | null;
  createdByUsername: string;
  createdAt: Date | string;
  reviewedByUsername: string | null;
  reviewedAt: Date | string | null;
  reviewNote: string | null;
}

const CORRECTION_SELECT = `
  SELECT mc.id,
         mc.movement_id AS "movementId",
         mc.correction_kind AS "correctionKind",
         mc.status,
         mc.reason,
         mc.request_key AS "requestKey",
         mc.review_request_key AS "reviewRequestKey",
         mc.previous_quantity AS "previousQuantity",
         mc.new_quantity AS "newQuantity",
         mc.previous_item_id AS "previousItemId",
         pri.name AS "previousItemName",
         mc.new_item_id AS "newItemId",
         nwi.name AS "newItemName",
         mc.previous_unit AS "previousUnit",
         mc.new_unit AS "newUnit",
         to_char(mc.previous_effective_date, 'YYYY-MM-DD') AS "previousEffectiveDate",
         to_char(mc.new_effective_date, 'YYYY-MM-DD') AS "newEffectiveDate",
         mc.previous_note AS "previousNote",
         mc.new_note AS "newNote",
         mc.primary_item_id AS "primaryItemId",
         pi.name AS "primaryItemName",
         pi.unit AS "primaryItemUnit",
         mc.primary_raw_delta AS "primaryRawDelta",
         mc.primary_coverage_mode AS "primaryCoverageMode",
         mc.primary_covered_quantity AS "primaryCoveredQuantity",
         mc.primary_applied_delta AS "primaryAppliedDelta",
         mc.primary_supporting_reconciliation_id AS "primarySupportingReconciliationId",
         mc.primary_covered_by_opening_count AS "primaryCoveredByOpeningCount",
         psr.physical_count AS "primaryRecPhysicalCount",
         psr.quantity_delta AS "primaryRecQuantityDelta",
         psr.unit AS "primaryRecUnit",
         psr.reason AS "primaryRecReason",
         psru.username AS "primaryRecRecordedBy",
         psr.recorded_at AS "primaryRecRecordedAt",
         mc.secondary_item_id AS "secondaryItemId",
         si.name AS "secondaryItemName",
         si.unit AS "secondaryItemUnit",
         mc.secondary_raw_delta AS "secondaryRawDelta",
         mc.secondary_coverage_mode AS "secondaryCoverageMode",
         mc.secondary_covered_quantity AS "secondaryCoveredQuantity",
         mc.secondary_applied_delta AS "secondaryAppliedDelta",
         mc.secondary_supporting_reconciliation_id AS "secondarySupportingReconciliationId",
         mc.secondary_covered_by_opening_count AS "secondaryCoveredByOpeningCount",
         ssr.physical_count AS "secondaryRecPhysicalCount",
         ssr.quantity_delta AS "secondaryRecQuantityDelta",
         ssr.unit AS "secondaryRecUnit",
         ssr.reason AS "secondaryRecReason",
         ssru.username AS "secondaryRecRecordedBy",
         ssr.recorded_at AS "secondaryRecRecordedAt",
         cu.username AS "createdByUsername",
         mc.created_at AS "createdAt",
         ru.username AS "reviewedByUsername",
         mc.reviewed_at AS "reviewedAt",
         mc.review_note AS "reviewNote"
    FROM inventory_movement_corrections mc
    JOIN inventory_items pi ON pi.id = mc.primary_item_id
    JOIN app_users cu ON cu.id = mc.created_by_user_id
    LEFT JOIN inventory_items pri ON pri.id = mc.previous_item_id
    LEFT JOIN inventory_items nwi ON nwi.id = mc.new_item_id
    LEFT JOIN inventory_items si ON si.id = mc.secondary_item_id
    LEFT JOIN app_users ru ON ru.id = mc.reviewed_by_user_id
    LEFT JOIN inventory_reconciliations psr ON psr.id = mc.primary_supporting_reconciliation_id
    LEFT JOIN app_users psru ON psru.id = psr.actor_user_id
    LEFT JOIN inventory_reconciliations ssr ON ssr.id = mc.secondary_supporting_reconciliation_id
    LEFT JOIN app_users ssru ON ssru.id = ssr.actor_user_id`;

function buildSupportingSummary(
  id: string | null,
  physicalCount: number | string | null,
  quantityDelta: number | string | null,
  unit: string | null,
  reason: string | null,
  recordedBy: string | null,
  recordedAt: Date | string | null,
): SupportingReconciliationSummary | null {
  if (
    !id ||
    physicalCount === null ||
    quantityDelta === null ||
    unit === null ||
    reason === null ||
    recordedBy === null ||
    recordedAt === null
  ) {
    return null;
  }
  return {
    id,
    physicalCount: Number(physicalCount),
    quantityDelta: Number(quantityDelta),
    unit,
    reason,
    recordedBy,
    recordedAt: formatManilaIso(toDate(recordedAt)),
  };
}

function toMovementCorrectionView(row: MovementCorrectionDbRow): MovementCorrectionView {
  return {
    id: row.id,
    movementId: row.movementId,
    correctionKind: row.correctionKind,
    status: row.status,
    reason: row.reason,
    previousQuantity: toOptionalNumber(row.previousQuantity),
    newQuantity: toOptionalNumber(row.newQuantity),
    previousItemId: row.previousItemId ?? null,
    previousItemName: row.previousItemName ?? null,
    newItemId: row.newItemId ?? null,
    newItemName: row.newItemName ?? null,
    previousUnit: row.previousUnit ?? null,
    newUnit: row.newUnit ?? null,
    previousEffectiveDate: toOptionalDateString(row.previousEffectiveDate),
    newEffectiveDate: toOptionalDateString(row.newEffectiveDate),
    previousNote: row.previousNote ?? null,
    newNote: row.newNote ?? null,
    primaryItemId: row.primaryItemId,
    primaryItemName: row.primaryItemName,
    primaryItemUnit: row.primaryItemUnit,
    primaryRawDelta: Number(row.primaryRawDelta),
    primaryCoverageMode: row.primaryCoverageMode ?? null,
    primaryCoveredQuantity: Number(row.primaryCoveredQuantity ?? 0),
    primaryAppliedDelta: Number(row.primaryAppliedDelta ?? 0),
    primarySupportingReconciliationId: row.primarySupportingReconciliationId ?? null,
    primarySupportingReconciliation: buildSupportingSummary(
      row.primarySupportingReconciliationId,
      row.primaryRecPhysicalCount,
      row.primaryRecQuantityDelta,
      row.primaryRecUnit,
      row.primaryRecReason,
      row.primaryRecRecordedBy,
      row.primaryRecRecordedAt,
    ),
    primaryCoveredByOpeningCount: Boolean(row.primaryCoveredByOpeningCount),
    secondaryItemId: row.secondaryItemId ?? null,
    secondaryItemName: row.secondaryItemName ?? null,
    secondaryItemUnit: row.secondaryItemUnit ?? null,
    secondaryRawDelta: Number(row.secondaryRawDelta ?? 0),
    secondaryCoverageMode: row.secondaryCoverageMode ?? null,
    secondaryCoveredQuantity: Number(row.secondaryCoveredQuantity ?? 0),
    secondaryAppliedDelta: Number(row.secondaryAppliedDelta ?? 0),
    secondarySupportingReconciliationId: row.secondarySupportingReconciliationId ?? null,
    secondarySupportingReconciliation: buildSupportingSummary(
      row.secondarySupportingReconciliationId,
      row.secondaryRecPhysicalCount,
      row.secondaryRecQuantityDelta,
      row.secondaryRecUnit,
      row.secondaryRecReason,
      row.secondaryRecRecordedBy,
      row.secondaryRecRecordedAt,
    ),
    secondaryCoveredByOpeningCount: Boolean(row.secondaryCoveredByOpeningCount),
    createdBy: row.createdByUsername,
    createdAt: formatManilaIso(toDate(row.createdAt)),
    reviewedBy: row.reviewedByUsername ?? null,
    reviewedAt: row.reviewedAt ? formatManilaIso(toDate(row.reviewedAt)) : null,
    reviewNote: row.reviewNote ?? null,
  };
}

async function loadCorrectionsByMovementIds(
  db: Queryable,
  movementIds: string[],
): Promise<Map<string, MovementCorrectionView[]>> {
  const byMovement = new Map<string, MovementCorrectionView[]>();
  if (movementIds.length === 0) return byMovement;

  const { rows } = await db.query<MovementCorrectionDbRow>(
    `${CORRECTION_SELECT}
      WHERE mc.movement_id = ANY($1::uuid[])
      ORDER BY mc.created_at ASC, mc.id ASC`,
    [movementIds],
  );
  for (const row of rows) {
    const view = toMovementCorrectionView(row);
    const bucket = byMovement.get(row.movementId);
    if (bucket) bucket.push(view);
    else byMovement.set(row.movementId, [view]);
  }
  return byMovement;
}

export function redactItemForEmployee(item: InventoryItemView): InventoryItemView {
  return {
    ...item,
    // Keep Round/Slim opening counts visible per DEC-065; redact Owner opening audit metadata on operating supplies.
    openingStock: item.category === "OPERATING_SUPPLY" ? null : item.openingStock,
    latestReconciliation: null,
    pendingStockReviews: [],
  };
}

export function redactMovementForEmployee(movement: StockMovementView): StockMovementView {
  return {
    ...movement,
    supportingReconciliationId: null,
    supportingReconciliation: null,
    reviewNote: null,
    cancelledBy: null,
    corrections: [],
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

  const currentQuantity = openingStock ? toOptionalNumber(row.currentQuantity) : null;
  const activeCommitted = Number(row.activeCommitted ?? 0);
  const heldQuantity = Number(row.heldQty ?? 0);
  const heldReducingQty = Number(row.heldReducingQty ?? 0);
  const availableQuantity =
    currentQuantity === null
      ? null
      : Math.max(0, subtractQuantities(currentQuantity, activeCommitted + heldReducingQty));

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
    allowDecimalQuantity: Boolean(row.allowDecimalQuantity),
    needsReconciliation: Boolean(row.needsReconciliation),
    unitPriceCentavos: toOptionalNumber(row.unitPriceCentavos),
    showInPos: Boolean(row.showInPos),
    posSection: row.posSection ?? null,
    lowStockLevel: toOptionalNumber(row.lowStockLevel),
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
         i.allow_decimal_quantity AS "allowDecimalQuantity",
         i.needs_reconciliation AS "needsReconciliation",
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

const STOCK_MOVEMENT_SELECT = `
  SELECT m.id,
         m.item_id AS "itemId",
         m.movement_type AS "movementType",
         m.entry_status AS "entryStatus",
         m.entered_quantity AS "enteredQuantity",
         m.quantity_delta AS "quantityDelta",
         m.balance_before AS "balanceBefore",
         m.balance_after AS "balanceAfter",
         m.unit,
         to_char(m.effective_date, 'YYYY-MM-DD') AS "effectiveDate",
         m.note,
         m.coverage_mode AS "coverageMode",
         m.covered_quantity AS "coveredQuantity",
         m.supporting_reconciliation_id AS "supportingReconciliationId",
         m.covered_by_opening_count AS "coveredByOpeningCount",
         m.pos_reference AS "posReference",
         m.request_key AS "requestKey",
         m.review_request_key AS "reviewRequestKey",
         m.actor_user_id AS "actorUserId",
         u.username AS "actorUsername",
         m.recorded_at AS "recordedAt",
         ru.username AS "reviewedByUsername",
         m.reviewed_at AS "reviewedAt",
         m.review_note AS "reviewNote",
         sr.physical_count AS "supportingRecPhysicalCount",
         sr.quantity_delta AS "supportingRecQuantityDelta",
         sr.unit AS "supportingRecUnit",
         sr.reason AS "supportingRecReason",
         sru.username AS "supportingRecRecordedBy",
         sr.recorded_at AS "supportingRecRecordedAt",
         m.is_cancelled AS "isCancelled",
         m.cancelled_at AS "cancelledAt",
         cu.username AS "cancelledByUsername",
         m.current_quantity_value AS "currentQuantityValue",
         m.current_item_id AS "currentItemId",
         ci.name AS "currentItemName",
         ci.unit AS "currentItemUnit",
         to_char(m.current_effective_date, 'YYYY-MM-DD') AS "currentEffectiveDate",
         m.current_note AS "currentNote",
         m.correction_version AS "correctionVersion",
         m.source_correction_id AS "sourceCorrectionId"
    FROM inventory_stock_movements m
    JOIN app_users u ON u.id = m.actor_user_id
    LEFT JOIN app_users ru ON ru.id = m.reviewed_by_user_id
    LEFT JOIN app_users cu ON cu.id = m.cancelled_by_user_id
    LEFT JOIN inventory_items ci ON ci.id = m.current_item_id
    LEFT JOIN inventory_reconciliations sr ON sr.id = m.supporting_reconciliation_id
    LEFT JOIN app_users sru ON sru.id = sr.actor_user_id`;

export type OpeningStockTarget =
  | { kind: "shape"; shape: ContainerShape }
  | { kind: "id"; id: string };

export type RecordOpeningStockResult =
  | { kind: "created"; item: InventoryItemView }
  | { kind: "already-set"; item: InventoryItemView }
  | { kind: "invalid-quantity"; allowDecimalQuantity: boolean; unit: string }
  | { kind: "archived" }
  | { kind: "not-found" };

export type CreateProductResult =
  | { kind: "created"; item: InventoryItemView }
  | { kind: "duplicate-name" };

export type UpdateProductResult =
  | { kind: "updated"; item: InventoryItemView }
  | { kind: "not-found" }
  | { kind: "archived" }
  | { kind: "duplicate-name" }
  | { kind: "invalid-pos-visibility" }
  | { kind: "invalid-supply-fields" }
  | { kind: "invalid-low-stock"; allowDecimalQuantity: boolean; unit: string };

export type CreatePosSectionResult =
  | { kind: "created"; section: PosSectionView }
  | { kind: "duplicate-name" };

export type ArchiveProductResult =
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
  | { kind: "invalid-quantity"; allowDecimalQuantity: boolean; unit: string }
  | { kind: "invalid-baseline"; allowDecimalQuantity: boolean; unit: string }
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

export interface LateCoverageSelectionInput {
  coverageMode?: MovementCoverageMode | null;
  coveredQuantity?: number | null;
  supportingReconciliationId?: string | null;
  coveredByOpeningCount?: boolean;
  reviewNote?: string | null;
  expectedLatestReconciliationId?: string | null;
  expectedOpeningCountCoversDate?: boolean;
}

export type RecordStockMovementResult =
  | { kind: "created"; item: InventoryItemView; movement: StockMovementView }
  | { kind: "replayed"; item: InventoryItemView; movement: StockMovementView }
  | { kind: "cancelled" }
  | { kind: "key-conflict" }
  | { kind: "invalid-coverage"; message: string }
  | {
      kind: "stale-review";
      item: InventoryItemView;
      applicableReconciliations: StockReconciliationView[];
      openingCountCoversDate: boolean;
    }
  | { kind: "not-found" }
  | { kind: "archived" }
  | { kind: "not-set" }
  | { kind: "not-operating-supply" }
  | { kind: "invalid-quantity"; allowDecimalQuantity: boolean; unit: string }
  | { kind: "invalid-baseline"; allowDecimalQuantity: boolean; unit: string }
  | { kind: "stale"; item: InventoryItemView };

export type ResolvePendingReviewResult =
  | { kind: "resolved"; item: InventoryItemView; movement: StockMovementView }
  | { kind: "replayed"; item: InventoryItemView; movement: StockMovementView }
  | { kind: "not-found" }
  | { kind: "already-resolved"; item: InventoryItemView; movement: StockMovementView }
  | { kind: "key-conflict" }
  | { kind: "invalid-coverage"; message: string }
  | { kind: "invalid-baseline"; allowDecimalQuantity: boolean; unit: string }
  | {
      kind: "stale-review";
      item: InventoryItemView;
      entry: StockMovementView;
      applicableReconciliations: StockReconciliationView[];
      openingCountCoversDate: boolean;
    }
  | {
      kind: "stale";
      item: InventoryItemView;
      entry: StockMovementView;
      applicableReconciliations: StockReconciliationView[];
      openingCountCoversDate: boolean;
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

async function loadApplicableCountsForDate(
  tx: Queryable,
  itemId: string,
  sinceDate: string,
): Promise<{
  applicableReconciliations: StockReconciliationView[];
  openingCountCoversDate: boolean;
}> {
  const [{ rows: recRows }, { rows: openRows }] = await Promise.all([
    tx.query<ReconciliationDbRow>(
      `${RECONCILIATION_SELECT}
        WHERE r.item_id = $1
          AND ((r.recorded_at AT TIME ZONE 'Asia/Manila')::date) >= $2::date
        ORDER BY r.recorded_at DESC, r.id DESC`,
      [itemId, sinceDate],
    ),
    tx.query<{ recordedAt: Date | string }>(
      `SELECT recorded_at AS "recordedAt" FROM inventory_opening_counts WHERE item_id = $1`,
      [itemId],
    ),
  ]);
  const applicableReconciliations = recRows.map(toReconciliationView);
  const openingCountCoversDate = Boolean(
    openRows[0] && formatManilaDate(toDate(openRows[0].recordedAt)) >= sinceDate,
  );
  return { applicableReconciliations, openingCountCoversDate };
}

type CoverageResolutionOutcome =
  | {
      ok: true;
      entryStatus: MovementEntryStatus;
      coverageMode: MovementCoverageMode;
      coveredQuantity: number;
      supportingReconciliationId: string | null;
      coveredByOpeningCount: boolean;
      deltaMagnitude: number;
      reviewed: boolean;
    }
  | { ok: false; kind: "invalid-coverage"; message: string }
  | { ok: false; kind: "stale-review" };

function evaluateOwnerCoverageSelection(params: {
  enteredQuantity: number;
  allowDecimal: boolean;
  applicableReconciliations: StockReconciliationView[];
  openingCountCoversDate: boolean;
  selection: LateCoverageSelectionInput;
  requireExplicitWhenCountsExist: boolean;
  requireSnapshot?: boolean;
}): CoverageResolutionOutcome {
  if (
    params.requireSnapshot &&
    (params.selection.expectedLatestReconciliationId === undefined ||
      params.selection.expectedOpeningCountCoversDate === undefined)
  ) {
    return {
      ok: false,
      kind: "invalid-coverage",
      message: "Missing count-review snapshot reference. Refresh the pending review and try again.",
    };
  }
  const latestRecId = params.applicableReconciliations[0]?.id ?? null;
  if (
    params.selection.expectedLatestReconciliationId !== undefined &&
    params.selection.expectedLatestReconciliationId !== latestRecId
  ) {
    return { ok: false, kind: "stale-review" };
  }
  if (
    params.selection.expectedOpeningCountCoversDate !== undefined &&
    params.selection.expectedOpeningCountCoversDate !== params.openingCountCoversDate
  ) {
    return { ok: false, kind: "stale-review" };
  }

  const hasApplicableCounts =
    params.applicableReconciliations.length > 0 || params.openingCountCoversDate;
  const mode =
    params.selection.coverageMode ??
    (params.requireExplicitWhenCountsExist && hasApplicableCounts ? null : "NONE");
  if (!mode) {
    return {
      ok: false,
      kind: "invalid-coverage",
      message:
        "Choose whether an intervening physical count covered this late entry, or mark coverage unclear.",
    };
  }

  const recId = params.selection.supportingReconciliationId ?? null;
  const byOpening = Boolean(params.selection.coveredByOpeningCount);
  if (recId && byOpening) {
    return {
      ok: false,
      kind: "invalid-coverage",
      message: "Choose either a supporting physical count or the opening count, not both.",
    };
  }

  if (mode === "UNCLEAR") {
    if (
      recId ||
      byOpening ||
      (params.selection.coveredQuantity !== undefined && params.selection.coveredQuantity !== null)
    ) {
      return {
        ok: false,
        kind: "invalid-coverage",
        message: "Unclear coverage cannot set a covered quantity or supporting count.",
      };
    }
    return {
      ok: true,
      entryStatus: "PENDING_REVIEW",
      coverageMode: "UNCLEAR",
      coveredQuantity: 0,
      supportingReconciliationId: null,
      coveredByOpeningCount: false,
      deltaMagnitude: 0,
      reviewed: false,
    };
  }

  if (mode === "NONE") {
    if (
      recId ||
      byOpening ||
      (params.selection.coveredQuantity !== undefined && params.selection.coveredQuantity !== null)
    ) {
      return {
        ok: false,
        kind: "invalid-coverage",
        message: "No-coverage confirmation cannot set a covered quantity or supporting count.",
      };
    }
    return {
      ok: true,
      entryStatus: "APPLIED",
      coverageMode: "NONE",
      coveredQuantity: 0,
      supportingReconciliationId: null,
      coveredByOpeningCount: false,
      deltaMagnitude: params.enteredQuantity,
      reviewed: true,
    };
  }

  if (recId) {
    if (!params.applicableReconciliations.some((r) => r.id === recId)) {
      return {
        ok: false,
        kind: "invalid-coverage",
        message: "Selected supporting physical count does not apply to this entry date.",
      };
    }
  } else if (byOpening) {
    if (!params.openingCountCoversDate) {
      return {
        ok: false,
        kind: "invalid-coverage",
        message: "The opening stock count was recorded before this entry date and cannot cover it.",
      };
    }
  } else {
    return {
      ok: false,
      kind: "invalid-coverage",
      message: "Select the supporting physical count or opening count that covered this entry.",
    };
  }

  if (mode === "FULL") {
    if (
      params.selection.coveredQuantity !== undefined &&
      params.selection.coveredQuantity !== null &&
      !quantitiesEqual(Number(params.selection.coveredQuantity), params.enteredQuantity)
    ) {
      return {
        ok: false,
        kind: "invalid-coverage",
        message: "Full coverage covers the entire entered quantity.",
      };
    }
    return {
      ok: true,
      entryStatus: "APPLIED",
      coverageMode: "FULL",
      coveredQuantity: params.enteredQuantity,
      supportingReconciliationId: recId,
      coveredByOpeningCount: byOpening,
      deltaMagnitude: 0,
      reviewed: true,
    };
  }

  const parsedCovered = parseQuantity(params.selection.coveredQuantity, {
    allowDecimal: params.allowDecimal,
    allowZero: false,
  });
  if (parsedCovered === null) {
    return {
      ok: false,
      kind: "invalid-coverage",
      message: "Enter a positive covered quantity in the item's unit.",
    };
  }
  const remaining = subtractQuantities(params.enteredQuantity, parsedCovered);
  if (remaining <= 0) {
    return {
      ok: false,
      kind: "invalid-coverage",
      message:
        "Covered quantity must be strictly less than the full entry quantity. Choose Full Coverage when the entire entry was covered.",
    };
  }

  return {
    ok: true,
    entryStatus: "APPLIED",
    coverageMode: "PARTIAL",
    coveredQuantity: parsedCovered,
    supportingReconciliationId: recId,
    coveredByOpeningCount: byOpening,
    deltaMagnitude: remaining,
    reviewed: true,
  };
}

function sameOptionalReplayCoverage(
  existing: StockMovementDbRow,
  selection: LateCoverageSelectionInput | undefined,
): boolean {
  if (!selection || existing.reviewRequestKey !== null) {
    return true;
  }
  if (selection.coverageMode && existing.coverageMode !== selection.coverageMode) {
    return false;
  }
  if (
    selection.coveredQuantity !== undefined &&
    selection.coveredQuantity !== null &&
    !quantitiesEqual(Number(existing.coveredQuantity ?? 0), Number(selection.coveredQuantity))
  ) {
    return false;
  }
  if (
    selection.supportingReconciliationId !== undefined &&
    (existing.supportingReconciliationId ?? null) !== (selection.supportingReconciliationId ?? null)
  ) {
    return false;
  }
  if (
    selection.coveredByOpeningCount !== undefined &&
    Boolean(existing.coveredByOpeningCount) !== Boolean(selection.coveredByOpeningCount)
  ) {
    return false;
  }
  return true;
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
                 CASE i.category WHEN 'CONTAINER' THEN 1 WHEN 'MERCHANDISE' THEN 2 ELSE 3 END,
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

  async findEditableProductById(db: Queryable, id: string): Promise<InventoryItemView | undefined> {
    const { rows } = await db.query<InventoryItemDbRow>(
      `${ITEM_SELECT} WHERE i.id = $1 AND i.category IN ('MERCHANDISE', 'OPERATING_SUPPLY')`,
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

  async createInventoryProduct(
    db: Database,
    input: {
      category: "MERCHANDISE" | "OPERATING_SUPPLY";
      name: string;
      description: string | null;
      unit: string;
      allowDecimalQuantity: boolean;
      unitPriceCentavos: number | null;
      showInPos: boolean;
      posSection: PosSection | null;
      lowStockLevel: number | null;
      faucetReportingType: FaucetReportingType | null;
      createdByUserId: string;
      createdAt: Date;
    },
  ): Promise<CreateProductResult> {
    const prefix = input.category === "OPERATING_SUPPLY" ? "SUPPLY" : "MERCH";
    const code = `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO inventory_items (
           code, name, category, container_shape, description, unit,
           allow_decimal_quantity, unit_price_centavos, show_in_pos, pos_section,
           low_stock_level, faucet_reporting_type, current_quantity, created_by_user_id, created_at
         )
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13)
         RETURNING id`,
        [
          code,
          input.name,
          input.category,
          input.description,
          input.unit,
          input.allowDecimalQuantity,
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

  async updateInventoryProduct(
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
  ): Promise<UpdateProductResult> {
    try {
      return await db.transaction(async (tx) => {
        const { rows: lockedRows } = await tx.query<{
          id: string;
          category: InventoryCategory;
          unit: string;
          allowDecimalQuantity: boolean;
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
                  unit,
                  allow_decimal_quantity AS "allowDecimalQuantity",
                  name,
                  description,
                  unit_price_centavos AS "unitPriceCentavos",
                  show_in_pos AS "showInPos",
                  pos_section AS "posSection",
                  low_stock_level AS "lowStockLevel",
                  faucet_reporting_type AS "faucetReportingType",
                  archived_at AS "archivedAt"
             FROM inventory_items
            WHERE id = $1 AND category IN ('MERCHANDISE', 'OPERATING_SUPPLY')
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

        if (
          locked.category === "OPERATING_SUPPLY" &&
          (input.unitPriceCentavos !== undefined ||
            input.showInPos !== undefined ||
            input.posSection !== undefined ||
            input.faucetReportingType !== undefined)
        ) {
          return { kind: "invalid-supply-fields" as const };
        }

        const allowDecimal = Boolean(locked.allowDecimalQuantity);
        if (input.lowStockLevel !== undefined && input.lowStockLevel !== null) {
          const validLow = parseQuantity(input.lowStockLevel, {
            allowDecimal,
            allowZero: false,
          });
          if (validLow === null) {
            return {
              kind: "invalid-low-stock" as const,
              allowDecimalQuantity: allowDecimal,
              unit: locked.unit,
            };
          }
        }

        const nextName = input.name !== undefined ? input.name : locked.name;
        const nextDescription =
          input.description !== undefined ? input.description : locked.description;
        const nextPrice =
          locked.category === "OPERATING_SUPPLY"
            ? null
            : input.unitPriceCentavos !== undefined
              ? input.unitPriceCentavos
              : toOptionalNumber(locked.unitPriceCentavos);
        const nextShowInPos =
          locked.category === "OPERATING_SUPPLY"
            ? false
            : input.showInPos !== undefined
              ? input.showInPos
              : Boolean(locked.showInPos);
        const nextPosSection =
          locked.category === "OPERATING_SUPPLY"
            ? null
            : input.posSection !== undefined
              ? input.posSection
              : locked.posSection;
        const nextLowStockLevel =
          input.lowStockLevel !== undefined
            ? input.lowStockLevel
            : toOptionalNumber(locked.lowStockLevel);
        const nextFaucetReportingType =
          locked.category === "OPERATING_SUPPLY"
            ? null
            : input.faucetReportingType !== undefined
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
          : toOptionalNumber(locked.lowStockLevel);

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

  async archiveInventoryProduct(
    db: Database,
    input: {
      id: string;
      archivedByUserId: string;
      archivedAt: Date;
    },
  ): Promise<ArchiveProductResult> {
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
      if (locked.category === "CONTAINER") {
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
                  allow_decimal_quantity AS "allowDecimalQuantity",
                  needs_reconciliation AS "needsReconciliation",
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

        const allowDecimal = Boolean(locked.allowDecimalQuantity);
        const validatedQuantity = parseOpeningQuantity(input.quantity, allowDecimal);
        if (validatedQuantity === null) {
          return {
            kind: "invalid-quantity" as const,
            allowDecimalQuantity: allowDecimal,
            unit: locked.unit,
          };
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
          [locked.id, validatedQuantity, locked.unit, input.recordedByUserId, input.recordedAt],
        );

        await tx.query(
          `UPDATE inventory_items
              SET current_quantity = $1,
                  stock_revision = stock_revision + 1
            WHERE id = $2`,
          [validatedQuantity, locked.id],
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
                allow_decimal_quantity AS "allowDecimalQuantity",
                needs_reconciliation AS "needsReconciliation",
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

      const allowDecimal = Boolean(locked.allowDecimalQuantity);
      const validatedPhysicalCount = parsePhysicalCount(input.physicalCount, allowDecimal);
      if (validatedPhysicalCount === null) {
        return {
          kind: "invalid-quantity" as const,
          allowDecimalQuantity: allowDecimal,
          unit: locked.unit,
        };
      }

      const validatedBaseline = parseStoredBalanceBaseline(input.expectedCurrentQuantity, {
        allowDecimal,
        allowNegative: locked.category === "OPERATING_SUPPLY",
      });
      if (validatedBaseline === null) {
        return {
          kind: "invalid-baseline" as const,
          allowDecimalQuantity: allowDecimal,
          unit: locked.unit,
        };
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
            !quantitiesEqual(Number(existingRec.physicalCount), validatedPhysicalCount) ||
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
        !quantitiesEqual(currentQuantity, validatedBaseline)
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
      if (validatedPhysicalCount < activeCommitted) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "active-commitment" as const,
          activeCommitted,
          item: latestItem!,
        };
      }
      if (validatedPhysicalCount < activeCommitted + activeHeldReducing) {
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

      const quantityDelta = subtractQuantities(validatedPhysicalCount, currentQuantity);

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
          validatedPhysicalCount,
          quantityDelta,
          validatedPhysicalCount,
          locked.unit,
          input.reason,
          input.actorUserId,
          input.recordedAt,
        ],
      );
      const reconciliationId = insertedRec[0]!.id;

      if (!quantitiesEqual(quantityDelta, 0)) {
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
            validatedPhysicalCount,
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
                stock_revision = stock_revision + 1,
                needs_reconciliation = false
          WHERE id = $1`,
        [locked.id, validatedPhysicalCount],
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

  async recordStockReceived(
    db: Database,
    input: {
      target: OpeningStockTarget;
      quantity: number;
      effectiveDate: string;
      todayManila: string;
      note: string | null;
      expectedRevision: number;
      expectedCurrentQuantity: number;
      requestKey: string | null;
      actorUserId: string;
      recordedAt: Date;
      coverage?: LateCoverageSelectionInput;
    },
  ): Promise<RecordStockMovementResult> {
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
                allow_decimal_quantity AS "allowDecimalQuantity",
                needs_reconciliation AS "needsReconciliation",
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

      const allowDecimal = Boolean(locked.allowDecimalQuantity);
      const validatedQuantity = parseQuantity(input.quantity, {
        allowDecimal,
        allowZero: false,
      });
      if (validatedQuantity === null) {
        return {
          kind: "invalid-quantity" as const,
          allowDecimalQuantity: allowDecimal,
          unit: locked.unit,
        };
      }

      // Resolve saved same-reference replays for the original actor before late-date or stale-revision checks.
      if (input.requestKey) {
        const { rows: existingRows } = await tx.query<StockMovementDbRow>(
          `${STOCK_MOVEMENT_SELECT} WHERE m.request_key = $1`,
          [input.requestKey],
        );
        const existing = existingRows[0];
        if (existing) {
          const existingEntered =
            existing.enteredQuantity !== null && existing.enteredQuantity !== undefined
              ? Number(existing.enteredQuantity)
              : Math.abs(Number(existing.quantityDelta));
          if (
            existing.itemId !== locked.id ||
            existing.actorUserId !== input.actorUserId ||
            existing.movementType !== "STOCK_RECEIVED" ||
            !quantitiesEqual(existingEntered, validatedQuantity) ||
            toOptionalDateString(existing.effectiveDate) !== input.effectiveDate ||
            (existing.note ?? null) !== input.note ||
            !sameOptionalReplayCoverage(existing, input.coverage)
          ) {
            return { kind: "key-conflict" as const };
          }
          const currentItem = await findItemById(tx, locked.id);
          return {
            kind: "replayed" as const,
            item: currentItem!,
            movement: toStockMovementView(existing),
          };
        }

        const { rows: cancelledRows } = await tx.query<{ requestKey: string }>(
          `SELECT request_key AS "requestKey"
             FROM inventory_cancelled_movement_requests
            WHERE request_key = $1`,
          [input.requestKey],
        );
        if (cancelledRows.length > 0) {
          return { kind: "cancelled" as const };
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

      const isLateEntry = input.effectiveDate < input.todayManila;
      let entryStatus: MovementEntryStatus = "APPLIED";
      let coverageMode: MovementCoverageMode = "NONE";
      let coveredQuantity = 0;
      let supportingReconciliationId: string | null = null;
      let coveredByOpeningCount = false;
      let deltaMagnitude = validatedQuantity;
      let reviewed = false;

      if (!isLateEntry) {
        const cov = input.coverage;
        if (
          (cov?.coverageMode !== undefined && cov.coverageMode !== null && cov.coverageMode !== "NONE") ||
          (cov?.coveredQuantity !== undefined && cov.coveredQuantity !== null) ||
          cov?.supportingReconciliationId ||
          cov?.coveredByOpeningCount ||
          cov?.reviewNote
        ) {
          return {
            kind: "invalid-coverage" as const,
            message: "Count-coverage options apply only to late deliveries dated before today.",
          };
        }
      } else {
        const counts = await loadApplicableCountsForDate(tx, locked.id, input.effectiveDate);
        const coverageOutcome = evaluateOwnerCoverageSelection({
          enteredQuantity: validatedQuantity,
          allowDecimal,
          applicableReconciliations: counts.applicableReconciliations,
          openingCountCoversDate: counts.openingCountCoversDate,
          selection: input.coverage ?? {},
          requireExplicitWhenCountsExist: true,
        });
        if (!coverageOutcome.ok) {
          if (coverageOutcome.kind === "stale-review") {
            const latestItem = await findItemById(tx, locked.id);
            return {
              kind: "stale-review" as const,
              item: latestItem!,
              applicableReconciliations: counts.applicableReconciliations,
              openingCountCoversDate: counts.openingCountCoversDate,
            };
          }
          return {
            kind: "invalid-coverage" as const,
            message: coverageOutcome.message,
          };
        }
        entryStatus = coverageOutcome.entryStatus;
        coverageMode = coverageOutcome.coverageMode;
        coveredQuantity = coverageOutcome.coveredQuantity;
        supportingReconciliationId = coverageOutcome.supportingReconciliationId;
        coveredByOpeningCount = coverageOutcome.coveredByOpeningCount;
        deltaMagnitude = coverageOutcome.deltaMagnitude;
        reviewed = coverageOutcome.reviewed;
      }

      const currentQuantity = Number(locked.currentQuantity);
      const stockRevision = Number(locked.stockRevision);
      if (deltaMagnitude > 0) {
        const validatedBaseline = parseStoredBalanceBaseline(input.expectedCurrentQuantity, {
          allowDecimal,
          allowNegative: locked.category === "OPERATING_SUPPLY",
        });
        if (validatedBaseline === null) {
          return {
            kind: "invalid-baseline" as const,
            allowDecimalQuantity: allowDecimal,
            unit: locked.unit,
          };
        }
        if (
          stockRevision !== input.expectedRevision ||
          !quantitiesEqual(currentQuantity, validatedBaseline)
        ) {
          const latestItem = await findItemById(tx, locked.id);
          return { kind: "stale" as const, item: latestItem! };
        }
      }

      const balanceAfter =
        deltaMagnitude > 0 ? addQuantities(currentQuantity, deltaMagnitude) : currentQuantity;

      const { rows: insertedRows } = await tx.query<{ id: string }>(
        `INSERT INTO inventory_stock_movements (
           item_id, movement_type, entry_status, entered_quantity, quantity_delta,
           balance_before, balance_after, unit, effective_date, note,
           coverage_mode, covered_quantity, supporting_reconciliation_id, covered_by_opening_count,
           reviewed_by_user_id, reviewed_at, review_note, request_key, actor_user_id, recorded_at,
           balance_applied_at, current_quantity_value, current_item_id, current_effective_date, current_note
         )
         VALUES (
           $1, 'STOCK_RECEIVED', $2, $3, $4,
           $5, $6, $7, $8::date, $9,
           $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19,
           $20, $3, $1, $8::date, $9
         )
         RETURNING id`,
        [
          locked.id,
          entryStatus,
          validatedQuantity,
          deltaMagnitude,
          currentQuantity,
          balanceAfter,
          locked.unit,
          input.effectiveDate,
          input.note,
          coverageMode,
          coveredQuantity,
          supportingReconciliationId,
          coveredByOpeningCount,
          reviewed ? input.actorUserId : null,
          reviewed ? input.recordedAt : null,
          reviewed ? (input.coverage?.reviewNote ?? null) : null,
          input.requestKey,
          input.actorUserId,
          input.recordedAt,
          deltaMagnitude > 0 ? input.recordedAt : null,
        ],
      );
      const movementId = insertedRows[0]!.id;

      // INV-009: Receiving alone does NOT clear an existing reconciliation flag.
      if (deltaMagnitude > 0) {
        await tx.query(
          `UPDATE inventory_items
              SET current_quantity = $2,
                  stock_revision = stock_revision + 1
            WHERE id = $1`,
          [locked.id, balanceAfter],
        );
      }

      const [{ rows: movRows }, updatedItem] = await Promise.all([
        tx.query<StockMovementDbRow>(`${STOCK_MOVEMENT_SELECT} WHERE m.id = $1`, [movementId]),
        findItemById(tx, locked.id),
      ]);

      return {
        kind: "created" as const,
        item: updatedItem!,
        movement: toStockMovementView(movRows[0]!),
      };
    });
  },

  async recordStockUsed(
    db: Database,
    input: {
      target: OpeningStockTarget;
      quantity: number;
      effectiveDate: string;
      todayManila: string;
      purpose: string;
      expectedRevision: number;
      expectedCurrentQuantity: number;
      requestKey: string | null;
      actorUserId: string;
      actorRole: Role;
      recordedAt: Date;
      coverage?: LateCoverageSelectionInput;
    },
  ): Promise<RecordStockMovementResult> {
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
                allow_decimal_quantity AS "allowDecimalQuantity",
                needs_reconciliation AS "needsReconciliation",
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

      if (locked.category !== "OPERATING_SUPPLY") {
        return { kind: "not-operating-supply" as const };
      }

      const allowDecimal = Boolean(locked.allowDecimalQuantity);
      const validatedQuantity = parseQuantity(input.quantity, {
        allowDecimal,
        allowZero: false,
      });
      if (validatedQuantity === null) {
        return {
          kind: "invalid-quantity" as const,
          allowDecimalQuantity: allowDecimal,
          unit: locked.unit,
        };
      }

      // Resolve saved same-reference replays for the original actor before late-date or stale-revision checks.
      if (input.requestKey) {
        const { rows: existingRows } = await tx.query<StockMovementDbRow>(
          `${STOCK_MOVEMENT_SELECT} WHERE m.request_key = $1`,
          [input.requestKey],
        );
        const existing = existingRows[0];
        if (existing) {
          const existingEntered =
            existing.enteredQuantity !== null && existing.enteredQuantity !== undefined
              ? Number(existing.enteredQuantity)
              : Math.abs(Number(existing.quantityDelta));
          if (
            existing.itemId !== locked.id ||
            existing.actorUserId !== input.actorUserId ||
            existing.movementType !== "STOCK_USED" ||
            !quantitiesEqual(existingEntered, validatedQuantity) ||
            toOptionalDateString(existing.effectiveDate) !== input.effectiveDate ||
            (existing.note ?? null) !== input.purpose ||
            !sameOptionalReplayCoverage(existing, input.coverage)
          ) {
            return { kind: "key-conflict" as const };
          }
          const currentItem = await findItemById(tx, locked.id);
          const itemView =
            input.actorRole === "OWNER" ? currentItem! : redactItemForEmployee(currentItem!);
          const movementView =
            input.actorRole === "OWNER"
              ? toStockMovementView(existing)
              : redactMovementForEmployee(toStockMovementView(existing));
          return {
            kind: "replayed" as const,
            item: itemView,
            movement: movementView,
          };
        }

        const { rows: cancelledRows } = await tx.query<{ requestKey: string }>(
          `SELECT request_key AS "requestKey"
             FROM inventory_cancelled_movement_requests
            WHERE request_key = $1`,
          [input.requestKey],
        );
        if (cancelledRows.length > 0) {
          return { kind: "cancelled" as const };
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

      const isLateEntry = input.effectiveDate < input.todayManila;
      let entryStatus: MovementEntryStatus = "APPLIED";
      let coverageMode: MovementCoverageMode = "NONE";
      let coveredQuantity = 0;
      let supportingReconciliationId: string | null = null;
      let coveredByOpeningCount = false;
      let deltaMagnitude = validatedQuantity;
      let reviewed = false;

      if (!isLateEntry) {
        const cov = input.coverage;
        if (
          (cov?.coverageMode !== undefined && cov.coverageMode !== null && cov.coverageMode !== "NONE") ||
          (cov?.coveredQuantity !== undefined && cov.coveredQuantity !== null) ||
          cov?.supportingReconciliationId ||
          cov?.coveredByOpeningCount ||
          cov?.reviewNote
        ) {
          return {
            kind: "invalid-coverage" as const,
            message: "Count-coverage options apply only to late usage dated before today.",
          };
        }
      } else {
        const counts = await loadApplicableCountsForDate(tx, locked.id, input.effectiveDate);
        if (input.actorRole === "EMPLOYEE") {
          const hasCounts =
            counts.applicableReconciliations.length > 0 || counts.openingCountCoversDate;
          if (hasCounts) {
            entryStatus = "PENDING_REVIEW";
            coverageMode = "UNCLEAR";
            deltaMagnitude = 0;
          } else {
            entryStatus = "APPLIED";
            coverageMode = "NONE";
            deltaMagnitude = validatedQuantity;
          }
        } else {
          const coverageOutcome = evaluateOwnerCoverageSelection({
            enteredQuantity: validatedQuantity,
            allowDecimal,
            applicableReconciliations: counts.applicableReconciliations,
            openingCountCoversDate: counts.openingCountCoversDate,
            selection: input.coverage ?? {},
            requireExplicitWhenCountsExist: true,
          });
          if (!coverageOutcome.ok) {
            if (coverageOutcome.kind === "stale-review") {
              const latestItem = await findItemById(tx, locked.id);
              return {
                kind: "stale-review" as const,
                item: latestItem!,
                applicableReconciliations: counts.applicableReconciliations,
                openingCountCoversDate: counts.openingCountCoversDate,
              };
            }
            return {
              kind: "invalid-coverage" as const,
              message: coverageOutcome.message,
            };
          }
          entryStatus = coverageOutcome.entryStatus;
          coverageMode = coverageOutcome.coverageMode;
          coveredQuantity = coverageOutcome.coveredQuantity;
          supportingReconciliationId = coverageOutcome.supportingReconciliationId;
          coveredByOpeningCount = coverageOutcome.coveredByOpeningCount;
          deltaMagnitude = coverageOutcome.deltaMagnitude;
          reviewed = coverageOutcome.reviewed;
        }
      }

      const currentQuantity = Number(locked.currentQuantity);
      const stockRevision = Number(locked.stockRevision);
      if (deltaMagnitude > 0) {
        const validatedBaseline = parseStoredBalanceBaseline(input.expectedCurrentQuantity, {
          allowDecimal,
          allowNegative: true,
        });
        if (validatedBaseline === null) {
          return {
            kind: "invalid-baseline" as const,
            allowDecimalQuantity: allowDecimal,
            unit: locked.unit,
          };
        }
        if (
          stockRevision !== input.expectedRevision ||
          !quantitiesEqual(currentQuantity, validatedBaseline)
        ) {
          const latestItem = await findItemById(tx, locked.id);
          return {
            kind: "stale" as const,
            item:
              input.actorRole === "OWNER" ? latestItem! : redactItemForEmployee(latestItem!),
          };
        }
      }

      const quantityDelta = deltaMagnitude > 0 ? subtractQuantities(0, deltaMagnitude) : 0;
      const balanceAfter =
        deltaMagnitude > 0 ? subtractQuantities(currentQuantity, deltaMagnitude) : currentQuantity;
      const nextNeedsReconciliation =
        deltaMagnitude > 0 ? Boolean(locked.needsReconciliation) || balanceAfter < 0 : Boolean(locked.needsReconciliation);

      const { rows: insertedRows } = await tx.query<{ id: string }>(
        `INSERT INTO inventory_stock_movements (
           item_id, movement_type, entry_status, entered_quantity, quantity_delta,
           balance_before, balance_after, unit, effective_date, note,
           coverage_mode, covered_quantity, supporting_reconciliation_id, covered_by_opening_count,
           reviewed_by_user_id, reviewed_at, review_note, request_key, actor_user_id, recorded_at,
           balance_applied_at, current_quantity_value, current_item_id, current_effective_date, current_note
         )
         VALUES (
           $1, 'STOCK_USED', $2, $3, $4,
           $5, $6, $7, $8::date, $9,
           $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19,
           $20, $3, $1, $8::date, $9
         )
         RETURNING id`,
        [
          locked.id,
          entryStatus,
          validatedQuantity,
          quantityDelta,
          currentQuantity,
          balanceAfter,
          locked.unit,
          input.effectiveDate,
          input.purpose,
          coverageMode,
          coveredQuantity,
          supportingReconciliationId,
          coveredByOpeningCount,
          reviewed ? input.actorUserId : null,
          reviewed ? input.recordedAt : null,
          reviewed ? (input.coverage?.reviewNote ?? null) : null,
          input.requestKey,
          input.actorUserId,
          input.recordedAt,
          deltaMagnitude > 0 ? input.recordedAt : null,
        ],
      );
      const movementId = insertedRows[0]!.id;

      if (deltaMagnitude > 0) {
        await tx.query(
          `UPDATE inventory_items
              SET current_quantity = $2,
                  stock_revision = stock_revision + 1,
                  needs_reconciliation = $3
            WHERE id = $1`,
          [locked.id, balanceAfter, nextNeedsReconciliation],
        );
      }

      const [{ rows: movRows }, updatedItem] = await Promise.all([
        tx.query<StockMovementDbRow>(`${STOCK_MOVEMENT_SELECT} WHERE m.id = $1`, [movementId]),
        findItemById(tx, locked.id),
      ]);

      const rawView = toStockMovementView(movRows[0]!);
      return {
        kind: "created" as const,
        item: input.actorRole === "OWNER" ? updatedItem! : redactItemForEmployee(updatedItem!),
        movement: input.actorRole === "OWNER" ? rawView : redactMovementForEmployee(rawView),
      };
    });
  },

  async findStockMovementByRequestKey(
    db: Queryable,
    input: {
      requestKey: string;
      actorUserId: string;
      actorRole?: Role;
    },
  ): Promise<
    | { status: "NOT_FOUND" }
    | { status: "CANCELLED" }
    | { status: "SAVED"; item: InventoryItemView; movement: StockMovementView }
  > {
    const { rows } = await db.query<StockMovementDbRow>(
      `${STOCK_MOVEMENT_SELECT}
        WHERE m.request_key = $1
          AND m.actor_user_id = $2
          AND m.movement_type IN ('STOCK_RECEIVED', 'STOCK_USED')`,
      [input.requestKey, input.actorUserId],
    );
    const row = rows[0];
    if (row) {
      const item = await findItemById(db, row.itemId);
      if (!item) {
        return { status: "NOT_FOUND" };
      }
      const view = toStockMovementView(row);
      const isOwner = (input.actorRole ?? "OWNER") === "OWNER";
      return {
        status: "SAVED",
        item: isOwner ? item : redactItemForEmployee(item),
        movement: isOwner ? view : redactMovementForEmployee(view),
      };
    }

    const { rows: cancelledRows } = await db.query<{ requestKey: string }>(
      `SELECT request_key AS "requestKey"
         FROM inventory_cancelled_movement_requests
        WHERE request_key = $1
          AND actor_user_id = $2`,
      [input.requestKey, input.actorUserId],
    );
    if (cancelledRows.length > 0) {
      return { status: "CANCELLED" };
    }

    return { status: "NOT_FOUND" };
  },

  async cancelPendingMovementRequest(
    db: Database,
    input: {
      target: OpeningStockTarget;
      movementType: "STOCK_RECEIVED" | "STOCK_USED";
      requestKey: string;
      actorUserId: string;
      actorRole?: Role;
      cancelledAt: Date;
    },
  ): Promise<
    | { kind: "not-found" }
    | { kind: "key-conflict" }
    | { kind: "already-saved"; item: InventoryItemView; movement: StockMovementView }
    | { kind: "cancelled" }
  > {
    return db.transaction(async (tx) => {
      const whereSql =
        input.target.kind === "shape"
          ? `category = 'CONTAINER' AND container_shape = $1`
          : `id = $1`;
      const whereParam = input.target.kind === "shape" ? input.target.shape : input.target.id;

      const { rows: lockedRows } = await tx.query<{ id: string }>(
        `SELECT id
           FROM inventory_items
          WHERE ${whereSql}
          FOR UPDATE`,
        [whereParam],
      );
      const locked = lockedRows[0];
      if (!locked) {
        return { kind: "not-found" as const };
      }

      const { rows: existingRows } = await tx.query<StockMovementDbRow>(
        `${STOCK_MOVEMENT_SELECT} WHERE m.request_key = $1`,
        [input.requestKey],
      );
      const existing = existingRows[0];
      if (existing) {
        if (
          existing.itemId !== locked.id ||
          existing.actorUserId !== input.actorUserId ||
          existing.movementType !== input.movementType
        ) {
          return { kind: "key-conflict" as const };
        }
        const currentItem = await findItemById(tx, locked.id);
        const view = toStockMovementView(existing);
        const isOwner = (input.actorRole ?? "OWNER") === "OWNER";
        return {
          kind: "already-saved" as const,
          item: isOwner ? currentItem! : redactItemForEmployee(currentItem!),
          movement: isOwner ? view : redactMovementForEmployee(view),
        };
      }

      const { rows: tombstoneRows } = await tx.query<{
        itemId: string;
        movementType: string;
        actorUserId: string;
      }>(
        `SELECT item_id AS "itemId",
                movement_type AS "movementType",
                actor_user_id AS "actorUserId"
           FROM inventory_cancelled_movement_requests
          WHERE request_key = $1`,
        [input.requestKey],
      );
      const tombstone = tombstoneRows[0];
      if (tombstone) {
        if (
          tombstone.itemId !== locked.id ||
          tombstone.movementType !== input.movementType ||
          tombstone.actorUserId !== input.actorUserId
        ) {
          return { kind: "key-conflict" as const };
        }
        return { kind: "cancelled" as const };
      }

      await tx.query(
        `INSERT INTO inventory_cancelled_movement_requests (
           request_key, item_id, movement_type, actor_user_id, cancelled_at
         )
         VALUES ($1, $2, $3, $4, $5)`,
        [input.requestKey, locked.id, input.movementType, input.actorUserId, input.cancelledAt],
      );

      return { kind: "cancelled" as const };
    });
  },

  async listReconciliations(
    db: Queryable,
    target: OpeningStockTarget,
    options: { sinceDate?: string } = {},
  ): Promise<{
    found: boolean;
    reconciliations: StockReconciliationView[];
    openingCountCoversDate: boolean;
  }> {
    const item = await findItemByTarget(db, target);
    if (!item) {
      return { found: false, reconciliations: [], openingCountCoversDate: false };
    }
    if (options.sinceDate) {
      const counts = await loadApplicableCountsForDate(db, item.id, options.sinceDate);
      return {
        found: true,
        reconciliations: counts.applicableReconciliations,
        openingCountCoversDate: counts.openingCountCoversDate,
      };
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
      openingCountCoversDate: false,
    };
  },

  async countPendingMovementReviews(db: Queryable): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM inventory_stock_movements
        WHERE entry_status = 'PENDING_REVIEW'`,
    );
    return Number(rows[0]?.count ?? 0);
  },

  async listPendingMovementReviews(db: Queryable): Promise<PendingMovementReviewView[]> {
    const { rows } = await db.query<StockMovementDbRow>(
      `${STOCK_MOVEMENT_SELECT}
        WHERE m.entry_status = 'PENDING_REVIEW'
        ORDER BY m.recorded_at ASC, m.id ASC`,
    );
    if (rows.length === 0) {
      return [];
    }

    const itemIds = [...new Set(rows.map((r) => r.itemId))];
    const { rows: itemRows } = await db.query<InventoryItemDbRow>(
      `${ITEM_SELECT} WHERE i.id = ANY($1::uuid[])`,
      [itemIds],
    );
    const [holdsByItem, saleReviewsByItem] = await Promise.all([
      loadActiveHoldsByItemIds(db, itemIds),
      loadPendingSaleActionReviewsByItemIds(db, itemRows),
    ]);
    const itemMap = new Map<string, InventoryItemView>();
    for (const row of itemRows) {
      itemMap.set(
        row.id,
        toInventoryItemView(row, holdsByItem.get(row.id) ?? [], saleReviewsByItem.get(row.id) ?? []),
      );
    }

    const reviews: PendingMovementReviewView[] = [];
    for (const row of rows) {
      const item = itemMap.get(row.itemId);
      if (!item) continue;
      const view = toStockMovementView(row);
      const sinceDate = view.effectiveDate ?? formatManilaDate(toDate(row.recordedAt));
      const counts = await loadApplicableCountsForDate(db, row.itemId, sinceDate);
      reviews.push({
        entry: view,
        item,
        applicableReconciliations: counts.applicableReconciliations,
        openingCountCoversDate: counts.openingCountCoversDate,
      });
    }
    return reviews;
  },

  async resolvePendingMovementReview(
    db: Database,
    input: {
      entryId: string;
      expectedRevision: number;
      expectedCurrentQuantity: number;
      requestKey: string | null;
      reviewerUserId: string;
      reviewedAt: Date;
      coverage: LateCoverageSelectionInput;
    },
  ): Promise<ResolvePendingReviewResult> {
    return db.transaction(async (tx) => {
      if (input.requestKey) {
        const { rows: replayRows } = await tx.query<StockMovementDbRow>(
          `${STOCK_MOVEMENT_SELECT} WHERE m.review_request_key = $1`,
          [input.requestKey],
        );
        const replayed = replayRows[0];
        if (replayed) {
          if (replayed.id !== input.entryId) {
            return { kind: "key-conflict" as const };
          }
          const currentItem = await findItemById(tx, replayed.itemId);
          return {
            kind: "replayed" as const,
            item: currentItem!,
            movement: toStockMovementView(replayed),
          };
        }
      }

      const { rows: entrySeedRows } = await tx.query<{ itemId: string }>(
        `SELECT item_id AS "itemId" FROM inventory_stock_movements WHERE id = $1`,
        [input.entryId],
      );
      if (!entrySeedRows[0]) {
        return { kind: "not-found" as const };
      }

      const { rows: lockedItemRows } = await tx.query<LockedItemRow>(
        `SELECT id,
                code,
                name,
                category,
                container_shape AS "containerShape",
                unit,
                allow_decimal_quantity AS "allowDecimalQuantity",
                needs_reconciliation AS "needsReconciliation",
                current_quantity AS "currentQuantity",
                stock_revision AS "stockRevision",
                archived_at AS "archivedAt"
           FROM inventory_items
          WHERE id = $1
          FOR UPDATE`,
        [entrySeedRows[0].itemId],
      );
      const locked = lockedItemRows[0];
      if (!locked || locked.currentQuantity === null) {
        return { kind: "not-found" as const };
      }

      const { rows: lockedMovRows } = await tx.query<StockMovementDbRow>(
        `${STOCK_MOVEMENT_SELECT} WHERE m.id = $1 FOR UPDATE OF m`,
        [input.entryId],
      );
      const existing = lockedMovRows[0];
      if (!existing) {
        return { kind: "not-found" as const };
      }

      if (existing.isCancelled || existing.entryStatus !== "PENDING_REVIEW") {
        const currentItem = await findItemById(tx, locked.id);
        return {
          kind: "already-resolved" as const,
          item: currentItem!,
          movement: toStockMovementView(existing),
        };
      }

      if (
        existing.movementType !== "STOCK_RECEIVED" &&
        existing.movementType !== "STOCK_USED"
      ) {
        return { kind: "not-found" as const };
      }

      const allowDecimal = Boolean(locked.allowDecimalQuantity);
      const enteredQuantity =
        existing.enteredQuantity !== null && existing.enteredQuantity !== undefined
          ? Number(existing.enteredQuantity)
          : Math.abs(Number(existing.quantityDelta));
      const sinceDate =
        toOptionalDateString(existing.effectiveDate) ??
        formatManilaDate(toDate(existing.recordedAt));
      const counts = await loadApplicableCountsForDate(tx, locked.id, sinceDate);

      const mode = input.coverage.coverageMode;
      if (mode !== "NONE" && mode !== "FULL" && mode !== "PARTIAL") {
        return {
          kind: "invalid-coverage" as const,
          message: "Choose No Coverage, Full Coverage, or Partial Coverage to resolve a pending review.",
        };
      }

      const coverageOutcome = evaluateOwnerCoverageSelection({
        enteredQuantity,
        allowDecimal,
        applicableReconciliations: counts.applicableReconciliations,
        openingCountCoversDate: counts.openingCountCoversDate,
        selection: { ...input.coverage, coverageMode: mode },
        requireExplicitWhenCountsExist: true,
        requireSnapshot: true,
      });
      if (!coverageOutcome.ok) {
        if (coverageOutcome.kind === "stale-review") {
          const latestItem = await findItemById(tx, locked.id);
          return {
            kind: "stale-review" as const,
            item: latestItem!,
            entry: toStockMovementView(existing),
            applicableReconciliations: counts.applicableReconciliations,
            openingCountCoversDate: counts.openingCountCoversDate,
          };
        }
        return {
          kind: "invalid-coverage" as const,
          message: coverageOutcome.message,
        };
      }

      const currentQuantity = Number(locked.currentQuantity);
      const stockRevision = Number(locked.stockRevision);
      const validatedBaseline = parseStoredBalanceBaseline(input.expectedCurrentQuantity, {
        allowDecimal,
        allowNegative: locked.category === "OPERATING_SUPPLY",
      });
      if (validatedBaseline === null) {
        return {
          kind: "invalid-baseline" as const,
          allowDecimalQuantity: allowDecimal,
          unit: locked.unit,
        };
      }
      if (
        stockRevision !== input.expectedRevision ||
        !quantitiesEqual(currentQuantity, validatedBaseline)
      ) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "stale" as const,
          item: latestItem!,
          entry: toStockMovementView(existing),
          applicableReconciliations: counts.applicableReconciliations,
          openingCountCoversDate: counts.openingCountCoversDate,
        };
      }

      const deltaMagnitude = coverageOutcome.deltaMagnitude;
      const signedDelta =
        deltaMagnitude === 0
          ? 0
          : existing.movementType === "STOCK_RECEIVED"
            ? deltaMagnitude
            : subtractQuantities(0, deltaMagnitude);
      const balanceAfter =
        signedDelta === 0
          ? currentQuantity
          : existing.movementType === "STOCK_RECEIVED"
            ? addQuantities(currentQuantity, deltaMagnitude)
            : subtractQuantities(currentQuantity, deltaMagnitude);

      await tx.query(
        `UPDATE inventory_stock_movements
            SET entry_status = 'APPLIED',
                coverage_mode = $2,
                covered_quantity = $3,
                quantity_delta = $4,
                balance_before = $5,
                balance_after = $6,
                supporting_reconciliation_id = $7,
                covered_by_opening_count = $8,
                reviewed_by_user_id = $9,
                reviewed_at = $10,
                review_note = $11,
                review_request_key = $12,
                balance_applied_at = $13
          WHERE id = $1`,
        [
          existing.id,
          coverageOutcome.coverageMode,
          coverageOutcome.coveredQuantity,
          signedDelta,
          currentQuantity,
          balanceAfter,
          coverageOutcome.supportingReconciliationId,
          coverageOutcome.coveredByOpeningCount,
          input.reviewerUserId,
          input.reviewedAt,
          input.coverage.reviewNote ?? null,
          input.requestKey,
          signedDelta !== 0 ? input.reviewedAt : null,
        ],
      );

      if (signedDelta !== 0) {
        const nextNeedsReconciliation =
          existing.movementType === "STOCK_USED"
            ? Boolean(locked.needsReconciliation) || balanceAfter < 0
            : Boolean(locked.needsReconciliation);
        await tx.query(
          `UPDATE inventory_items
              SET current_quantity = $2,
                  stock_revision = stock_revision + 1,
                  needs_reconciliation = $3
            WHERE id = $1`,
          [locked.id, balanceAfter, nextNeedsReconciliation],
        );
      }

      const [{ rows: updatedMovRows }, updatedItem] = await Promise.all([
        tx.query<StockMovementDbRow>(`${STOCK_MOVEMENT_SELECT} WHERE m.id = $1`, [existing.id]),
        findItemById(tx, locked.id),
      ]);

      return {
        kind: "resolved" as const,
        item: updatedItem!,
        movement: toStockMovementView(updatedMovRows[0]!),
      };
    });
  },

  async listItemHistory(
    db: Queryable,
    input: {
      target: OpeningStockTarget;
      role: Role;
      actorUserId: string;
    },
  ): Promise<InventoryItemHistoryView | null> {
    const item = await findItemByTarget(db, input.target);
    if (!item) {
      return null;
    }

    if (input.role === "EMPLOYEE") {
      if (item.archivedAt !== null) {
        return null;
      }
      const { rows: movRows } = await db.query<StockMovementDbRow>(
        `${STOCK_MOVEMENT_SELECT}
          WHERE m.item_id = $1
            AND m.actor_user_id = $2
            AND m.movement_type = 'STOCK_USED'
          ORDER BY m.recorded_at DESC, m.id DESC`,
        [item.id, input.actorUserId],
      );
      return {
        scope: "OWN_USAGE",
        item: redactItemForEmployee(item),
        openingStock: null,
        movements: movRows.map((row) => redactMovementForEmployee(toStockMovementView(row))),
        reconciliations: [],
      };
    }

    const [{ rows: movRows }, { rows: recRows }] = await Promise.all([
      db.query<StockMovementDbRow>(
        `${STOCK_MOVEMENT_SELECT}
          WHERE m.item_id = $1 OR m.current_item_id = $1
          ORDER BY m.recorded_at DESC, m.id DESC`,
        [item.id],
      ),
      db.query<ReconciliationDbRow>(
        `${RECONCILIATION_SELECT}
          WHERE r.item_id = $1
          ORDER BY r.recorded_at DESC, r.id DESC`,
        [item.id],
      ),
    ]);

    const correctionsByMovement = await loadCorrectionsByMovementIds(
      db,
      movRows.map((row) => row.id),
    );

    return {
      scope: "FULL",
      item,
      openingStock: item.openingStock,
      movements: movRows.map((row) => {
        const corrections = correctionsByMovement.get(row.id) ?? [];
        const appliedNetDelta =
          row.movementType === "STOCK_RECEIVED" || row.movementType === "STOCK_USED"
            ? computeCurrentItemAppliedNetDelta(row, corrections)
            : undefined;
        return {
          ...toStockMovementView(row),
          appliedNetDelta,
          corrections,
        };
      }),
      reconciliations: recRows.map(toReconciliationView),
    };
  },

  async countPendingCorrectionReviews(db: Queryable): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM inventory_movement_corrections
        WHERE status = 'PENDING_REVIEW'`,
    );
    return Number(rows[0]?.count ?? 0);
  },

  async listPendingCorrectionReviews(db: Queryable): Promise<PendingCorrectionReviewView[]> {
    const { rows: corrRows } = await db.query<MovementCorrectionDbRow>(
      `${CORRECTION_SELECT}
        WHERE mc.status = 'PENDING_REVIEW'
        ORDER BY mc.created_at ASC, mc.id ASC`,
    );
    if (corrRows.length === 0) {
      return [];
    }

    const movementIds = [...new Set(corrRows.map((c) => c.movementId))];
    const itemIds = [
      ...new Set(
        corrRows.flatMap((c) => (c.secondaryItemId ? [c.primaryItemId, c.secondaryItemId] : [c.primaryItemId])),
      ),
    ];

    const [{ rows: movRows }, { rows: itemRows }] = await Promise.all([
      db.query<StockMovementDbRow>(`${STOCK_MOVEMENT_SELECT} WHERE m.id = ANY($1::uuid[])`, [movementIds]),
      db.query<InventoryItemDbRow>(`${ITEM_SELECT} WHERE i.id = ANY($1::uuid[])`, [itemIds]),
    ]);

    const [holdsByItem, saleReviewsByItem, correctionsByMovement] = await Promise.all([
      loadActiveHoldsByItemIds(db, itemIds),
      loadPendingSaleActionReviewsByItemIds(db, itemRows),
      loadCorrectionsByMovementIds(db, movementIds),
    ]);

    const itemMap = new Map<string, InventoryItemView>();
    for (const row of itemRows) {
      itemMap.set(
        row.id,
        toInventoryItemView(row, holdsByItem.get(row.id) ?? [], saleReviewsByItem.get(row.id) ?? []),
      );
    }
    const movMap = new Map<string, StockMovementView>();
    for (const row of movRows) {
      const corrections = correctionsByMovement.get(row.id) ?? [];
      movMap.set(row.id, {
        ...toStockMovementView(row),
        appliedNetDelta:
          row.movementType === "STOCK_RECEIVED" || row.movementType === "STOCK_USED"
            ? computeCurrentItemAppliedNetDelta(row, corrections)
            : undefined,
        corrections,
      });
    }

    const reviews: PendingCorrectionReviewView[] = [];
    for (const corr of corrRows) {
      const movement = movMap.get(corr.movementId);
      const primaryItem = itemMap.get(corr.primaryItemId);
      if (!movement || !primaryItem) continue;
      const sinceDate =
        toOptionalDateString(corr.newEffectiveDate) ??
        movement.currentEffectiveDate ??
        movement.effectiveDate ??
        formatManilaDate(toDate(movement.recordedAt));
      const [primaryCounts, qualifyingPrimaryReconciliationIds] = await Promise.all([
        loadApplicableCountsForDate(db, corr.primaryItemId, sinceDate),
        listReconciliationIdsRecordedAfterCorrection(db, corr.primaryItemId, corr.id),
      ]);
      const secondaryItem = corr.secondaryItemId ? (itemMap.get(corr.secondaryItemId) ?? null) : null;
      const secondaryCounts = corr.secondaryItemId
        ? await loadApplicableCountsForDate(db, corr.secondaryItemId, sinceDate)
        : { applicableReconciliations: [], openingCountCoversDate: false };

      reviews.push({
        correction: toMovementCorrectionView(corr),
        movement,
        primaryItem,
        primaryApplicableReconciliations: primaryCounts.applicableReconciliations,
        primaryOpeningCountCoversDate: primaryCounts.openingCountCoversDate,
        qualifyingPrimaryReconciliationIds,
        secondaryItem,
        secondaryApplicableReconciliations: secondaryCounts.applicableReconciliations,
        secondaryOpeningCountCoversDate: secondaryCounts.openingCountCoversDate,
      });
    }
    return reviews;
  },

  async correctMovementQuantity(
    db: Database,
    input: {
      movementId: string;
      newQuantity: number;
      reason: string;
      expectedCorrectionVersion: number;
      expectedRevision: number;
      expectedCurrentQuantity: number;
      requestKey: string;
      actorUserId: string;
      correctedAt: Date;
      coverage: LateCoverageSelectionInput;
    },
  ): Promise<MovementCorrectionActionResult> {
    return db.transaction(async (tx) => {
      const replayRow = await findCorrectionByRequestKey(tx, input.requestKey);
      if (replayRow) {
        const expectedPrevMatches =
          replayRow.movementId === input.movementId &&
          replayRow.correctionKind === "QUANTITY" &&
          replayRow.reason === input.reason &&
          replayRow.newQuantity !== null &&
          quantitiesEqual(Number(replayRow.newQuantity), input.newQuantity);
        if (!expectedPrevMatches) {
          return { kind: "key-conflict" as const };
        }
        return hydrateCorrectionOutcome(tx, "replayed", replayRow);
      }

      const seed = await loadMovementForCorrectionSeed(tx, input.movementId);
      if (!seed) {
        return { kind: "not-found" as const };
      }

      const itemMap = await lockInventoryItemsInOrder(tx, [seed.currentItemId ?? seed.itemId]);
      const locked = itemMap.get(seed.currentItemId ?? seed.itemId);
      if (!locked || locked.currentQuantity === null) {
        return { kind: "not-found" as const };
      }

      const existing = await lockMovementById(tx, input.movementId);
      if (!existing) {
        return { kind: "not-found" as const };
      }
      if (existing.movementType !== "STOCK_RECEIVED" && existing.movementType !== "STOCK_USED") {
        return { kind: "not-found" as const };
      }
      if (existing.isCancelled) {
        return { kind: "already-cancelled" as const };
      }
      if (existing.entryStatus !== "APPLIED") {
        return {
          kind: "pending-conflict" as const,
          message: "Resolve the pending late-entry review before correcting its quantity.",
        };
      }
      if (await hasOpenPendingCorrectionForMovement(tx, existing.id)) {
        return {
          kind: "pending-conflict" as const,
          message: "Resolve the pending correction for this entry before making another change.",
        };
      }
      if (hasUnrecordedTargetUnitQuantity(existing)) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "different-unit-quantity-unrecorded" as const,
          item: latestItem!,
          originalUnit: existing.unit,
        };
      }

      const allowDecimal = Boolean(locked.allowDecimalQuantity);
      const validatedNewQuantity = parseQuantity(input.newQuantity, {
        allowDecimal,
        allowZero: false,
      });
      if (validatedNewQuantity === null) {
        return {
          kind: "invalid-quantity" as const,
          allowDecimalQuantity: allowDecimal,
          unit: locked.unit,
        };
      }

      const prevQuantity = getLatestMovementQuantity(existing);
      if (quantitiesEqual(validatedNewQuantity, prevQuantity)) {
        return {
          kind: "invalid-quantity-unchanged" as const,
          currentQuantityValue: prevQuantity,
        };
      }

      const existingCorrectionVersion = Number(existing.correctionVersion ?? 0);
      if (existingCorrectionVersion !== input.expectedCorrectionVersion) {
        return buildStaleMovementOutcome(tx, locked.id, existing.id);
      }

      const currentQuantity = Number(locked.currentQuantity);
      const stockRevision = Number(locked.stockRevision);
      const validatedBaseline = parseStoredBalanceBaseline(input.expectedCurrentQuantity, {
        allowDecimal,
        allowNegative: locked.category === "OPERATING_SUPPLY",
      });
      if (validatedBaseline === null) {
        return {
          kind: "invalid-baseline" as const,
          allowDecimalQuantity: allowDecimal,
          unit: locked.unit,
        };
      }
      if (
        stockRevision !== input.expectedRevision ||
        !quantitiesEqual(currentQuantity, validatedBaseline)
      ) {
        return buildStaleStockOutcome(tx, locked.id, existing.id);
      }

      const rawDiff = subtractQuantities(validatedNewQuantity, prevQuantity);
      const rawDelta =
        existing.movementType === "STOCK_RECEIVED" ? rawDiff : subtractQuantities(0, rawDiff);

      const sinceDate =
        toOptionalDateString(existing.currentEffectiveDate) ??
        toOptionalDateString(existing.effectiveDate) ??
        formatManilaDate(toDate(existing.recordedAt));
      const counts = await loadApplicableCountsForDate(tx, locked.id, sinceDate);

      const cov = evaluateOwnerCoverageSelection({
        enteredQuantity: Math.abs(rawDelta),
        allowDecimal,
        applicableReconciliations: counts.applicableReconciliations,
        openingCountCoversDate: counts.openingCountCoversDate,
        selection: input.coverage,
        requireExplicitWhenCountsExist: true,
        requireSnapshot: true,
      });
      if (!cov.ok) {
        if (cov.kind === "stale-review") {
          return buildStaleReviewOutcome(tx, locked.id, existing.id, counts);
        }
        return { kind: "invalid-coverage" as const, message: cov.message };
      }

      const appliedDelta =
        cov.deltaMagnitude === 0
          ? 0
          : rawDelta > 0
            ? cov.deltaMagnitude
            : subtractQuantities(0, cov.deltaMagnitude);

      const guard = checkNegativeMerchandiseGuard(locked, appliedDelta);
      if (guard) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "count-required-negative" as const,
          item: latestItem!,
          attemptedDelta: appliedDelta,
        };
      }

      const status: MovementCorrectionStatus = cov.entryStatus;
      const correctionId = await insertMovementCorrectionRow(tx, {
        movementId: existing.id,
        correctionKind: "QUANTITY",
        status,
        reason: input.reason,
        requestKey: input.requestKey,
        previousQuantity: prevQuantity,
        newQuantity: validatedNewQuantity,
        primaryItemId: locked.id,
        primaryRawDelta: rawDelta,
        primaryCoverageMode: cov.coverageMode,
        primaryCoveredQuantity: cov.coveredQuantity,
        primaryAppliedDelta: appliedDelta,
        primarySupportingReconciliationId: cov.supportingReconciliationId,
        primaryCoveredByOpeningCount: cov.coveredByOpeningCount,
        createdByUserId: input.actorUserId,
        createdAt: input.correctedAt,
        reviewedByUserId: status === "APPLIED" ? input.actorUserId : null,
        reviewedAt: status === "APPLIED" ? input.correctedAt : null,
        reviewNote: cov.reviewed ? (input.coverage.reviewNote ?? null) : null,
      });

      if (status === "APPLIED") {
        await tx.query(
          `UPDATE inventory_stock_movements
              SET current_quantity_value = $2,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [existing.id, validatedNewQuantity],
        );

        if (appliedDelta !== 0) {
          await applyCorrectionStockDelta(tx, {
            locked,
            appliedDelta,
            correctionId,
            actorUserId: input.actorUserId,
            appliedAt: input.correctedAt,
            effectiveDate: sinceDate,
            note: `Qty corrected (${prevQuantity} → ${validatedNewQuantity} ${locked.unit}): ${input.reason}`,
          });
        }
      }

      return hydrateCorrectionOutcomeById(tx, "applied", correctionId);
    });
  },

  async cancelSavedMovement(
    db: Database,
    input: {
      movementId: string;
      reason: string;
      expectedCorrectionVersion: number;
      expectedRevision: number;
      expectedCurrentQuantity: number;
      requestKey: string;
      actorUserId: string;
      cancelledAt: Date;
      coverage: LateCoverageSelectionInput;
    },
  ): Promise<MovementCorrectionActionResult> {
    return db.transaction(async (tx) => {
      const replayRow = await findCorrectionByRequestKey(tx, input.requestKey);
      if (replayRow) {
        if (
          replayRow.movementId !== input.movementId ||
          replayRow.correctionKind !== "CANCEL" ||
          replayRow.reason !== input.reason
        ) {
          return { kind: "key-conflict" as const };
        }
        return hydrateCorrectionOutcome(tx, "replayed", replayRow);
      }

      const seed = await loadMovementForCorrectionSeed(tx, input.movementId);
      if (!seed) {
        return { kind: "not-found" as const };
      }

      const itemMap = await lockInventoryItemsInOrder(tx, [seed.currentItemId ?? seed.itemId]);
      const locked = itemMap.get(seed.currentItemId ?? seed.itemId);
      if (!locked || locked.currentQuantity === null) {
        return { kind: "not-found" as const };
      }

      const existing = await lockMovementById(tx, input.movementId);
      if (!existing) {
        return { kind: "not-found" as const };
      }
      if (existing.movementType !== "STOCK_RECEIVED" && existing.movementType !== "STOCK_USED") {
        return { kind: "not-found" as const };
      }
      if (existing.isCancelled) {
        return { kind: "already-cancelled" as const };
      }
      if (await hasOpenPendingCorrectionForMovement(tx, existing.id)) {
        return {
          kind: "pending-conflict" as const,
          message: "Resolve the pending correction for this entry before cancelling it.",
        };
      }
      if (hasUnrecordedTargetUnitQuantity(existing)) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "different-unit-quantity-unrecorded" as const,
          item: latestItem!,
          originalUnit: existing.unit,
        };
      }

      const existingCorrectionVersion = Number(existing.correctionVersion ?? 0);
      if (existingCorrectionVersion !== input.expectedCorrectionVersion) {
        return buildStaleMovementOutcome(tx, locked.id, existing.id);
      }

      const allowDecimal = Boolean(locked.allowDecimalQuantity);
      const currentQuantity = Number(locked.currentQuantity);
      const stockRevision = Number(locked.stockRevision);
      const validatedBaseline = parseStoredBalanceBaseline(input.expectedCurrentQuantity, {
        allowDecimal,
        allowNegative: locked.category === "OPERATING_SUPPLY",
      });
      if (validatedBaseline === null) {
        return {
          kind: "invalid-baseline" as const,
          allowDecimalQuantity: allowDecimal,
          unit: locked.unit,
        };
      }
      if (
        stockRevision !== input.expectedRevision ||
        !quantitiesEqual(currentQuantity, validatedBaseline)
      ) {
        return buildStaleStockOutcome(tx, locked.id, existing.id);
      }

      const prevQuantity = getLatestMovementQuantity(existing);
      const sinceDate =
        toOptionalDateString(existing.currentEffectiveDate) ??
        toOptionalDateString(existing.effectiveDate) ??
        formatManilaDate(toDate(existing.recordedAt));

      // Pending late entries have never changed stock, so Owner can cancel them directly with zero stock delta.
      if (existing.entryStatus === "PENDING_REVIEW") {
        const correctionId = await insertMovementCorrectionRow(tx, {
          movementId: existing.id,
          correctionKind: "CANCEL",
          status: "APPLIED",
          reason: input.reason,
          requestKey: input.requestKey,
          previousQuantity: prevQuantity,
          newQuantity: 0,
          primaryItemId: locked.id,
          primaryRawDelta: 0,
          primaryCoverageMode: "FULL",
          primaryCoveredQuantity: prevQuantity,
          primaryAppliedDelta: 0,
          primarySupportingReconciliationId: null,
          primaryCoveredByOpeningCount: false,
          createdByUserId: input.actorUserId,
          createdAt: input.cancelledAt,
          reviewedByUserId: input.actorUserId,
          reviewedAt: input.cancelledAt,
          reviewNote: "Cancelled before pending late entry applied stock.",
        });

        await tx.query(
          `UPDATE inventory_stock_movements
              SET entry_status = 'APPLIED',
                  is_cancelled = true,
                  cancelled_at = $2,
                  cancelled_by_user_id = $3,
                  current_quantity_value = 0,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [existing.id, input.cancelledAt, input.actorUserId],
        );

        return hydrateCorrectionOutcomeById(tx, "applied", correctionId);
      }

      const counts = await loadApplicableCountsForDate(tx, locked.id, sinceDate);
      const alreadyAppliedNetDelta = await computeAppliedNetDeltaForMovement(tx, existing);
      const outstandingMagnitude =
        existing.movementType === "STOCK_RECEIVED"
          ? Math.min(prevQuantity, Math.max(0, alreadyAppliedNetDelta))
          : Math.min(prevQuantity, Math.max(0, subtractQuantities(0, alreadyAppliedNetDelta)));

      if (quantitiesEqual(outstandingMagnitude, 0)) {
        const latestRecId = counts.applicableReconciliations[0]?.id ?? null;
        if (
          input.coverage.expectedLatestReconciliationId !== latestRecId ||
          input.coverage.expectedOpeningCountCoversDate !== counts.openingCountCoversDate
        ) {
          return buildStaleReviewOutcome(tx, locked.id, existing.id, counts);
        }

        const correctionId = await insertMovementCorrectionRow(tx, {
          movementId: existing.id,
          correctionKind: "CANCEL",
          status: "APPLIED",
          reason: input.reason,
          requestKey: input.requestKey,
          previousQuantity: prevQuantity,
          newQuantity: 0,
          primaryItemId: locked.id,
          primaryRawDelta: 0,
          primaryCoverageMode: "FULL",
          primaryCoveredQuantity: prevQuantity,
          primaryAppliedDelta: 0,
          primarySupportingReconciliationId: null,
          primaryCoveredByOpeningCount: false,
          createdByUserId: input.actorUserId,
          createdAt: input.cancelledAt,
          reviewedByUserId: input.actorUserId,
          reviewedAt: input.cancelledAt,
          reviewNote: "Full stock effect was already covered by physical count; cancelled with 0 further stock change.",
        });

        await tx.query(
          `UPDATE inventory_stock_movements
              SET is_cancelled = true,
                  cancelled_at = $2,
                  cancelled_by_user_id = $3,
                  current_quantity_value = 0,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [existing.id, input.cancelledAt, input.actorUserId],
        );

        return hydrateCorrectionOutcomeById(tx, "applied", correctionId);
      }

      const rawDelta =
        existing.movementType === "STOCK_RECEIVED"
          ? subtractQuantities(0, outstandingMagnitude)
          : outstandingMagnitude;

      const cov = evaluateOwnerCoverageSelection({
        enteredQuantity: outstandingMagnitude,
        allowDecimal,
        applicableReconciliations: counts.applicableReconciliations,
        openingCountCoversDate: counts.openingCountCoversDate,
        selection: input.coverage,
        requireExplicitWhenCountsExist: true,
        requireSnapshot: true,
      });
      if (!cov.ok) {
        if (cov.kind === "stale-review") {
          return buildStaleReviewOutcome(tx, locked.id, existing.id, counts);
        }
        return { kind: "invalid-coverage" as const, message: cov.message };
      }

      const appliedDelta =
        cov.deltaMagnitude === 0
          ? 0
          : rawDelta > 0
            ? cov.deltaMagnitude
            : subtractQuantities(0, cov.deltaMagnitude);

      const guard = checkNegativeMerchandiseGuard(locked, appliedDelta);
      if (guard) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "count-required-negative" as const,
          item: latestItem!,
          attemptedDelta: appliedDelta,
        };
      }

      const status: MovementCorrectionStatus = cov.entryStatus;
      const correctionId = await insertMovementCorrectionRow(tx, {
        movementId: existing.id,
        correctionKind: "CANCEL",
        status,
        reason: input.reason,
        requestKey: input.requestKey,
        previousQuantity: prevQuantity,
        newQuantity: 0,
        primaryItemId: locked.id,
        primaryRawDelta: rawDelta,
        primaryCoverageMode: cov.coverageMode,
        primaryCoveredQuantity: cov.coveredQuantity,
        primaryAppliedDelta: appliedDelta,
        primarySupportingReconciliationId: cov.supportingReconciliationId,
        primaryCoveredByOpeningCount: cov.coveredByOpeningCount,
        createdByUserId: input.actorUserId,
        createdAt: input.cancelledAt,
        reviewedByUserId: status === "APPLIED" ? input.actorUserId : null,
        reviewedAt: status === "APPLIED" ? input.cancelledAt : null,
        reviewNote: cov.reviewed ? (input.coverage.reviewNote ?? null) : null,
      });

      if (status === "APPLIED") {
        await tx.query(
          `UPDATE inventory_stock_movements
              SET is_cancelled = true,
                  cancelled_at = $2,
                  cancelled_by_user_id = $3,
                  current_quantity_value = 0,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [existing.id, input.cancelledAt, input.actorUserId],
        );

        if (appliedDelta !== 0) {
          await applyCorrectionStockDelta(tx, {
            locked,
            appliedDelta,
            correctionId,
            actorUserId: input.actorUserId,
            appliedAt: input.cancelledAt,
            effectiveDate: sinceDate,
            note: `Cancelled ${existing.movementType === "STOCK_RECEIVED" ? "Stock Received" : "Stock Used"} (${prevQuantity} ${locked.unit}): ${input.reason}`,
          });
        }
      }

      return hydrateCorrectionOutcomeById(tx, "applied", correctionId);
    });
  },

  async correctReceiptItem(
    db: Database,
    input: {
      movementId: string;
      newItemTarget: OpeningStockTarget;
      reason: string;
      expectedCorrectionVersion: number;
      expectedPrimaryRevision: number;
      expectedPrimaryQuantity: number;
      expectedSecondaryRevision: number;
      expectedSecondaryQuantity: number;
      requestKey: string;
      actorUserId: string;
      correctedAt: Date;
      primaryCoverage: LateCoverageSelectionInput;
      secondaryCoverage: LateCoverageSelectionInput;
      differentUnitReconciliation?: {
        primarySupportingReconciliationId: string | null;
        secondarySupportingReconciliationId: string | null;
      };
    },
  ): Promise<MovementCorrectionActionResult> {
    return db.transaction(async (tx) => {
      const replayRow = await findCorrectionByRequestKey(tx, input.requestKey);
      if (replayRow) {
        const targetItem = await findItemByTarget(tx, input.newItemTarget);
        if (
          !targetItem ||
          replayRow.movementId !== input.movementId ||
          replayRow.correctionKind !== "RECEIPT_ITEM" ||
          replayRow.newItemId !== targetItem.id ||
          replayRow.reason !== input.reason
        ) {
          return { kind: "key-conflict" as const };
        }
        return hydrateCorrectionOutcome(tx, "replayed", replayRow);
      }

      const seed = await loadMovementForCorrectionSeed(tx, input.movementId);
      if (!seed) {
        return { kind: "not-found" as const };
      }

      const resolvedTargetItem = await findItemByTarget(tx, input.newItemTarget);
      if (!resolvedTargetItem) {
        return { kind: "not-found" as const };
      }

      const wrongItemId = seed.currentItemId ?? seed.itemId;
      const correctItemId = resolvedTargetItem.id;
      if (wrongItemId === correctItemId) {
        return {
          kind: "invalid-target" as const,
          message: "Choose a different Inventory item for the receipt correction.",
        };
      }

      const itemMap = await lockInventoryItemsInOrder(tx, [wrongItemId, correctItemId]);
      const wrongLocked = itemMap.get(wrongItemId);
      const correctLocked = itemMap.get(correctItemId);
      if (!wrongLocked || !correctLocked) {
        return { kind: "not-found" as const };
      }

      const existing = await lockMovementById(tx, input.movementId);
      if (!existing) {
        return { kind: "not-found" as const };
      }
      if (existing.movementType !== "STOCK_RECEIVED") {
        return {
          kind: "invalid-target" as const,
          message: "Only saved Stock Received entries can switch items; cancel wrong-supply Stock Used and record against the right supply.",
        };
      }
      if (existing.isCancelled) {
        return { kind: "already-cancelled" as const };
      }
      if (existing.entryStatus !== "APPLIED") {
        return {
          kind: "pending-conflict" as const,
          message: "Resolve the pending late-entry review before switching its receipt item.",
        };
      }
      if (await hasOpenPendingCorrectionForMovement(tx, existing.id)) {
        return {
          kind: "pending-conflict" as const,
          message: "Resolve the pending correction for this entry before making another change.",
        };
      }
      if (hasUnrecordedTargetUnitQuantity(existing)) {
        const latestItem = await findItemById(tx, wrongLocked.id);
        return {
          kind: "different-unit-quantity-unrecorded" as const,
          item: latestItem!,
          originalUnit: existing.unit,
        };
      }
      if (correctLocked.archivedAt !== null) {
        return {
          kind: "archived" as const,
          message: "Archived products cannot receive corrected stock entries.",
        };
      }
      if (wrongLocked.currentQuantity === null || correctLocked.currentQuantity === null) {
        return {
          kind: "not-set" as const,
          message: "Record an opening stock count on both items before transferring a receipt.",
        };
      }

      const existingCorrectionVersion = Number(existing.correctionVersion ?? 0);
      if (existingCorrectionVersion !== input.expectedCorrectionVersion) {
        return buildStaleMovementOutcome(tx, wrongLocked.id, existing.id, correctLocked.id);
      }

      const wrongBaseline = parseStoredBalanceBaseline(input.expectedPrimaryQuantity, {
        allowDecimal: Boolean(wrongLocked.allowDecimalQuantity),
        allowNegative: wrongLocked.category === "OPERATING_SUPPLY",
      });
      const correctBaseline = parseStoredBalanceBaseline(input.expectedSecondaryQuantity, {
        allowDecimal: Boolean(correctLocked.allowDecimalQuantity),
        allowNegative: correctLocked.category === "OPERATING_SUPPLY",
      });
      if (wrongBaseline === null || correctBaseline === null) {
        return {
          kind: "invalid-baseline" as const,
          allowDecimalQuantity: Boolean(wrongLocked.allowDecimalQuantity),
          unit: wrongLocked.unit,
        };
      }

      const wrongQtyNow = Number(wrongLocked.currentQuantity);
      const correctQtyNow = Number(correctLocked.currentQuantity);
      if (
        Number(wrongLocked.stockRevision) !== input.expectedPrimaryRevision ||
        !quantitiesEqual(wrongQtyNow, wrongBaseline)
      ) {
        return buildStaleStockOutcome(tx, wrongLocked.id, existing.id, correctLocked.id);
      }
      if (
        Number(correctLocked.stockRevision) !== input.expectedSecondaryRevision ||
        !quantitiesEqual(correctQtyNow, correctBaseline)
      ) {
        return buildStaleStockOutcome(tx, wrongLocked.id, existing.id, correctLocked.id);
      }

      const receiptQuantity = getLatestMovementQuantity(existing);
      const sinceDate =
        toOptionalDateString(existing.currentEffectiveDate) ??
        toOptionalDateString(existing.effectiveDate) ??
        formatManilaDate(toDate(existing.recordedAt));
      const [wrongCounts, correctCounts] = await Promise.all([
        loadApplicableCountsForDate(tx, wrongLocked.id, sinceDate),
        loadApplicableCountsForDate(tx, correctLocked.id, sinceDate),
      ]);

      const unitsMatch =
        wrongLocked.unit.trim().toLowerCase() === correctLocked.unit.trim().toLowerCase();
      const qtyFitsTargetItem =
        parseQuantity(receiptQuantity, {
          allowDecimal: Boolean(correctLocked.allowDecimalQuantity),
          allowZero: false,
        }) !== null;

      // INV-036: different units (or whole-piece unit mismatch) require both items to be reconciled in their own units first.
      if (!unitsMatch || !qtyFitsTargetItem) {
        const primaryRecId =
          input.differentUnitReconciliation?.primarySupportingReconciliationId ?? null;
        const secondaryRecId =
          input.differentUnitReconciliation?.secondarySupportingReconciliationId ?? null;
        const primaryRecOk =
          primaryRecId !== null &&
          wrongCounts.applicableReconciliations.some((r) => r.id === primaryRecId);
        const secondaryRecOk =
          secondaryRecId !== null &&
          correctCounts.applicableReconciliations.some((r) => r.id === secondaryRecId);

        if (!primaryRecOk || !secondaryRecOk) {
          const [primaryItem, secondaryItem] = await Promise.all([
            findItemById(tx, wrongLocked.id),
            findItemById(tx, correctLocked.id),
          ]);
          return {
            kind: "different-unit-reconciliation-required" as const,
            primaryItem: primaryItem!,
            secondaryItem: secondaryItem!,
            primaryApplicableReconciliations: wrongCounts.applicableReconciliations,
            secondaryApplicableReconciliations: correctCounts.applicableReconciliations,
          };
        }

        const correctionId = await insertMovementCorrectionRow(tx, {
          movementId: existing.id,
          correctionKind: "RECEIPT_ITEM",
          status: "APPLIED",
          reason: input.reason,
          requestKey: input.requestKey,
          previousQuantity: receiptQuantity,
          newQuantity: null,
          previousItemId: wrongLocked.id,
          newItemId: correctLocked.id,
          previousUnit: wrongLocked.unit,
          newUnit: correctLocked.unit,
          primaryItemId: wrongLocked.id,
          primaryRawDelta: 0,
          primaryCoverageMode: "DIFFERENT_UNIT_RECONCILED",
          primaryCoveredQuantity: receiptQuantity,
          primaryAppliedDelta: 0,
          primarySupportingReconciliationId: primaryRecId,
          primaryCoveredByOpeningCount: false,
          secondaryItemId: correctLocked.id,
          secondaryRawDelta: 0,
          secondaryCoverageMode: "DIFFERENT_UNIT_RECONCILED",
          secondaryCoveredQuantity: 0,
          secondaryAppliedDelta: 0,
          secondarySupportingReconciliationId: secondaryRecId,
          secondaryCoveredByOpeningCount: false,
          createdByUserId: input.actorUserId,
          createdAt: input.correctedAt,
          reviewedByUserId: input.actorUserId,
          reviewedAt: input.correctedAt,
          reviewNote: "Different stock units reconciled separately; saved history with zero stock change.",
        });

        await tx.query(
          `UPDATE inventory_stock_movements
              SET current_item_id = $2,
                  current_quantity_value = NULL,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [existing.id, correctLocked.id],
        );

        return hydrateCorrectionOutcomeById(tx, "applied", correctionId);
      }

      // INV-032..035: same-unit two-item review evaluated independently on wrong (-Q) and correct (+Q) items.
      const wrongCov = evaluateOwnerCoverageSelection({
        enteredQuantity: receiptQuantity,
        allowDecimal: Boolean(wrongLocked.allowDecimalQuantity),
        applicableReconciliations: wrongCounts.applicableReconciliations,
        openingCountCoversDate: wrongCounts.openingCountCoversDate,
        selection: input.primaryCoverage,
        requireExplicitWhenCountsExist: true,
        requireSnapshot: true,
      });
      if (!wrongCov.ok) {
        if (wrongCov.kind === "stale-review") {
          return buildStaleDualReviewOutcome(
            tx,
            wrongLocked.id,
            correctLocked.id,
            existing.id,
            wrongCounts,
            correctCounts,
          );
        }
        return { kind: "invalid-coverage" as const, message: wrongCov.message };
      }

      const correctCov = evaluateOwnerCoverageSelection({
        enteredQuantity: receiptQuantity,
        allowDecimal: Boolean(correctLocked.allowDecimalQuantity),
        applicableReconciliations: correctCounts.applicableReconciliations,
        openingCountCoversDate: correctCounts.openingCountCoversDate,
        selection: input.secondaryCoverage,
        requireExplicitWhenCountsExist: true,
        requireSnapshot: true,
      });
      if (!correctCov.ok) {
        if (correctCov.kind === "stale-review") {
          return buildStaleDualReviewOutcome(
            tx,
            wrongLocked.id,
            correctLocked.id,
            existing.id,
            wrongCounts,
            correctCounts,
          );
        }
        return { kind: "invalid-coverage" as const, message: correctCov.message };
      }

      const isAnyUnclear =
        wrongCov.entryStatus === "PENDING_REVIEW" || correctCov.entryStatus === "PENDING_REVIEW";
      const wrongAppliedDelta = isAnyUnclear
        ? 0
        : wrongCov.deltaMagnitude === 0
          ? 0
          : subtractQuantities(0, wrongCov.deltaMagnitude);
      const correctAppliedDelta = isAnyUnclear ? 0 : correctCov.deltaMagnitude;

      if (!isAnyUnclear) {
        const guard = checkNegativeMerchandiseGuard(wrongLocked, wrongAppliedDelta);
        if (guard) {
          const latestWrong = await findItemById(tx, wrongLocked.id);
          return {
            kind: "count-required-negative" as const,
            item: latestWrong!,
            attemptedDelta: wrongAppliedDelta,
          };
        }
      }

      const status: MovementCorrectionStatus = isAnyUnclear ? "PENDING_REVIEW" : "APPLIED";
      const correctionId = await insertMovementCorrectionRow(tx, {
        movementId: existing.id,
        correctionKind: "RECEIPT_ITEM",
        status,
        reason: input.reason,
        requestKey: input.requestKey,
        previousQuantity: receiptQuantity,
        newQuantity: receiptQuantity,
        previousItemId: wrongLocked.id,
        newItemId: correctLocked.id,
        previousUnit: wrongLocked.unit,
        newUnit: correctLocked.unit,
        primaryItemId: wrongLocked.id,
        primaryRawDelta: subtractQuantities(0, receiptQuantity),
        primaryCoverageMode: wrongCov.coverageMode,
        primaryCoveredQuantity: wrongCov.coveredQuantity,
        primaryAppliedDelta: wrongAppliedDelta,
        primarySupportingReconciliationId: wrongCov.supportingReconciliationId,
        primaryCoveredByOpeningCount: wrongCov.coveredByOpeningCount,
        secondaryItemId: correctLocked.id,
        secondaryRawDelta: receiptQuantity,
        secondaryCoverageMode: correctCov.coverageMode,
        secondaryCoveredQuantity: correctCov.coveredQuantity,
        secondaryAppliedDelta: correctAppliedDelta,
        secondarySupportingReconciliationId: correctCov.supportingReconciliationId,
        secondaryCoveredByOpeningCount: correctCov.coveredByOpeningCount,
        createdByUserId: input.actorUserId,
        createdAt: input.correctedAt,
        reviewedByUserId: status === "APPLIED" ? input.actorUserId : null,
        reviewedAt: status === "APPLIED" ? input.correctedAt : null,
        reviewNote:
          input.primaryCoverage.reviewNote ?? input.secondaryCoverage.reviewNote ?? null,
      });

      if (status === "APPLIED") {
        if (wrongAppliedDelta !== 0) {
          await applyCorrectionStockDelta(tx, {
            locked: wrongLocked,
            appliedDelta: wrongAppliedDelta,
            correctionId,
            actorUserId: input.actorUserId,
            appliedAt: input.correctedAt,
            effectiveDate: sinceDate,
            note: `Wrong-item receipt moved to ${correctLocked.name} (${receiptQuantity} ${wrongLocked.unit}): ${input.reason}`,
          });
        }
        if (correctAppliedDelta !== 0) {
          await applyCorrectionStockDelta(tx, {
            locked: correctLocked,
            appliedDelta: correctAppliedDelta,
            correctionId,
            actorUserId: input.actorUserId,
            appliedAt: input.correctedAt,
            effectiveDate: sinceDate,
            note: `Receipt reassigned from ${wrongLocked.name} (${receiptQuantity} ${correctLocked.unit}): ${input.reason}`,
          });
        }
        await tx.query(
          `UPDATE inventory_stock_movements
              SET current_item_id = $2,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [existing.id, correctLocked.id],
        );
      }

      return hydrateCorrectionOutcomeById(tx, "applied", correctionId);
    });
  },

  async correctMovementMetadata(
    db: Database,
    input: {
      movementId: string;
      effectiveDateProvided: boolean;
      newEffectiveDate: string | null;
      noteProvided: boolean;
      newNote: string | null;
      reason: string;
      expectedCorrectionVersion: number;
      expectedRevision: number;
      expectedCurrentQuantity: number;
      requestKey: string;
      actorUserId: string;
      correctedAt: Date;
      coverage?: LateCoverageSelectionInput;
    },
  ): Promise<MovementCorrectionActionResult> {
    return db.transaction(async (tx) => {
      const replayRow = await findCorrectionByRequestKey(tx, input.requestKey);
      if (replayRow) {
        if (
          replayRow.movementId !== input.movementId ||
          replayRow.correctionKind !== "METADATA" ||
          replayRow.reason !== input.reason
        ) {
          return { kind: "key-conflict" as const };
        }
        return hydrateCorrectionOutcome(tx, "replayed", replayRow);
      }

      const seed = await loadMovementForCorrectionSeed(tx, input.movementId);
      if (!seed) {
        return { kind: "not-found" as const };
      }

      const itemMap = await lockInventoryItemsInOrder(tx, [seed.currentItemId ?? seed.itemId]);
      const locked = itemMap.get(seed.currentItemId ?? seed.itemId);
      if (!locked || locked.currentQuantity === null) {
        return { kind: "not-found" as const };
      }

      const existing = await lockMovementById(tx, input.movementId);
      if (!existing) {
        return { kind: "not-found" as const };
      }
      if (existing.movementType !== "STOCK_RECEIVED" && existing.movementType !== "STOCK_USED") {
        return { kind: "not-found" as const };
      }
      if (existing.isCancelled) {
        return { kind: "already-cancelled" as const };
      }
      if (existing.entryStatus !== "APPLIED") {
        return {
          kind: "pending-conflict" as const,
          message: "Resolve the pending late-entry review before changing its date or note.",
        };
      }
      if (await hasOpenPendingCorrectionForMovement(tx, existing.id)) {
        return {
          kind: "pending-conflict" as const,
          message: "Resolve the pending correction for this entry before making another change.",
        };
      }

      const existingCorrectionVersion = Number(existing.correctionVersion ?? 0);
      if (existingCorrectionVersion !== input.expectedCorrectionVersion) {
        return buildStaleMovementOutcome(tx, locked.id, existing.id);
      }

      const allowDecimal = Boolean(locked.allowDecimalQuantity);
      const currentQuantity = Number(locked.currentQuantity);
      const stockRevision = Number(locked.stockRevision);
      const validatedBaseline = parseStoredBalanceBaseline(input.expectedCurrentQuantity, {
        allowDecimal,
        allowNegative: locked.category === "OPERATING_SUPPLY",
      });
      if (validatedBaseline === null) {
        return {
          kind: "invalid-baseline" as const,
          allowDecimalQuantity: allowDecimal,
          unit: locked.unit,
        };
      }
      if (
        stockRevision !== input.expectedRevision ||
        !quantitiesEqual(currentQuantity, validatedBaseline)
      ) {
        return buildStaleStockOutcome(tx, locked.id, existing.id);
      }

      const oldDate =
        toOptionalDateString(existing.currentEffectiveDate) ??
        toOptionalDateString(existing.effectiveDate) ??
        formatManilaDate(toDate(existing.recordedAt));
      const nextDate = input.effectiveDateProvided && input.newEffectiveDate
        ? input.newEffectiveDate
        : oldDate;
      const oldNote = existing.currentNote ?? null;
      const nextNote = input.noteProvided ? input.newNote : oldNote;

      if (existing.movementType === "STOCK_USED" && input.noteProvided && !nextNote) {
        return {
          kind: "invalid-coverage" as const,
          message: "Enter a short purpose note for Stock Used (1 to 240 characters).",
        };
      }
      if (nextDate === oldDate && nextNote === oldNote) {
        return {
          kind: "invalid-coverage" as const,
          message: "Change the actual date or note before saving.",
        };
      }

      const dateChanged = nextDate !== oldDate;
      let countsChanged = false;
      let newCounts = await loadApplicableCountsForDate(tx, locked.id, nextDate);
      if (dateChanged) {
        const oldCounts = await loadApplicableCountsForDate(tx, locked.id, oldDate);
        countsChanged = !hasSameApplicableCountSet(oldCounts, newCounts);
      }

      const unrecordedCrossUnitQty = hasUnrecordedTargetUnitQuantity(existing);
      const latestQty = unrecordedCrossUnitQty ? null : getLatestMovementQuantity(existing);
      const alreadyAppliedNetDelta = await computeAppliedNetDeltaForMovement(tx, existing);
      const fullSignedEffect =
        latestQty === null
          ? 0
          : existing.movementType === "STOCK_RECEIVED"
            ? latestQty
            : subtractQuantities(0, latestQty);

      if (!countsChanged) {
        const correctionId = await insertMovementCorrectionRow(tx, {
          movementId: existing.id,
          correctionKind: "METADATA",
          status: "APPLIED",
          reason: input.reason,
          requestKey: input.requestKey,
          previousQuantity: latestQty,
          newQuantity: latestQty,
          previousEffectiveDate: oldDate,
          newEffectiveDate: nextDate,
          previousNote: oldNote,
          newNote: nextNote,
          primaryItemId: locked.id,
          primaryRawDelta: 0,
          primaryCoverageMode: null,
          primaryCoveredQuantity: 0,
          primaryAppliedDelta: 0,
          primarySupportingReconciliationId: null,
          primaryCoveredByOpeningCount: false,
          createdByUserId: input.actorUserId,
          createdAt: input.correctedAt,
          reviewedByUserId: input.actorUserId,
          reviewedAt: input.correctedAt,
          reviewNote: dateChanged
            ? "Date updated with no change to applicable physical counts."
            : "Note/purpose updated with zero stock change.",
        });

        await tx.query(
          `UPDATE inventory_stock_movements
              SET current_effective_date = $2::date,
                  current_note = $3,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [existing.id, nextDate, nextNote],
        );

        return hydrateCorrectionOutcomeById(tx, "applied", correctionId);
      }

      if (unrecordedCrossUnitQty || latestQty === null) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "different-unit-quantity-unrecorded" as const,
          item: latestItem!,
          originalUnit: existing.unit,
        };
      }

      // Date crossed one or more physical counts (INV-043): require Owner count review before applying any stock change.
      const selection = input.coverage ?? {};
      if (selection.coverageMode === undefined || selection.coverageMode === null) {
        const correctionId = await insertMovementCorrectionRow(tx, {
          movementId: existing.id,
          correctionKind: "METADATA",
          status: "PENDING_REVIEW",
          reason: input.reason,
          requestKey: input.requestKey,
          previousQuantity: latestQty,
          newQuantity: latestQty,
          previousEffectiveDate: oldDate,
          newEffectiveDate: nextDate,
          previousNote: oldNote,
          newNote: nextNote,
          primaryItemId: locked.id,
          primaryRawDelta: subtractQuantities(fullSignedEffect, alreadyAppliedNetDelta),
          primaryCoverageMode: "UNCLEAR",
          primaryCoveredQuantity: 0,
          primaryAppliedDelta: 0,
          primarySupportingReconciliationId: null,
          primaryCoveredByOpeningCount: false,
          createdByUserId: input.actorUserId,
          createdAt: input.correctedAt,
          reviewedByUserId: null,
          reviewedAt: null,
          reviewNote: null,
        });

        return hydrateCorrectionOutcomeById(tx, "applied", correctionId);
      }

      const cov = evaluateOwnerCoverageSelection({
        enteredQuantity: latestQty,
        allowDecimal,
        applicableReconciliations: newCounts.applicableReconciliations,
        openingCountCoversDate: newCounts.openingCountCoversDate,
        selection,
        requireExplicitWhenCountsExist: true,
        requireSnapshot: true,
      });
      if (!cov.ok) {
        if (cov.kind === "stale-review") {
          return buildStaleReviewOutcome(tx, locked.id, existing.id, newCounts);
        }
        return { kind: "invalid-coverage" as const, message: cov.message };
      }

      if (cov.entryStatus === "PENDING_REVIEW") {
        const correctionId = await insertMovementCorrectionRow(tx, {
          movementId: existing.id,
          correctionKind: "METADATA",
          status: "PENDING_REVIEW",
          reason: input.reason,
          requestKey: input.requestKey,
          previousQuantity: latestQty,
          newQuantity: latestQty,
          previousEffectiveDate: oldDate,
          newEffectiveDate: nextDate,
          previousNote: oldNote,
          newNote: nextNote,
          primaryItemId: locked.id,
          primaryRawDelta: subtractQuantities(fullSignedEffect, alreadyAppliedNetDelta),
          primaryCoverageMode: "UNCLEAR",
          primaryCoveredQuantity: 0,
          primaryAppliedDelta: 0,
          primarySupportingReconciliationId: null,
          primaryCoveredByOpeningCount: false,
          createdByUserId: input.actorUserId,
          createdAt: input.correctedAt,
          reviewedByUserId: null,
          reviewedAt: null,
          reviewNote: null,
        });
        return hydrateCorrectionOutcomeById(tx, "applied", correctionId);
      }

      const targetNetDelta =
        cov.deltaMagnitude === 0
          ? 0
          : existing.movementType === "STOCK_RECEIVED"
            ? cov.deltaMagnitude
            : subtractQuantities(0, cov.deltaMagnitude);
      const rawAdjustmentDelta = subtractQuantities(targetNetDelta, alreadyAppliedNetDelta);

      const guard = checkNegativeMerchandiseGuard(locked, rawAdjustmentDelta);
      if (guard) {
        const latestItem = await findItemById(tx, locked.id);
        return {
          kind: "count-required-negative" as const,
          item: latestItem!,
          attemptedDelta: rawAdjustmentDelta,
        };
      }

      const correctionId = await insertMovementCorrectionRow(tx, {
        movementId: existing.id,
        correctionKind: "METADATA",
        status: "APPLIED",
        reason: input.reason,
        requestKey: input.requestKey,
        previousQuantity: latestQty,
        newQuantity: latestQty,
        previousEffectiveDate: oldDate,
        newEffectiveDate: nextDate,
        previousNote: oldNote,
        newNote: nextNote,
        primaryItemId: locked.id,
        primaryRawDelta: rawAdjustmentDelta,
        primaryCoverageMode: cov.coverageMode,
        primaryCoveredQuantity: cov.coveredQuantity,
        primaryAppliedDelta: rawAdjustmentDelta,
        primarySupportingReconciliationId: cov.supportingReconciliationId,
        primaryCoveredByOpeningCount: cov.coveredByOpeningCount,
        createdByUserId: input.actorUserId,
        createdAt: input.correctedAt,
        reviewedByUserId: input.actorUserId,
        reviewedAt: input.correctedAt,
        reviewNote: selection.reviewNote ?? null,
      });

      await tx.query(
        `UPDATE inventory_stock_movements
            SET current_effective_date = $2::date,
                current_note = $3,
                correction_version = correction_version + 1
          WHERE id = $1`,
        [existing.id, nextDate, nextNote],
      );

      if (rawAdjustmentDelta !== 0) {
        await applyCorrectionStockDelta(tx, {
          locked,
          appliedDelta: rawAdjustmentDelta,
          correctionId,
          actorUserId: input.actorUserId,
          appliedAt: input.correctedAt,
          effectiveDate: nextDate,
          note: `Date corrected (${oldDate} → ${nextDate}): ${input.reason}`,
        });
      }

      return hydrateCorrectionOutcomeById(tx, "applied", correctionId);
    });
  },

  async resolvePendingMovementCorrection(
    db: Database,
    input: {
      correctionId: string;
      expectedPrimaryRevision: number;
      expectedPrimaryQuantity: number;
      expectedSecondaryRevision?: number;
      expectedSecondaryQuantity?: number;
      requestKey: string;
      reviewerUserId: string;
      reviewedAt: Date;
      primaryCoverage: LateCoverageSelectionInput;
      secondaryCoverage?: LateCoverageSelectionInput;
    },
  ): Promise<MovementCorrectionActionResult> {
    return db.transaction(async (tx) => {
      const replayRow = await findCorrectionByReviewRequestKey(tx, input.requestKey);
      if (replayRow) {
        if (replayRow.id !== input.correctionId) {
          return { kind: "key-conflict" as const };
        }
        return hydrateCorrectionOutcome(tx, "replayed", replayRow);
      }

      const { rows: seedRows } = await tx.query<{
        id: string;
        movementId: string;
        primaryItemId: string;
        secondaryItemId: string | null;
      }>(
        `SELECT id,
                movement_id AS "movementId",
                primary_item_id AS "primaryItemId",
                secondary_item_id AS "secondaryItemId"
           FROM inventory_movement_corrections
          WHERE id = $1`,
        [input.correctionId],
      );
      const seed = seedRows[0];
      if (!seed) {
        return { kind: "not-found" as const };
      }

      const itemIds = seed.secondaryItemId
        ? [seed.primaryItemId, seed.secondaryItemId]
        : [seed.primaryItemId];
      const itemMap = await lockInventoryItemsInOrder(tx, itemIds);
      const primaryLocked = itemMap.get(seed.primaryItemId);
      if (!primaryLocked || primaryLocked.currentQuantity === null) {
        return { kind: "not-found" as const };
      }
      const secondaryLocked = seed.secondaryItemId ? (itemMap.get(seed.secondaryItemId) ?? null) : null;
      if (seed.secondaryItemId && (!secondaryLocked || secondaryLocked.currentQuantity === null)) {
        return { kind: "not-found" as const };
      }

      const { rows: corrLockRows } = await tx.query<MovementCorrectionDbRow>(
        `${CORRECTION_SELECT} WHERE mc.id = $1 FOR UPDATE OF mc`,
        [input.correctionId],
      );
      const pendingCorr = corrLockRows[0];
      if (!pendingCorr) {
        return { kind: "not-found" as const };
      }
      if (pendingCorr.status !== "PENDING_REVIEW") {
        const hydrated = await hydrateCorrectionOutcome(tx, "replayed", pendingCorr);
        return {
          kind: "already-resolved" as const,
          primaryItem: hydrated.primaryItem,
          secondaryItem: hydrated.secondaryItem,
          movement: hydrated.movement,
          correction: hydrated.correction,
        };
      }

      const existing = await lockMovementById(tx, pendingCorr.movementId);
      if (!existing) {
        return { kind: "not-found" as const };
      }

      const primaryBaseline = parseStoredBalanceBaseline(input.expectedPrimaryQuantity, {
        allowDecimal: Boolean(primaryLocked.allowDecimalQuantity),
        allowNegative: primaryLocked.category === "OPERATING_SUPPLY",
      });
      if (primaryBaseline === null) {
        return {
          kind: "invalid-baseline" as const,
          allowDecimalQuantity: Boolean(primaryLocked.allowDecimalQuantity),
          unit: primaryLocked.unit,
        };
      }
      if (
        Number(primaryLocked.stockRevision) !== input.expectedPrimaryRevision ||
        !quantitiesEqual(Number(primaryLocked.currentQuantity), primaryBaseline)
      ) {
        return buildStaleStockOutcome(
          tx,
          primaryLocked.id,
          existing.id,
          secondaryLocked?.id,
        );
      }

      if (secondaryLocked) {
        if (
          input.expectedSecondaryRevision === undefined ||
          input.expectedSecondaryQuantity === undefined
        ) {
          return {
            kind: "invalid-baseline" as const,
            allowDecimalQuantity: Boolean(secondaryLocked.allowDecimalQuantity),
            unit: secondaryLocked.unit,
          };
        }
        const secondaryBaseline = parseStoredBalanceBaseline(input.expectedSecondaryQuantity, {
          allowDecimal: Boolean(secondaryLocked.allowDecimalQuantity),
          allowNegative: secondaryLocked.category === "OPERATING_SUPPLY",
        });
        if (secondaryBaseline === null) {
          return {
            kind: "invalid-baseline" as const,
            allowDecimalQuantity: Boolean(secondaryLocked.allowDecimalQuantity),
            unit: secondaryLocked.unit,
          };
        }
        if (
          Number(secondaryLocked.stockRevision) !== input.expectedSecondaryRevision ||
          !quantitiesEqual(Number(secondaryLocked.currentQuantity), secondaryBaseline)
        ) {
          return buildStaleStockOutcome(
            tx,
            primaryLocked.id,
            existing.id,
            secondaryLocked.id,
          );
        }
      }

      const sinceDate =
        toOptionalDateString(pendingCorr.newEffectiveDate) ??
        toOptionalDateString(existing.currentEffectiveDate) ??
        toOptionalDateString(existing.effectiveDate) ??
        formatManilaDate(toDate(existing.recordedAt));
      const primaryCounts = await loadApplicableCountsForDate(tx, primaryLocked.id, sinceDate);
      const secondaryCounts = secondaryLocked
        ? await loadApplicableCountsForDate(tx, secondaryLocked.id, sinceDate)
        : { applicableReconciliations: [], openingCountCoversDate: false };

      const primaryMode = input.primaryCoverage.coverageMode;
      if (primaryMode !== "NONE" && primaryMode !== "FULL" && primaryMode !== "PARTIAL") {
        return {
          kind: "invalid-coverage" as const,
          message: "Choose No Coverage, Full Coverage, or Partial Coverage to resolve a pending correction.",
        };
      }

      let primaryAppliedDelta = 0;
      let primaryCovMode: CorrectionCoverageMode = "FULL";
      let primaryCoveredQty = 0;
      let primaryRecId: string | null = null;
      let primaryByOpen = false;
      let secondaryAppliedDelta = 0;
      let secondaryCovMode: CorrectionCoverageMode | null = null;
      let secondaryCoveredQty = 0;
      let secondaryRecId: string | null = null;
      let secondaryByOpen = false;
      let effectiveRawDeltaForMetadata = Number(pendingCorr.primaryRawDelta);

      if (
        pendingCorr.correctionKind === "QUANTITY" ||
        pendingCorr.correctionKind === "CANCEL"
      ) {
        // Finding 1 / INV-019, INV-022: unclear quantity or cancellation corrections must be reconciled
        // with a new physical count recorded after the pending correction and resolve with 0 further stock effect.
        const latestRecId = primaryCounts.applicableReconciliations[0]?.id ?? null;
        if (
          input.primaryCoverage.expectedLatestReconciliationId !== latestRecId ||
          input.primaryCoverage.expectedOpeningCountCoversDate !==
            primaryCounts.openingCountCoversDate
        ) {
          return buildStaleReviewOutcome(
            tx,
            primaryLocked.id,
            existing.id,
            primaryCounts,
            pendingCorr.id,
          );
        }

        if (primaryMode !== "FULL") {
          return {
            kind: "invalid-coverage" as const,
            message:
              "Unclear quantity or cancellation corrections must be resolved with Full Coverage (0 further stock effect) after recording a new physical count.",
          };
        }

        if (input.primaryCoverage.coveredByOpeningCount) {
          const latestPrimary = await findItemById(tx, primaryLocked.id);
          return {
            kind: "count-required-unclear" as const,
            item: latestPrimary!,
          };
        }

        const selectedRecId = input.primaryCoverage.supportingReconciliationId ?? null;
        const qualifyingRecIds = await listReconciliationIdsRecordedAfterCorrection(
          tx,
          primaryLocked.id,
          pendingCorr.id,
        );
        const selectedRec =
          selectedRecId && qualifyingRecIds.includes(selectedRecId)
            ? primaryCounts.applicableReconciliations.find((rec) => rec.id === selectedRecId)
            : undefined;
        if (!selectedRec) {
          const latestPrimary = await findItemById(tx, primaryLocked.id);
          return {
            kind: "count-required-unclear" as const,
            item: latestPrimary!,
          };
        }

        primaryCovMode = "FULL";
        primaryCoveredQty = Math.abs(Number(pendingCorr.primaryRawDelta));
        primaryRecId = selectedRec.id;
        primaryByOpen = false;
        primaryAppliedDelta = 0;
      } else if (pendingCorr.correctionKind === "METADATA") {
        const latestQty = getLatestMovementQuantity(existing);
        const alreadyAppliedNetDelta = await computeAppliedNetDeltaForMovement(tx, existing);
        const cov = evaluateOwnerCoverageSelection({
          enteredQuantity: latestQty,
          allowDecimal: Boolean(primaryLocked.allowDecimalQuantity),
          applicableReconciliations: primaryCounts.applicableReconciliations,
          openingCountCoversDate: primaryCounts.openingCountCoversDate,
          selection: { ...input.primaryCoverage, coverageMode: primaryMode },
          requireExplicitWhenCountsExist: true,
          requireSnapshot: true,
        });
        if (!cov.ok) {
          if (cov.kind === "stale-review") {
            return buildStaleReviewOutcome(tx, primaryLocked.id, existing.id, primaryCounts);
          }
          return { kind: "invalid-coverage" as const, message: cov.message };
        }
        const targetNetDelta =
          cov.deltaMagnitude === 0
            ? 0
            : existing.movementType === "STOCK_RECEIVED"
              ? cov.deltaMagnitude
              : subtractQuantities(0, cov.deltaMagnitude);
        primaryAppliedDelta = subtractQuantities(targetNetDelta, alreadyAppliedNetDelta);
        effectiveRawDeltaForMetadata = primaryAppliedDelta;
        primaryCovMode = cov.coverageMode;
        primaryCoveredQty = cov.coveredQuantity;
        primaryRecId = cov.supportingReconciliationId;
        primaryByOpen = cov.coveredByOpeningCount;
      } else {
        const rawPrimary = Number(pendingCorr.primaryRawDelta);
        const primaryCov = evaluateOwnerCoverageSelection({
          enteredQuantity: Math.abs(rawPrimary),
          allowDecimal: Boolean(primaryLocked.allowDecimalQuantity),
          applicableReconciliations: primaryCounts.applicableReconciliations,
          openingCountCoversDate: primaryCounts.openingCountCoversDate,
          selection: { ...input.primaryCoverage, coverageMode: primaryMode },
          requireExplicitWhenCountsExist: true,
          requireSnapshot: true,
        });
        if (!primaryCov.ok) {
          if (primaryCov.kind === "stale-review") {
            return secondaryLocked
              ? buildStaleDualReviewOutcome(
                  tx,
                  primaryLocked.id,
                  secondaryLocked.id,
                  existing.id,
                  primaryCounts,
                  secondaryCounts,
                )
              : buildStaleReviewOutcome(tx, primaryLocked.id, existing.id, primaryCounts);
          }
          return { kind: "invalid-coverage" as const, message: primaryCov.message };
        }
        primaryCovMode = primaryCov.coverageMode;
        primaryCoveredQty = primaryCov.coveredQuantity;
        primaryRecId = primaryCov.supportingReconciliationId;
        primaryByOpen = primaryCov.coveredByOpeningCount;
        primaryAppliedDelta =
          primaryCov.deltaMagnitude === 0
            ? 0
            : rawPrimary > 0
              ? primaryCov.deltaMagnitude
              : subtractQuantities(0, primaryCov.deltaMagnitude);

        if (secondaryLocked) {
          const secMode = input.secondaryCoverage?.coverageMode;
          if (secMode !== "NONE" && secMode !== "FULL" && secMode !== "PARTIAL") {
            return {
              kind: "invalid-coverage" as const,
              message: "Confirm count coverage for both items before resolving this receipt correction.",
            };
          }
          const rawSecondary = Number(pendingCorr.secondaryRawDelta);
          const secCov = evaluateOwnerCoverageSelection({
            enteredQuantity: Math.abs(rawSecondary),
            allowDecimal: Boolean(secondaryLocked.allowDecimalQuantity),
            applicableReconciliations: secondaryCounts.applicableReconciliations,
            openingCountCoversDate: secondaryCounts.openingCountCoversDate,
            selection: { ...input.secondaryCoverage!, coverageMode: secMode },
            requireExplicitWhenCountsExist: true,
            requireSnapshot: true,
          });
          if (!secCov.ok) {
            if (secCov.kind === "stale-review") {
              return buildStaleDualReviewOutcome(
                tx,
                primaryLocked.id,
                secondaryLocked.id,
                existing.id,
                primaryCounts,
                secondaryCounts,
              );
            }
            return { kind: "invalid-coverage" as const, message: secCov.message };
          }
          secondaryCovMode = secCov.coverageMode;
          secondaryCoveredQty = secCov.coveredQuantity;
          secondaryRecId = secCov.supportingReconciliationId;
          secondaryByOpen = secCov.coveredByOpeningCount;
          secondaryAppliedDelta =
            secCov.deltaMagnitude === 0
              ? 0
              : rawSecondary > 0
                ? secCov.deltaMagnitude
                : subtractQuantities(0, secCov.deltaMagnitude);
        }
      }

      const guard = checkNegativeMerchandiseGuard(primaryLocked, primaryAppliedDelta);
      if (guard) {
        const latestPrimary = await findItemById(tx, primaryLocked.id);
        return {
          kind: "count-required-negative" as const,
          item: latestPrimary!,
          attemptedDelta: primaryAppliedDelta,
        };
      }

      const combinedReviewNote =
        input.primaryCoverage.reviewNote ?? input.secondaryCoverage?.reviewNote ?? null;

      await tx.query(
        `UPDATE inventory_movement_corrections
            SET status = 'APPLIED',
                primary_raw_delta = $2,
                primary_coverage_mode = $3,
                primary_covered_quantity = $4,
                primary_applied_delta = $5,
                primary_supporting_reconciliation_id = $6,
                primary_covered_by_opening_count = $7,
                secondary_coverage_mode = $8,
                secondary_covered_quantity = $9,
                secondary_applied_delta = $10,
                secondary_supporting_reconciliation_id = $11,
                secondary_covered_by_opening_count = $12,
                reviewed_by_user_id = $13,
                reviewed_at = $14,
                review_note = $15,
                review_request_key = $16
          WHERE id = $1`,
        [
          pendingCorr.id,
          effectiveRawDeltaForMetadata,
          primaryCovMode,
          primaryCoveredQty,
          primaryAppliedDelta,
          primaryRecId,
          primaryByOpen,
          secondaryCovMode,
          secondaryCoveredQty,
          secondaryAppliedDelta,
          secondaryRecId,
          secondaryByOpen,
          input.reviewerUserId,
          input.reviewedAt,
          combinedReviewNote,
          input.requestKey,
        ],
      );

      if (pendingCorr.correctionKind === "QUANTITY") {
        await tx.query(
          `UPDATE inventory_stock_movements
              SET current_quantity_value = $2,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [existing.id, Number(pendingCorr.newQuantity)],
        );
      } else if (pendingCorr.correctionKind === "CANCEL") {
        await tx.query(
          `UPDATE inventory_stock_movements
              SET is_cancelled = true,
                  cancelled_at = $2,
                  cancelled_by_user_id = $3,
                  current_quantity_value = 0,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [existing.id, input.reviewedAt, input.reviewerUserId],
        );
      } else if (pendingCorr.correctionKind === "RECEIPT_ITEM" && secondaryLocked) {
        await tx.query(
          `UPDATE inventory_stock_movements
              SET current_item_id = $2,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [existing.id, secondaryLocked.id],
        );
      } else if (pendingCorr.correctionKind === "METADATA") {
        await tx.query(
          `UPDATE inventory_stock_movements
              SET current_effective_date = $2::date,
                  current_note = $3,
                  correction_version = correction_version + 1
            WHERE id = $1`,
          [
            existing.id,
            toOptionalDateString(pendingCorr.newEffectiveDate) ?? sinceDate,
            pendingCorr.newNote ?? null,
          ],
        );
      }

      if (primaryAppliedDelta !== 0) {
        await applyCorrectionStockDelta(tx, {
          locked: primaryLocked,
          appliedDelta: primaryAppliedDelta,
          correctionId: pendingCorr.id,
          actorUserId: input.reviewerUserId,
          appliedAt: input.reviewedAt,
          effectiveDate: sinceDate,
          note: `Pending correction resolved: ${pendingCorr.reason}`,
        });
      }
      if (secondaryLocked && secondaryAppliedDelta !== 0) {
        await applyCorrectionStockDelta(tx, {
          locked: secondaryLocked,
          appliedDelta: secondaryAppliedDelta,
          correctionId: pendingCorr.id,
          actorUserId: input.reviewerUserId,
          appliedAt: input.reviewedAt,
          effectiveDate: sinceDate,
          note: `Pending two-item receipt correction resolved: ${pendingCorr.reason}`,
        });
      }

      return hydrateCorrectionOutcomeById(tx, "resolved", pendingCorr.id);
    });
  },
};

export type MovementCorrectionActionResult =
  | {
      kind: "applied" | "resolved" | "replayed";
      primaryItem: InventoryItemView;
      secondaryItem: InventoryItemView | null;
      movement: StockMovementView;
      correction: MovementCorrectionView;
    }
  | {
      kind: "already-resolved";
      primaryItem: InventoryItemView;
      secondaryItem: InventoryItemView | null;
      movement: StockMovementView;
      correction: MovementCorrectionView;
    }
  | { kind: "not-found" }
  | { kind: "key-conflict" }
  | { kind: "already-cancelled" }
  | { kind: "pending-conflict"; message: string }
  | { kind: "archived"; message: string }
  | { kind: "not-set"; message: string }
  | { kind: "invalid-target"; message: string }
  | { kind: "invalid-quantity"; allowDecimalQuantity: boolean; unit: string }
  | { kind: "invalid-quantity-unchanged"; currentQuantityValue: number }
  | { kind: "invalid-baseline"; allowDecimalQuantity: boolean; unit: string }
  | { kind: "invalid-coverage"; message: string }
  | {
      kind: "stale-movement";
      primaryItem: InventoryItemView;
      secondaryItem: InventoryItemView | null;
      movement: StockMovementView;
    }
  | {
      kind: "stale-stock";
      primaryItem: InventoryItemView;
      secondaryItem: InventoryItemView | null;
      movement: StockMovementView;
    }
  | {
      kind: "stale-review";
      primaryItem: InventoryItemView;
      secondaryItem: InventoryItemView | null;
      movement: StockMovementView;
      primaryApplicableReconciliations: StockReconciliationView[];
      primaryOpeningCountCoversDate: boolean;
      qualifyingPrimaryReconciliationIds?: string[];
      secondaryApplicableReconciliations: StockReconciliationView[];
      secondaryOpeningCountCoversDate: boolean;
    }
  | {
      kind: "count-required-negative";
      item: InventoryItemView;
      attemptedDelta: number;
    }
  | {
      kind: "count-required-unclear";
      item: InventoryItemView;
    }
  | {
      kind: "different-unit-quantity-unrecorded";
      item: InventoryItemView;
      originalUnit: string;
    }
  | {
      kind: "different-unit-reconciliation-required";
      primaryItem: InventoryItemView;
      secondaryItem: InventoryItemView;
      primaryApplicableReconciliations: StockReconciliationView[];
      secondaryApplicableReconciliations: StockReconciliationView[];
    };

function hasUnrecordedTargetUnitQuantity(row: StockMovementDbRow): boolean {
  return (
    row.currentQuantityValue === null &&
    !row.isCancelled &&
    row.currentItemId !== null &&
    row.currentItemId !== row.itemId
  );
}

function getLatestMovementQuantity(row: StockMovementDbRow): number {
  if (row.currentQuantityValue !== null && row.currentQuantityValue !== undefined) {
    return Number(row.currentQuantityValue);
  }
  if (row.enteredQuantity !== null && row.enteredQuantity !== undefined) {
    return Number(row.enteredQuantity);
  }
  return Math.abs(Number(row.quantityDelta));
}

function hasSameApplicableCountSet(
  a: { applicableReconciliations: StockReconciliationView[]; openingCountCoversDate: boolean },
  b: { applicableReconciliations: StockReconciliationView[]; openingCountCoversDate: boolean },
): boolean {
  if (a.openingCountCoversDate !== b.openingCountCoversDate) return false;
  if (a.applicableReconciliations.length !== b.applicableReconciliations.length) return false;
  const aIds = a.applicableReconciliations.map((r) => r.id).sort();
  const bIds = b.applicableReconciliations.map((r) => r.id).sort();
  return aIds.every((id, index) => id === bIds[index]);
}

function checkNegativeMerchandiseGuard(
  locked: LockedItemRow,
  delta: number,
): boolean {
  if (delta >= 0 || locked.category === "OPERATING_SUPPLY") {
    return false;
  }
  const balanceAfter = addQuantities(Number(locked.currentQuantity), delta);
  return balanceAfter < 0;
}

async function lockInventoryItemsInOrder(
  tx: Queryable,
  rawIds: string[],
): Promise<Map<string, LockedItemRow>> {
  const uniqueIds = [...new Set(rawIds)].sort((a, b) => a.localeCompare(b));
  const map = new Map<string, LockedItemRow>();
  for (const id of uniqueIds) {
    const { rows } = await tx.query<LockedItemRow>(
      `SELECT id,
              code,
              name,
              category,
              container_shape AS "containerShape",
              unit,
              allow_decimal_quantity AS "allowDecimalQuantity",
              needs_reconciliation AS "needsReconciliation",
              current_quantity AS "currentQuantity",
              stock_revision AS "stockRevision",
              archived_at AS "archivedAt"
         FROM inventory_items
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    if (rows[0]) {
      map.set(rows[0].id, rows[0]);
    }
  }
  return map;
}

async function loadMovementForCorrectionSeed(
  tx: Queryable,
  movementId: string,
): Promise<{ itemId: string; currentItemId: string | null } | null> {
  const { rows } = await tx.query<{ itemId: string; currentItemId: string | null }>(
    `SELECT item_id AS "itemId", current_item_id AS "currentItemId"
       FROM inventory_stock_movements
      WHERE id = $1`,
    [movementId],
  );
  return rows[0] ?? null;
}

async function lockMovementById(
  tx: Queryable,
  movementId: string,
): Promise<StockMovementDbRow | null> {
  const { rows } = await tx.query<StockMovementDbRow>(
    `${STOCK_MOVEMENT_SELECT} WHERE m.id = $1 FOR UPDATE OF m`,
    [movementId],
  );
  return rows[0] ?? null;
}

async function hasOpenPendingCorrectionForMovement(
  tx: Queryable,
  movementId: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id
       FROM inventory_movement_corrections
      WHERE movement_id = $1
        AND status = 'PENDING_REVIEW'
      LIMIT 1`,
    [movementId],
  );
  return rows.length > 0;
}

/**
 * Net stock effect that this movement currently has on its owning item
 * (`currentItemId ?? itemId`), including same-unit receipt switches (`RECEIPT_ITEM`)
 * and subsequent quantity/metadata adjustments.
 */
function computeCurrentItemAppliedNetDelta(
  movement: {
    itemId: string;
    currentItemId: string | null;
    quantityDelta: number | string;
  },
  corrections: ReadonlyArray<{
    status: string;
    primaryItemId: string;
    primaryAppliedDelta: number | string;
    secondaryItemId: string | null;
    secondaryAppliedDelta: number | string;
  }>,
): number {
  const currentItemId = movement.currentItemId ?? movement.itemId;
  let net = movement.itemId === currentItemId ? Number(movement.quantityDelta) : 0;
  for (const corr of corrections) {
    if (corr.status !== "APPLIED") continue;
    if (corr.primaryItemId === currentItemId) {
      net = addQuantities(net, Number(corr.primaryAppliedDelta));
    }
    if (corr.secondaryItemId === currentItemId) {
      net = addQuantities(net, Number(corr.secondaryAppliedDelta));
    }
  }
  return net;
}

async function computeAppliedNetDeltaForMovement(
  tx: Queryable,
  movement: StockMovementDbRow,
): Promise<number> {
  const { rows } = await tx.query<{
    status: string;
    primaryItemId: string;
    primaryAppliedDelta: number | string;
    secondaryItemId: string | null;
    secondaryAppliedDelta: number | string;
  }>(
    `SELECT status,
            primary_item_id AS "primaryItemId",
            primary_applied_delta AS "primaryAppliedDelta",
            secondary_item_id AS "secondaryItemId",
            secondary_applied_delta AS "secondaryAppliedDelta"
       FROM inventory_movement_corrections
      WHERE movement_id = $1
        AND status = 'APPLIED'
      ORDER BY created_at ASC, id ASC`,
    [movement.id],
  );
  return computeCurrentItemAppliedNetDelta(movement, rows);
}

/**
 * Checks physical-count timestamps in PostgreSQL rather than using second-truncated API strings,
 * so counts recorded later within the same second remain eligible.
 */
async function listReconciliationIdsRecordedAfterCorrection(
  db: Queryable,
  itemId: string,
  correctionId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT r.id
       FROM inventory_reconciliations r
       JOIN inventory_movement_corrections mc ON mc.id = $2
      WHERE r.item_id = $1
        AND r.recorded_at > mc.created_at
      ORDER BY r.recorded_at DESC, r.id DESC`,
    [itemId, correctionId],
  );
  return rows.map((row) => row.id);
}

function toHydratedMovementView(
  row: StockMovementDbRow,
  corrections: MovementCorrectionView[],
): StockMovementView {
  return {
    ...toStockMovementView(row),
    appliedNetDelta:
      row.movementType === "STOCK_RECEIVED" || row.movementType === "STOCK_USED"
        ? computeCurrentItemAppliedNetDelta(row, corrections)
        : undefined,
    corrections,
  };
}

async function findCorrectionByRequestKey(
  tx: Queryable,
  requestKey: string,
): Promise<MovementCorrectionDbRow | null> {
  const { rows } = await tx.query<MovementCorrectionDbRow>(
    `${CORRECTION_SELECT} WHERE mc.request_key = $1`,
    [requestKey],
  );
  return rows[0] ?? null;
}

async function findCorrectionByReviewRequestKey(
  tx: Queryable,
  reviewRequestKey: string,
): Promise<MovementCorrectionDbRow | null> {
  const { rows } = await tx.query<MovementCorrectionDbRow>(
    `${CORRECTION_SELECT} WHERE mc.review_request_key = $1`,
    [reviewRequestKey],
  );
  return rows[0] ?? null;
}

async function hydrateCorrectionOutcome(
  tx: Queryable,
  kind: "applied" | "resolved" | "replayed",
  corrRow: MovementCorrectionDbRow,
) {
  const [primaryItem, secondaryItem, { rows: movRows }, corrMap] = await Promise.all([
    findItemById(tx, corrRow.primaryItemId),
    corrRow.secondaryItemId ? findItemById(tx, corrRow.secondaryItemId) : Promise.resolve(undefined),
    tx.query<StockMovementDbRow>(`${STOCK_MOVEMENT_SELECT} WHERE m.id = $1`, [corrRow.movementId]),
    loadCorrectionsByMovementIds(tx, [corrRow.movementId]),
  ]);
  const corrections = corrMap.get(corrRow.movementId) ?? [];
  return {
    kind,
    primaryItem: primaryItem!,
    secondaryItem: secondaryItem ?? null,
    movement: toHydratedMovementView(movRows[0]!, corrections),
    correction: toMovementCorrectionView(corrRow),
  };
}

async function hydrateCorrectionOutcomeById(
  tx: Queryable,
  kind: "applied" | "resolved" | "replayed",
  correctionId: string,
) {
  const { rows } = await tx.query<MovementCorrectionDbRow>(
    `${CORRECTION_SELECT} WHERE mc.id = $1`,
    [correctionId],
  );
  return hydrateCorrectionOutcome(tx, kind, rows[0]!);
}

async function buildStaleMovementOutcome(
  tx: Queryable,
  primaryItemId: string,
  movementId: string,
  secondaryItemId?: string,
): Promise<MovementCorrectionActionResult> {
  const [primaryItem, secondaryItem, { rows: movRows }, corrMap] = await Promise.all([
    findItemById(tx, primaryItemId),
    secondaryItemId ? findItemById(tx, secondaryItemId) : Promise.resolve(undefined),
    tx.query<StockMovementDbRow>(`${STOCK_MOVEMENT_SELECT} WHERE m.id = $1`, [movementId]),
    loadCorrectionsByMovementIds(tx, [movementId]),
  ]);
  return {
    kind: "stale-movement",
    primaryItem: primaryItem!,
    secondaryItem: secondaryItem ?? null,
    movement: toHydratedMovementView(movRows[0]!, corrMap.get(movementId) ?? []),
  };
}

async function buildStaleStockOutcome(
  tx: Queryable,
  primaryItemId: string,
  movementId: string,
  secondaryItemId?: string,
): Promise<MovementCorrectionActionResult> {
  const [primaryItem, secondaryItem, { rows: movRows }, corrMap] = await Promise.all([
    findItemById(tx, primaryItemId),
    secondaryItemId ? findItemById(tx, secondaryItemId) : Promise.resolve(undefined),
    tx.query<StockMovementDbRow>(`${STOCK_MOVEMENT_SELECT} WHERE m.id = $1`, [movementId]),
    loadCorrectionsByMovementIds(tx, [movementId]),
  ]);
  return {
    kind: "stale-stock",
    primaryItem: primaryItem!,
    secondaryItem: secondaryItem ?? null,
    movement: toHydratedMovementView(movRows[0]!, corrMap.get(movementId) ?? []),
  };
}

async function buildStaleReviewOutcome(
  tx: Queryable,
  primaryItemId: string,
  movementId: string,
  counts: { applicableReconciliations: StockReconciliationView[]; openingCountCoversDate: boolean },
  pendingCorrectionId?: string,
): Promise<MovementCorrectionActionResult> {
  const [primaryItem, { rows: movRows }, corrMap, qualifyingPrimaryReconciliationIds] =
    await Promise.all([
      findItemById(tx, primaryItemId),
      tx.query<StockMovementDbRow>(`${STOCK_MOVEMENT_SELECT} WHERE m.id = $1`, [movementId]),
      loadCorrectionsByMovementIds(tx, [movementId]),
      pendingCorrectionId
        ? listReconciliationIdsRecordedAfterCorrection(tx, primaryItemId, pendingCorrectionId)
        : Promise.resolve(undefined),
    ]);
  return {
    kind: "stale-review",
    primaryItem: primaryItem!,
    secondaryItem: null,
    movement: toHydratedMovementView(movRows[0]!, corrMap.get(movementId) ?? []),
    primaryApplicableReconciliations: counts.applicableReconciliations,
    primaryOpeningCountCoversDate: counts.openingCountCoversDate,
    ...(qualifyingPrimaryReconciliationIds ? { qualifyingPrimaryReconciliationIds } : {}),
    secondaryApplicableReconciliations: [],
    secondaryOpeningCountCoversDate: false,
  };
}

async function buildStaleDualReviewOutcome(
  tx: Queryable,
  primaryItemId: string,
  secondaryItemId: string,
  movementId: string,
  primaryCounts: { applicableReconciliations: StockReconciliationView[]; openingCountCoversDate: boolean },
  secondaryCounts: { applicableReconciliations: StockReconciliationView[]; openingCountCoversDate: boolean },
): Promise<MovementCorrectionActionResult> {
  const [primaryItem, secondaryItem, { rows: movRows }, corrMap] = await Promise.all([
    findItemById(tx, primaryItemId),
    findItemById(tx, secondaryItemId),
    tx.query<StockMovementDbRow>(`${STOCK_MOVEMENT_SELECT} WHERE m.id = $1`, [movementId]),
    loadCorrectionsByMovementIds(tx, [movementId]),
  ]);
  return {
    kind: "stale-review",
    primaryItem: primaryItem!,
    secondaryItem: secondaryItem!,
    movement: toHydratedMovementView(movRows[0]!, corrMap.get(movementId) ?? []),
    primaryApplicableReconciliations: primaryCounts.applicableReconciliations,
    primaryOpeningCountCoversDate: primaryCounts.openingCountCoversDate,
    secondaryApplicableReconciliations: secondaryCounts.applicableReconciliations,
    secondaryOpeningCountCoversDate: secondaryCounts.openingCountCoversDate,
  };
}

async function insertMovementCorrectionRow(
  tx: Queryable,
  params: {
    movementId: string;
    correctionKind: MovementCorrectionKind;
    status: MovementCorrectionStatus;
    reason: string;
    requestKey: string;
    previousQuantity?: number | null;
    newQuantity?: number | null;
    previousItemId?: string | null;
    newItemId?: string | null;
    previousUnit?: string | null;
    newUnit?: string | null;
    previousEffectiveDate?: string | null;
    newEffectiveDate?: string | null;
    previousNote?: string | null;
    newNote?: string | null;
    primaryItemId: string;
    primaryRawDelta: number;
    primaryCoverageMode: CorrectionCoverageMode | null;
    primaryCoveredQuantity: number;
    primaryAppliedDelta: number;
    primarySupportingReconciliationId: string | null;
    primaryCoveredByOpeningCount: boolean;
    secondaryItemId?: string | null;
    secondaryRawDelta?: number;
    secondaryCoverageMode?: CorrectionCoverageMode | null;
    secondaryCoveredQuantity?: number;
    secondaryAppliedDelta?: number;
    secondarySupportingReconciliationId?: string | null;
    secondaryCoveredByOpeningCount?: boolean;
    createdByUserId: string;
    createdAt: Date;
    reviewedByUserId: string | null;
    reviewedAt: Date | null;
    reviewNote: string | null;
  },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO inventory_movement_corrections (
       movement_id, correction_kind, status, reason, request_key,
       previous_quantity, new_quantity,
       previous_item_id, new_item_id, previous_unit, new_unit,
       previous_effective_date, new_effective_date,
       previous_note, new_note,
       primary_item_id, primary_raw_delta, primary_coverage_mode,
       primary_covered_quantity, primary_applied_delta,
       primary_supporting_reconciliation_id, primary_covered_by_opening_count,
       secondary_item_id, secondary_raw_delta, secondary_coverage_mode,
       secondary_covered_quantity, secondary_applied_delta,
       secondary_supporting_reconciliation_id, secondary_covered_by_opening_count,
       created_by_user_id, created_at, reviewed_by_user_id, reviewed_at, review_note
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7,
       $8, $9, $10, $11,
       $12::date, $13::date,
       $14, $15,
       $16, $17, $18,
       $19, $20,
       $21, $22,
       $23, $24, $25,
       $26, $27,
       $28, $29,
       $30, $31, $32, $33, $34
     )
     RETURNING id`,
    [
      params.movementId,
      params.correctionKind,
      params.status,
      params.reason,
      params.requestKey,
      params.previousQuantity ?? null,
      params.newQuantity ?? null,
      params.previousItemId ?? null,
      params.newItemId ?? null,
      params.previousUnit ?? null,
      params.newUnit ?? null,
      params.previousEffectiveDate ?? null,
      params.newEffectiveDate ?? null,
      params.previousNote ?? null,
      params.newNote ?? null,
      params.primaryItemId,
      params.primaryRawDelta,
      params.primaryCoverageMode,
      params.primaryCoveredQuantity,
      params.primaryAppliedDelta,
      params.primarySupportingReconciliationId,
      params.primaryCoveredByOpeningCount,
      params.secondaryItemId ?? null,
      params.secondaryRawDelta ?? 0,
      params.secondaryCoverageMode ?? null,
      params.secondaryCoveredQuantity ?? 0,
      params.secondaryAppliedDelta ?? 0,
      params.secondarySupportingReconciliationId ?? null,
      params.secondaryCoveredByOpeningCount ?? false,
      params.createdByUserId,
      params.createdAt,
      params.reviewedByUserId,
      params.reviewedAt,
      params.reviewNote,
    ],
  );
  return rows[0]!.id;
}

async function applyCorrectionStockDelta(
  tx: Queryable,
  params: {
    locked: LockedItemRow;
    appliedDelta: number;
    correctionId: string;
    actorUserId: string;
    appliedAt: Date;
    effectiveDate: string;
    note: string;
  },
): Promise<void> {
  const balanceBefore = Number(params.locked.currentQuantity);
  const balanceAfter = addQuantities(balanceBefore, params.appliedDelta);
  const nextNeedsReconciliation =
    params.locked.category === "OPERATING_SUPPLY"
      ? Boolean(params.locked.needsReconciliation) || balanceAfter < 0
      : Boolean(params.locked.needsReconciliation);

  await tx.query(
    `INSERT INTO inventory_stock_movements (
       item_id, movement_type, entry_status, quantity_delta,
       balance_before, balance_after, unit, effective_date, note,
       source_correction_id, actor_user_id, recorded_at
     )
     VALUES (
       $1, 'MOVEMENT_CORRECTION', 'APPLIED', $2,
       $3, $4, $5, $6::date, $7,
       $8, $9, $10
     )`,
    [
      params.locked.id,
      params.appliedDelta,
      balanceBefore,
      balanceAfter,
      params.locked.unit,
      params.effectiveDate,
      params.note,
      params.correctionId,
      params.actorUserId,
      params.appliedAt,
    ],
  );

  await tx.query(
    `UPDATE inventory_items
        SET current_quantity = $2,
            stock_revision = stock_revision + 1,
            needs_reconciliation = $3
      WHERE id = $1`,
    [params.locked.id, balanceAfter, nextNeedsReconciliation],
  );
}
