/** Pure POS domain view types, formatting, cart scoping, and recovery state machine. */

export type WaterType = "PURIFIED" | "ALKALINE";
export type ItemKind = "STANDARD" | "CUSTOM" | "MERCHANDISE" | "CONTAINER_PACKAGE";
export type PosSection = string;
export type ContainerShape = "ROUND" | "SLIM";
export type IncludedGripoType = "PUSH_TYPE" | "TWIST_TYPE";
export type FaucetReportingType = "PUSH_TYPE" | "TWIST_TYPE";
export type ContainerPackageCode =
  | "ROUND_EMPTY"
  | "ROUND_PURIFIED"
  | "ROUND_ALKALINE"
  | "SLIM_EMPTY"
  | "SLIM_PURIFIED"
  | "SLIM_ALKALINE";

export function formatIncludedGripoLabel(gripo: IncludedGripoType): string {
  return gripo === "PUSH_TYPE" ? "Push-Type gripo" : "Twist-Type gripo";
}
export type DayState = "NOT_STARTED" | "OPEN" | "CLOSED" | "PREVIOUS_DAY_OPEN";
export type CheckoutStatus =
  | "DRAFT"
  | "PAYMENT_PENDING"
  | "SAVED"
  | "REVIEW_REQUIRED"
  | "SETTLED_PRIOR_DAY"
  | "CANCELLED_DRAFT"
  | "CANCELLED_NO_CASH"
  | "REFUNDED_UNSAVED";
export type SaleStatus = "ACTIVE" | "VOIDED";
export type RecoveryState =
  | "SAVED"
  | "SAFE_TO_RETRY"
  | "UNRESOLVED"
  | "REVIEW_REQUIRED"
  | "SETTLED_PRIOR_DAY"
  | "CANCELLED"
  | "CANCELLED_NO_CASH"
  | "REFUNDED_UNSAVED";

export interface CatalogRefill {
  code: string;
  waterType: WaterType;
  displayName: string;
  unitVolumeMl: number;
  unitVolumeLiters: number;
  unitPriceCentavos: number;
}

export interface PosSectionInfo {
  code: string;
  name: string;
  isBuiltIn: boolean;
  sortOrder: number;
}

export interface PosContainerPackageItem {
  packageCode: ContainerPackageCode;
  shape: ContainerShape;
  productId: string;
  name: string;
  description: string;
  unit: string;
  waterType: WaterType | null;
  unitVolumeMl: number;
  unitVolumeLiters: number;
  unitPriceCentavos: number;
  posSection: "CONTAINERS";
  stockStatus: "NOT_SET" | "OUT_OF_STOCK" | "IN_STOCK";
  currentQuantity: number | null;
  availableQuantity: number | null;
}

export interface PosMerchandiseItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unit: string;
  unitPriceCentavos: number;
  posSection: PosSection;
  faucetReportingType?: FaucetReportingType | null;
  stockStatus: "NOT_SET" | "OUT_OF_STOCK" | "IN_STOCK";
  currentQuantity: number | null;
  availableQuantity: number | null;
}

export type CartItemInput =
  | {
      kind: "STANDARD";
      waterType: WaterType;
      quantity: number;
    }
  | {
      kind: "CUSTOM";
      waterType: WaterType;
      unitVolumeLiters: number;
      unitPriceCentavos: number;
      quantity: number;
    }
  | {
      kind: "MERCHANDISE";
      productId: string;
      quantity: number;
    }
  | {
      kind: "CONTAINER_PACKAGE";
      packageCode: ContainerPackageCode;
      includedGripo?: IncludedGripoType;
      quantity: number;
    };

export interface QuoteLineItem {
  lineIndex: number;
  kind: ItemKind;
  catalogCode: string | null;
  waterType: WaterType | null;
  productId?: string | null;
  stockUnit?: string | null;
  posSection?: PosSection | null;
  includedGripo?: IncludedGripoType | null;
  faucetReportingType?: FaucetReportingType | null;
  displayLabel: string;
  unitVolumeMl: number;
  unitVolumeLiters: number;
  unitPriceCentavos: number;
  quantity: number;
  lineTotalCentavos: number;
  lineVolumeMl: number;
  lineVolumeLiters: number;
}

export interface DaySummaryView {
  businessDate: string;
  totalSalesCentavos: number;
  validTransactionCount: number;
  purifiedQuantity: number;
  alkalineQuantity: number;
  purifiedVolumeMl: number;
  alkalineVolumeMl: number;
  totalVolumeMl: number;
  totalVolumeLiters: number;
  voidedCount: number;
  voidedTotalCentavos: number;
}

export interface DayView {
  businessDate: string;
  startedBy: string;
  startedAt: string;
  closedBy: string | null;
  closedAt: string | null;
  summary: DaySummaryView;
}

export interface CheckoutView {
  reference: string;
  businessDate: string;
  status: CheckoutStatus;
  createdBy: string;
  ownedByCurrentUser?: boolean;
  createdAt: string;
  updatedAt: string;
  totalCentavos: number;
  totalContainers: number;
  totalVolumeMl: number;
  totalVolumeLiters: number;
  cashReceivedCentavos: number | null;
  changeCentavos: number | null;
  paymentStartedAt: string | null;
  paymentRecordedAt: string | null;
  resolutionReason: string | null;
  items: QuoteLineItem[];
}

export interface PosDayResponse {
  state: DayState;
  todayDate: string;
  canStartDay: boolean;
  canSell: boolean;
  canEndDay: boolean;
  day: DayView | null;
  unresolvedCheckouts: CheckoutView[];
  unpaidDrafts: CheckoutView[];
  pendingSaleActions?: SaleActionRequestView[];
  priorDayReviewCheckouts?: CheckoutView[];
  replayed?: boolean;
}

export type SaleActionType = "VOID" | "CORRECT";
export type SaleActionStatus = "PENDING" | "COMPLETED" | "CANCELLED_NO_CASH";
export type SaleActionCashDirection = "REFUND" | "COLLECT" | "NONE";

export interface SaleCashEventChain {
  rootCashSale: {
    reference: string;
    totalCentavos: number;
    cashReceivedCentavos: number;
    changeCentavos: number;
  };
  correctionEvents: Array<{
    actionReference: string;
    originalSaleReference: string;
    replacementSaleReference: string;
    originalTotalCentavos: number;
    correctedTotalCentavos: number;
    cashDirection: SaleActionCashDirection;
    cashDifferenceCentavos: number;
    cashTenderedCentavos: number | null;
    cashChangeCentavos: number | null;
    cashRefundedCentavos: number | null;
    completedAt: string | null;
  }>;
}

export type SaleActionCountCoverage = "COVERED_BY_COUNT" | "UNCOVERED" | "UNCLEAR" | "PARTIAL";

export interface SaleActionStockDispositionInput {
  productId: string;
  exchangedQuantity?: number;
  eligibleReturnedQuantity?: number;
  heldQuantity?: number;
  notReturnedQuantity?: number;
  holdReason?: string;
  countCoverage?: SaleActionCountCoverage;
  uncoveredReturnedQuantity?: number;
  coveredByCountQuantity?: number;
  unclearCoverageQuantity?: number;
}

