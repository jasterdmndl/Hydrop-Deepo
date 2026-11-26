import { describe, expect, it } from "vitest";
import {
  deriveSaleActionControlFlags,
  formatSaleActionCashExchange,
  formatSaleActionStockItemSummary,
  INITIAL_CUSTOM_LITERS_INPUT,
  INITIAL_CUSTOM_PRICE_INPUT,
  validateNewCustomLine,
} from "./saleActionView";

describe("saleActionView helpers (Findings 1, 4 & 6)", () => {
  it("locks confirm and cancel controls on uncertain response until status check succeeds (Finding 1)", () => {
    const locked = deriveSaleActionControlFlags({
      status: "PENDING",
      canConfirm: true,
      canCancelNoCash: true,
      statusUncertain: true,
    });
    expect(locked).toEqual({
      showConfirmControls: false,
      showCancelNoCashControls: false,
      showUncertainWarning: true,
    });

    // After status check succeeds and confirms PENDING, controls re-enable
    const recoveredPending = deriveSaleActionControlFlags({
      status: "PENDING",
      canConfirm: true,
      canCancelNoCash: true,
      statusUncertain: false,
    });
    expect(recoveredPending).toEqual({
      showConfirmControls: true,
      showCancelNoCashControls: true,
      showUncertainWarning: false,
    });

    // If status check reveals action already saved, cash controls remain disabled
    const recoveredCompleted = deriveSaleActionControlFlags({
      status: "COMPLETED",
      canConfirm: false,
      canCancelNoCash: false,
      statusUncertain: false,
    });
    expect(recoveredCompleted).toEqual({
      showConfirmControls: false,
      showCancelNoCashControls: false,
      showUncertainWarning: false,
    });
  });

  it("hides confirm while keeping no-cash cancel available for post-midnight unsaved zero-cash correction (Finding 4)", () => {
    const midnightZeroCash = deriveSaleActionControlFlags({
      status: "PENDING",
      canConfirm: false,
      canCancelNoCash: true,
      statusUncertain: false,
    });
    expect(midnightZeroCash).toEqual({
      showConfirmControls: false,
      showCancelNoCashControls: true,
      showUncertainWarning: false,
    });
  });

  it("starts new custom lines with blank manual price and rejects empty price input (Finding 6)", () => {
    expect(INITIAL_CUSTOM_LITERS_INPUT).toBe("");
    expect(INITIAL_CUSTOM_PRICE_INPUT).toBe("");

    expect(validateNewCustomLine("25", "").ok).toBe(false);
    expect(validateNewCustomLine("", "25.00").ok).toBe(false);
    expect(validateNewCustomLine("25", "0").ok).toBe(false);

    expect(validateNewCustomLine("18.9", "32.50")).toEqual({
      ok: true,
      unitVolumeLiters: 18.9,
      unitPriceCentavos: 3250,
    });
  });

  it("formats actual correction cash exchange accurately without inventing tender or change (Finding 5)", () => {
    expect(
      formatSaleActionCashExchange({
        cashDirection: "COLLECT",
        cashDifferenceCentavos: 7500,
        cashTenderedCentavos: 10000,
        cashChangeCentavos: 2500,
        cashRefundedCentavos: null,
      }),
    ).toBe("Collected ₱75.00 (₱100.00 tendered · ₱25.00 change)");

    expect(
      formatSaleActionCashExchange({
        cashDirection: "REFUND",
        cashDifferenceCentavos: -17500,
        cashTenderedCentavos: null,
        cashChangeCentavos: null,
        cashRefundedCentavos: 17500,
      }),
    ).toBe("Refunded ₱175.00");

    expect(
      formatSaleActionCashExchange({
        cashDirection: "NONE",
        cashDifferenceCentavos: 0,
        cashTenderedCentavos: null,
        cashChangeCentavos: null,
        cashRefundedCentavos: null,
      }),
    ).toBe("₱0.00 (no cash exchanged)");
  });

  it("formats Task 3 per-product stock effect summaries accurately", () => {
    expect(
      formatSaleActionStockItemSummary({
        productId: "p1",
        productName: "Round Container",
        unit: "pcs",
        originalQuantity: 2,
        correctedQuantity: 0,
        retainedQuantity: 0,
        exchangedQuantity: 0,
        addedQuantity: 0,
        returningFromSaleQuantity: 2,
        restoredQuantity: 1,
        heldQuantity: 1,
        holdReason: "Cracked neck",
        countCoveredQuantity: 0,
        unclearCoverageQuantity: 0,
        interveningReconciliationId: null,
        interveningReconciliationAt: null,
        interveningPhysicalCount: null,
        countCoverage: null,
      }),
    ).toBe("+1 pcs restored · 1 pcs excluded/held (Cracked neck)");

    expect(
      formatSaleActionStockItemSummary({
        productId: "p2",
        productName: "Push Faucet",
        unit: "pcs",
        originalQuantity: 2,
        correctedQuantity: 3,
        retainedQuantity: 1,
        exchangedQuantity: 1,
        addedQuantity: 2,
        returningFromSaleQuantity: 1,
        restoredQuantity: 0,
        heldQuantity: 0,
        holdReason: null,
        countCoveredQuantity: 0,
        unclearCoverageQuantity: 1,
        interveningReconciliationId: "rec-1",
        interveningReconciliationAt: "2026-11-26T10:00:00+08:00",
        interveningPhysicalCount: 5,
        countCoverage: "UNCLEAR",
      }),
    ).toBe("1 pcs retained · -2 pcs deducted · 1 pcs unclear coverage (pending Inventory review)");

    expect(
      formatSaleActionStockItemSummary({
        productId: "p3",
        productName: "Round Container (Purified · 25 L)",
        unit: "pcs",
        originalQuantity: 1,
        correctedQuantity: 0,
        retainedQuantity: 0,
        exchangedQuantity: 0,
        addedQuantity: 0,
        returningFromSaleQuantity: 1,
        returningFilledQuantity: 1,
        eligibleReturnedQuantity: 0,
        notReturnedQuantity: 1,
        restoredQuantity: 0,
        heldQuantity: 0,
        holdReason: null,
        countCoveredQuantity: 0,
        unclearCoverageQuantity: 0,
        interveningReconciliationId: null,
        interveningReconciliationAt: null,
        interveningPhysicalCount: null,
        countCoverage: null,
      }),
    ).toBe("1 pcs not returned (no stock change)");
  });
});
