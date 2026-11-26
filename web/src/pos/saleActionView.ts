import {
  formatCentavos,
  parsePesoInputToCentavos,
  type SaleActionCashDirection,
  type SaleActionMerchandisePlanItem,
  type SaleActionStatus,
} from "./posRecovery";

export const INITIAL_CUSTOM_LITERS_INPUT = "";
export const INITIAL_CUSTOM_PRICE_INPUT = "";

export function formatSaleActionCashExchange(action: {
  cashDirection: SaleActionCashDirection;
  cashDifferenceCentavos: number;
  cashTenderedCentavos: number | null;
  cashChangeCentavos: number | null;
  cashRefundedCentavos: number | null;
}): string {
  if (action.cashDirection === "COLLECT") {
    return `Collected ${formatCentavos(action.cashDifferenceCentavos)} (${formatCentavos(action.cashTenderedCentavos ?? 0)} tendered · ${formatCentavos(action.cashChangeCentavos ?? 0)} change)`;
  }
  if (action.cashDirection === "REFUND") {
    const refunded =
      action.cashRefundedCentavos ??
      (action.cashDifferenceCentavos < 0 ? -action.cashDifferenceCentavos : 0);
    return `Refunded ${formatCentavos(refunded)}`;
  }
  return "₱0.00 (no cash exchanged)";
}

export interface SaleActionControlFlags {
  showConfirmControls: boolean;
  showCancelNoCashControls: boolean;
  showUncertainWarning: boolean;
}

/**
 * Pure control visibility / lockout calculation for SaleActionModal.
 * After a failed save or cancel attempt, cash & terminal controls remain locked
 * (`statusUncertain: true`) until a fresh GET status check succeeds.
 */
export function deriveSaleActionControlFlags(input: {
  status: SaleActionStatus;
  canConfirm: boolean;
  canCancelNoCash: boolean;
  statusUncertain: boolean;
}): SaleActionControlFlags {
  if (input.statusUncertain) {
    return {
      showConfirmControls: false,
      showCancelNoCashControls: false,
      showUncertainWarning: true,
    };
  }
  if (input.status !== "PENDING") {
    return {
      showConfirmControls: false,
      showCancelNoCashControls: false,
      showUncertainWarning: false,
    };
  }
  return {
    showConfirmControls: input.canConfirm,
    showCancelNoCashControls: input.canCancelNoCash,
    showUncertainWarning: false,
  };
}

export function validateNewCustomLine(
  litersInput: string,
  priceInput: string,
):
  | { ok: true; unitVolumeLiters: number; unitPriceCentavos: number }
  | { ok: false; message: string } {
  const litersTrimmed = litersInput.trim();
  const priceTrimmed = priceInput.trim();
  if (!litersTrimmed || !priceTrimmed) {
    return {
      ok: false,
      message: "Enter container volume (L) and manual unit price (₱) for a custom line.",
    };
  }
  const liters = Number(litersTrimmed);
  const priceCentavos = parsePesoInputToCentavos(priceTrimmed);
  if (!Number.isFinite(liters) || liters <= 0 || priceCentavos === null || priceCentavos <= 0) {
    return {
      ok: false,
      message: "Enter a positive container volume (L) and manual unit price (₱).",
    };
  }
  return {
    ok: true,
    unitVolumeLiters: liters,
    unitPriceCentavos: priceCentavos,
  };
}

export function formatSaleActionStockItemSummary(item: SaleActionMerchandisePlanItem): string {
  const parts: string[] = [];
  if (item.retainedQuantity > 0) {
    parts.push(`${item.retainedQuantity} ${item.unit} retained`);
  }
  if (item.addedQuantity > 0) {
    parts.push(`-${item.addedQuantity} ${item.unit} deducted`);
  }
  if (item.restoredQuantity > 0) {
    parts.push(`+${item.restoredQuantity} ${item.unit} restored`);
  }
  if (item.countCoveredQuantity > 0) {
    parts.push(`${item.countCoveredQuantity} ${item.unit} covered by later physical count (+0)`);
  }
  if (item.unclearCoverageQuantity > 0) {
    parts.push(`${item.unclearCoverageQuantity} ${item.unit} unclear coverage (pending Inventory review)`);
  }
  if ((item.notReturnedQuantity ?? 0) > 0) {
    parts.push(`${item.notReturnedQuantity} ${item.unit} not returned (no stock change)`);
  }
  if (item.heldQuantity > 0) {
    parts.push(
      `${item.heldQuantity} ${item.unit} excluded/held${item.holdReason ? ` (${item.holdReason})` : ""}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "No net stock change";
}
