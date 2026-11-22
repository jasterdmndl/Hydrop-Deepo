/** Pure POS domain view types, formatting, cart scoping, and recovery state machine. */

export type WaterType = "PURIFIED" | "ALKALINE";
export type ItemKind = "STANDARD" | "CUSTOM" | "MERCHANDISE" | "CONTAINER_PACKAGE";
export type PosSection = string;
export type ContainerShape = "ROUND" | "SLIM";
export type IncludedGripoType = "PUSH_TYPE" | "TWIST_TYPE";
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
  | "CANCELLED_DRAFT";
export type SaleStatus = "ACTIVE" | "VOIDED";
export type RecoveryState =
  | "SAVED"
  | "SAFE_TO_RETRY"
  | "UNRESOLVED"
  | "REVIEW_REQUIRED"
  | "SETTLED_PRIOR_DAY";

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
  priorDayReviewCheckouts?: CheckoutView[];
  replayed?: boolean;
}

export interface SaleActionView {
  action: "SALE_SAVED" | "SALE_VOIDED";
  actor: string;
  note: string | null;
  recordedAt: string;
}

export interface SaleView {
  reference: string;
  checkoutReference: string;
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
  refillDeliveredConfirmed: true;
  settledBy: string;
  settledAt: string;
  note: string | null;
}

export interface CheckoutLookupView {
  recoveryState: RecoveryState;
  reason: string | null;
  canRetry: boolean;
  canSettlePriorDay?: boolean;
  ownedByCurrentUser: boolean;
  checkedAt: string;
  checkout: CheckoutView;
  sale: SaleView | null;
  settlement?: PriorDaySettlementView | null;
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
  items: CartItemInput[];
  quoteItems: QuoteLineItem[];
  totalCentavos: number;
  totalContainers: number;
  totalVolumeMl: number;
  totalVolumeLiters: number;
  cashReceivedCentavos: number;
  changeCentavos: number;
  attemptedAt: string;
  lastLookup: CheckoutLookupView | null;
  lastError: string | null;
}

export type RecoveryScreen =
  | "UNKNOWN"
  | "SAVED"
  | "SAFE_TO_RETRY"
  | "REVIEW_REQUIRED"
  | "SETTLED_PRIOR_DAY";
export type RecoveryTone = "warning" | "success" | "danger" | "neutral";

export interface RecoveryPresentation {
  screen: RecoveryScreen;
  isDifferentAccount: boolean;
  canCheckStatus: boolean;
  canRetry: boolean;
  canContinueSaved: boolean;
  canContinueSettled: boolean;
  canSettlePriorDay: boolean;
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
    cashReceivedCentavos: number;
    changeCentavos: number;
    totalContainers: number;
    totalVolumeLiters: number;
    items: QuoteLineItem[];
  };
  checkedAt: string | null;
  sale: SaleView | null;
  settlement: PriorDaySettlementView | null;
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

export function isPriorDayMerchandiseOnly(items: QuoteLineItem[]): boolean {
  const hasMerchandise = items.some(
    (item) => item.kind === "MERCHANDISE" || item.kind === "CONTAINER_PACKAGE",
  );
  const hasRefill = items.some(
    (item) => item.kind === "STANDARD" || item.kind === "CUSTOM",
  );
  return hasMerchandise && !hasRefill;
}

export function isPriorDaySettleableComposition(items: QuoteLineItem[]): boolean {
  const hasMerchandise = items.some(
    (item) => item.kind === "MERCHANDISE" || item.kind === "CONTAINER_PACKAGE",
  );
  const hasRefill = items.some(
    (item) => item.kind === "STANDARD" || item.kind === "CUSTOM",
  );
  return !(hasMerchandise && hasRefill);
}

