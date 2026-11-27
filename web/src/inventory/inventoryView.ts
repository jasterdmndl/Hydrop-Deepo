/** Pure formatting, grouping, reconciliation, and input helpers for Inventory. */
import { api } from "../api";

export type ContainerShape = "ROUND" | "SLIM";
export type InventoryCategory = "CONTAINER" | "MERCHANDISE" | "OPERATING_SUPPLY";
export type PosSection = string;
export type FaucetReportingType = "PUSH_TYPE" | "TWIST_TYPE";
export type OpeningStockStatus = "NOT_SET" | "INITIALIZED";
export type InventoryCategoryFilter = string;
export type StockStatusTone = "unset" | "out" | "in" | "low" | "discrepancy";
export type InventoryLoadPhase = "initial-loading" | "initial-error" | "ready" | "refresh-error";

export interface StockStatusMeta {
  tone: StockStatusTone;
  label: "Not Set" | "No Stock" | "In Stock" | "Low Stock" | "Needs Reconciliation";
}

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
  createdBy?: string | null;
  createdAt?: string;
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
  id?: string;
  code: string;
  name: string;
  category: InventoryCategory;
  shape: ContainerShape | null;
  description?: string | null;
  unit: string;
  allowDecimalQuantity?: boolean;
  needsReconciliation?: boolean;
  unitPriceCentavos?: number | null;
  showInPos?: boolean;
  posSection?: PosSection | null;
  lowStockLevel?: number | null;
  faucetReportingType?: FaucetReportingType | null;
  status: OpeningStockStatus;
  currentQuantity: number | null;
  heldQuantity?: number;
  availableQuantity?: number | null;
  activeHolds?: InventoryStockHoldView[];
  pendingStockReviews?: PendingSaleActionStockReviewView[];
  stockRevision?: number;
  openingStock: OpeningStockRecord | null;
  latestReconciliation?: StockReconciliationView | null;
  archivedAt?: string | null;
  archivedBy?: string | null;
  createdBy?: string | null;
  createdAt?: string;
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
  entryStatus?: MovementEntryStatus;
  quantity: number;
  enteredQuantity?: number | null;
  appliedQuantity?: number;
  quantityDelta: number;
  balanceBefore: number;
  balanceAfter: number;
  unit: string;
  effectiveDate: string | null;
  note: string | null;
  coverageMode?: MovementCoverageMode | null;
  coveredQuantity?: number;
  supportingReconciliationId?: string | null;
  supportingReconciliation?: SupportingReconciliationSummary | null;
  coveredByOpeningCount?: boolean;
  posReference?: string | null;
  recordedBy: string;
  recordedAt: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
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

export interface InventoryPermissions {
  canView: boolean;
  canInitializeOpeningStock: boolean;
  canCreateProduct?: boolean;
  canRecordReceiving?: boolean;
  canRecordUsage?: boolean;
  canReconcile?: boolean;
  canViewFullHistory?: boolean;
  canViewOwnUsageHistory?: boolean;
  canReviewPendingEntries?: boolean;
  canCorrectMovements?: boolean;
}

export interface InventoryItemsResponse {
  permissions: InventoryPermissions;
  items: InventoryItemView[];
  posSections?: PosSectionView[];
  pendingStockReviews?: PendingSaleActionStockReviewView[];
  pendingMovementReviewsCount?: number;
  pendingCorrectionReviewsCount?: number;
}

export const DEFAULT_POS_SECTIONS: readonly PosSectionView[] = [
  { code: "CONTAINERS", name: "Containers", isBuiltIn: true, sortOrder: 10 },
  { code: "TAKIP_ACCESSORIES", name: "Takip Types / Accessories", isBuiltIn: true, sortOrder: 20 },
  { code: "CHANGE_OF_GRIPO", name: "Change of Gripo", isBuiltIn: true, sortOrder: 30 },
];

export const QUANTITY_SCALE = 10_000;
export const MAX_OPENING_QUANTITY = 1_000_000;
export const MAX_UNIT_PRICE_CENTAVOS = 10_000_000;

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function parseQuantityInputInternal(
  raw: string,
  unit: string,
  options: { allowDecimal: boolean; allowZero: boolean },
): { ok: true; quantity: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  const unitNoun = unit === "containers" ? "container" : unit;
  if (!trimmed) {
    return {
      ok: false,
      message: options.allowZero
        ? `Enter the actual ${unitNoun} count (0 or more).`
        : `Enter a positive quantity of ${unit}.`,
    };
  }

  const pattern = options.allowDecimal ? /^(?:\d+|\d*\.\d+)$/ : /^\d+$/;
  if (!pattern.test(trimmed)) {
    return {
      ok: false,
      message: options.allowDecimal
        ? `Enter a valid number of ${unit} (up to 4 decimal places).`
        : options.allowZero
          ? `Enter a whole number of ${unit} (0 or more).`
          : `Enter a positive whole number of ${unit}.`,
    };
  }

  if (options.allowDecimal && trimmed.includes(".")) {
    const decimals = trimmed.split(".")[1] ?? "";
    if (decimals.length > 4) {
      return {
        ok: false,
        message: `Enter at most 4 decimal places for ${unit}.`,
      };
    }
  }

  const quantity = Number(trimmed);
  if (!Number.isFinite(quantity)) {
    return { ok: false, message: `Enter a valid number of ${unit}.` };
  }
  const scaled = Math.round(quantity * QUANTITY_SCALE);
  const normalized = scaled / QUANTITY_SCALE;

  if (options.allowZero) {
    if (scaled < 0 || normalized > MAX_OPENING_QUANTITY) {
      return {
        ok: false,
        message: options.allowDecimal
          ? "Enter a quantity from 0 to 1,000,000."
          : "Enter a whole number from 0 to 1,000,000.",
      };
    }
  } else if (scaled <= 0 || normalized > MAX_OPENING_QUANTITY) {
    return {
      ok: false,
      message: options.allowDecimal
        ? "Enter a positive quantity up to 1,000,000."
        : "Enter a whole number from 1 to 1,000,000.",
    };
  }

  return { ok: true, quantity: normalized };
}

