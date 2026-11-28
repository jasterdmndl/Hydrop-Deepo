import {
  aggregateFilledContainerDemand,
  aggregateMerchandiseDemand,
  type QuoteLineItem,
  type SaleView,
} from "./sales.js";

export type SaleActionType = "VOID" | "CORRECT";
export type SaleActionStatus = "PENDING" | "COMPLETED" | "CANCELLED_NO_CASH";
export type SaleActionCashDirection = "REFUND" | "COLLECT" | "NONE";
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

export interface SaleActionInterveningCount {
  reconciliationId: string;
  recordedAt: string;
  physicalCount: number;
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
  returningFilledQuantity: number;
  eligibleReturnedQuantity: number;
  notReturnedQuantity: number;
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

export interface SaleActionSubmittedMerchandiseLine {
  productId: string;
  quantity: number;
  originalLineIndex: number | null;
}

export interface SaleActionSubmittedContainerLine {
  packageCode: string;
  includedGripo: "PUSH_TYPE" | "TWIST_TYPE" | null;
  quantity: number;
  originalLineIndex: number | null;
}

export interface SaleActionMerchandisePlan {
  hasMerchandise: boolean;
  requiresInventoryReview: boolean;
  submittedMerchandiseLines?: SaleActionSubmittedMerchandiseLine[];
  submittedContainerLines?: SaleActionSubmittedContainerLine[];
  items: SaleActionMerchandisePlanItem[];
  retained: Array<{ productId: string; quantity: number }>;
  added: Array<{ productId: string; quantity: number }>;
  returned: Array<{ productId: string; quantity: number }>;
  held: Array<{ productId: string; quantity: number; reason?: string | null }>;
}

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
  merchandisePlan: SaleActionMerchandisePlan;
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
  originalSale: SaleView;
  replacementSale: SaleView | null;
  canConfirm: boolean;
  canCancelNoCash: boolean;
}

export interface SaleActionFinancials {
  correctedTotalCentavos: number;
  cashDifferenceCentavos: number;
  cashDirection: SaleActionCashDirection;
  refundAmountCentavos: number | null;
  collectAmountCentavos: number | null;
}

/** Formats durable sale-action reference HDA-MMDD-NNN on the original business date. */
export function formatSaleActionReference(businessDate: string, seq: number): string {
  const [, month, day] = businessDate.split("-");
  const padded = String(seq).padStart(3, "0");
  return `HDA-${month}${day}-${padded}`;
}

/**
 * Computes exact signed cash movement between original saved sale total and the
 * corrected/voided outcome. Always compares against saved sale total (not original tender).
 */
export function computeSaleActionFinancials(
  originalTotalCentavos: number,
  actionType: SaleActionType,
  correctedTotalCentavos: number,
): SaleActionFinancials {
  const effectiveCorrected = actionType === "VOID" ? 0 : correctedTotalCentavos;
  const cashDifferenceCentavos = effectiveCorrected - originalTotalCentavos;
  if (cashDifferenceCentavos < 0) {
    return {
      correctedTotalCentavos: effectiveCorrected,
      cashDifferenceCentavos,
      cashDirection: "REFUND",
      refundAmountCentavos: -cashDifferenceCentavos,
      collectAmountCentavos: null,
    };
  }
  if (cashDifferenceCentavos > 0) {
    return {
      correctedTotalCentavos: effectiveCorrected,
      cashDifferenceCentavos,
      cashDirection: "COLLECT",
      refundAmountCentavos: null,
      collectAmountCentavos: cashDifferenceCentavos,
    };
  }
  return {
    correctedTotalCentavos: effectiveCorrected,
    cashDifferenceCentavos: 0,
    cashDirection: "NONE",
    refundAmountCentavos: null,
    collectAmountCentavos: null,
  };
}

function fallbackProductMeta(
  itemsList: ReadonlyArray<readonly QuoteLineItem[] | null>,
  productId: string,
): { name: string; unit: string } {
  for (const list of itemsList) {
    if (!list) continue;
    for (const item of list) {
      if (item.productId === productId) {
        return {
          name: item.displayLabel,
          unit: item.stockUnit ?? "pcs",
        };
      }
    }
  }
  return { name: "Merchandise item", unit: "pcs" };
}

