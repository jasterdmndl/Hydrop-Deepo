import type { Role } from "../auth/policy.js";

/**
 * Inventory domain rules and validation for Round/Slim containers,
 * Owner-created merchandise and operating supply products, reusable POS sections,
 * archiving, Stock Received / Stock Used movements, and INV-009 reconciliations.
 */
export type ContainerShape = "ROUND" | "SLIM";
export type InventoryCategory = "CONTAINER" | "MERCHANDISE" | "OPERATING_SUPPLY";
export type PosSection = string;
export type FaucetReportingType = "PUSH_TYPE" | "TWIST_TYPE";

export const CONTAINER_SHAPES: readonly ContainerShape[] = ["ROUND", "SLIM"] as const;
export const FAUCET_REPORTING_TYPES: readonly FaucetReportingType[] = ["PUSH_TYPE", "TWIST_TYPE"] as const;
export const BUILT_IN_POS_SECTIONS = {
  CONTAINERS: "CONTAINERS",
  TAKIP_ACCESSORIES: "TAKIP_ACCESSORIES",
  CHANGE_OF_GRIPO: "CHANGE_OF_GRIPO",
} as const;

export const QUANTITY_SCALE = 10_000;
export const MAX_OPENING_QUANTITY = 1_000_000;
/** Stored balances use numeric(12, 4), so accumulated balances can exceed single-entry caps up to 99,999,999.9999. */
export const MAX_STORED_BALANCE = 99_999_999.9999;
export const MAX_UNIT_PRICE_CENTAVOS = 10_000_000;
export const MAX_PRODUCT_NAME_LENGTH = 80;
export const MAX_PRODUCT_DESCRIPTION_LENGTH = 160;
export const MAX_STOCK_UNIT_LENGTH = 30;
export const MAX_POS_SECTION_NAME_LENGTH = 60;
export const MAX_POS_SECTION_CODE_LENGTH = 64;
export const MAX_RECONCILIATION_REASON_LENGTH = 240;
export const MAX_MOVEMENT_NOTE_LENGTH = 240;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface InventoryPermissions {
  canView: boolean;
  /** Only the Owner can record the initial physical count per item (INV-005). */
  canInitializeOpeningStock: boolean;
  /** Only the Owner can manage Inventory products, POS visibility, sections, and archiving. */
  canCreateProduct: boolean;
  /** Only the Owner can record Stock Received (INV-003, INV-006). */
  canRecordReceiving: boolean;
  /** Both Owner and Employee can record Stock Used for operating supplies (INV-003, INV-007). */
  canRecordUsage: boolean;
  /** Only the Owner can run physical-count reconciliations (INV-009). */
  canReconcile: boolean;
  /** Only the Owner can inspect full stock history, reconciliations, and pending reviews (INV-040, INV-041). */
  canViewFullHistory: boolean;
  /** Signed-in operators can view their own recorded Stock Used history (INV-041). */
  canViewOwnUsageHistory: boolean;
  /** Only the Owner can confirm count coverage and resolve pending late entries (INV-025, INV-029, INV-040). */
  canReviewPendingEntries: boolean;
  /** Only the Owner can correct or cancel saved Stock Received / Stock Used entries (INV-010..043). */
  canCorrectMovements: boolean;
}

export function inventoryPermissions(role: Role): InventoryPermissions {
  const isOwner = role === "OWNER";
  return {
    canView: true,
    canInitializeOpeningStock: isOwner,
    canCreateProduct: isOwner,
    canRecordReceiving: isOwner,
    canRecordUsage: true,
    canReconcile: isOwner,
    canViewFullHistory: isOwner,
    canViewOwnUsageHistory: true,
    canReviewPendingEntries: isOwner,
    canCorrectMovements: isOwner,
  };
}

export type OpeningStockStatus = "NOT_SET" | "INITIALIZED";

export interface OpeningStockRecord {
  quantity: number;
  unit: string;
  recordedBy: string;
  recordedAt: string;
}

export interface PosSectionView {
  code: string;
  name: string;
  isBuiltIn: boolean;
  sortOrder: number;
  createdBy: string | null;
  createdAt: string;
}