export interface SaleActionMerchandisePlanItem {
  productId: string;
  productName: string;
  unit: string;
  originalQuantity: number;
  correctedQuantity: number;
  retainedQuantity: number;
  exchangedQuantity: number;
  addedQuantity: number;
  returningFromSaleQuantity: number;
  returningFilledQuantity?: number;
  eligibleReturnedQuantity?: number;
  notReturnedQuantity?: number;
  restoredQuantity: number;
  heldQuantity: number;
  holdReason: string | null;
  countCoveredQuantity: number;
  unclearCoverageQuantity: number;
  interveningReconciliationId: string | null;
  interveningReconciliationAt: string | null;
  interveningPhysicalCount: number | null;
  countCoverage: SaleActionCountCoverage | null;
}

export interface SaleActionRequestView {
  reference: string;
  originalSaleReference: string;
  originalSaleIsReplacement: boolean;
  originalBusinessDate: string;
  actionType: SaleActionType;
  status: SaleActionStatus;
  reason: string;
  originalTotalCentavos: number;
  originalCashReceivedCentavos: number | null;
  originalChangeCentavos: number | null;
  correctedTotalCentavos: number;
  cashDifferenceCentavos: number;
  cashDirection: SaleActionCashDirection;
  correctedItems: QuoteLineItem[] | null;
  merchandisePlan: {
    hasMerchandise: boolean;
    requiresInventoryReview?: boolean;
    items?: SaleActionMerchandisePlanItem[];
    retained: Array<{ productId: string; quantity: number }>;
    added: Array<{ productId: string; quantity: number }>;
    returned: Array<{ productId: string; quantity: number }>;
    held: Array<{ productId: string; quantity: number; reason?: string | null }>;
  };
  cashTenderedCentavos: number | null;
  cashChangeCentavos: number | null;
  cashRefundedCentavos: number | null;
  replacementSaleReference: string | null;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  updatedAt: string;
}

export interface SaleActionLookupResponse {
  action: SaleActionRequestView;
  originalSale: SaleView | null;
  replacementSale: SaleView | null;
  canConfirm: boolean;
  canCancelNoCash: boolean;
}

export interface SaleActionView {
  action: "SALE_SAVED" | "SALE_VOIDED";
  actor: string;
  note: string | null;
  recordedAt: string;
}

export interface SaleView {
  reference: string;
  checkoutReference: string | null;
  businessDate: string;
  status: SaleStatus;
  totalCentavos: number;
  cashReceivedCentavos: number;
  changeCentavos: number;
  totalContainers: number;
  totalVolumeMl: number;
  totalVolumeLiters: number;
  createdBy: string;
  createdAt: string;
  correctedFromSaleReference?: string | null;
  replacedBySaleReference?: string | null;
  sourceAction?: SaleActionRequestView | null;
  cashEventChain?: SaleCashEventChain | null;
  pendingAction?: SaleActionRequestView | null;
  completedAction?: SaleActionRequestView | null;
  items: QuoteLineItem[];
  actionHistory: SaleActionView[];
}

export interface PriorDaySettlementView {
  checkoutReference: string;
  originalBusinessDate: string;
  settlementDate: string;
  outcome: "PAID_AND_DELIVERED";
  netAmountKeptCentavos: number;
  cashReceivedCentavos: number | null;
  changeCentavos: number | null;
  totalContainers: number;
  totalVolumeMl: number;
  totalVolumeLiters: number;
  items: QuoteLineItem[];
  originalActor: string;
  originalPaymentStartedAt?: string | null;
  originalPaymentRecordedAt: string | null;
  paymentKeptConfirmed: true;
  refillDeliveredConfirmed: boolean;
  itemsHandedOverConfirmed?: boolean;
  settledBy: string;
  settledAt: string;
  note: string | null;
}

export interface CheckoutHoldView {
  id: string;
  itemId: string;
  itemName: string;
  quantity: number;
  unit: string;
  reason: string;
  posReference: string;
  recordedBy: string;
  recordedAt: string;
}

export interface CheckoutResolutionView {
  checkoutReference: string;
  originalBusinessDate: string;
  resolutionDate: string;
  outcome: "NO_CASH_CANCELLED" | "FULL_REFUND";
  quoteTotalCentavos: number;
  cashReceivedCentavos: number | null;
  changeAlreadyGiven: boolean | null;
  changeGivenCentavos: number | null;
  refundedAmountCentavos: number | null;
  items: QuoteLineItem[];
  originalActor: string;
  resolvedBy: string;
  resolvedAt: string;
  reason: string;
  note: string | null;
  heldItems: CheckoutHoldView[];
}

export interface CheckoutLookupView {
  recoveryState: RecoveryState;
  reason: string | null;
  canRetry: boolean;
  canCancelUnpaid?: boolean;
  canSettlePriorDay?: boolean;
  canDismissCancelled?: boolean;
  canResolveNoCashPriorDay?: boolean;
  canResolveFullRefund?: boolean;
  ownedByCurrentUser: boolean;
  checkedAt: string;
  checkout: CheckoutView;
  sale: SaleView | null;
  settlement?: PriorDaySettlementView | null;
  resolution?: CheckoutResolutionView | null;
}

export interface ResolveCheckoutResponse {
  outcome: "RESOLVED";
  replayed: boolean;
  resolution: CheckoutResolutionView;
  sale: null;
  settlement: null;
  checkout: CheckoutView;
}

export interface SettlePriorDayResponse {
  outcome: "SETTLED" | "ALREADY_SAVED";
  replayed: boolean;
  settlement: PriorDaySettlementView | null;
  sale: SaleView | null;
  checkout: CheckoutView;
}

export interface PrepareCheckoutResponse {
  checkout: CheckoutView;
  replayed: boolean;
}

export interface BeginPaymentResponse {
  checkout: CheckoutView;
  replayed: boolean;
}

export interface ConfirmSaleResponse {
  sale: SaleView;
  checkout: CheckoutView;
  replayed: boolean;
}

export interface EndDayResponse {
  state: "CLOSED";
  day: DayView;
  summary: DaySummaryView;
  clearedDraftReferences: string[];
  replayed: boolean;
}

export interface SalesListResponse {
  businessDate: string;
  status: "ACTIVE" | "VOIDED" | "ALL";
  query: string;
  sales: SaleView[];
  priorDaySettlements?: PriorDaySettlementView[];
}

export type CartDraftLine =
  | {
      id: string;
      kind: "STANDARD";
      waterType: WaterType;
      displayName: string;
      unitVolumeMl: number;
      unitVolumeLiters: number;
      unitPriceCentavos: number;
      quantity: number;
    }
  | {
      id: string;
      kind: "CUSTOM";
      waterType: WaterType;
      displayName: string;
      unitVolumeLiters: number;
      unitPriceCentavos: number;
      quantity: number;
    }
  | {
      id: string;
      kind: "MERCHANDISE";
      productId: string;
      displayName: string;
      description: string | null;
      stockUnit: string;
      posSection: PosSection;
      unitPriceCentavos: number;
      quantity: number;
    }
  | {
      id: string;
      kind: "CONTAINER_PACKAGE";
      packageCode: ContainerPackageCode;
      includedGripo: IncludedGripoType | null;
      productId: string;
      displayName: string;
      unitVolumeMl: number;
      unitVolumeLiters: number;
      unitPriceCentavos: number;
      stockUnit: string;
      quantity: number;
    };