export type BuildSaleActionMerchandisePlanResult =
  | { ok: true; plan: SaleActionMerchandisePlan }
  | { ok: false; kind: "validation-failed"; message: string }
  | {
      ok: false;
      kind: "intervening-count-review-required";
      message: string;
      affectedItems: Array<{
        productId: string;
        productName: string;
        unit: string;
        returningQuantity: number;
        reconciliationId: string;
        recordedAt: string;
        physicalCount: number;
      }>;
    };

/**
 * Computes exact per-product retained, exchanged, added, restored, count-covered,
 * unclear-coverage, and damaged/held quantities under DEC-100..DEC-105 / INV-012..INV-015.
 */
export function buildSaleActionMerchandisePlan(input: {
  originalItems: readonly QuoteLineItem[];
  correctedItems: readonly QuoteLineItem[] | null;
  productMetaById?: ReadonlyMap<string, { name: string; unit: string }>;
  interveningCountByProductId?: ReadonlyMap<string, SaleActionInterveningCount>;
  stockDispositions?: readonly SaleActionStockDispositionInput[];
}): BuildSaleActionMerchandisePlanResult {
  const originalMerch = aggregateMerchandiseDemand([...input.originalItems]);
  const correctedMerch = input.correctedItems
    ? aggregateMerchandiseDemand([...input.correctedItems])
    : new Map<string, number>();
  const originalFilledMerch = aggregateFilledContainerDemand([...input.originalItems]);
  const correctedFilledMerch = input.correctedItems
    ? aggregateFilledContainerDemand([...input.correctedItems])
    : new Map<string, number>();

  const allProductIds = Array.from(
    new Set([...originalMerch.keys(), ...correctedMerch.keys()]),
  ).sort();

  const dispByProduct = new Map<string, SaleActionStockDispositionInput>();
  for (const disp of input.stockDispositions ?? []) {
    if (dispByProduct.has(disp.productId)) {
      return {
        ok: false,
        kind: "validation-failed",
        message: "Provide at most one stock disposition entry per product.",
      };
    }
    if (!originalMerch.has(disp.productId) && !correctedMerch.has(disp.productId)) {
      return {
        ok: false,
        kind: "validation-failed",
        message: "Stock disposition refers to a product not present on this sale action.",
      };
    }
    dispByProduct.set(disp.productId, disp);
  }

  if (allProductIds.length === 0) {
    return {
      ok: true,
      plan: {
        hasMerchandise: false,
        requiresInventoryReview: false,
        items: [],
        retained: [],
        added: [],
        returned: [],
        held: [],
      },
    };
  }

  const planItems: SaleActionMerchandisePlanItem[] = [];
  const retained: Array<{ productId: string; quantity: number }> = [];
  const added: Array<{ productId: string; quantity: number }> = [];
  const returned: Array<{ productId: string; quantity: number }> = [];
  const held: Array<{ productId: string; quantity: number; reason?: string | null }> = [];
  const reviewNeededItems: Array<{
    productId: string;
    productName: string;
    unit: string;
    returningQuantity: number;
    reconciliationId: string;
    recordedAt: string;
    physicalCount: number;
  }> = [];

  for (const productId of allProductIds) {
    const originalQuantity = originalMerch.get(productId) ?? 0;
    const correctedQuantity = correctedMerch.get(productId) ?? 0;
    const meta =
      input.productMetaById?.get(productId) ??
      fallbackProductMeta([input.originalItems, input.correctedItems], productId);
    const disp = dispByProduct.get(productId);
    const retainedBase = Math.min(originalQuantity, correctedQuantity);

    const exchangedQuantity = disp?.exchangedQuantity ?? 0;
    if (!Number.isInteger(exchangedQuantity) || exchangedQuantity < 0 || exchangedQuantity > retainedBase) {
      return {
        ok: false,
        kind: "validation-failed",
        message: `Exchanged quantity for ${meta.name} must be between 0 and ${retainedBase}.`,
      };
    }

    const retainedQuantity = retainedBase - exchangedQuantity;
    const returningFromSaleQuantity = originalQuantity - retainedQuantity;
    const addedQuantity = Math.max(0, correctedQuantity - originalQuantity) + exchangedQuantity;

    if (returningFromSaleQuantity === 0) {
      if (
        (disp?.heldQuantity ?? 0) > 0 ||
        (disp?.eligibleReturnedQuantity ?? 0) > 0 ||
        (disp?.notReturnedQuantity ?? 0) > 0 ||
        disp?.holdReason?.trim() ||
        disp?.countCoverage !== undefined ||
        disp?.uncoveredReturnedQuantity !== undefined ||
        disp?.coveredByCountQuantity !== undefined ||
        disp?.unclearCoverageQuantity !== undefined
      ) {
        return {
          ok: false,
          kind: "validation-failed",
          message: `Return/hold disposition for ${meta.name} only applies when units leave the customer from the original sale.`,
        };
      }
      planItems.push({
        productId,
        productName: meta.name,
        unit: meta.unit,
        originalQuantity,
        correctedQuantity,
        retainedQuantity,
        exchangedQuantity,
        addedQuantity,
        returningFromSaleQuantity: 0,
        returningFilledQuantity: 0,
        eligibleReturnedQuantity: 0,
        notReturnedQuantity: 0,
        restoredQuantity: 0,
        heldQuantity: 0,
        holdReason: null,
        countCoveredQuantity: 0,
        unclearCoverageQuantity: 0,
        interveningReconciliationId: null,
        interveningReconciliationAt: null,
        interveningPhysicalCount: null,
        countCoverage: null,
      });
      if (retainedQuantity > 0) retained.push({ productId, quantity: retainedQuantity });
      if (addedQuantity > 0) added.push({ productId, quantity: addedQuantity });
      continue;
    }

    const origFilledQty = originalFilledMerch.get(productId) ?? 0;
    const corrFilledQty = correctedFilledMerch.get(productId) ?? 0;
    const keptFilled = Math.min(origFilledQty, retainedQuantity, corrFilledQty);
    const returningFilledQuantity = Math.max(0, origFilledQty - keptFilled);

    // Finding 1: Require explicit physical disposition before any stock return or hold.
    if (!disp) {
      return {
        ok: false,
        kind: "validation-failed",
        message: `Confirm physical return disposition for ${returningFromSaleQuantity} returning ${meta.unit} of ${meta.name} (good returned, damaged/held, or not returned).`,
      };
    }

    const eligibleReturnedQuantity = disp.eligibleReturnedQuantity ?? 0;
    const heldQuantity = disp.heldQuantity ?? 0;
    const notReturnedQuantity = disp.notReturnedQuantity ?? 0;

    if (
      !Number.isInteger(eligibleReturnedQuantity) ||
      eligibleReturnedQuantity < 0 ||
      !Number.isInteger(heldQuantity) ||
      heldQuantity < 0 ||
      !Number.isInteger(notReturnedQuantity) ||
      notReturnedQuantity < 0
    ) {
      return {
        ok: false,
        kind: "validation-failed",
        message: `Return, held, and not-returned quantities for ${meta.name} must be non-negative whole numbers.`,
      };
    }

    if (eligibleReturnedQuantity + heldQuantity + notReturnedQuantity !== returningFromSaleQuantity) {
      return {
        ok: false,
        kind: "validation-failed",
        message: `Eligible returned (${eligibleReturnedQuantity}), held (${heldQuantity}), and not returned (${notReturnedQuantity}) quantities must equal ${returningFromSaleQuantity} for ${meta.name}.`,
      };
    }

    const maxEligibleReturn = returningFromSaleQuantity - returningFilledQuantity;
    if (eligibleReturnedQuantity > maxEligibleReturn) {
      return {
        ok: false,
        kind: "validation-failed",
        message: `Filled container units (${returningFilledQuantity} ${meta.unit}) of ${meta.name} cannot be auto-restored as sellable empty stock; mark them damaged/held or not returned.`,
      };
    }

    const holdReason = disp.holdReason?.trim().replace(/\s+/g, " ") || null;
    if (heldQuantity > 0 && !holdReason) {
      return {
        ok: false,
        kind: "validation-failed",
        message: `Enter a short reason for the held or damaged units of ${meta.name}.`,
      };
    }
    if (heldQuantity === 0 && disp.holdReason?.trim()) {
      return {
        ok: false,
        kind: "validation-failed",
        message: `Remove the hold reason or set held quantity above 0 for ${meta.name}.`,
      };
    }

    const intervening = input.interveningCountByProductId?.get(productId) ?? null;

    let restoredQuantity = 0;
    let countCoveredQuantity = 0;
    let unclearCoverageQuantity = 0;
    let countCoverage: SaleActionCountCoverage | null = disp.countCoverage ?? null;

    if (intervening) {
      if (eligibleReturnedQuantity > 0 && !countCoverage) {
        reviewNeededItems.push({
          productId,
          productName: meta.name,
          unit: meta.unit,
          returningQuantity: eligibleReturnedQuantity,
          reconciliationId: intervening.reconciliationId,
          recordedAt: intervening.recordedAt,
          physicalCount: intervening.physicalCount,
        });
        continue;
      }

      if (eligibleReturnedQuantity === 0) {
        if (
          countCoverage !== null ||
          disp.uncoveredReturnedQuantity !== undefined ||
          disp.coveredByCountQuantity !== undefined ||
          disp.unclearCoverageQuantity !== undefined
        ) {
          return {
            ok: false,
            kind: "validation-failed",
            message: `Physical-count coverage applies only when eligible returned units of ${meta.name} are selected for stock restoration.`,
          };
        }
        restoredQuantity = 0;
        countCoveredQuantity = 0;
        unclearCoverageQuantity = 0;
        countCoverage = null;
      } else if (countCoverage === "COVERED_BY_COUNT") {
        restoredQuantity = 0;
        countCoveredQuantity = eligibleReturnedQuantity;
        unclearCoverageQuantity = 0;
      } else if (countCoverage === "UNCOVERED") {
        restoredQuantity = eligibleReturnedQuantity;
        countCoveredQuantity = 0;
        unclearCoverageQuantity = 0;
      } else if (countCoverage === "UNCLEAR") {
        restoredQuantity = 0;
        countCoveredQuantity = 0;
        unclearCoverageQuantity = eligibleReturnedQuantity;
      } else if (countCoverage === "PARTIAL") {
        const partUncovered = disp.uncoveredReturnedQuantity ?? 0;
        const partCovered = disp.coveredByCountQuantity ?? 0;
        const partUnclear = disp.unclearCoverageQuantity ?? 0;
        if (
          !Number.isInteger(partUncovered) ||
          partUncovered < 0 ||
          !Number.isInteger(partCovered) ||
          partCovered < 0 ||
          !Number.isInteger(partUnclear) ||
          partUnclear < 0 ||
          partUncovered + partCovered + partUnclear !== eligibleReturnedQuantity
        ) {
          return {
            ok: false,
            kind: "validation-failed",
            message: `Partial count coverage for ${meta.name} must sum to ${eligibleReturnedQuantity} eligible returned ${meta.unit}.`,
          };
        }
        restoredQuantity = partUncovered;
        countCoveredQuantity = partCovered;
        unclearCoverageQuantity = partUnclear;
      }
    } else {
      if (
        disp.countCoverage !== undefined ||
        disp.uncoveredReturnedQuantity !== undefined ||
        disp.coveredByCountQuantity !== undefined ||
        disp.unclearCoverageQuantity !== undefined
      ) {
        return {
          ok: false,
          kind: "validation-failed",
          message: `No physical-count reconciliation occurred after the original sale for ${meta.name}.`,
        };
      }
      restoredQuantity = eligibleReturnedQuantity;
    }

    planItems.push({
      productId,
      productName: meta.name,
      unit: meta.unit,
      originalQuantity,
      correctedQuantity,
      retainedQuantity,
      exchangedQuantity,
      addedQuantity,
      returningFromSaleQuantity,
      returningFilledQuantity,
      eligibleReturnedQuantity,
      notReturnedQuantity,
      restoredQuantity,
      heldQuantity,
      holdReason,
      countCoveredQuantity,
      unclearCoverageQuantity,
      interveningReconciliationId: intervening?.reconciliationId ?? null,
      interveningReconciliationAt: intervening?.recordedAt ?? null,
      interveningPhysicalCount: intervening?.physicalCount ?? null,
      countCoverage,
    });

    if (retainedQuantity > 0) retained.push({ productId, quantity: retainedQuantity });
    if (addedQuantity > 0) added.push({ productId, quantity: addedQuantity });
    if (restoredQuantity > 0) returned.push({ productId, quantity: restoredQuantity });
    if (heldQuantity > 0) held.push({ productId, quantity: heldQuantity, reason: holdReason });
  }

  if (reviewNeededItems.length > 0) {
    const names = reviewNeededItems.map((item) => item.productName).join(", ");
    return {
      ok: false,
      kind: "intervening-count-review-required",
      message: `A physical count already ran after the original sale for ${names}. Confirm whether returned units were already counted, missed/uncovered, partial, or unclear.`,
      affectedItems: reviewNeededItems,
    };
  }

  return {
    ok: true,
    plan: {
      hasMerchandise: true,
      requiresInventoryReview: planItems.some((item) => item.unclearCoverageQuantity > 0),
      items: planItems,
      retained,
      added,
      returned,
      held,
    },
  };
}