export function parseOpeningQuantityInput(
  raw: string,
  unit = "containers",
  allowDecimal = false,
): { ok: true; quantity: number } | { ok: false; message: string } {
  return parseQuantityInputInternal(raw, unit, { allowDecimal, allowZero: true });
}

export function parsePhysicalCountInput(
  raw: string,
  unit = "containers",
  allowDecimal = false,
): { ok: true; quantity: number } | { ok: false; message: string } {
  return parseQuantityInputInternal(raw, unit, { allowDecimal, allowZero: true });
}

export function parseMovementQuantityInput(
  raw: string,
  unit: string,
  allowDecimal = false,
): { ok: true; quantity: number } | { ok: false; message: string } {
  return parseQuantityInputInternal(raw, unit, { allowDecimal, allowZero: false });
}

export function parseLowStockLevelInput(
  raw: string,
  unit = "units",
  allowDecimal = false,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  const parsed = parseQuantityInputInternal(trimmed, unit, {
    allowDecimal,
    allowZero: false,
  });
  if (!parsed.ok) {
    return {
      ok: false,
      message: allowDecimal
        ? `Enter a positive quantity of ${unit} (up to 4 decimals), or leave blank to clear.`
        : `Enter a positive whole number of ${unit} (1 or more), or leave blank to clear.`,
    };
  }
  return { ok: true, value: parsed.quantity };
}

export function formatFaucetReportingTypeLabel(
  faucetType: FaucetReportingType | null | undefined,
): string {
  switch (faucetType) {
    case "PUSH_TYPE":
      return "Push-Type Faucet";
    case "TWIST_TYPE":
      return "Twist-Type Faucet";
    default:
      return "Not classified";
  }
}

export function computeReconciliationPreview(
  currentQuantity: number,
  physicalCount: number,
): {
  before: number;
  physicalCount: number;
  delta: number;
  after: number;
} {
  const delta =
    (Math.round(physicalCount * QUANTITY_SCALE) - Math.round(currentQuantity * QUANTITY_SCALE)) /
    QUANTITY_SCALE;
  return {
    before: currentQuantity,
    physicalCount,
    delta: Object.is(delta, -0) ? 0 : delta,
    after: physicalCount,
  };
}

export function formatQuantityNumber(value: number): string {
  const scaled = Math.round(value * QUANTITY_SCALE);
  if (scaled === 0) return "0";
  const normalized = scaled / QUANTITY_SCALE;
  const abs = Math.abs(normalized);
  const text = Number.isInteger(abs) ? String(abs) : String(Number(abs.toFixed(4)));
  return normalized < 0 ? `−${text}` : text;
}

export function formatSignedDelta(delta: number, unit: string): string {
  const scaled = Math.round(delta * QUANTITY_SCALE);
  if (scaled === 0) {
    return `0 ${unit === "containers" ? "containers" : unit} (Verified match)`;
  }
  const absVal = Math.abs(scaled / QUANTITY_SCALE);
  const absLabel = formatQuantityLabel(absVal, unit);
  return scaled > 0 ? `+${absLabel}` : `−${absLabel}`;
}

export function parsePesoPriceToCentavos(raw: string): number | null {
  const cleaned = raw.trim().replace(/^[₱\s]+/, "").replace(/,/g, "");
  if (!cleaned) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const pesos = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const total = pesos * 100 + cents;
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_UNIT_PRICE_CENTAVOS) {
    return null;
  }
  return total;
}