export interface UnpaidCartSnapshot {
  ownerUsername: string;
  businessDate: string;
  lines: CartDraftLine[];
  preparedCheckout: CheckoutView | null;
  prepareKey: string | null;
  prepareSignature: string | null;
}

export interface PendingCheckoutRecovery {
  reference: string;
  businessDate: string;
  initiatedBy: string;
  source?: "local" | "server";
  items: CartItemInput[];
  quoteItems: QuoteLineItem[];
  totalCentavos: number;
  totalContainers: number;
  totalVolumeMl: number;
  totalVolumeLiters: number;
  cashReceivedCentavos: number | null;
  changeCentavos: number | null;
  attemptedAt: string;
  lastLookup: CheckoutLookupView | null;
  lastError: string | null;
}

export type RecoveryScreen =
  | "UNKNOWN"
  | "SAVED"
  | "SAFE_TO_RETRY"
  | "REVIEW_REQUIRED"
  | "SETTLED_PRIOR_DAY"
  | "CANCELLED"
  | "CANCELLED_NO_CASH"
  | "REFUNDED_UNSAVED";
export type RecoveryTone = "warning" | "success" | "danger" | "neutral";

export interface RecoveryPresentation {
  screen: RecoveryScreen;
  isDifferentAccount: boolean;
  needsOriginalBrowserForRetry: boolean;
  canCheckStatus: boolean;
  canRetry: boolean;
  canCancelUnpaid: boolean;
  canContinueSaved: boolean;
  canContinueSettled: boolean;
  canSettlePriorDay: boolean;
  canDismissCancelled: boolean;
  canResolveNoCashPriorDay: boolean;
  canResolveFullRefund: boolean;
  canContinueResolved: boolean;
  blocksNewSale: boolean;
  statusPillLabel: string;
  statusPillTone: RecoveryTone;
  headline: string;
  subline: string;
  calloutTitle: string;
  calloutBody: string;
  calloutTone: "warning" | "success" | "danger";
  amounts: {
    totalCentavos: number;
    cashReceivedCentavos: number | null;
    changeCentavos: number | null;
    totalContainers: number;
    totalVolumeLiters: number;
    items: QuoteLineItem[];
  };
  checkedAt: string | null;
  sale: SaleView | null;
  settlement: PriorDaySettlementView | null;
  resolution: CheckoutResolutionView | null;
}

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PENDING_RECOVERY_KEY_PREFIX = "hydrop.pos.pendingRecovery.v2:";
export const LEGACY_PENDING_RECOVERY_STORAGE_KEY = "hydrop.pos.pendingRecovery.v1";
export const UNPAID_CART_STORAGE_PREFIX = "hydrop.pos.unpaidCart.v1:";
export const POS_SYNC_STORAGE_KEY = "hydrop.pos.daySync.v1";

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function currentManilaIso(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hour = pad2(shifted.getUTCHours());
  const minute = pad2(shifted.getUTCMinutes());
  const second = pad2(shifted.getUTCSeconds());
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}

export function formatManilaTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const datePart = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
  const timePart = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(parsed);
  return `${datePart} · ${timePart}`;
}

export function formatManilaTimeOnly(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(parsed);
}

export function formatManilaTimeWithSeconds(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(parsed);
}

export function manilaDateFromIso(iso: string): string | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return currentManilaIso(new Date(parsed)).slice(0, 10);
}

export function reconcileRecoveryTodayDate(
  todayDate?: string | null,
  checkedAt?: string | null,
): string | undefined {
  const cleanToday =
    typeof todayDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(todayDate.trim())
      ? todayDate.trim()
      : undefined;
  const checkedDate = checkedAt ? manilaDateFromIso(checkedAt) : null;
  if (cleanToday && checkedDate) {
    return checkedDate > cleanToday ? checkedDate : cleanToday;
  }
  return checkedDate ?? cleanToday;
}