export function resolveRecoveryPresentation(
  record: PendingCheckoutRecovery,
  currentUsername: string,
  currentUserRole: "OWNER" | "CASHIER" = "CASHIER",
  todayDate?: string,
): RecoveryPresentation {
  const isDifferentAccount =
    record.initiatedBy.trim().toLowerCase() !== currentUsername.trim().toLowerCase();
  const lookup = record.lastLookup;
  const localCash = record.cashReceivedCentavos;
  const localAmounts = {
    totalCentavos: record.totalCentavos,
    cashReceivedCentavos: localCash,
    changeCentavos: localCash - record.totalCentavos,
    totalContainers: record.totalContainers,
    totalVolumeLiters: record.totalVolumeLiters,
    items: record.quoteItems,
  };

  if (lookup && lookup.recoveryState === "SAVED" && lookup.sale) {
    const sale = lookup.sale;
    return {
      screen: "SAVED",
      isDifferentAccount,
      canCheckStatus: false,
      canRetry: false,
      canContinueSaved: true,
      canContinueSettled: false,
      canSettlePriorDay: false,
      blocksNewSale: true,
      statusPillLabel: "Saved · verified",
      statusPillTone: "success",
      headline: "This sale is already saved",
      subline: `Transaction status checked at ${formatManilaTimeOnly(lookup.checkedAt)}.`,
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
    };
  }

  if (lookup && lookup.recoveryState === "SETTLED_PRIOR_DAY" && lookup.settlement) {
    const settlement = lookup.settlement;
    const isMerchOnly = isPriorDayMerchandiseOnly(settlement.items);
    const cashReceived = settlement.cashReceivedCentavos ?? localCash;
    const change =
      settlement.changeCentavos ?? cashReceived - settlement.netAmountKeptCentavos;
    return {
      screen: "SETTLED_PRIOR_DAY",
      isDifferentAccount,
      canCheckStatus: false,
      canRetry: false,
      canContinueSaved: false,
      canContinueSettled: true,
      canSettlePriorDay: false,
      blocksNewSale: true,
      statusPillLabel: "Settled · prior day",
      statusPillTone: "success",
      headline: isMerchOnly ? "Prior-day merchandise settled" : "Prior-day refill settled",
      subline: `Settlement recorded on ${settlement.settlementDate} · checked at ${formatManilaTimeOnly(lookup.checkedAt)}.`,
      calloutTitle: "No further payment collected",
      calloutBody: isMerchOnly
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
    };
  }

  if (lookup && lookup.recoveryState === "REVIEW_REQUIRED") {
    const serverTotal = lookup.checkout.totalCentavos;
    const cashReceived = lookup.checkout.cashReceivedCentavos ?? localCash;
    const change = lookup.checkout.changeCentavos ?? cashReceived - serverTotal;
    const isDateCrossed = lookup.reason === "BUSINESS_DATE_CROSSED";
    const isDayClosed = lookup.reason === "DAY_CLOSED";
    const isPriorDay = todayDate
      ? lookup.checkout.businessDate < todayDate
      : lookup.reason === "BUSINESS_DATE_CROSSED" ||
      (lookup.checkedAt.length >= 10 &&
        lookup.checkout.businessDate < lookup.checkedAt.slice(0, 10));
    const canSettlePriorDay =
      isPriorDaySettleableComposition(lookup.checkout.items) &&
      currentUserRole === "OWNER" &&
      isPriorDay &&
      (lookup.checkout.status === "REVIEW_REQUIRED" ||
        lookup.checkout.status === "PAYMENT_PENDING");

    return {
      screen: "REVIEW_REQUIRED",
      isDifferentAccount,
      canCheckStatus: true,
      canRetry: false,
      canContinueSaved: false,
      canContinueSettled: false,
      canSettlePriorDay,
      blocksNewSale: true,
      statusPillLabel: "Review required",
      statusPillTone: "danger",
      headline: "Owner review required",
      subline: `Transaction status checked at ${formatManilaTimeOnly(lookup.checkedAt)}.`,
      calloutTitle: isDateCrossed
        ? "Business date changed before save"
        : isDayClosed
          ? "Station day closed before save"
          : "Manual review required",
      calloutBody: isDateCrossed
        ? "This checkout crossed the Manila midnight boundary and cannot be saved automatically as a backdated sale. Keep this reference and payment amounts for Owner review."
        : "This checkout cannot be saved automatically. Keep this reference and payment details for Owner review; no automatic refund is issued.",
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
    };
  }

  if (lookup && lookup.recoveryState === "SAFE_TO_RETRY" && lookup.canRetry && !isDifferentAccount) {
    const serverTotal = lookup.checkout.totalCentavos;
    return {
      screen: "SAFE_TO_RETRY",
      isDifferentAccount: false,
      canCheckStatus: true,
      canRetry: true,
      canContinueSaved: false,
      canContinueSettled: false,
      canSettlePriorDay: false,
      blocksNewSale: true,
      statusPillLabel: "Not saved · verified",
      statusPillTone: "neutral",
      headline: "Not saved. Safe to retry.",
      subline: `Transaction status checked at ${formatManilaTimeOnly(lookup.checkedAt)}.`,
      calloutTitle: "No matching sale found",
      calloutBody:
        "A server check confirmed this transaction was not saved. Retry the same transaction without collecting cash again.",
      calloutTone: "warning",
      amounts: {
        totalCentavos: serverTotal,
        cashReceivedCentavos: localCash,
        changeCentavos: localCash - serverTotal,
        totalContainers: lookup.checkout.totalContainers,
        totalVolumeLiters: lookup.checkout.totalVolumeLiters,
        items: lookup.checkout.items,
      },
      checkedAt: lookup.checkedAt,
      sale: null,
      settlement: null,
    };
  }

  const inProgress = lookup?.reason === "SAVE_IN_PROGRESS";
  const serverCheckout = lookup?.checkout;
  const resolvedAmounts = serverCheckout
    ? {
      totalCentavos: serverCheckout.totalCentavos,
      cashReceivedCentavos: serverCheckout.cashReceivedCentavos ?? localCash,
      changeCentavos:
        serverCheckout.changeCentavos ??
        (serverCheckout.cashReceivedCentavos ?? localCash) - serverCheckout.totalCentavos,
      totalContainers: serverCheckout.totalContainers,
      totalVolumeLiters: serverCheckout.totalVolumeLiters,
      items: serverCheckout.items,
    }
    : localAmounts;

  return {
    screen: "UNKNOWN",
    isDifferentAccount,
    canCheckStatus: true,
    canRetry: false,
    canContinueSaved: false,
    canContinueSettled: false,
    canSettlePriorDay: false,
    blocksNewSale: true,
    statusPillLabel: isDifferentAccount
      ? "Pending · other account"
      : inProgress
        ? "Saving in progress"
        : "Not yet verified",
    statusPillTone: "warning",
    headline: isDifferentAccount ? "Pending checkout from another account" : "Check before retrying",
    subline: lookup
      ? `Transaction status checked at ${formatManilaTimeOnly(lookup.checkedAt)}.`
      : "The connection was interrupted during saving.",
    calloutTitle: isDifferentAccount
      ? `Started by ${record.initiatedBy} — sign back into that account to retry`
      : inProgress
        ? "Save still in progress"
        : "Do not confirm payment again",
    calloutBody: isDifferentAccount
      ? "This workstation still has an unverified checkout started by another account. Check its status or sign in as the initiating operator before retrying."
      : "The sale may already be saved. Check its status using the same transaction reference before taking any action.",
    calloutTone: "warning",
    amounts: resolvedAmounts,
    checkedAt: lookup?.checkedAt ?? null,
    sale: null,
    settlement: null,
  };
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

  const clearableDrafts = input.serverUnpaidDrafts.filter(
    (d) => !blockingRefs.has(d.reference.trim().toUpperCase()),
  );

  return {
    blocked: blockingEntries.length > 0,
    blockingEntries,
    clearableDrafts,
  };
}