export interface StockReconciliationView {
  id: string;
  itemId: string;
  balanceBefore: number;
  physicalCount: number;
  quantityDelta: number;
  balanceAfter: number;
  unit: string;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

export interface InventoryStockHoldView {
  id: string;
  itemId: string;
  quantity: number;
  unit: string;
  reason: string;
  sourceKind: "CHECKOUT_REFUND" | "CHECKOUT_CANCEL" | "SALE_ACTION";
  reducesAvailability: boolean;
  posReference: string;
  recordedBy: string;
  recordedAt: string;
}

export interface PendingSaleActionStockReviewView {
  saleActionReference: string;
  originalSaleReference: string;
  actionType: "VOID" | "CORRECT";
  itemId: string;
  itemName: string;
  unclearQuantity: number;
  unit: string;
  interveningReconciliationAt: string | null;
  completedAt: string;
}

export interface InventoryItemView {
  id: string;
  code: string;
  name: string;
  category: InventoryCategory;
  shape: ContainerShape | null;
  description: string | null;
  unit: string;
  allowDecimalQuantity: boolean;
  needsReconciliation: boolean;
  unitPriceCentavos: number | null;
  showInPos: boolean;
  posSection: PosSection | null;
  lowStockLevel: number | null;
  faucetReportingType: FaucetReportingType | null;
  status: OpeningStockStatus;
  currentQuantity: number | null;
  heldQuantity: number;
  availableQuantity: number | null;
  activeHolds: InventoryStockHoldView[];
  pendingStockReviews: PendingSaleActionStockReviewView[];
  stockRevision: number;
  openingStock: OpeningStockRecord | null;
  latestReconciliation: StockReconciliationView | null;
  archivedAt: string | null;
  archivedBy: string | null;
  createdBy: string | null;
  createdAt: string;
}

export type StockMovementType =
  | "POS_SALE"
  | "PRIOR_DAY_SETTLEMENT"
  | "PHYSICAL_COUNT_RECONCILIATION"
  | "SALE_ACTION_DEDUCTION"
  | "SALE_ACTION_RESTORATION"
  | "STOCK_RECEIVED"
  | "STOCK_USED"
  | "MOVEMENT_CORRECTION";

export type MovementEntryStatus = "APPLIED" | "PENDING_REVIEW";
export type MovementCoverageMode = "NONE" | "FULL" | "PARTIAL" | "UNCLEAR";
export type CorrectionCoverageMode = MovementCoverageMode | "DIFFERENT_UNIT_RECONCILED";
export type MovementCorrectionKind = "QUANTITY" | "CANCEL" | "RECEIPT_ITEM" | "METADATA";
export type MovementCorrectionStatus = "APPLIED" | "PENDING_REVIEW";

export interface SupportingReconciliationSummary {
  id: string;
  physicalCount: number;
  quantityDelta: number;
  unit: string;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

export interface MovementCorrectionView {
  id: string;
  movementId: string;
  correctionKind: MovementCorrectionKind;
  status: MovementCorrectionStatus;
  reason: string;
  previousQuantity: number | null;
  newQuantity: number | null;
  previousItemId: string | null;
  previousItemName: string | null;
  newItemId: string | null;
  newItemName: string | null;
  previousUnit: string | null;
  newUnit: string | null;
  previousEffectiveDate: string | null;
  newEffectiveDate: string | null;
  previousNote: string | null;
  newNote: string | null;
  primaryItemId: string;
  primaryItemName: string;
  primaryItemUnit: string;
  primaryRawDelta: number;
  primaryCoverageMode: CorrectionCoverageMode | null;
  primaryCoveredQuantity: number;
  primaryAppliedDelta: number;
  primarySupportingReconciliationId: string | null;
  primarySupportingReconciliation: SupportingReconciliationSummary | null;
  primaryCoveredByOpeningCount: boolean;
  secondaryItemId: string | null;
  secondaryItemName: string | null;
  secondaryItemUnit: string | null;
  secondaryRawDelta: number;
  secondaryCoverageMode: CorrectionCoverageMode | null;
  secondaryCoveredQuantity: number;
  secondaryAppliedDelta: number;
  secondarySupportingReconciliationId: string | null;
  secondarySupportingReconciliation: SupportingReconciliationSummary | null;
  secondaryCoveredByOpeningCount: boolean;
  createdBy: string;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface StockMovementView {
  id: string;
  itemId: string;
  movementType: StockMovementType;
  entryStatus: MovementEntryStatus;
  quantity: number;
  enteredQuantity: number | null;
  appliedQuantity: number;
  quantityDelta: number;
  balanceBefore: number;
  balanceAfter: number;
  unit: string;
  effectiveDate: string | null;
  note: string | null;
  coverageMode: MovementCoverageMode | null;
  coveredQuantity: number;
  supportingReconciliationId: string | null;
  supportingReconciliation: SupportingReconciliationSummary | null;
  coveredByOpeningCount: boolean;
  posReference: string | null;
  recordedBy: string;
  recordedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  isCancelled?: boolean;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
  currentQuantityValue?: number | null;
  currentItemId?: string | null;
  currentItemName?: string | null;
  currentItemUnit?: string | null;
  currentEffectiveDate?: string | null;
  currentNote?: string | null;
  correctionVersion?: number;
  sourceCorrectionId?: string | null;
  corrections?: MovementCorrectionView[];
}

export interface PendingMovementReviewView {
  entry: StockMovementView;
  item: InventoryItemView;
  applicableReconciliations: StockReconciliationView[];
  openingCountCoversDate: boolean;
}

export interface PendingCorrectionReviewView {
  correction: MovementCorrectionView;
  movement: StockMovementView;
  primaryItem: InventoryItemView;
  primaryApplicableReconciliations: StockReconciliationView[];
  primaryOpeningCountCoversDate: boolean;
  secondaryItem: InventoryItemView | null;
  secondaryApplicableReconciliations: StockReconciliationView[];
  secondaryOpeningCountCoversDate: boolean;
}

export interface InventoryItemHistoryView {
  scope: "FULL" | "OWN_USAGE";
  item: InventoryItemView;
  openingStock: OpeningStockRecord | null;
  movements: StockMovementView[];
  reconciliations: StockReconciliationView[];
}

const CANONICAL_DECIMAL_REGEX = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;

function parseScaledDecimalNumber(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const match = CANONICAL_DECIMAL_REGEX.exec(String(value));
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const whole = Number(match[2]);
  const frac = Number((match[3] ?? "").padEnd(4, "0"));
  if (!Number.isSafeInteger(whole)) return null;
  const scaled = sign * (whole * QUANTITY_SCALE + frac);
  if (!Number.isSafeInteger(scaled)) return null;
  return scaled === 0 ? 0 : scaled;
}

export function toScaledQuantity(value: number): number {
  const exact = parseScaledDecimalNumber(value);
  if (exact !== null) return exact;
  const rounded = Math.round(value * QUANTITY_SCALE);
  return rounded === 0 ? 0 : rounded;
}

export function fromScaledQuantity(scaled: number): number {
  const result = scaled / QUANTITY_SCALE;
  return Object.is(result, -0) ? 0 : result;
}

export function addQuantities(a: number, b: number): number {
  return fromScaledQuantity(toScaledQuantity(a) + toScaledQuantity(b));
}

export function subtractQuantities(a: number, b: number): number {
  return fromScaledQuantity(toScaledQuantity(a) - toScaledQuantity(b));
}

export function quantitiesEqual(a: number, b: number): boolean {
  return toScaledQuantity(a) === toScaledQuantity(b);
}

export function parseContainerShape(raw: unknown): ContainerShape | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toUpperCase();
  if (normalized === "ROUND" || normalized === "SLIM") {
    return normalized;
  }
  return null;
}

export function isUuid(raw: unknown): raw is string {
  return typeof raw === "string" && UUID_REGEX.test(raw.trim());
}

export function parseQuantity(
  raw: unknown,
  options: { allowDecimal: boolean; allowZero: boolean; allowNegative?: boolean; max?: number },
): number | null {
  const scaled = typeof raw === "number" ? parseScaledDecimalNumber(raw) : null;
  if (scaled === null) return null;

  const maxScaled = parseScaledDecimalNumber(options.max ?? MAX_OPENING_QUANTITY);
  if (maxScaled === null) return null;

  if (!options.allowDecimal && scaled % QUANTITY_SCALE !== 0) {
    return null;
  }

  if (options.allowNegative) {
    if (scaled < -maxScaled || scaled > maxScaled) {
      return null;
    }
    if (!options.allowZero && scaled === 0) {
      return null;
    }
    return fromScaledQuantity(scaled);
  }

  if (options.allowZero) {
    if (scaled < 0 || scaled > maxScaled) return null;
  } else {
    if (scaled <= 0 || scaled > maxScaled) return null;
  }

  return fromScaledQuantity(scaled);
}

export function parseStoredBalanceBaseline(
  raw: unknown,
  options: { allowDecimal: boolean; allowNegative: boolean },
): number | null {
  return parseQuantity(raw, {
    allowDecimal: options.allowDecimal,
    allowZero: true,
    allowNegative: options.allowNegative,
    max: MAX_STORED_BALANCE,
  });
}

export function parseOpeningQuantity(raw: unknown, allowDecimal = false): number | null {
  return parseQuantity(raw, { allowDecimal, allowZero: true });
}

export function parsePhysicalCount(raw: unknown, allowDecimal = false): number | null {
  return parseQuantity(raw, { allowDecimal, allowZero: true });
}

export function parseProductName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_PRODUCT_NAME_LENGTH) return null;
  return trimmed;
}

