import { createHash } from "node:crypto";

/**
 * Pure domain rules, money/volume arithmetic, Asia/Manila date handling,
 * and recovery state machine for POS (refills + Inventory-sourced merchandise)
 * (DEC-043, DEC-068 through DEC-070, DAY-001, DAY-002, POS-002, POS-003, POS-006 through POS-008).
 */

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
  | "SETTLED_PRIOR_DAY"
  | "CANCELLED";

export const MAX_ITEMS_PER_SALE = 50;
export const MAX_QUANTITY_PER_LINE = 500;
export const MIN_VOLUME_LITERS = 0.01;
export const MAX_VOLUME_LITERS = 1000;
export const MIN_UNIT_PRICE_CENTAVOS = 1;
export const MAX_UNIT_PRICE_CENTAVOS = 10_000_000;
export const MAX_TOTAL_CENTAVOS = 100_000_000;
export const MAX_CASH_CENTAVOS = 100_000_000;
export const MAX_TOTAL_VOLUME_ML = 1_000_000_000;

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

export interface ContainerPackageDefinition {
  packageCode: ContainerPackageCode;
  shape: ContainerShape;
  name: string;
  description: string;
  waterType: WaterType | null;
  unitVolumeMl: number;
  unitVolumeLiters: number;
  unitPriceCentavos: number;
}

export const CONTAINER_PACKAGE_DEFINITIONS: readonly ContainerPackageDefinition[] = [
  {
    packageCode: "ROUND_EMPTY",
    shape: "ROUND",
    name: "Empty Round Container",
    description: "Includes gripo, divider, and cap · Empty",
    waterType: null,
    unitVolumeMl: 0,
    unitVolumeLiters: 0,
    unitPriceCentavos: 17500,
  },
  {
    packageCode: "ROUND_PURIFIED",
    shape: "ROUND",
    name: "Round Container (Purified · 25 L)",
    description: "Includes 25 L Purified water, gripo, divider, and cap",
    waterType: "PURIFIED",
    unitVolumeMl: 25000,
    unitVolumeLiters: 25,
    unitPriceCentavos: 20000,
  },
  {
    packageCode: "ROUND_ALKALINE",
    shape: "ROUND",
    name: "Round Container (Alkaline · 25 L)",
    description: "Includes 25 L Alkaline water, gripo, divider, and cap",
    waterType: "ALKALINE",
    unitVolumeMl: 25000,
    unitVolumeLiters: 25,
    unitPriceCentavos: 21000,
  },
  {
    packageCode: "SLIM_EMPTY",
    shape: "SLIM",
    name: "Empty Slim Container",
    description: "Includes gripo, divider, and cap · Empty",
    waterType: null,
    unitVolumeMl: 0,
    unitVolumeLiters: 0,
    unitPriceCentavos: 20000,
  },
  {
    packageCode: "SLIM_PURIFIED",
    shape: "SLIM",
    name: "Slim Container (Purified · 25 L)",
    description: "Includes 25 L Purified water, gripo, divider, and cap",
    waterType: "PURIFIED",
    unitVolumeMl: 25000,
    unitVolumeLiters: 25,
    unitPriceCentavos: 20000,
  },
  {
    packageCode: "SLIM_ALKALINE",
    shape: "SLIM",
    name: "Slim Container (Alkaline · 25 L)",
    description: "Includes 25 L Alkaline water, gripo, divider, and cap",
    waterType: "ALKALINE",
    unitVolumeMl: 25000,
    unitVolumeLiters: 25,
    unitPriceCentavos: 21000,
  },
] as const;

export function containerShapeFromPackageCode(code: ContainerPackageCode): ContainerShape {
  return code.startsWith("ROUND_") ? "ROUND" : "SLIM";
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
      includedGripo: IncludedGripoType;
      quantity: number;
    };

/** Confirm/retry items may omit includedGripo only when matching a pre-0010 quote. */
export type ConfirmCartItemInput =
  | Exclude<CartItemInput, { kind: "CONTAINER_PACKAGE" }>
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

