import { formatCentavos, type QuoteLineItem } from "./posRecovery";

export interface AggregatedCheckoutHoldProduct {
  productId: string;
  label: string;
  unit: string;
  orderedQuantity: number;
  filledQuantity: number;
  emptyOrMerchQuantity: number;
}

export interface HoldDraftState {
  enabled: boolean;
  quantityInput: string;
  reason: string;
}

export interface RefundSummaryState {
  valid: boolean;
  changeGivenCentavos: number | null;
  refundCentavos: number | null;
  confirmationSignature: string | null;
  validationMessage: string | null;
}

export interface HoldDispositionEvaluation {
  valid: boolean;
  heldItems: Array<{ productId: string; quantity: number; reason: string }>;
  requiresVerification: boolean;
  needsNoFilledConfirmed: boolean;
  errorMessage: string | null;
}

function baseProductLabel(item: QuoteLineItem): string {
  if (item.kind === "CONTAINER_PACKAGE") {
    if (item.catalogCode?.startsWith("ROUND_")) return "Round Container";
    if (item.catalogCode?.startsWith("SLIM_")) return "Slim Container";
  }
  return item.displayLabel;
}

export function aggregateCheckoutProductsForHold(
  items: readonly QuoteLineItem[],
): AggregatedCheckoutHoldProduct[] {
  const map = new Map<string, AggregatedCheckoutHoldProduct>();
  for (const item of items) {
    if ((item.kind !== "MERCHANDISE" && item.kind !== "CONTAINER_PACKAGE") || !item.productId) {
      continue;
    }
    const isFilledContainer = item.kind === "CONTAINER_PACKAGE" && item.waterType !== null;
    const existing = map.get(item.productId);
    if (existing) {
      existing.orderedQuantity += item.quantity;
      if (isFilledContainer) {
        existing.filledQuantity += item.quantity;
      } else {
        existing.emptyOrMerchQuantity += item.quantity;
      }
      if (item.kind === "CONTAINER_PACKAGE") {
        existing.label = baseProductLabel(item);
      }
    } else {
      map.set(item.productId, {
        productId: item.productId,
        label: item.kind === "CONTAINER_PACKAGE" ? baseProductLabel(item) : item.displayLabel,
        unit: item.stockUnit ?? "pcs",
        orderedQuantity: item.quantity,
        filledQuantity: isFilledContainer ? item.quantity : 0,
        emptyOrMerchQuantity: isFilledContainer ? 0 : item.quantity,
      });
    }
  }
  return Array.from(map.values());
}

export function buildInitialHoldDrafts(
  products: readonly AggregatedCheckoutHoldProduct[],
): Record<string, HoldDraftState> {
  const initial: Record<string, HoldDraftState> = {};
  for (const prod of products) {
    const hasFilled = prod.filledQuantity > 0;
    initial[prod.productId] = {
      enabled: hasFilled,
      quantityInput: hasFilled ? String(prod.filledQuantity) : String(prod.orderedQuantity),
      reason: hasFilled
        ? "Cancelled filled container order held from ready-to-sell stock (INV-015)"
        : "Cancelled order item held from ready-to-sell stock",
    };
  }
  return initial;
}

export function computeRefundSummary(
  quoteTotalCentavos: number,
  effectiveCashCentavos: number | null,
  changeAlreadyGiven: boolean,
): RefundSummaryState {
  if (effectiveCashCentavos === null) {
    return {
      valid: false,
      changeGivenCentavos: null,
      refundCentavos: null,
      confirmationSignature: null,
      validationMessage: "Enter the cash received from the customer.",
    };
  }
  if (changeAlreadyGiven && effectiveCashCentavos < quoteTotalCentavos) {
    return {
      valid: false,
      changeGivenCentavos: null,
      refundCentavos: null,
      confirmationSignature: null,
      validationMessage: `Cash received must cover ${formatCentavos(quoteTotalCentavos)} when change was already given.`,
    };
  }
  const changeGivenCentavos = changeAlreadyGiven
    ? effectiveCashCentavos - quoteTotalCentavos
    : 0;
  const refundCentavos = effectiveCashCentavos - changeGivenCentavos;
  if (refundCentavos <= 0) {
    return {
      valid: false,
      changeGivenCentavos,
      refundCentavos,
      confirmationSignature: null,
      validationMessage: "Refund amount must be greater than ₱0.00.",
    };
  }
  return {
    valid: true,
    changeGivenCentavos,
    refundCentavos,
    confirmationSignature: `${effectiveCashCentavos}:${changeAlreadyGiven ? 1 : 0}:${refundCentavos}`,
    validationMessage: null,
  };
}

export function isRefundConfirmationValid(
  confirmedSignature: string | null,
  currentSignature: string | null,
): boolean {
  return currentSignature !== null && confirmedSignature === currentSignature;
}

export function evaluateHoldDisposition(
  products: readonly AggregatedCheckoutHoldProduct[],
  holdDrafts: Readonly<Record<string, HoldDraftState>>,
  dispositionVerified: boolean,
): HoldDispositionEvaluation {
  const heldItems: Array<{ productId: string; quantity: number; reason: string }> = [];
  const heldByProduct = new Map<string, number>();

  for (const prod of products) {
    const draft = holdDrafts[prod.productId];
    if (!draft?.enabled) continue;
    const trimmedQty = draft.quantityInput.trim();
    const qty = Number(trimmedQty);
    if (
      !/^\d+$/.test(trimmedQty) ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > prod.orderedQuantity
    ) {
      return {
        valid: false,
        heldItems: [],
        requiresVerification: true,
        needsNoFilledConfirmed: false,
        errorMessage: `Held quantity for ${prod.label} must be between 1 and ${prod.orderedQuantity}.`,
      };
    }
    const trimmedReason = draft.reason.trim();
    if (!trimmedReason || trimmedReason.length > 240) {
      return {
        valid: false,
        heldItems: [],
        requiresVerification: true,
        needsNoFilledConfirmed: false,
        errorMessage: `Enter a factual hold reason for ${prod.label} (1 to 240 characters).`,
      };
    }
    heldByProduct.set(prod.productId, qty);
    heldItems.push({
      productId: prod.productId,
      quantity: qty,
      reason: trimmedReason,
    });
  }

  const hasFilledProducts = products.some((p) => p.filledQuantity > 0);
  const needsNoFilledConfirmed = products.some(
    (p) => p.filledQuantity > 0 && (heldByProduct.get(p.productId) ?? 0) < p.filledQuantity,
  );
  const requiresVerification = hasFilledProducts || heldItems.length > 0;

  if (requiresVerification && !dispositionVerified) {
    return {
      valid: false,
      heldItems,
      requiresVerification,
      needsNoFilledConfirmed,
      errorMessage: "Verify the held/affected unit quantities before submitting.",
    };
  }

  return {
    valid: true,
    heldItems,
    requiresVerification,
    needsNoFilledConfirmed,
    errorMessage: null,
  };
}