export function formatCentavosInputValue(centavos: number): string {
  const abs = Math.abs(Math.trunc(centavos));
  const pesos = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${pesos}.${String(remainder).padStart(2, "0")}`;
}

export function formatPesoCentavos(centavos: number): string {
  const truncated = Math.trunc(centavos);
  const abs = Math.abs(truncated);
  const pesos = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `₱${pesos.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

export function formatQuantityLabel(quantity: number | null, unit: string): string {
  if (quantity === null) {
    return "Not Set";
  }
  const unitLabel = Math.abs(quantity) === 1 && unit === "containers" ? "container" : unit;
  return `${formatQuantityNumber(quantity)} ${unitLabel}`;
}

export function getTodayManilaDateString(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isUncertainSubmissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return true;
  }
  const maybeStatus = (error as { status?: unknown }).status;
  const maybeCode = (error as { code?: unknown }).code;
  if (maybeCode === "NETWORK_ERROR") {
    return true;
  }
  if (typeof maybeStatus === "number") {
    return maybeStatus === 0 || maybeStatus >= 500;
  }
  return true;
}

export interface PendingStockMovementAttempt {
  movementType: "STOCK_RECEIVED" | "STOCK_USED";
  itemKey: string;
  itemName: string;
  unit: string;
  quantityInput: string;
  noteOrPurposeInput: string;
  effectiveDate: string;
  requestKey: string;
  expectedRevision: number;
  expectedCurrentQuantity: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PENDING_MOVEMENT_STORAGE_PREFIX = "hydrop_inventory_pending_movements_v1:";

export function pendingMovementStorageKey(username: string): string {
  return `${PENDING_MOVEMENT_STORAGE_PREFIX}${username.trim().toLowerCase()}`;
}

function browserLocalStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isValidPendingMovementAttempt(value: unknown): value is PendingStockMovementAttempt {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.movementType === "STOCK_RECEIVED" || candidate.movementType === "STOCK_USED") &&
    typeof candidate.itemKey === "string" &&
    candidate.itemKey.length > 0 &&
    typeof candidate.itemName === "string" &&
    typeof candidate.unit === "string" &&
    typeof candidate.quantityInput === "string" &&
    typeof candidate.noteOrPurposeInput === "string" &&
    typeof candidate.effectiveDate === "string" &&
    typeof candidate.requestKey === "string" &&
    candidate.requestKey.length > 0 &&
    typeof candidate.expectedRevision === "number" &&
    Number.isInteger(candidate.expectedRevision) &&
    typeof candidate.expectedCurrentQuantity === "number" &&
    Number.isFinite(candidate.expectedCurrentQuantity)
  );
}

export function loadPendingMovementAttempts(
  username: string,
  storage: StorageLike | null = browserLocalStorage(),
): PendingStockMovementAttempt[] {
  const normalizedUser = username.trim().toLowerCase();
  if (!normalizedUser || !storage) return [];
  try {
    const raw = storage.getItem(pendingMovementStorageKey(normalizedUser));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPendingMovementAttempt);
  } catch {
    return [];
  }
}

export function savePendingMovementAttempts(
  username: string,
  attempts: PendingStockMovementAttempt[],
  storage: StorageLike | null = browserLocalStorage(),
): void {
  const normalizedUser = username.trim().toLowerCase();
  if (!normalizedUser || !storage) return;
  try {
    const key = pendingMovementStorageKey(normalizedUser);
    if (attempts.length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(attempts));
    }
  } catch {
    // Ignore quota/storage availability errors; in-memory state remains active.
  }
}

export function upsertPendingMovementAttempt(
  attempts: PendingStockMovementAttempt[],
  next: PendingStockMovementAttempt,
): PendingStockMovementAttempt[] {
  const filtered = attempts.filter(
    (entry) => !(entry.movementType === next.movementType && entry.itemKey === next.itemKey),
  );
  return [...filtered, next];
}

export function removePendingMovementAttempt(
  attempts: PendingStockMovementAttempt[],
  movementType: "STOCK_RECEIVED" | "STOCK_USED",
  itemKey: string,
): PendingStockMovementAttempt[] {
  return attempts.filter(
    (entry) => !(entry.movementType === movementType && entry.itemKey === itemKey),
  );
}