/**
 * Compatibility helper retained for pure domain tests; builds a default plan assuming
 * empty returning units are eligible returns when called directly without explicit dispositions.
 */
export function buildTask2MerchandisePlan(
  originalItems: readonly QuoteLineItem[],
  correctedItems: readonly QuoteLineItem[] | null,
): SaleActionMerchandisePlan {
  const originalMerch = aggregateMerchandiseDemand([...originalItems]);
  const correctedMerch = correctedItems
    ? aggregateMerchandiseDemand([...correctedItems])
    : new Map<string, number>();
  const defaults: SaleActionStockDispositionInput[] = [];
  for (const [productId, origQty] of originalMerch.entries()) {
    const corrQty = correctedMerch.get(productId) ?? 0;
    const returning = Math.max(0, origQty - Math.min(origQty, corrQty));
    if (returning > 0) {
      defaults.push({ productId, eligibleReturnedQuantity: returning });
    }
  }
  const result = buildSaleActionMerchandisePlan({
    originalItems,
    correctedItems,
    stockDispositions: defaults,
  });
  if (result.ok) {
    return result.plan;
  }
  return {
    hasMerchandise: originalMerch.size > 0 || correctedMerch.size > 0,
    requiresInventoryReview: false,
    items: [],
    retained: [],
    added: [],
    returned: [],
    held: [],
  };
}