export interface ValidatedQuote {
  items: QuoteLineItem[];
  quoteHash: string;
  totalCentavos: number;
  totalContainers: number;
  totalVolumeMl: number;
  totalVolumeLiters: number;
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

export interface DayStatusView {
  state: DayState;
  todayDate: string;
  canStartDay: boolean;
  canSell: boolean;
  canEndDay: boolean;
  day: DayView | null;
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
  originalPaymentStartedAt: string | null;
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
  canCancelUnpaid: boolean;
  canSettlePriorDay: boolean;
  canDismissCancelled: boolean;
  ownedByCurrentUser: boolean;
  checkedAt: string;
  checkout: CheckoutView;
  sale: SaleView | null;
  settlement: PriorDaySettlementView | null;
}

// Asia/Manila is fixed UTC+08:00 with no daylight saving transitions.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function manilaParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const shifted = new Date(date.getTime() + MANILA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

export function formatManilaDate(date: Date): string {
  const p = manilaParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function formatManilaTime(date: Date): string {
  const p = manilaParts(date);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function formatManilaIso(date: Date): string {
  const p = manilaParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}+08:00`;
}

export function isValidCalendarDate(dateStr: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    !Number.isNaN(check.getTime()) &&
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

export function formatSaleReference(businessDate: string, seq: number): string {
  const [, month, day] = businessDate.split("-");
  return `HD-${month}${day}-${String(seq).padStart(3, "0")}`;
}

export function mlToLiters(ml: number): number {
  return ml / 1000;
}

export function litersToMl(liters: number): number | null {
  if (!Number.isFinite(liters)) return null;
  if (liters < MIN_VOLUME_LITERS || liters > MAX_VOLUME_LITERS) return null;
  const hundredths = liters * 100;
  const rounded = Math.round(hundredths);
  if (Math.abs(hundredths - rounded) > 1e-9 || rounded <= 0) return null;
  return rounded * 10;
}

export function formatCustomLabel(waterType: WaterType, unitVolumeMl: number): string {
  const name = waterType === "PURIFIED" ? "Purified" : "Alkaline";
  return `Custom ${name} refill · ${mlToLiters(unitVolumeMl)} L`;
}

export function aggregateMerchandiseDemand(
  items: readonly { kind: ItemKind; productId?: string | null; quantity: number }[],
): Map<string, number> {
  const raw = new Map<string, number>();
  for (const item of items) {
    if ((item.kind !== "MERCHANDISE" && item.kind !== "CONTAINER_PACKAGE") || !item.productId) {
      continue;
    }
    raw.set(item.productId, (raw.get(item.productId) ?? 0) + item.quantity);
  }
  const sorted = new Map<string, number>();
  for (const key of Array.from(raw.keys()).sort()) {
    sorted.set(key, raw.get(key)!);
  }
  return sorted;
}

export function buildValidatedQuote(
  items: CartItemInput[],
  catalogByWaterType: ReadonlyMap<WaterType, CatalogRefill>,
  merchandiseById: ReadonlyMap<string, PosMerchandiseItem> = new Map(),
  containerPackagesByCode: ReadonlyMap<ContainerPackageCode, PosContainerPackageItem> = new Map(),
):
  | { ok: true; quote: ValidatedQuote }
  | { ok: false; code: "VALIDATION_FAILED" | "PRODUCT_UNAVAILABLE"; message: string } {
  if (items.length < 1 || items.length > MAX_ITEMS_PER_SALE) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: `Select between 1 and ${MAX_ITEMS_PER_SALE} items.`,
    };
  }

  const resolved: QuoteLineItem[] = [];
  let totalCentavos = 0;
  let totalContainers = 0;
  let totalVolumeMl = 0;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY_PER_LINE) {
      return {
        ok: false,
        code: "VALIDATION_FAILED",
        message: `Quantity must be a whole number from 1 to ${MAX_QUANTITY_PER_LINE}.`,
      };
    }

    if (item.kind === "MERCHANDISE") {
      const product = merchandiseById.get(item.productId);
      if (!product) {
        return {
          ok: false,
          code: "PRODUCT_UNAVAILABLE",
          message: "One or more selected merchandise items are unavailable in POS.",
        };
      }
      const lineTotalCentavos = product.unitPriceCentavos * item.quantity;
      totalCentavos += lineTotalCentavos;

      resolved.push({
        lineIndex: i,
        kind: "MERCHANDISE",
        catalogCode: null,
        waterType: null,
        productId: product.id,
        stockUnit: product.unit,
        posSection: product.posSection,
        displayLabel: product.name,
        unitVolumeMl: 0,
        unitVolumeLiters: 0,
        unitPriceCentavos: product.unitPriceCentavos,
        quantity: item.quantity,
        lineTotalCentavos,
        lineVolumeMl: 0,
        lineVolumeLiters: 0,
      });
      continue;
    }

    if (item.kind === "CONTAINER_PACKAGE") {
      const pkg = containerPackagesByCode.get(item.packageCode);
      if (!pkg) {
        return {
          ok: false,
          code: "PRODUCT_UNAVAILABLE",
          message: "One or more selected container packages are unavailable in POS.",
        };
      }
      const lineTotalCentavos = pkg.unitPriceCentavos * item.quantity;
      const lineVolumeMl = pkg.unitVolumeMl * item.quantity;
      totalCentavos += lineTotalCentavos;
      totalVolumeMl += lineVolumeMl;

      resolved.push({
        lineIndex: i,
        kind: "CONTAINER_PACKAGE",
        catalogCode: pkg.packageCode,
        waterType: pkg.waterType,
        productId: pkg.productId,
        stockUnit: pkg.unit,
        posSection: pkg.posSection,
        includedGripo: item.includedGripo,
        displayLabel: `${pkg.name} · ${formatIncludedGripoLabel(item.includedGripo)}`,
        unitVolumeMl: pkg.unitVolumeMl,
        unitVolumeLiters: pkg.unitVolumeLiters,
        unitPriceCentavos: pkg.unitPriceCentavos,
        quantity: item.quantity,
        lineTotalCentavos,
        lineVolumeMl,
        lineVolumeLiters: mlToLiters(lineVolumeMl),
      });
      continue;
    }

    let catalogCode: string | null = null;
    let displayLabel: string;
    let unitVolumeMl: number;
    let unitPriceCentavos: number;

    if (item.kind === "STANDARD") {
      const catalog = catalogByWaterType.get(item.waterType);
      if (!catalog) {
        return {
          ok: false,
          code: "VALIDATION_FAILED",
          message: `Selected ${item.waterType.toLowerCase()} refill is unavailable.`,
        };
      }
      catalogCode = catalog.code;
      displayLabel = catalog.displayName;
      unitVolumeMl = catalog.unitVolumeMl;
      unitPriceCentavos = catalog.unitPriceCentavos;
    } else {
      const convertedMl = litersToMl(item.unitVolumeLiters);
      if (convertedMl === null) {
        return {
          ok: false,
          code: "VALIDATION_FAILED",
          message: "Custom liters per container must be between 0.01 and 1000 with up to 2 decimal places.",
        };
      }
      if (
        !Number.isInteger(item.unitPriceCentavos) ||
        item.unitPriceCentavos < MIN_UNIT_PRICE_CENTAVOS ||
        item.unitPriceCentavos > MAX_UNIT_PRICE_CENTAVOS
      ) {
        return {
          ok: false,
          code: "VALIDATION_FAILED",
          message: "Custom price per container must be a positive amount in centavos.",
        };
      }
      unitVolumeMl = convertedMl;
      unitPriceCentavos = item.unitPriceCentavos;
      displayLabel = formatCustomLabel(item.waterType, unitVolumeMl);
    }

    const lineTotalCentavos = unitPriceCentavos * item.quantity;
    const lineVolumeMl = unitVolumeMl * item.quantity;

    totalCentavos += lineTotalCentavos;
    totalContainers += item.quantity;
    totalVolumeMl += lineVolumeMl;

    resolved.push({
      lineIndex: i,
      kind: item.kind,
      catalogCode,
      waterType: item.waterType,
      displayLabel,
      unitVolumeMl,
      unitVolumeLiters: mlToLiters(unitVolumeMl),
      unitPriceCentavos,
      quantity: item.quantity,
      lineTotalCentavos,
      lineVolumeMl,
      lineVolumeLiters: mlToLiters(lineVolumeMl),
    });
  }

  if (totalCentavos > MAX_TOTAL_CENTAVOS || totalVolumeMl > MAX_TOTAL_VOLUME_ML) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Order total or water volume exceeds the maximum single-sale limit.",
    };
  }

  const canonical = resolved.map((line) => ({
    kind: line.kind,
    catalogCode: line.catalogCode,
    waterType: line.waterType,
    productId: line.productId ?? null,
    includedGripo: line.includedGripo ?? null,
    unitVolumeMl: line.unitVolumeMl,
    unitPriceCentavos: line.unitPriceCentavos,
    quantity: line.quantity,
  }));
  const quoteHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");

  return {
    ok: true,
    quote: {
      items: resolved,
      quoteHash,
      totalCentavos,
      totalContainers,
      totalVolumeMl,
      totalVolumeLiters: mlToLiters(totalVolumeMl),
    },
  };
}

export function submittedItemsMatchQuote(
  submittedItems: ConfirmCartItemInput[],
  quoteItems: QuoteLineItem[],
): boolean {
  if (submittedItems.length !== quoteItems.length) return false;
  for (let i = 0; i < quoteItems.length; i += 1) {
    const submitted = submittedItems[i]!;
    const quote = quoteItems[i]!;
    if (submitted.kind !== quote.kind || submitted.quantity !== quote.quantity) {
      return false;
    }
    if (submitted.kind === "MERCHANDISE") {
      if (submitted.productId !== (quote.productId ?? null)) return false;
      continue;
    }
    if (submitted.kind === "CONTAINER_PACKAGE") {
      if (
        submitted.packageCode !== quote.catalogCode ||
        (submitted.includedGripo ?? null) !== (quote.includedGripo ?? null)
      ) {
        return false;
      }
      continue;
    }
    if (submitted.waterType !== quote.waterType) {
      return false;
    }
    if (submitted.kind === "CUSTOM") {
      const ml = litersToMl(submitted.unitVolumeLiters);
      if (ml === null || ml !== quote.unitVolumeMl) return false;
      if (submitted.unitPriceCentavos !== quote.unitPriceCentavos) return false;
    }
  }
  return true;
}

export function deriveDayStatus(
  openDay: DayView | null,
  todayClosedDay: DayView | null,
  todayDate: string,
): DayStatusView {
  if (openDay && openDay.businessDate < todayDate) {
    return {
      state: "PREVIOUS_DAY_OPEN",
      todayDate,
      canStartDay: false,
      canSell: false,
      canEndDay: true,
      day: openDay,
    };
  }
  if (openDay && openDay.businessDate === todayDate) {
    return {
      state: "OPEN",
      todayDate,
      canStartDay: false,
      canSell: true,
      canEndDay: true,
      day: openDay,
    };
  }
  if (openDay && openDay.businessDate > todayDate) {
    return {
      state: "PREVIOUS_DAY_OPEN",
      todayDate,
      canStartDay: false,
      canSell: false,
      canEndDay: true,
      day: openDay,
    };
  }
  if (!openDay && todayClosedDay) {
    return {
      state: "CLOSED",
      todayDate,
      canStartDay: false,
      canSell: false,
      canEndDay: false,
      day: todayClosedDay,
    };
  }
  return {
    state: "NOT_STARTED",
    todayDate,
    canStartDay: true,
    canSell: false,
    canEndDay: false,
    day: null,
  };
}

export interface InFlightEntry {
  count: number;
  reference: string;
  businessDayId: string;
  createdByUserId: string;
  cashReceivedCentavos: number;
  changeCentavos: number;
  attemptedAt: string;
  checkoutView: CheckoutView;
}

/**
 * Tracks active confirmation executions inside this single Node/Express process
 * so status checks and End Day see an in-flight attempt before DB commit.
 */
export class InFlightCheckoutTracker {
  private readonly entries = new Map<string, InFlightEntry>();

  enter(input: Omit<InFlightEntry, "count">): void {
    const existing = this.entries.get(input.reference);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.entries.set(input.reference, {
      ...input,
      count: 1,
      checkoutView: {
        ...input.checkoutView,
        cashReceivedCentavos: input.cashReceivedCentavos,
        changeCentavos: input.changeCentavos,
        paymentRecordedAt: input.attemptedAt,
      },
    });
  }

  leave(reference: string): void {
    const existing = this.entries.get(reference);
    if (!existing) return;
    if (existing.count <= 1) {
      this.entries.delete(reference);
    } else {
      existing.count -= 1;
    }
  }

  get(reference: string): InFlightEntry | undefined {
    return this.entries.get(reference);
  }

  has(reference: string): boolean {
    return this.entries.has(reference);
  }

  listForDay(businessDayId: string): InFlightEntry[] {
    const matches: InFlightEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.businessDayId === businessDayId) matches.push(entry);
    }
    return matches;
  }
}

export type CheckoutComposition = "REFILL_ONLY" | "MERCHANDISE_ONLY" | "MIXED";

export function classifyCheckoutComposition(items: QuoteLineItem[]): CheckoutComposition {
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

export function deriveCheckoutLookup(input: {
  checkout: CheckoutView;
  checkoutOwnerUserId: string;
  dayClosedAt: string | null;
  cancellationOrigin?: "EXPLICIT_OPERATOR" | "AUTO_END_DAY" | null;
  sale: SaleView | null;
  settlement: PriorDaySettlementView | null;
  todayDate: string;
  currentUserId: string;
  currentUserRole: "OWNER" | "CASHIER";
  checkedAt: string;
  inFlightEntry?: InFlightEntry;
}): CheckoutLookupView {
  const ownedByCurrentUser = input.checkoutOwnerUserId === input.currentUserId;
  const composition = classifyCheckoutComposition(input.checkout.items);
  const canSettlePriorDay =
    composition !== "MIXED" &&
    input.currentUserRole === "OWNER" &&
    !input.inFlightEntry &&
    input.checkout.businessDate < input.todayDate &&
    (input.checkout.status === "REVIEW_REQUIRED" || input.checkout.status === "PAYMENT_PENDING");

  if (input.checkout.status === "SAVED" && input.sale) {
    return {
      recoveryState: "SAVED",
      reason: null,
      canRetry: false,
      canCancelUnpaid: false,
      canSettlePriorDay: false,
      canDismissCancelled: false,
      ownedByCurrentUser,
      checkedAt: input.checkedAt,
      checkout: input.checkout,
      sale: input.sale,
      settlement: null,
    };
  }

  if (input.checkout.status === "SETTLED_PRIOR_DAY" && input.settlement) {
    return {
      recoveryState: "SETTLED_PRIOR_DAY",
      reason: "SETTLED_PRIOR_DAY_PAID_AND_DELIVERED",
      canRetry: false,
      canCancelUnpaid: false,
      canSettlePriorDay: false,
      canDismissCancelled: false,
      ownedByCurrentUser,
      checkedAt: input.checkedAt,
      checkout: input.checkout,
      sale: null,
      settlement: input.settlement,
    };
  }

  if (input.inFlightEntry) {
    return {
      recoveryState: "UNRESOLVED",
      reason: "SAVE_IN_PROGRESS",
      canRetry: false,
      canCancelUnpaid: false,
      canSettlePriorDay: false,
      canDismissCancelled: false,
      ownedByCurrentUser,
      checkedAt: input.checkedAt,
      checkout: input.inFlightEntry.checkoutView,
      sale: null,
      settlement: null,
    };
  }

  if (input.checkout.status === "REVIEW_REQUIRED") {
    return {
      recoveryState: "REVIEW_REQUIRED",
      reason: input.checkout.resolutionReason ?? "REVIEW_REQUIRED",
      canRetry: false,
      canCancelUnpaid: false,
      canSettlePriorDay,
      canDismissCancelled: false,
      ownedByCurrentUser,
      checkedAt: input.checkedAt,
      checkout: input.checkout,
      sale: null,
      settlement: null,
    };
  }

  if (input.checkout.status === "CANCELLED_DRAFT") {
    const isExplicitUnpaidCancellation =
      input.cancellationOrigin === "EXPLICIT_OPERATOR" &&
      input.checkout.cashReceivedCentavos === null &&
      input.checkout.paymentRecordedAt === null;
    if (isExplicitUnpaidCancellation) {
      return {
        recoveryState: "CANCELLED",
        reason: input.checkout.resolutionReason ?? "CHECKOUT_CANCELLED",
        canRetry: false,
        canCancelUnpaid: false,
        canSettlePriorDay: false,
        canDismissCancelled: true,
        ownedByCurrentUser,
        checkedAt: input.checkedAt,
        checkout: input.checkout,
        sale: null,
        settlement: null,
      };
    }
    return {
      recoveryState: "REVIEW_REQUIRED",
      reason: input.checkout.resolutionReason ?? "CHECKOUT_CANCELLED",
      canRetry: false,
      canCancelUnpaid: false,
      canSettlePriorDay: false,
      canDismissCancelled: false,
      ownedByCurrentUser,
      checkedAt: input.checkedAt,
      checkout: input.checkout,
      sale: null,
      settlement: null,
    };
  }

  if (input.dayClosedAt !== null) {
    return {
      recoveryState: "REVIEW_REQUIRED",
      reason: "DAY_CLOSED",
      canRetry: false,
      canCancelUnpaid: false,
      canSettlePriorDay,
      canDismissCancelled: false,
      ownedByCurrentUser,
      checkedAt: input.checkedAt,
      checkout: input.checkout,
      sale: null,
      settlement: null,
    };
  }

  if (input.checkout.businessDate !== input.todayDate) {
    return {
      recoveryState: "REVIEW_REQUIRED",
      reason: "BUSINESS_DATE_CROSSED",
      canRetry: false,
      canCancelUnpaid: false,
      canSettlePriorDay,
      canDismissCancelled: false,
      ownedByCurrentUser,
      checkedAt: input.checkedAt,
      checkout: input.checkout,
      sale: null,
      settlement: null,
    };
  }

  if (!ownedByCurrentUser) {
    return {
      recoveryState: "UNRESOLVED",
      reason: "OWNED_BY_OTHER_ACCOUNT",
      canRetry: false,
      canCancelUnpaid: false,
      canSettlePriorDay: false,
      canDismissCancelled: false,
      ownedByCurrentUser,
      checkedAt: input.checkedAt,
      checkout: input.checkout,
      sale: null,
      settlement: null,
    };
  }

  return {
    recoveryState: "SAFE_TO_RETRY",
    reason: "NOT_SAVED",
    canRetry: true,
    canCancelUnpaid:
      input.checkout.status === "PAYMENT_PENDING" &&
      input.checkout.cashReceivedCentavos === null &&
      input.checkout.paymentRecordedAt === null,
    canSettlePriorDay: false,
    canDismissCancelled: false,
    ownedByCurrentUser,
    checkedAt: input.checkedAt,
    checkout: input.checkout,
    sale: null,
    settlement: null,
  };
}