export function formatCentavos(centavos: number): string {
  const truncated = Math.trunc(centavos);
  const sign = truncated < 0 ? "-" : "";
  const abs = Math.abs(truncated);
  const pesos = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}₱${pesos.toLocaleString("en-US")}.${pad2(remainder)}`;
}

export function parsePesoInputToCentavos(raw: string): number | null {
  const cleaned = raw.trim().replace(/^[₱\s]+/, "").replace(/,/g, "");
  if (!cleaned) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const pesos = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const total = pesos * 100 + cents;
  if (!Number.isSafeInteger(total) || total <= 0 || total > 100_000_000) {
    return null;
  }
  return total;
}

export function parseLitersInput(raw: string): number | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? "").padEnd(2, "0"));
  const hundredths = whole * 100 + frac;
  if (!Number.isSafeInteger(hundredths) || hundredths < 1 || hundredths > 100_000) {
    return null;
  }
  return hundredths / 100;
}

export function formatLiters(liters: number): string {
  return Number.isInteger(liters) ? `${liters} L` : `${Number(liters.toFixed(2))} L`;
}

export function computeCashSummary(
  totalCentavos: number,
  cashReceivedCentavos: number | null,
): { sufficient: boolean; changeCentavos: number | null; shortfallCentavos: number } {
  if (cashReceivedCentavos === null || !Number.isInteger(cashReceivedCentavos) || cashReceivedCentavos <= 0) {
    return {
      sufficient: false,
      changeCentavos: null,
      shortfallCentavos: Math.max(0, totalCentavos),
    };
  }
  if (cashReceivedCentavos < totalCentavos) {
    return {
      sufficient: false,
      changeCentavos: null,
      shortfallCentavos: totalCentavos - cashReceivedCentavos,
    };
  }
  return {
    sufficient: true,
    changeCentavos: cashReceivedCentavos - totalCentavos,
    shortfallCentavos: 0,
  };
}

export function toCartItemInputs(lines: CartDraftLine[]): CartItemInput[] {
  return lines.map((line) => {
    if (line.kind === "STANDARD") {
      return { kind: "STANDARD", waterType: line.waterType, quantity: line.quantity };
    }
    if (line.kind === "CUSTOM") {
      return {
        kind: "CUSTOM",
        waterType: line.waterType,
        unitVolumeLiters: line.unitVolumeLiters,
        unitPriceCentavos: line.unitPriceCentavos,
        quantity: line.quantity,
      };
    }
    if (line.kind === "CONTAINER_PACKAGE") {
      return {
        kind: "CONTAINER_PACKAGE",
        packageCode: line.packageCode,
        ...(line.includedGripo ? { includedGripo: line.includedGripo } : {}),
        quantity: line.quantity,
      };
    }
    return {
      kind: "MERCHANDISE",
      productId: line.productId,
      quantity: line.quantity,
    };
  });
}

export function cartLinesSignature(lines: CartDraftLine[]): string {
  return JSON.stringify(toCartItemInputs(lines));
}

function browserStorage(kind: "local" | "session"): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function pendingRecoveryStorageKey(reference: string): string {
  return `${PENDING_RECOVERY_KEY_PREFIX}${reference.trim().toUpperCase()}`;
}

export function isPendingRecoveryStorageKey(key: string | null): boolean {
  if (key === null) return true;
  return (
    key.startsWith(PENDING_RECOVERY_KEY_PREFIX) ||
    key === LEGACY_PENDING_RECOVERY_STORAGE_KEY
  );
}

export function isPosSyncStorageKey(key: string | null): boolean {
  return key === null || key === POS_SYNC_STORAGE_KEY;
}

export function notifyPosStateChanged(
  reason: string,
  storage: StorageLike | null = browserStorage("local"),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      POS_SYNC_STORAGE_KEY,
      JSON.stringify({
        reason,
        at: Date.now(),
        nonce: Math.random().toString(36).slice(2),
      }),
    );
  } catch {
    // Ignore storage access errors in best-effort cross-tab notification.
  }
}

function parsePendingRecovery(raw: string | null): PendingCheckoutRecovery | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingCheckoutRecovery;
    if (
      !parsed ||
      typeof parsed.reference !== "string" ||
      !parsed.reference.trim() ||
      typeof parsed.initiatedBy !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function savePendingRecovery(
  record: PendingCheckoutRecovery,
  storage: StorageLike | null = browserStorage("local"),
): void {
  if (!storage || !record.reference.trim()) return;
  try {
    storage.setItem(pendingRecoveryStorageKey(record.reference), JSON.stringify(record));
  } catch {
    // Ignore storage quota errors in best-effort persistence.
  }
}

export function loadPendingRecoveryByReference(
  reference: string,
  storage: StorageLike | null = browserStorage("local"),
): PendingCheckoutRecovery | null {
  if (!storage || !reference.trim()) return null;
  const normalized = reference.trim().toUpperCase();
  try {
    const direct = parsePendingRecovery(storage.getItem(pendingRecoveryStorageKey(normalized)));
    if (direct) return direct;
    const legacy = parsePendingRecovery(storage.getItem(LEGACY_PENDING_RECOVERY_STORAGE_KEY));
    if (legacy && legacy.reference.trim().toUpperCase() === normalized) {
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

export function loadPendingRecoveries(
  storage: StorageLike | null = browserStorage("local"),
): PendingCheckoutRecovery[] {
  if (!storage) return [];
  try {
    const byRef = new Map<string, PendingCheckoutRecovery>();
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith(PENDING_RECOVERY_KEY_PREFIX)) continue;
      const parsed = parsePendingRecovery(storage.getItem(key));
      if (parsed) {
        byRef.set(parsed.reference.trim().toUpperCase(), parsed);
      }
    }
    const legacy = parsePendingRecovery(storage.getItem(LEGACY_PENDING_RECOVERY_STORAGE_KEY));
    if (legacy) {
      const refKey = legacy.reference.trim().toUpperCase();
      if (!byRef.has(refKey)) {
        byRef.set(refKey, legacy);
      }
    }
    return Array.from(byRef.values()).sort((a, b) => {
      if (a.attemptedAt !== b.attemptedAt) return a.attemptedAt < b.attemptedAt ? -1 : 1;
      return a.reference.localeCompare(b.reference);
    });
  } catch {
    return [];
  }
}

export function removePendingRecovery(
  reference: string,
  storage: StorageLike | null = browserStorage("local"),
): void {
  if (!storage || !reference.trim()) return;
  const normalized = reference.trim().toUpperCase();
  try {
    storage.removeItem(pendingRecoveryStorageKey(normalized));
    const legacy = parsePendingRecovery(storage.getItem(LEGACY_PENDING_RECOVERY_STORAGE_KEY));
    if (legacy && legacy.reference.trim().toUpperCase() === normalized) {
      storage.removeItem(LEGACY_PENDING_RECOVERY_STORAGE_KEY);
    }
  } catch {
    // Ignore storage access errors.
  }
}

function unpaidCartKey(username: string): string {
  return `${UNPAID_CART_STORAGE_PREFIX}${username.trim().toLowerCase()}`;
}

export function saveUnpaidCart(
  snapshot: UnpaidCartSnapshot,
  storage: StorageLike | null = browserStorage("session"),
): void {
  if (!storage) return;
  try {
    storage.setItem(unpaidCartKey(snapshot.ownerUsername), JSON.stringify(snapshot));
  } catch {
    // Ignore storage quota errors.
  }
}

export function loadUnpaidCart(
  username: string,
  storage: StorageLike | null = browserStorage("session"),
): UnpaidCartSnapshot | null {
  if (!storage || !username.trim()) return null;
  try {
    const raw = storage.getItem(unpaidCartKey(username));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UnpaidCartSnapshot;
    if (
      !parsed ||
      typeof parsed.ownerUsername !== "string" ||
      parsed.ownerUsername.trim().toLowerCase() !== username.trim().toLowerCase()
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearUnpaidCart(
  username: string,
  storage: StorageLike | null = browserStorage("session"),
): void {
  if (!storage || !username.trim()) return;
  try {
    storage.removeItem(unpaidCartKey(username));
  } catch {
    // Ignore storage access errors.
  }
}

export function clearUnpaidCartIfMatchesReference(
  username: string,
  targetReference: string,
  storage: StorageLike | null = browserStorage("session"),
): boolean {
  const normalizedTarget = targetReference.trim().toUpperCase();
  if (!normalizedTarget) return false;
  const saved = loadUnpaidCart(username, storage);
  if (saved?.preparedCheckout?.reference.trim().toUpperCase() !== normalizedTarget) {
    return false;
  }
  clearUnpaidCart(username, storage);
  return true;
}

export function classifyCheckoutComposition(
  items: QuoteLineItem[],
): "REFILL_ONLY" | "MERCHANDISE_ONLY" | "MIXED" {
  const hasMerchandise = items.some(
    (item) => item.kind === "MERCHANDISE" || item.kind === "CONTAINER_PACKAGE",
  );
  const hasRefill = items.some(
    (item) => item.kind === "STANDARD" || item.kind === "CUSTOM",
  );
  if (hasMerchandise && hasRefill) return "MIXED";
  if (hasMerchandise) return "MERCHANDISE_ONLY";
  return "REFILL_ONLY";
}

export function isPriorDayMerchandiseOnly(items: QuoteLineItem[]): boolean {
  return classifyCheckoutComposition(items) === "MERCHANDISE_ONLY";
}

export function isPriorDaySettleableComposition(_items: QuoteLineItem[]): boolean {
  return true;
}

export function createServerRecoveryRecord(
  checkout: CheckoutView,
  initialLookup: CheckoutLookupView | null = null,
): PendingCheckoutRecovery {
  return {
    reference: checkout.reference,
    businessDate: checkout.businessDate,
    initiatedBy: checkout.createdBy,
    source: "server",
    items: [],
    quoteItems: checkout.items,
    totalCentavos: checkout.totalCentavos,
    totalContainers: checkout.totalContainers,
    totalVolumeMl: checkout.totalVolumeMl,
    totalVolumeLiters: checkout.totalVolumeLiters,
    cashReceivedCentavos: checkout.cashReceivedCentavos,
    changeCentavos: checkout.changeCentavos,
    attemptedAt: checkout.paymentStartedAt ?? checkout.updatedAt,
    lastLookup: initialLookup,
    lastError: null,
  };
}

function isTerminalLookup(lookup: CheckoutLookupView | null): boolean {
  return (
    lookup !== null &&
    (lookup.recoveryState === "SAVED" ||
      lookup.recoveryState === "SETTLED_PRIOR_DAY" ||
      lookup.recoveryState === "CANCELLED_NO_CASH" ||
      lookup.recoveryState === "REFUNDED_UNSAVED")
  );
}

/**
 * Merges a status lookup response without allowing failed or late responses to
 * overwrite a newer saved/settled result or a more recently checked snapshot.
 */
export function mergeRecoveryLookup(
  record: PendingCheckoutRecovery,
  incoming: CheckoutLookupView,
): PendingCheckoutRecovery {
  const existing = record.lastLookup;
  if (existing) {
    if (isTerminalLookup(existing) && incoming.recoveryState !== existing.recoveryState) {
      return record;
    }
    const existingTs = Date.parse(existing.checkedAt);
    const incomingTs = Date.parse(incoming.checkedAt);
    if (!Number.isNaN(existingTs) && !Number.isNaN(incomingTs) && incomingTs < existingTs) {
      return record;
    }
  }
  return {
    ...record,
    lastLookup: incoming,
    lastError: null,
  };
}

export function resolveRecoveryPresentation(
  record: PendingCheckoutRecovery,
  currentUsername: string,
  currentUserRole: "OWNER" | "CASHIER" = "CASHIER",
  todayDate?: string,
): RecoveryPresentation {
  const lookup = record.lastLookup;
  const isDifferentAccount =
    record.initiatedBy.trim().toLowerCase() !== currentUsername.trim().toLowerCase() ||
    lookup?.ownedByCurrentUser === false;
  const localCash = record.cashReceivedCentavos;
  const hasLocalTender = record.source !== "server" && localCash !== null;
  const localAmounts = {
    totalCentavos: record.totalCentavos,
    cashReceivedCentavos: localCash,
    changeCentavos: localCash !== null ? localCash - record.totalCentavos : null,
    totalContainers: record.totalContainers,
    totalVolumeLiters: record.totalVolumeLiters,
    items: record.quoteItems,
  };

  if (lookup && lookup.recoveryState === "SAVED" && lookup.sale) {
    const sale = lookup.sale;
    return {
      screen: "SAVED",
      isDifferentAccount,
      needsOriginalBrowserForRetry: false,
      canCheckStatus: false,
      canRetry: false,
      canCancelUnpaid: false,
      canContinueSaved: true,
      canContinueSettled: false,
      canSettlePriorDay: false,
      canDismissCancelled: false,
      canResolveNoCashPriorDay: false,
      canResolveFullRefund: false,
      canContinueResolved: false,
      blocksNewSale: true,
      statusPillLabel: "Saved · verified",
      statusPillTone: "success",
      headline: "This sale is already saved",
      subline: `Transaction status checked at ${formatManilaTimeWithSeconds(lookup.checkedAt)}.`,
      calloutTitle: "No duplicate sale was created",
      calloutBody: isDifferentAccount
        ? `The original transaction started by ${record.initiatedBy} is confirmed. Continue with the saved sale; do not collect cash again.`
        : "The original transaction is confirmed. Continue with the saved sale; do not collect cash again.",
      calloutTone: "success",
      amounts: {
        totalCentavos: sale.totalCentavos,
        cashReceivedCentavos: sale.cashReceivedCentavos,
        changeCentavos: sale.changeCentavos,
        totalContainers: sale.totalContainers,
        totalVolumeLiters: sale.totalVolumeLiters,
        items: sale.items,
      },
      checkedAt: lookup.checkedAt,
      sale,
      settlement: null,
      resolution: null,
    };
  }

  if (lookup && lookup.recoveryState === "SETTLED_PRIOR_DAY" && lookup.settlement) {
    const settlement = lookup.settlement;
    const composition = classifyCheckoutComposition(settlement.items);
    const isMerchOnly = composition === "MERCHANDISE_ONLY";
    const isMixed = composition === "MIXED";
    const cashReceived = settlement.cashReceivedCentavos ?? localCash;
    const change =
      settlement.changeCentavos ??
      (cashReceived !== null ? cashReceived - settlement.netAmountKeptCentavos : null);
    return {
      screen: "SETTLED_PRIOR_DAY",
      isDifferentAccount,
      needsOriginalBrowserForRetry: false,
      canCheckStatus: false,
      canRetry: false,
      canCancelUnpaid: false,
      canContinueSaved: false,
      canContinueSettled: true,
      canSettlePriorDay: false,
      canDismissCancelled: false,
      canResolveNoCashPriorDay: false,
      canResolveFullRefund: false,
      canContinueResolved: false,
      blocksNewSale: true,
      statusPillLabel: "Settled · prior day",
      statusPillTone: "success",
      headline: isMixed
        ? "Prior-day mixed order settled"
        : isMerchOnly
          ? "Prior-day merchandise settled"
          : "Prior-day refill settled",
      subline: `Settlement recorded on ${settlement.settlementDate} · checked at ${formatManilaTimeWithSeconds(lookup.checkedAt)}.`,
      calloutTitle: "No further payment collected",
      calloutBody: isMixed
        ? `Confirmed paid and all refills and merchandise handed over from ${settlement.originalBusinessDate}. Recorded separately from today's sales.`
        : isMerchOnly
          ? `Confirmed paid and handed over from ${settlement.originalBusinessDate}. Recorded separately from today's sales.`
          : `Confirmed paid and delivered from ${settlement.originalBusinessDate}. Recorded separately from today's refill sales.`,
      calloutTone: "success",
      amounts: {
        totalCentavos: settlement.netAmountKeptCentavos,
        cashReceivedCentavos: cashReceived,
        changeCentavos: change,
        totalContainers: settlement.totalContainers,
        totalVolumeLiters: settlement.totalVolumeLiters,
        items: settlement.items,
      },
      checkedAt: lookup.checkedAt,
      sale: null,
      settlement,
      resolution: null,
    };
  }

  if (lookup && lookup.recoveryState === "CANCELLED_NO_CASH" && lookup.resolution) {
    const res = lookup.resolution;
    const heldCount = res.heldItems.reduce((sum, item) => sum + item.quantity, 0);
    return {
      screen: "CANCELLED_NO_CASH",
      isDifferentAccount,
      needsOriginalBrowserForRetry: false,
      canCheckStatus: false,
      canRetry: false,
      canCancelUnpaid: false,
      canContinueSaved: false,
      canContinueSettled: false,
      canSettlePriorDay: false,
      canDismissCancelled: false,
      canResolveNoCashPriorDay: false,
      canResolveFullRefund: false,
      canContinueResolved: true,
      blocksNewSale: true,
      statusPillLabel: "Cancelled · no cash",
      statusPillTone: "neutral",
      headline: "Prior-day checkout cancelled (no cash)",
      subline: `Resolved on ${res.resolutionDate} · checked at ${formatManilaTimeWithSeconds(lookup.checkedAt)}.`,
      calloutTitle: "No cash received and no sale created",
      calloutBody: `Confirmed by ${res.resolvedBy} that no cash was received for this ${res.originalBusinessDate} checkout. Ordinary stock reservations were released${
        heldCount > 0
          ? `, and ${heldCount} held unit${heldCount === 1 ? " remains" : "s remain"} unavailable in Inventory and POS`
          : ""
      }; do not collect payment, refund, or hand over items.`,
      calloutTone: "warning",
      amounts: {
        totalCentavos: res.quoteTotalCentavos,
        cashReceivedCentavos: null,
        changeCentavos: null,
        totalContainers: lookup.checkout.totalContainers,
        totalVolumeLiters: lookup.checkout.totalVolumeLiters,
        items: res.items,
      },
      checkedAt: lookup.checkedAt,
      sale: null,
      settlement: null,
      resolution: res,
    };
  }

  if (lookup && lookup.recoveryState === "REFUNDED_UNSAVED" && lookup.resolution) {
    const res = lookup.resolution;
    const refundedLabel =
      res.refundedAmountCentavos !== null ? formatCentavos(res.refundedAmountCentavos) : "full cash";
    const heldCount = res.heldItems.reduce((sum, item) => sum + item.quantity, 0);
    return {
      screen: "REFUNDED_UNSAVED",
      isDifferentAccount,
      needsOriginalBrowserForRetry: false,
      canCheckStatus: false,
      canRetry: false,
      canCancelUnpaid: false,
      canContinueSaved: false,
      canContinueSettled: false,
      canSettlePriorDay: false,
      canDismissCancelled: false,
      canResolveNoCashPriorDay: false,
      canResolveFullRefund: false,
      canContinueResolved: true,
      blocksNewSale: true,
      statusPillLabel: "Refunded · unsaved",
      statusPillTone: "neutral",
      headline: "Unsaved checkout refunded in full",
      subline: `Resolved on ${res.resolutionDate} · checked at ${formatManilaTimeWithSeconds(lookup.checkedAt)}.`,
      calloutTitle: `${refundedLabel} refunded — no sale created`,
      calloutBody: `Confirmed by ${res.resolvedBy} that the order was undelivered and ${refundedLabel} was returned to the customer.${
        heldCount > 0
          ? ` ${heldCount} held unit${heldCount === 1 ? " remains" : "s remain"} unavailable in Inventory and POS.`
          : ""
      } Do not collect payment, refund again, or hand over items.`,
      calloutTone: "warning",
      amounts: {
        totalCentavos: res.quoteTotalCentavos,
        cashReceivedCentavos: res.cashReceivedCentavos,
        changeCentavos: res.changeGivenCentavos,
        totalContainers: lookup.checkout.totalContainers,
        totalVolumeLiters: lookup.checkout.totalVolumeLiters,
        items: res.items,
      },
      checkedAt: lookup.checkedAt,
      sale: null,
      settlement: null,
      resolution: res,
    };
  }

  if (
    lookup &&
    lookup.recoveryState === "CANCELLED" &&
    lookup.canDismissCancelled === true &&
    lookup.checkout.status === "CANCELLED_DRAFT" &&
    lookup.checkout.cashReceivedCentavos === null &&
    lookup.checkout.paymentRecordedAt === null
  ) {
    const serverTotal = lookup.checkout.totalCentavos;
    const cancelReason = lookup.reason?.trim() || "No cash received";
    return {
      screen: "CANCELLED",
      isDifferentAccount,
      needsOriginalBrowserForRetry: false,
      canCheckStatus: true,
      canRetry: false,
      canCancelUnpaid: false,
      canContinueSaved: false,
      canContinueSettled: false,
      canSettlePriorDay: false,
      canDismissCancelled: true,
      canResolveNoCashPriorDay: false,
      canResolveFullRefund: false,
      canContinueResolved: false,
      blocksNewSale: true,
      statusPillLabel: "Cancelled",
      statusPillTone: "neutral",
      headline: "Checkout cancelled",
      subline: `Transaction status checked at ${formatManilaTimeWithSeconds(lookup.checkedAt)}.`,
      calloutTitle: "Cancelled before payment was recorded",
      calloutBody: `The server verified an explicit unpaid cancellation (${cancelReason}) with no saved sale or recorded payment. Confirm no cash was received before returning to New Sale; if cash changed hands, keep this reference for Owner review.`,
      calloutTone: "warning",
      amounts: {
        totalCentavos: serverTotal,
        cashReceivedCentavos: localCash,
        changeCentavos: localCash !== null ? localCash - serverTotal : null,
        totalContainers: lookup.checkout.totalContainers,
        totalVolumeLiters: lookup.checkout.totalVolumeLiters,
        items: lookup.checkout.items,
      },
      checkedAt: lookup.checkedAt,
      sale: null,
      settlement: null,
      resolution: null,
    };
  }

  if (lookup && lookup.recoveryState === "REVIEW_REQUIRED") {
    const serverTotal = lookup.checkout.totalCentavos;
    const cashReceived = lookup.checkout.cashReceivedCentavos ?? localCash;
    const change =
      lookup.checkout.changeCentavos ??
      (cashReceived !== null ? cashReceived - serverTotal : null);
    const isDateCrossed = lookup.reason === "BUSINESS_DATE_CROSSED";
    const isDayClosed = lookup.reason === "DAY_CLOSED";
    const effectiveTodayDate = reconcileRecoveryTodayDate(todayDate, lookup.checkedAt);
    const isPriorDay = effectiveTodayDate
      ? lookup.checkout.businessDate < effectiveTodayDate
      : lookup.reason === "BUSINESS_DATE_CROSSED";
    const isEligibleStatus =
      lookup.checkout.status === "REVIEW_REQUIRED" ||
      lookup.checkout.status === "PAYMENT_PENDING";
    const canSettlePriorDay =
      currentUserRole === "OWNER" && isPriorDay && isEligibleStatus;
    const canResolveNoCashPriorDay =
      currentUserRole === "OWNER" &&
      (lookup.canResolveNoCashPriorDay ??
        (isPriorDay &&
          lookup.checkout.status === "PAYMENT_PENDING" &&
          lookup.checkout.cashReceivedCentavos === null &&
          lookup.checkout.paymentRecordedAt === null));
    const canResolveFullRefund =
      currentUserRole === "OWNER" && (lookup.canResolveFullRefund ?? isEligibleStatus);
    const canCancelUnpaid =
      !isDifferentAccount &&
      lookup.canCancelUnpaid === true &&
      lookup.checkout.status === "DRAFT" &&
      lookup.checkout.cashReceivedCentavos === null &&
      lookup.checkout.paymentRecordedAt === null;

    return {
      screen: "REVIEW_REQUIRED",
      isDifferentAccount,
      needsOriginalBrowserForRetry: false,
      canCheckStatus: true,
      canRetry: false,
      canCancelUnpaid,
      canContinueSaved: false,
      canContinueSettled: false,
      canSettlePriorDay,
      canDismissCancelled: false,
      canResolveNoCashPriorDay,
      canResolveFullRefund,
      canContinueResolved: false,
      blocksNewSale: true,
      statusPillLabel: "Review required",
      statusPillTone: "danger",
      headline: "Owner review required",
      subline: `Transaction status checked at ${formatManilaTimeWithSeconds(lookup.checkedAt)}.`,
      calloutTitle: canCancelUnpaid
        ? "Unpaid filled draft crossed Manila midnight"
        : isDateCrossed
          ? "Business date changed before save"
          : isDayClosed
            ? "Station day closed before save"
            : "Manual review required",
      calloutBody: canCancelUnpaid
        ? "This unpaid filled-container draft has not started cash payment and crossed Manila midnight while the station day is still open. Record the affected filled-container disposition and confirm no cash was received to cancel it."
        : isDateCrossed
          ? "This checkout crossed the Manila midnight boundary and cannot be saved automatically as a backdated sale. Keep this reference and payment amounts for Owner review."
          : "This checkout cannot be saved automatically. Keep this reference and payment details for Owner review.",
      calloutTone: "danger",
      amounts: {
        totalCentavos: serverTotal,
        cashReceivedCentavos: cashReceived,
        changeCentavos: change,
        totalContainers: lookup.checkout.totalContainers,
        totalVolumeLiters: lookup.checkout.totalVolumeLiters,
        items: lookup.checkout.items,
      },
      checkedAt: lookup.checkedAt,
      sale: null,
      settlement: null,
      resolution: null,
    };
  }

  if (lookup && lookup.recoveryState === "SAFE_TO_RETRY" && lookup.canRetry && !isDifferentAccount) {
    const serverTotal = lookup.checkout.totalCentavos;
    const canResolveFullRefund =
      currentUserRole === "OWNER" &&
      (lookup.canResolveFullRefund ?? lookup.checkout.status === "PAYMENT_PENDING");
    if (!hasLocalTender) {
      const canCancelUnpaid =
        lookup.canCancelUnpaid === true &&
        (lookup.checkout.status === "PAYMENT_PENDING" || lookup.checkout.status === "DRAFT") &&
        lookup.checkout.cashReceivedCentavos === null &&
        lookup.checkout.paymentRecordedAt === null;
      return {
        screen: "SAFE_TO_RETRY",
        isDifferentAccount: false,
        needsOriginalBrowserForRetry: true,
        canCheckStatus: true,
        canRetry: false,
        canCancelUnpaid,
        canContinueSaved: false,
        canContinueSettled: false,
        canSettlePriorDay: false,
        canDismissCancelled: false,
        canResolveNoCashPriorDay: false,
        canResolveFullRefund,
        canContinueResolved: false,
        blocksNewSale: true,
        statusPillLabel: "Not saved · verified",
        statusPillTone: "warning",
        headline:
          lookup.checkout.status === "DRAFT"
            ? "Unpaid filled draft found."
            : "Not saved. Check original device.",
        subline: `Transaction status checked at ${formatManilaTimeWithSeconds(lookup.checkedAt)}.`,
        calloutTitle: "Do not take payment again.",
        calloutBody: canCancelUnpaid
          ? lookup.checkout.status === "DRAFT"
            ? "This unpaid filled-container draft has not started cash payment on this browser. Record the affected filled-container disposition and confirm no cash was received to cancel it."
            : "A server check confirmed this transaction was not saved, and the original cash tender is not stored on this device. Sign back in on the original browser to check status and resume recovery, or confirm no cash was received to cancel this unpaid checkout."
          : "A server check confirmed this transaction was not saved, and the original cash tender is not stored on this device. Sign back in on the original browser to check status and resume the existing recovery flow.",
        calloutTone: "warning",
        amounts: {
          totalCentavos: serverTotal,
          cashReceivedCentavos: lookup.checkout.cashReceivedCentavos,
          changeCentavos: lookup.checkout.changeCentavos,
          totalContainers: lookup.checkout.totalContainers,
          totalVolumeLiters: lookup.checkout.totalVolumeLiters,
          items: lookup.checkout.items,
        },
        checkedAt: lookup.checkedAt,
        sale: null,
        settlement: null,
        resolution: null,
      };
    }

    return {
      screen: "SAFE_TO_RETRY",
      isDifferentAccount: false,
      needsOriginalBrowserForRetry: false,
      canCheckStatus: true,
      canRetry: true,
      canCancelUnpaid: false,
      canContinueSaved: false,
      canContinueSettled: false,
      canSettlePriorDay: false,
      canDismissCancelled: false,
      canResolveNoCashPriorDay: false,
      canResolveFullRefund,
      canContinueResolved: false,
      blocksNewSale: true,
      statusPillLabel: "Not saved · verified",
      statusPillTone: "neutral",
      headline: "Not saved. Safe to retry.",
      subline: `Transaction status checked at ${formatManilaTimeWithSeconds(lookup.checkedAt)}.`,
      calloutTitle: "No matching sale found",
      calloutBody:
        "A server check confirmed this transaction was not saved. Retry the same transaction without collecting cash again.",
      calloutTone: "warning",
      amounts: {
        totalCentavos: serverTotal,
        cashReceivedCentavos: localCash,
        changeCentavos: localCash! - serverTotal,
        totalContainers: lookup.checkout.totalContainers,
        totalVolumeLiters: lookup.checkout.totalVolumeLiters,
        items: lookup.checkout.items,
      },
      checkedAt: lookup.checkedAt,
      sale: null,
      settlement: null,
      resolution: null,
    };
  }

  const inProgress = lookup?.reason === "SAVE_IN_PROGRESS";
  const serverCheckout = lookup?.checkout;
  const resolvedCash = serverCheckout
    ? (serverCheckout.cashReceivedCentavos ?? localCash)
    : localCash;
  const resolvedAmounts = serverCheckout
    ? {
      totalCentavos: serverCheckout.totalCentavos,
      cashReceivedCentavos: resolvedCash,
      changeCentavos:
        serverCheckout.changeCentavos ??
        (resolvedCash !== null ? resolvedCash - serverCheckout.totalCentavos : null),
      totalContainers: serverCheckout.totalContainers,
      totalVolumeLiters: serverCheckout.totalVolumeLiters,
      items: serverCheckout.items,
    }
    : localAmounts;
  const canResolveFullRefundUnknown =
    currentUserRole === "OWNER" &&
    Boolean(
      lookup &&
      !inProgress &&
      (lookup.canResolveFullRefund ??
        (lookup.checkout.status === "PAYMENT_PENDING" ||
          lookup.checkout.status === "REVIEW_REQUIRED")),
    );

  return {
    screen: "UNKNOWN",
    isDifferentAccount,
    needsOriginalBrowserForRetry: false,
    canCheckStatus: true,
    canRetry: false,
    canCancelUnpaid: false,
    canContinueSaved: false,
    canContinueSettled: false,
    canSettlePriorDay: false,
    canDismissCancelled: false,
    canResolveNoCashPriorDay: false,
    canResolveFullRefund: canResolveFullRefundUnknown,
    canContinueResolved: false,
    blocksNewSale: true,
    statusPillLabel: isDifferentAccount
      ? "Pending · other account"
      : inProgress
        ? "Saving in progress"
        : "Not yet verified",
    statusPillTone: "warning",
    headline: isDifferentAccount ? "Pending checkout from another account" : "Check before retrying",
    subline: lookup
      ? `Transaction status checked at ${formatManilaTimeWithSeconds(lookup.checkedAt)}.`
      : record.source === "server"
        ? "This server checkout has not been verified from this device yet."
        : "The connection was interrupted during saving.",
    calloutTitle: isDifferentAccount
      ? `Started by ${record.initiatedBy} — sign back into that account to retry`
      : inProgress
        ? "Save still in progress"
        : "Do not take payment again.",
    calloutBody: isDifferentAccount
      ? "This workstation or account has an unverified checkout started by another account. Do not take payment again. Check its status or sign in as the initiating operator before retrying."
      : inProgress
        ? "The save is still in progress on the server. Do not take payment again. Check transaction status before taking any action."
        : "The sale may already be saved. Do not take payment again. Check its status using the same transaction reference before taking any action.",
    calloutTone: "warning",
    amounts: resolvedAmounts,
    checkedAt: lookup?.checkedAt ?? null,
    sale: null,
    settlement: null,
    resolution: null,
  };
}