export function extractAddedDemandMap(plan: SaleActionMerchandisePlan): Map<string, number> {
  const demand = new Map<string, number>();
  for (const item of plan.added) {
    if (item.quantity > 0) {
      demand.set(item.productId, (demand.get(item.productId) ?? 0) + item.quantity);
    }
  }
  return demand;
}

export function saleActionMerchandisePlansEqual(
  a: SaleActionMerchandisePlan,
  b: SaleActionMerchandisePlan,
): boolean {
  const itemsA = a.items ?? [];
  const itemsB = b.items ?? [];
  if (itemsA.length !== itemsB.length) return false;
  for (let i = 0; i < itemsA.length; i += 1) {
    const left = itemsA[i]!;
    const right = itemsB[i]!;
    if (
      left.productId !== right.productId ||
      left.originalQuantity !== right.originalQuantity ||
      left.correctedQuantity !== right.correctedQuantity ||
      left.retainedQuantity !== right.retainedQuantity ||
      left.exchangedQuantity !== right.exchangedQuantity ||
      left.addedQuantity !== right.addedQuantity ||
      (left.eligibleReturnedQuantity ?? left.restoredQuantity) !==
        (right.eligibleReturnedQuantity ?? right.restoredQuantity) ||
      (left.notReturnedQuantity ?? 0) !== (right.notReturnedQuantity ?? 0) ||
      left.restoredQuantity !== right.restoredQuantity ||
      left.heldQuantity !== right.heldQuantity ||
      (left.holdReason ?? null) !== (right.holdReason ?? null) ||
      left.countCoveredQuantity !== right.countCoveredQuantity ||
      left.unclearCoverageQuantity !== right.unclearCoverageQuantity ||
      (left.countCoverage ?? null) !== (right.countCoverage ?? null)
    ) {
      return false;
    }
  }
  return true;
}