export function formatRecordedAtManila(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  const shifted = new Date(ms + MANILA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = SHORT_MONTHS[shifted.getUTCMonth()]!;
  const day = shifted.getUTCDate();
  const hour24 = shifted.getUTCHours();
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${month} ${day}, ${year} · ${hour12}:${minute} ${period}`;
}

export function formatAlreadySetNotice(
  itemName: string,
  attemptedQuantity: number,
  unit: string,
  existingItem: InventoryItemView | null,
  fallbackMessage: string,
): string {
  if (existingItem?.openingStock) {
    return `Your entry of ${formatQuantityLabel(attemptedQuantity, unit)} was not saved. Opening stock for ${itemName} is already set to ${formatQuantityLabel(existingItem.openingStock.quantity, existingItem.openingStock.unit)} (recorded by ${existingItem.openingStock.recordedBy}).`;
  }
  return fallbackMessage;
}

export function getStockStatusMeta(item: InventoryItemView): StockStatusMeta {
  if (item.status === "NOT_SET" || item.currentQuantity === null) {
    return { tone: "unset", label: "Not Set" };
  }
  if (item.needsReconciliation || item.currentQuantity < 0) {
    return { tone: "discrepancy", label: "Needs Reconciliation" };
  }
  if (item.currentQuantity === 0) {
    return { tone: "out", label: "No Stock" };
  }
  if (
    item.lowStockLevel !== undefined &&
    item.lowStockLevel !== null &&
    item.lowStockLevel > 0 &&
    item.currentQuantity <= item.lowStockLevel
  ) {
    return { tone: "low", label: "Low Stock" };
  }
  return { tone: "in", label: "In Stock" };
}

export function getInventorySummaryCounts(items: InventoryItemView[]): {
  total: number;
  notSet: number;
  noStock: number;
  inStock: number;
} {
  let notSet = 0;
  let noStock = 0;
  let inStock = 0;

  for (const item of items) {
    const { tone } = getStockStatusMeta(item);
    if (tone === "unset") {
      notSet += 1;
    } else if (tone === "out" || (item.currentQuantity !== null && item.currentQuantity <= 0)) {
      noStock += 1;
    } else {
      inStock += 1;
    }
  }

  return {
    total: items.length,
    notSet,
    noStock,
    inStock,
  };
}

export function getContainerSubtitle(shape: ContainerShape): string {
  return shape === "ROUND" ? "Round water container" : "Slim water container";
}

export function getContainerPackageSummary(shape: ContainerShape): string {
  return shape === "ROUND"
    ? "POS packages: Empty ₱175 · Purified 25 L ₱200 · Alkaline 25 L ₱210"
    : "POS packages: Empty ₱200 · Purified 25 L ₱200 · Alkaline 25 L ₱210";
}

export function getPosSectionLabel(
  section: PosSection | null | undefined,
  posSections: readonly PosSectionView[] = DEFAULT_POS_SECTIONS,
): string {
  if (!section) return "Other Products";
  const matched = posSections.find((s) => s.code === section);
  if (matched) return matched.name;
  switch (section) {
    case "CHANGE_OF_GRIPO":
      return "Change of Gripo";
    case "TAKIP_ACCESSORIES":
      return "Takip Types / Accessories";
    case "CONTAINERS":
      return "Containers";
    default:
      return "Other Products";
  }
}

export function getInventoryItemGroup(
  item: InventoryItemView,
  posSections: readonly PosSectionView[] = DEFAULT_POS_SECTIONS,
): string {
  if (item.category === "CONTAINER") {
    return "CONTAINER";
  }
  if (item.category === "OPERATING_SUPPLY") {
    return "OPERATING_SUPPLY";
  }
  if (item.posSection && item.posSection !== "CONTAINERS") {
    const known =
      posSections.some((s) => s.code === item.posSection) ||
      item.posSection === "TAKIP_ACCESSORIES" ||
      item.posSection === "CHANGE_OF_GRIPO";
    if (known) {
      return item.posSection;
    }
  }
  return "OTHER";
}

export interface InventoryGroupBucket {
  key: string;
  title: string;
  metaPrefix: string;
  items: InventoryItemView[];
}

export function groupInventoryItems(
  items: InventoryItemView[],
  filter: InventoryCategoryFilter,
  posSections: readonly PosSectionView[] = DEFAULT_POS_SECTIONS,
): InventoryGroupBucket[] {
  const filtered = filterInventoryItems(items, filter, posSections);
  const buckets = new Map<string, InventoryItemView[]>();
  for (const item of filtered) {
    const key = getInventoryItemGroup(item, posSections);
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }

  const orderedSections = [...posSections]
    .filter((s) => s.code !== "CONTAINERS")
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

  const result: InventoryGroupBucket[] = [];

  const containerItems = buckets.get("CONTAINER");
  if (containerItems && containerItems.length > 0) {
    result.push({
      key: "CONTAINER",
      title: "Containers",
      metaPrefix: "Whole containers",
      items: containerItems,
    });
  }

  for (const section of orderedSections) {
    const groupItems = buckets.get(section.code);
    if (!groupItems || groupItems.length === 0) continue;
    result.push({
      key: section.code,
      title: section.name,
      metaPrefix: section.isBuiltIn ? "Standalone merchandise" : "Custom POS section",
      items: groupItems,
    });
  }

  const otherItems = buckets.get("OTHER");
  if (otherItems && otherItems.length > 0) {
    result.push({
      key: "OTHER",
      title: "Other Products",
      metaPrefix: "Unassigned POS section",
      items: otherItems,
    });
  }

  const supplyItems = buckets.get("OPERATING_SUPPLY");
  if (supplyItems && supplyItems.length > 0) {
    result.push({
      key: "OPERATING_SUPPLY",
      title: "Operating Supplies",
      metaPrefix: "Station supplies",
      items: supplyItems,
    });
  }

  return result;
}

export function filterInventoryItems(
  items: InventoryItemView[],
  filter: InventoryCategoryFilter,
  posSections: readonly PosSectionView[] = DEFAULT_POS_SECTIONS,
): InventoryItemView[] {
  if (filter === "ALL") {
    return items;
  }
  return items.filter((item) => getInventoryItemGroup(item, posSections) === filter);
}

export function getInventoryLoadPhase(state: {
  hasLoaded: boolean;
  loading: boolean;
  loadError: string | null;
}): InventoryLoadPhase {
  if (!state.hasLoaded) {
    return state.loadError ? "initial-error" : "initial-loading";
  }
  if (state.loadError && !state.loading) {
    return "refresh-error";
  }
  return "ready";
}

export function getOpeningSubmitLabel(
  target: ContainerShape | InventoryItemView,
  isSubmitting: boolean,
): string {
  if (isSubmitting) {
    return "Saving opening count…";
  }
  if (typeof target === "string") {
    return target === "ROUND" ? "Save Round Opening Count" : "Save Slim Opening Count";
  }
  if (target.shape === "ROUND") {
    return "Save Round Opening Count";
  }
  if (target.shape === "SLIM") {
    return "Save Slim Opening Count";
  }
  return "Save Opening Count";
}

export function getInventoryItemKey(item: InventoryItemView): string {
  return item.id ?? item.shape ?? item.code;
}

export function mergeRefreshedInventoryItems(
  currentItems: InventoryItemView[],
  fetchedItems: InventoryItemView[],
): InventoryItemView[] {
  const currentByKey = new Map<string, InventoryItemView>(
    currentItems.map((item) => [getInventoryItemKey(item), item]),
  );

  return fetchedItems.map((fetched) => {
    const existing = currentByKey.get(getInventoryItemKey(fetched));
    if (
      existing &&
      existing.status === "INITIALIZED" &&
      fetched.status === "NOT_SET"
    ) {
      return existing;
    }
    if (
      existing &&
      typeof existing.stockRevision === "number" &&
      typeof fetched.stockRevision === "number" &&
      fetched.stockRevision < existing.stockRevision
    ) {
      return existing;
    }
    return fetched;
  });
}

const CANONICAL_DECIMAL_REGEX = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;

function parseExactFourDecimalScaled(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const match = CANONICAL_DECIMAL_REGEX.exec(String(value));
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const whole = Number(match[2]);
  const frac = Number((match[3] ?? "").padEnd(4, "0"));
  const scaled = sign * (whole * QUANTITY_SCALE + frac);
  return Number.isSafeInteger(scaled) ? scaled : null;
}

function isValidOpeningStockRecord(value: unknown): value is OpeningStockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const scaledQuantity =
    typeof candidate.quantity === "number" ? parseExactFourDecimalScaled(candidate.quantity) : null;
  return (
    scaledQuantity !== null &&
    scaledQuantity >= 0 &&
    typeof candidate.unit === "string" &&
    candidate.unit.length > 0 &&
    typeof candidate.recordedBy === "string" &&
    candidate.recordedBy.length > 0 &&
    typeof candidate.recordedAt === "string" &&
    candidate.recordedAt.length > 0
  );
}

export function isValidInventoryItemPayload(value: unknown): value is InventoryItemView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.code !== "string" ||
    candidate.code.length === 0 ||
    typeof candidate.name !== "string" ||
    candidate.name.length === 0 ||
    typeof candidate.unit !== "string" ||
    candidate.unit.length === 0 ||
    (candidate.category !== "CONTAINER" &&
      candidate.category !== "MERCHANDISE" &&
      candidate.category !== "OPERATING_SUPPLY") ||
    typeof candidate.stockRevision !== "number" ||
    !Number.isInteger(candidate.stockRevision) ||
    candidate.stockRevision < 0
  ) {
    return false;
  }
  if (candidate.status === "NOT_SET") {
    return candidate.currentQuantity === null && candidate.openingStock === null;
  }
  if (candidate.status === "INITIALIZED") {
    const validOpeningStock =
      candidate.openingStock === null
        ? candidate.category === "OPERATING_SUPPLY"
        : isValidOpeningStockRecord(candidate.openingStock);
    return (
      typeof candidate.currentQuantity === "number" &&
      parseExactFourDecimalScaled(candidate.currentQuantity) !== null &&
      validOpeningStock
    );
  }
  return false;
}

export function isValidSavedMovementItemPayload(value: unknown): value is InventoryItemView {
  return (
    isValidInventoryItemPayload(value) &&
    value.status === "INITIALIZED" &&
    typeof value.currentQuantity === "number" &&
    parseExactFourDecimalScaled(value.currentQuantity) !== null &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

export function isValidStockMovementPayload(value: unknown): value is StockMovementView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.itemId !== "string" ||
    candidate.itemId.length === 0 ||
    (candidate.movementType !== "STOCK_RECEIVED" && candidate.movementType !== "STOCK_USED") ||
    typeof candidate.quantity !== "number" ||
    typeof candidate.quantityDelta !== "number" ||
    typeof candidate.balanceBefore !== "number" ||
    typeof candidate.balanceAfter !== "number" ||
    typeof candidate.unit !== "string" ||
    candidate.unit.length === 0 ||
    typeof candidate.effectiveDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(candidate.effectiveDate) ||
    (candidate.note !== null && typeof candidate.note !== "string") ||
    typeof candidate.recordedBy !== "string" ||
    candidate.recordedBy.length === 0 ||
    typeof candidate.recordedAt !== "string" ||
    candidate.recordedAt.length === 0
  ) {
    return false;
  }
  if (
    candidate.entryStatus !== undefined &&
    candidate.entryStatus !== "APPLIED" &&
    candidate.entryStatus !== "PENDING_REVIEW"
  ) {
    return false;
  }
  if (
    candidate.coverageMode !== undefined &&
    candidate.coverageMode !== null &&
    candidate.coverageMode !== "NONE" &&
    candidate.coverageMode !== "FULL" &&
    candidate.coverageMode !== "PARTIAL" &&
    candidate.coverageMode !== "UNCLEAR"
  ) {
    return false;
  }

  const scaledQty = parseExactFourDecimalScaled(candidate.quantity);
  const scaledDelta = parseExactFourDecimalScaled(candidate.quantityDelta);
  const scaledBefore = parseExactFourDecimalScaled(candidate.balanceBefore);
  const scaledAfter = parseExactFourDecimalScaled(candidate.balanceAfter);
  if (
    scaledQty === null ||
    scaledQty <= 0 ||
    scaledDelta === null ||
    scaledBefore === null ||
    scaledAfter === null
  ) {
    return false;
  }

  const allowsZeroEffect =
    candidate.entryStatus === "PENDING_REVIEW" || candidate.coverageMode === "FULL";
  if (scaledDelta === 0) {
    return allowsZeroEffect && scaledBefore === scaledAfter;
  }

  const signMatches =
    candidate.movementType === "STOCK_RECEIVED" ? scaledDelta > 0 : scaledDelta < 0;
  if (!signMatches || scaledBefore + scaledDelta !== scaledAfter) {
    return false;
  }

  if (candidate.coverageMode === "PARTIAL") {
    const scaledCovered =
      typeof candidate.coveredQuantity === "number"
        ? parseExactFourDecimalScaled(candidate.coveredQuantity)
        : null;
    return (
      scaledCovered !== null &&
      scaledCovered > 0 &&
      Math.abs(scaledDelta) + scaledCovered === scaledQty
    );
  }

  return Math.abs(scaledDelta) === scaledQty;
}

export function matchesPendingMovementAttempt(
  attempt: PendingStockMovementAttempt,
  item: InventoryItemView,
  movement: StockMovementView,
): boolean {
  if (typeof item.id !== "string" || item.id !== movement.itemId) {
    return false;
  }
  if (getInventoryItemKey(item) !== attempt.itemKey) {
    return false;
  }
  if (movement.movementType !== attempt.movementType) {
    return false;
  }
  if (item.unit !== attempt.unit || movement.unit !== attempt.unit) {
    return false;
  }
  if (movement.effectiveDate !== attempt.effectiveDate) {
    return false;
  }
  const parsedQty = parseMovementQuantityInput(attempt.quantityInput, attempt.unit, true);
  if (!parsedQty.ok) {
    return false;
  }
  const scaledExpectedQty = parseExactFourDecimalScaled(parsedQty.quantity);
  const scaledMovementQty = parseExactFourDecimalScaled(movement.quantity);
  const scaledMovementDelta = parseExactFourDecimalScaled(movement.quantityDelta);
  if (
    scaledExpectedQty === null ||
    scaledMovementQty === null ||
    scaledMovementDelta === null ||
    scaledMovementQty !== scaledExpectedQty
  ) {
    return false;
  }

  if (movement.entryStatus === "PENDING_REVIEW" || movement.coverageMode === "FULL") {
    if (scaledMovementDelta !== 0) {
      return false;
    }
  } else if (movement.coverageMode === "PARTIAL") {
    const scaledCovered =
      typeof movement.coveredQuantity === "number"
        ? parseExactFourDecimalScaled(movement.coveredQuantity)
        : null;
    if (
      scaledCovered === null ||
      scaledCovered <= 0 ||
      Math.abs(scaledMovementDelta) + scaledCovered !== scaledExpectedQty
    ) {
      return false;
    }
  } else if (Math.abs(scaledMovementDelta) !== scaledExpectedQty) {
    return false;
  }

  const expectedNote = attempt.noteOrPurposeInput.trim().replace(/\s+/g, " ") || null;
  return (movement.note ?? null) === expectedNote;
}

export interface LateCoveragePreview {
  enteredQuantity: number;
  coveredQuantity: number;
  uncoveredQuantity: number;
  signedDelta: number;
  projectedBalance: number | null;
  pendingReview: boolean;
}

export function computeLateCoveragePreview(params: {
  movementType: "STOCK_RECEIVED" | "STOCK_USED";
  currentQuantity: number | null;
  enteredQuantity: number;
  coverageMode: MovementCoverageMode;
  coveredQuantity?: number | null;
}): LateCoveragePreview | null {
  const enteredScaled = parseExactFourDecimalScaled(params.enteredQuantity);
  if (enteredScaled === null || enteredScaled <= 0) return null;

  if (params.coverageMode === "UNCLEAR") {
    return {
      enteredQuantity: enteredScaled / QUANTITY_SCALE,
      coveredQuantity: 0,
      uncoveredQuantity: 0,
      signedDelta: 0,
      projectedBalance: params.currentQuantity,
      pendingReview: true,
    };
  }

  let coveredScaled = 0;
  if (params.coverageMode === "FULL") {
    coveredScaled = enteredScaled;
  } else if (params.coverageMode === "PARTIAL") {
    const parsedCov =
      typeof params.coveredQuantity === "number"
        ? parseExactFourDecimalScaled(params.coveredQuantity)
        : null;
    if (parsedCov === null || parsedCov <= 0 || parsedCov >= enteredScaled) {
      return null;
    }
    coveredScaled = parsedCov;
  }

  const uncoveredScaled = enteredScaled - coveredScaled;
  const signedScaledDelta =
    uncoveredScaled === 0
      ? 0
      : params.movementType === "STOCK_RECEIVED"
        ? uncoveredScaled
        : -uncoveredScaled;

  let projectedBalance = params.currentQuantity;
  if (params.currentQuantity !== null) {
    const currentScaled = parseExactFourDecimalScaled(params.currentQuantity);
    projectedBalance =
      currentScaled !== null
        ? (currentScaled + signedScaledDelta) / QUANTITY_SCALE
        : params.currentQuantity + signedScaledDelta / QUANTITY_SCALE;
  }

  return {
    enteredQuantity: enteredScaled / QUANTITY_SCALE,
    coveredQuantity: coveredScaled / QUANTITY_SCALE,
    uncoveredQuantity: uncoveredScaled / QUANTITY_SCALE,
    signedDelta: signedScaledDelta / QUANTITY_SCALE,
    projectedBalance,
    pendingReview: false,
  };
}

export interface CorrectionPreview {
  rawDelta: number;
  coveredQuantity: number;
  appliedDelta: number;
  projectedBalance: number | null;
  pendingReview: boolean;
  requiresCountBeforeNegative: boolean;
}

function computeSignedCorrectionPreview(params: {
  rawSignedDelta: number;
  currentBalance: number | null;
  category: InventoryCategory;
  coverageMode: MovementCoverageMode;
  coveredQuantity?: number;
}): CorrectionPreview | null {
  const rawScaled = parseExactFourDecimalScaled(params.rawSignedDelta);
  if (rawScaled === null || rawScaled === 0) {
    return null;
  }
  const absScaled = Math.abs(rawScaled);
  if (params.coverageMode === "UNCLEAR") {
    return {
      rawDelta: rawScaled / QUANTITY_SCALE,
      coveredQuantity: 0,
      appliedDelta: 0,
      projectedBalance: params.currentBalance,
      pendingReview: true,
      requiresCountBeforeNegative: false,
    };
  }
  let coveredScaled = 0;
  if (params.coverageMode === "FULL") {
    coveredScaled = absScaled;
  } else if (params.coverageMode === "PARTIAL") {
    const parsed =
      typeof params.coveredQuantity === "number"
        ? parseExactFourDecimalScaled(params.coveredQuantity)
        : null;
    if (parsed === null || parsed <= 0 || parsed >= absScaled) {
      return null;
    }
    coveredScaled = parsed;
  }

  const remainingScaled = absScaled - coveredScaled;
  const appliedScaled =
    remainingScaled === 0 ? 0 : rawScaled > 0 ? remainingScaled : -remainingScaled;
  let projectedBalance = params.currentBalance;
  if (params.currentBalance !== null) {
    const currScaled = parseExactFourDecimalScaled(params.currentBalance);
    projectedBalance =
      currScaled !== null
        ? (currScaled + appliedScaled) / QUANTITY_SCALE
        : params.currentBalance + appliedScaled / QUANTITY_SCALE;
  }
  const requiresCountBeforeNegative =
    params.category !== "OPERATING_SUPPLY" &&
    appliedScaled < 0 &&
    projectedBalance !== null &&
    projectedBalance < 0;

  return {
    rawDelta: rawScaled / QUANTITY_SCALE,
    coveredQuantity: coveredScaled / QUANTITY_SCALE,
    appliedDelta: appliedScaled / QUANTITY_SCALE,
    projectedBalance,
    pendingReview: false,
    requiresCountBeforeNegative,
  };
}

export function computeQuantityCorrectionPreview(params: {
  movementType: "STOCK_RECEIVED" | "STOCK_USED";
  previousQuantity: number;
  newQuantity: number;
  currentBalance: number | null;
  category: InventoryCategory;
  coverageMode: MovementCoverageMode;
  coveredQuantity?: number;
}): CorrectionPreview | null {
  const prevScaled = parseExactFourDecimalScaled(params.previousQuantity);
  const newScaled = parseExactFourDecimalScaled(params.newQuantity);
  if (prevScaled === null || newScaled === null || prevScaled <= 0 || newScaled <= 0) {
    return null;
  }
  const diffScaled = newScaled - prevScaled;
  if (diffScaled === 0) return null;
  const rawSignedScaled =
    params.movementType === "STOCK_RECEIVED" ? diffScaled : -diffScaled;
  return computeSignedCorrectionPreview({
    rawSignedDelta: rawSignedScaled / QUANTITY_SCALE,
    currentBalance: params.currentBalance,
    category: params.category,
    coverageMode: params.coverageMode,
    coveredQuantity: params.coveredQuantity,
  });
}

export function computeCancelMovementPreview(params: {
  movementType: "STOCK_RECEIVED" | "STOCK_USED";
  entryStatus: MovementEntryStatus;
  latestQuantity: number;
  currentBalance: number | null;
  category: InventoryCategory;
  coverageMode: MovementCoverageMode;
  coveredQuantity?: number;
}): CorrectionPreview | null {
  if (params.entryStatus === "PENDING_REVIEW") {
    return {
      rawDelta: 0,
      coveredQuantity: params.latestQuantity,
      appliedDelta: 0,
      projectedBalance: params.currentBalance,
      pendingReview: false,
      requiresCountBeforeNegative: false,
    };
  }
  const latestScaled = parseExactFourDecimalScaled(params.latestQuantity);
  if (latestScaled === null || latestScaled <= 0) return null;
  const rawSignedScaled =
    params.movementType === "STOCK_RECEIVED" ? -latestScaled : latestScaled;
  return computeSignedCorrectionPreview({
    rawSignedDelta: rawSignedScaled / QUANTITY_SCALE,
    currentBalance: params.currentBalance,
    category: params.category,
    coverageMode: params.coverageMode,
    coveredQuantity: params.coveredQuantity,
  });
}

export function computeReceiptItemCorrectionPreview(params: {
  quantity: number;
  wrongItem: InventoryItemView;
  correctItem: InventoryItemView;
  wrongCoverageMode: MovementCoverageMode;
  wrongCoveredQuantity?: number;
  correctCoverageMode: MovementCoverageMode;
  correctCoveredQuantity?: number;
}):
  | {
      kind: "DIFFERENT_UNITS";
      wrongUnit: string;
      correctUnit: string;
    }
  | {
      kind: "SAME_UNIT";
      wrongSide: CorrectionPreview;
      correctSide: CorrectionPreview;
      pendingReview: boolean;
      requiresCountBeforeNegative: boolean;
    }
  | null {
  const unitsMatch =
    params.wrongItem.unit.trim().toLowerCase() === params.correctItem.unit.trim().toLowerCase();
  const qtyFitsTarget =
    params.correctItem.allowDecimalQuantity || Number.isInteger(params.quantity);
  if (!unitsMatch || !qtyFitsTarget) {
    return {
      kind: "DIFFERENT_UNITS",
      wrongUnit: params.wrongItem.unit,
      correctUnit: params.correctItem.unit,
    };
  }
  const qtyScaled = parseExactFourDecimalScaled(params.quantity);
  if (qtyScaled === null || qtyScaled <= 0) return null;

  const wrongSide = computeSignedCorrectionPreview({
    rawSignedDelta: -params.quantity,
    currentBalance: params.wrongItem.currentQuantity,
    category: params.wrongItem.category,
    coverageMode: params.wrongCoverageMode,
    coveredQuantity: params.wrongCoveredQuantity,
  });
  const correctSide = computeSignedCorrectionPreview({
    rawSignedDelta: params.quantity,
    currentBalance: params.correctItem.currentQuantity,
    category: params.correctItem.category,
    coverageMode: params.correctCoverageMode,
    coveredQuantity: params.correctCoveredQuantity,
  });
  if (!wrongSide || !correctSide) return null;
  const pendingReview = wrongSide.pendingReview || correctSide.pendingReview;
  return {
    kind: "SAME_UNIT",
    wrongSide: pendingReview ? { ...wrongSide, appliedDelta: 0 } : wrongSide,
    correctSide: pendingReview ? { ...correctSide, appliedDelta: 0 } : correctSide,
    pendingReview,
    requiresCountBeforeNegative: !pendingReview && wrongSide.requiresCountBeforeNegative,
  };
}

export type PendingMovementStatusResult =
  | { kind: "SAVED"; item: InventoryItemView; movement: StockMovementView }
  | { kind: "CANCELLED" }
  | { kind: "NOT_FOUND" }
  | { kind: "UNEXPECTED" };

export type PendingMovementCancelResult =
  | { kind: "SAVED"; item: InventoryItemView; movement: StockMovementView }
  | { kind: "CANCELLED" }
  | { kind: "UNEXPECTED" };

export function parsePendingMovementStatusResponse(
  payload: unknown,
  attempt: PendingStockMovementAttempt,
): PendingMovementStatusResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "UNEXPECTED" };
  }
  const candidate = payload as Record<string, unknown>;
  if (candidate.status === "SAVED") {
    if (
      isValidSavedMovementItemPayload(candidate.item) &&
      isValidStockMovementPayload(candidate.movement) &&
      matchesPendingMovementAttempt(attempt, candidate.item, candidate.movement)
    ) {
      return {
        kind: "SAVED",
        item: candidate.item,
        movement: candidate.movement,
      };
    }
    return { kind: "UNEXPECTED" };
  }
  if (candidate.status === "CANCELLED") {
    return { kind: "CANCELLED" };
  }
  if (candidate.status === "NOT_FOUND") {
    return { kind: "NOT_FOUND" };
  }
  return { kind: "UNEXPECTED" };
}

export function parsePendingMovementCancelResponse(
  payload: unknown,
  attempt: PendingStockMovementAttempt,
): PendingMovementCancelResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "UNEXPECTED" };
  }
  const candidate = payload as Record<string, unknown>;
  if (candidate.status === "SAVED") {
    if (
      isValidSavedMovementItemPayload(candidate.item) &&
      isValidStockMovementPayload(candidate.movement) &&
      matchesPendingMovementAttempt(attempt, candidate.item, candidate.movement)
    ) {
      return {
        kind: "SAVED",
        item: candidate.item,
        movement: candidate.movement,
      };
    }
    return { kind: "UNEXPECTED" };
  }
  if (candidate.status === "CANCELLED") {
    return { kind: "CANCELLED" };
  }
  return { kind: "UNEXPECTED" };
}

export async function requestPendingMovementStatus(
  attempt: PendingStockMovementAttempt,
  fetcher: typeof api = api,
): Promise<PendingMovementStatusResult> {
  const payload = await fetcher<unknown>(
    `/api/inventory/movements/by-request-key/${encodeURIComponent(attempt.requestKey)}`,
  );
  return parsePendingMovementStatusResponse(payload, attempt);
}

export async function requestPendingMovementCancel(
  attempt: PendingStockMovementAttempt,
  endpointItemKey: string,
  fetcher: typeof api = api,
): Promise<PendingMovementCancelResult> {
  const payload = await fetcher<unknown>(
    `/api/inventory/movements/by-request-key/${encodeURIComponent(attempt.requestKey)}/cancel`,
    {
      method: "POST",
      body: {
        itemKey: endpointItemKey,
        movementType: attempt.movementType,
      },
    },
  );
  return parsePendingMovementCancelResponse(payload, attempt);
}