/** Formats a clear single-check outcome message for the recovery status alert. */
export function formatRecoveryCheckFeedback(
  lookup: CheckoutLookupView,
  presentation: RecoveryPresentation,
): string {
  const checkedTime = formatManilaTimeWithSeconds(lookup.checkedAt);
  switch (presentation.screen) {
    case "SAVED":
      return `Status confirmed (${checkedTime}) — sale is already saved.`;
    case "SETTLED_PRIOR_DAY":
      return `Status confirmed (${checkedTime}) — prior-day settlement is already recorded.`;
    case "CANCELLED_NO_CASH":
      return `Status confirmed (${checkedTime}) — prior-day checkout was cancelled with no cash received.`;
    case "REFUNDED_UNSAVED":
      return `Status confirmed (${checkedTime}) — unsaved checkout was resolved with a full refund.`;
    case "CANCELLED":
      return `Status confirmed (${checkedTime}) — checkout was cancelled with no payment recorded.`;
    case "SAFE_TO_RETRY":
      return presentation.needsOriginalBrowserForRetry
        ? `Status confirmed (${checkedTime}) — not saved yet. Original cash details are on the original browser.`
        : `Status confirmed (${checkedTime}) — not saved yet. Safe to retry.`;
    case "REVIEW_REQUIRED":
      return presentation.canSettlePriorDay
        ? `Status confirmed (${checkedTime}) — still requires Owner review. Prior-day settlement is available below.`
        : `Status confirmed (${checkedTime}) — still requires Owner review.`;
    case "UNKNOWN":
      if (lookup.reason === "SAVE_IN_PROGRESS") {
        return `Status confirmed (${checkedTime}) — save is still in progress.`;
      }
      if (presentation.isDifferentAccount || lookup.reason === "OWNED_BY_OTHER_ACCOUNT") {
        return `Status confirmed (${checkedTime}) — still pending under ${
          presentation.isDifferentAccount ? "another account" : "the initiating account"
        }.`;
      }
      return `Status confirmed (${checkedTime}) — status is still unresolved.`;
  }
}

