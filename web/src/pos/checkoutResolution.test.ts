import { describe, expect, it } from "vitest";
import {
  aggregateCheckoutProductsForHold,
  buildInitialHoldDrafts,
  computeRefundSummary,
  evaluateHoldDisposition,
  isRefundConfirmationValid,
} from "./checkoutResolution";
import { type QuoteLineItem } from "./posRecovery";

function makePackageLine(overrides: Partial<QuoteLineItem>): QuoteLineItem {
  return {
    lineIndex: 0,
    kind: "CONTAINER_PACKAGE",
    catalogCode: "ROUND_EMPTY",
    waterType: null,
    productId: "prod-round",
    stockUnit: "pcs",
    posSection: "CONTAINERS",
    includedGripo: "PUSH_TYPE",
    faucetReportingType: null,
    displayLabel: "Empty Round Container",
    unitVolumeMl: 0,
    unitVolumeLiters: 0,
    unitPriceCentavos: 17500,
    quantity: 1,
    lineTotalCentavos: 17500,
    lineVolumeMl: 0,
    lineVolumeLiters: 0,
    ...overrides,
  };
}

describe("checkoutResolution helpers (Findings 2 & 3)", () => {
  it("separates empty and filled quantities for the same container product and preselects only filledQuantity (Finding 2)", () => {
    const items: QuoteLineItem[] = [
      makePackageLine({
        lineIndex: 0,
        catalogCode: "ROUND_EMPTY",
        waterType: null,
        displayLabel: "Empty Round Container",
        quantity: 1,
      }),
      makePackageLine({
        lineIndex: 1,
        catalogCode: "ROUND_PURIFIED",
        waterType: "PURIFIED",
        displayLabel: "Round Container (Purified)",
        unitVolumeMl: 18927,
        unitVolumeLiters: 18.927,
        unitPriceCentavos: 20000,
        lineTotalCentavos: 20000,
        quantity: 1,
      }),
    ];

    const products = aggregateCheckoutProductsForHold(items);
    expect(products).toEqual([
      {
        productId: "prod-round",
        label: "Round Container",
        unit: "pcs",
        orderedQuantity: 2,
        filledQuantity: 1,
        emptyOrMerchQuantity: 1,
      },
    ]);

    const drafts = buildInitialHoldDrafts(products);
    expect(drafts["prod-round"]).toMatchObject({
      enabled: true,
      quantityInput: "1",
    });

    // Requires explicit Owner verification checkbox before submitting
    const unverified = evaluateHoldDisposition(products, drafts, false);
    expect(unverified.valid).toBe(false);
    expect(unverified.requiresVerification).toBe(true);

    // Once verified, submits only the 1 filled unit without needing noFilledUnitsHeldConfirmed
    const verified = evaluateHoldDisposition(products, drafts, true);
    expect(verified.valid).toBe(true);
    expect(verified.needsNoFilledConfirmed).toBe(false);
    expect(verified.heldItems).toEqual([
      {
        productId: "prod-round",
        quantity: 1,
        reason: drafts["prod-round"]!.reason,
      },
    ]);

    // If Owner unchecks/clears the hold (never filled), needsNoFilledConfirmed becomes true
    const zeroHold = evaluateHoldDisposition(
      products,
      { "prod-round": { ...drafts["prod-round"]!, enabled: false } },
      true,
    );
    expect(zeroHold.valid).toBe(true);
    expect(zeroHold.heldItems).toEqual([]);
    expect(zeroHold.needsNoFilledConfirmed).toBe(true);
  });

  it("invalidates full-refund confirmation whenever cash received or changeAlreadyGiven changes (Finding 3)", () => {
    const quoteTotalCentavos = 17500;

    // Initial confirmed calculation: ₱250 tender with ₱75 change already given => ₱175 refund
    const initialSummary = computeRefundSummary(quoteTotalCentavos, 25000, true);
    expect(initialSummary).toMatchObject({
      valid: true,
      changeGivenCentavos: 7500,
      refundCentavos: 17500,
    });
    const confirmedSig = initialSummary.confirmationSignature;
    expect(isRefundConfirmationValid(confirmedSig, initialSummary.confirmationSignature)).toBe(
      true,
    );

    // Switching changeAlreadyGiven from true to false changes refund from ₱175 to ₱250 and invalidates confirmation
    const toggledChangeSummary = computeRefundSummary(quoteTotalCentavos, 25000, false);
    expect(toggledChangeSummary).toMatchObject({
      valid: true,
      changeGivenCentavos: 0,
      refundCentavos: 25000,
    });
    expect(
      isRefundConfirmationValid(confirmedSig, toggledChangeSummary.confirmationSignature),
    ).toBe(false);

    // Editing cash received to ₱200 while keeping changeAlreadyGiven: true also invalidates confirmation
    const editedCashSummary = computeRefundSummary(quoteTotalCentavos, 20000, true);
    expect(editedCashSummary).toMatchObject({
      valid: true,
      changeGivenCentavos: 2500,
      refundCentavos: 17500,
    });
    expect(
      isRefundConfirmationValid(confirmedSig, editedCashSummary.confirmationSignature),
    ).toBe(false);

    // Re-confirming the revised signature passes
    expect(
      isRefundConfirmationValid(
        editedCashSummary.confirmationSignature,
        editedCashSummary.confirmationSignature,
      ),
    ).toBe(true);
  });

  it("supports recording a partial affected subset on a multi-unit filled order and requires explicit verification (Finding 1)", () => {
    const items: QuoteLineItem[] = [
      makePackageLine({
        lineIndex: 0,
        catalogCode: "ROUND_PURIFIED",
        waterType: "PURIFIED",
        displayLabel: "Round Container (Purified)",
        unitVolumeMl: 18927,
        unitVolumeLiters: 18.927,
        unitPriceCentavos: 20000,
        lineTotalCentavos: 40000,
        quantity: 2,
      }),
    ];

    const products = aggregateCheckoutProductsForHold(items);
    const drafts = buildInitialHoldDrafts(products);
    expect(drafts["prod-round"]).toMatchObject({
      enabled: true,
      quantityInput: "2",
    });

    // Staff lowers held count to 1 affected unit out of 2 filled units ordered
    const subsetDrafts = {
      ...drafts,
      "prod-round": {
        ...drafts["prod-round"]!,
        quantityInput: "1",
        reason: "Only 1 Round was filled before customer cancelled",
      },
    };

    const unverified = evaluateHoldDisposition(products, subsetDrafts, false);
    expect(unverified.valid).toBe(false);
    expect(unverified.needsNoFilledConfirmed).toBe(true);

    const verified = evaluateHoldDisposition(products, subsetDrafts, true);
    expect(verified.valid).toBe(true);
    expect(verified.needsNoFilledConfirmed).toBe(true);
    expect(verified.heldItems).toEqual([
      {
        productId: "prod-round",
        quantity: 1,
        reason: "Only 1 Round was filled before customer cancelled",
      },
    ]);
  });
});