export function parseProductDescription(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return { ok: true, value: null };
  }
  if (trimmed.length > MAX_PRODUCT_DESCRIPTION_LENGTH) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

export function parseStockUnit(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_STOCK_UNIT_LENGTH) return null;
  return trimmed;
}

export function parseUnitPriceCentavos(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  if (!Number.isInteger(raw)) return null;
  if (raw < 1 || raw > MAX_UNIT_PRICE_CENTAVOS) return null;
  return raw;
}

export function parsePosSectionName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_POS_SECTION_NAME_LENGTH) return null;
  return trimmed;
}

export function parsePosSectionCode(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed || trimmed.length > MAX_POS_SECTION_CODE_LENGTH) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

export function parseReconciliationReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_RECONCILIATION_REASON_LENGTH) return null;
  return trimmed;
}

export function parseLowStockLevel(
  raw: unknown,
  allowDecimal = false,
): { ok: true; value: number | null } | { ok: false } {
  if (raw === null) {
    return { ok: true, value: null };
  }
  const parsed = parseQuantity(raw, { allowDecimal, allowZero: false });
  if (parsed === null) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

export function parseMovementNote(
  raw: unknown,
  options: { required: boolean },
): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) {
    return options.required ? { ok: false } : { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return options.required ? { ok: false } : { ok: true, value: null };
  }
  if (trimmed.length > MAX_MOVEMENT_NOTE_LENGTH) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

export function parseRequestKey(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

export function parseManilaDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const match = DATE_REGEX.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(check.getTime()) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return trimmed;
}

export function parseCoverageMode(raw: unknown): MovementCoverageMode | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toUpperCase();
  if (
    normalized === "NONE" ||
    normalized === "FULL" ||
    normalized === "PARTIAL" ||
    normalized === "UNCLEAR"
  ) {
    return normalized;
  }
  return null;
}

export function parseFaucetReportingType(
  raw: unknown,
): { ok: true; value: FaucetReportingType | null } | { ok: false } {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const normalized = raw.trim().toUpperCase();
  if (normalized === "PUSH_TYPE" || normalized === "TWIST_TYPE") {
    return { ok: true, value: normalized };
  }
  return { ok: false };
}

// Asia/Manila is fixed UTC+08:00 with no daylight saving transitions.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatManilaIso(date: Date): string {
  const shifted = new Date(date.getTime() + MANILA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hour = pad2(shifted.getUTCHours());
  const minute = pad2(shifted.getUTCMinutes());
  const second = pad2(shifted.getUTCSeconds());
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}

export function formatManilaDate(date: Date): string {
  const shifted = new Date(date.getTime() + MANILA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  return `${year}-${month}-${day}`;
}