export function stationStatusFromDay(day: PosDayResponse): {
  isOpen: boolean;
  tone: "open" | "closed" | "warning";
  label: string;
  detail: string;
} {
  switch (day.state) {
    case "OPEN":
      return {
        isOpen: true,
        tone: "open",
        label: "Station open",
        detail: "Ready for refills and cash sales.",
      };
    case "PREVIOUS_DAY_OPEN":
      return {
        isOpen: true,
        tone: "warning",
        label: "Previous day open",
        detail: `Close ${day.day?.businessDate ?? "the previous day"} before starting today.`,
      };
    case "CLOSED":
      return {
        isOpen: false,
        tone: "closed",
        label: "Station closed",
        detail: "Today's business day is closed.",
      };
    case "NOT_STARTED":
      return {
        isOpen: false,
        tone: "closed",
        label: "Station closed",
        detail: "Start Day in POS when ready.",
      };
  }
}

export interface EndDayBlockingEntry {
  reference: string;
  label: string;
  source: "server" | "local-confirming" | "local-recovery";
}

export interface EndDayGuardResult {
  blocked: boolean;
  blockingEntries: EndDayBlockingEntry[];
  clearableDrafts: CheckoutView[];
}

export function evaluateEndDayGuard(input: {
  businessDate: string | null;
  serverUnresolved: CheckoutView[];
  serverUnpaidDrafts: CheckoutView[];
  serverPendingSaleActions?: SaleActionRequestView[];
  localPendingRecoveries: PendingCheckoutRecovery[];
  activeConfirming: PendingCheckoutRecovery | null;
}): EndDayGuardResult {
  const blockingEntries: EndDayBlockingEntry[] = [];
  const blockingRefs = new Set<string>();
  const matchesDay = (date: string) => input.businessDate === null || date === input.businessDate;

  if (input.activeConfirming && matchesDay(input.activeConfirming.businessDate)) {
    blockingEntries.push({
      reference: input.activeConfirming.reference,
      label: `Confirmation in progress (${input.activeConfirming.initiatedBy})`,
      source: "local-confirming",
    });
    blockingRefs.add(input.activeConfirming.reference.trim().toUpperCase());
  }

  for (const recovery of input.localPendingRecoveries) {
    const refKey = recovery.reference.trim().toUpperCase();
    if (!matchesDay(recovery.businessDate) || blockingRefs.has(refKey)) {
      continue;
    }
    blockingEntries.push({
      reference: recovery.reference,
      label: `Pending workstation payment recovery (${recovery.initiatedBy})`,
      source: "local-recovery",
    });
    blockingRefs.add(refKey);
  }

  for (const checkout of input.serverUnresolved) {
    const refKey = checkout.reference.trim().toUpperCase();
    if (blockingRefs.has(refKey)) continue;
    const label =
      checkout.status === "PAYMENT_PENDING"
        ? `Cash payment started (${checkout.createdBy})`
        : checkout.resolutionReason ?? checkout.status;
    blockingEntries.push({
      reference: checkout.reference,
      label,
      source: "server",
    });
    blockingRefs.add(refKey);
  }

  for (const action of input.serverPendingSaleActions ?? []) {
    const refKey = action.reference.trim().toUpperCase();
    if (blockingRefs.has(refKey)) continue;
    blockingEntries.push({
      reference: action.reference,
      label: `${action.actionType === "VOID" ? "Pending Void Sale" : "Pending Correct Sale"} on ${action.originalSaleReference} (${action.createdBy})`,
      source: "server",
    });
    blockingRefs.add(refKey);
  }

  const clearableDrafts = input.serverUnpaidDrafts.filter(
    (d) => !blockingRefs.has(d.reference.trim().toUpperCase()),
  );

  return {
    blocked: blockingEntries.length > 0,
    blockingEntries,
    clearableDrafts,
  };
}