export function deriveCashDirection(cashDifferenceCentavos: number): SaleActionCashDirection {
  if (cashDifferenceCentavos < 0) return "REFUND";
  if (cashDifferenceCentavos > 0) return "COLLECT";
  return "NONE";
}

/**
 * Compares two corrected item quote arrays semantically without relying on JSONB key order.
 */
export function saleActionCorrectedItemsEqual(
  a: readonly QuoteLineItem[] | null,
  b: readonly QuoteLineItem[] | null,
): boolean {
  if (a === null || b === null) {
    return a === null && b === null;
  }
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.lineIndex !== right.lineIndex ||
      left.kind !== right.kind ||
      (left.catalogCode ?? null) !== (right.catalogCode ?? null) ||
      (left.waterType ?? null) !== (right.waterType ?? null) ||
      (left.productId ?? null) !== (right.productId ?? null) ||
      (left.stockUnit ?? null) !== (right.stockUnit ?? null) ||
      (left.posSection ?? null) !== (right.posSection ?? null) ||
      (left.includedGripo ?? null) !== (right.includedGripo ?? null) ||
      (left.faucetReportingType ?? null) !== (right.faucetReportingType ?? null) ||
      left.displayLabel !== right.displayLabel ||
      left.unitVolumeMl !== right.unitVolumeMl ||
      left.unitPriceCentavos !== right.unitPriceCentavos ||
      left.quantity !== right.quantity ||
      left.lineTotalCentavos !== right.lineTotalCentavos ||
      left.lineVolumeMl !== right.lineVolumeMl
    ) {
      return false;
    }
  }
  return true;
}

