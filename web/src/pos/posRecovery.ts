/** Pure POS domain view types, formatting, cart scoping, and recovery state machine. */

export type WaterType = "PURIFIED" | "ALKALINE";
export type ItemKind = "STANDARD" | "CUSTOM";
export type DayState = "NOT_STARTED" | "OPEN" | "CLOSED" | "PREVIOUS_DAY_OPEN";
export type CheckoutStatus = "DRAFT" | "SAVED" | "REVIEW_REQUIRED" | "CANCELLED_DRAFT";
export type SaleStatus = "ACTIVE" | "VOIDED";
export type RecoveryState = "SAVED" | "SAFE_TO_RETRY" | "UNRESOLVED" | "REVIEW_REQUIRED";

export interface CatalogRefill {
  code: string;
  waterType: WaterType;
  displayName: string;
  unitVolumeMl: number;
  unitVolumeLiters: number;
  unitPriceCentavos: number;
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
    };

export interface QuoteLineItem {
  lineIndex: number;
  kind: ItemKind;
  catalogCode: string | null;
  waterType: WaterType;
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

export interface CheckoutLookupView {
  recoveryState: RecoveryState;
  reason: string | null;
  canRetry: boolean;
  ownedByCurrentUser: boolean;
  checkedAt: string;
  checkout: CheckoutView;
  sale: SaleView | null;
}

export interface PrepareCheckoutResponse {
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

export type RecoveryScreen = "UNKNOWN" | "SAVED" | "SAFE_TO_RETRY" | "REVIEW_REQUIRED";
export type RecoveryTone = "warning" | "success" | "danger" | "neutral";

export interface RecoveryPresentation {
  screen: RecoveryScreen;
  isDifferentAccount: boolean;
  canCheckStatus: boolean;
  canRetry: boolean;
  canContinueSaved: boolean;
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
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PENDING_RECOVERY_STORAGE_KEY = "hydrop.pos.pendingRecovery.v1";
export const UNPAID_CART_STORAGE_PREFIX = "hydrop.pos.unpaidCart.v1:";

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
  return lines.map((line) =>
    line.kind === "STANDARD"
      ? { kind: "STANDARD", waterType: line.waterType, quantity: line.quantity }
      : {
          kind: "CUSTOM",
          waterType: line.waterType,
          unitVolumeLiters: line.unitVolumeLiters,
          unitPriceCentavos: line.unitPriceCentavos,
          quantity: line.quantity,
        },
  );
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

export function savePendingRecovery(
  record: PendingCheckoutRecovery,
  storage: StorageLike | null = browserStorage("local"),
): void {
  if (!storage) return;
  try {
    storage.setItem(PENDING_RECOVERY_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Ignore storage quota errors in best-effort persistence.
  }
}

export function loadPendingRecovery(
  storage: StorageLike | null = browserStorage("local"),
): PendingCheckoutRecovery | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PENDING_RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingCheckoutRecovery;
    if (!parsed || typeof parsed.reference !== "string" || typeof parsed.initiatedBy !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingRecovery(storage: StorageLike | null = browserStorage("local")): void {
  if (!storage) return;
  try {
    storage.removeItem(PENDING_RECOVERY_STORAGE_KEY);
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

export function resolveRecoveryPresentation(
  record: PendingCheckoutRecovery,
  currentUsername: string,
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
    };
  }

  if (lookup && lookup.recoveryState === "REVIEW_REQUIRED") {
    const serverTotal = lookup.checkout.totalCentavos;
    const cashReceived = lookup.checkout.cashReceivedCentavos ?? localCash;
    const change = lookup.checkout.changeCentavos ?? cashReceived - serverTotal;
    const isDateCrossed = lookup.reason === "BUSINESS_DATE_CROSSED";
    const isDayClosed = lookup.reason === "DAY_CLOSED";

    return {
      screen: "REVIEW_REQUIRED",
      isDifferentAccount,
      canCheckStatus: true,
      canRetry: false,
      canContinueSaved: false,
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