/**
 * DEC-099 / DEC-106: A pending action on an open business day remains confirmable
 * after midnight only when cash changed hands (cashDifferenceCentavos !== 0).
 * An unsaved zero-cash correction crossing midnight must be cancelled (no cash) instead.
 */
export function canConfirmPendingSaleAction(input: {
  status: SaleActionStatus;
  originalBusinessDate: string;
  cashDifferenceCentavos: number;
  dayClosedAt: unknown;
  todayDate: string;
}): boolean {
  if (input.status !== "PENDING" || input.dayClosedAt !== null) {
    return false;
  }
  if (input.originalBusinessDate < input.todayDate && input.cashDifferenceCentavos === 0) {
    return false;
  }
  return true;
}

export function validateConfirmCashSettlement(
  cashDifferenceCentavos: number,
  input: {
    cashConfirmed?: boolean;
    cashTenderedCentavos?: number;
  },
):
  | {
      ok: true;
      cashRefundedCentavos: number | null;
      cashTenderedCentavos: number | null;
      cashChangeCentavos: number | null;
    }
  | { ok: false; message: string } {
  if (cashDifferenceCentavos < 0) {
    if (input.cashConfirmed !== true) {
      return {
        ok: false,
        message: "Confirm the cash refund was handed back to the customer before saving.",
      };
    }
    if (input.cashTenderedCentavos !== undefined) {
      return {
        ok: false,
        message: "Cash tendered does not apply to a refund action.",
      };
    }
    return {
      ok: true,
      cashRefundedCentavos: -cashDifferenceCentavos,
      cashTenderedCentavos: null,
      cashChangeCentavos: null,
    };
  }

  if (cashDifferenceCentavos > 0) {
    if (input.cashConfirmed !== true) {
      return {
        ok: false,
        message: "Confirm the additional cash collection before saving.",
      };
    }
    if (
      typeof input.cashTenderedCentavos !== "number" ||
      !Number.isInteger(input.cashTenderedCentavos) ||
      input.cashTenderedCentavos < cashDifferenceCentavos
    ) {
      return {
        ok: false,
        message: "Cash tendered must be at least the additional amount due.",
      };
    }
    return {
      ok: true,
      cashRefundedCentavos: null,
      cashTenderedCentavos: input.cashTenderedCentavos,
      cashChangeCentavos: input.cashTenderedCentavos - cashDifferenceCentavos,
    };
  }

  if (input.cashTenderedCentavos !== undefined) {
    return {
      ok: false,
      message: "Cash tendered does not apply to a zero-cash correction.",
    };
  }
  return {
    ok: true,
    cashRefundedCentavos: null,
    cashTenderedCentavos: null,
    cashChangeCentavos: null,
  };
}
