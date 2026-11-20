import { describe, expect, it } from "vitest";
import {
  cartLinesSignature,
  clearPendingRecovery,
  clearUnpaidCart,
  computeCashSummary,
  formatCentavos,
  loadPendingRecovery,
  loadUnpaidCart,
  parseLitersInput,
  parsePesoInputToCentavos,
  resolveRecoveryPresentation,
  savePendingRecovery,
  saveUnpaidCart,
  type CartDraftLine,
  type CheckoutLookupView,
  type PendingCheckoutRecovery,
  type QuoteLineItem,
  type SaleView,
  type StorageLike,
} from "./posRecovery";

function makeMemoryStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

const SAMPLE_ITEMS: QuoteLineItem[] = [
  {
    lineIndex: 0,
    kind: "STANDARD",
    catalogCode: "PURIFIED_25L",
    waterType: "PURIFIED",
    displayLabel: "Purified refill · 25 L",
    unitVolumeMl: 25000,
    unitVolumeLiters: 25,
    unitPriceCentavos: 2500,
    quantity: 2,
    lineTotalCentavos: 5000,
    lineVolumeMl: 50000,
    lineVolumeLiters: 50,
  },
  {
    lineIndex: 1,
    kind: "STANDARD",
    catalogCode: "ALKALINE_25L",
    waterType: "ALKALINE",
    displayLabel: "Alkaline refill · 25 L",
    unitVolumeMl: 25000,
    unitVolumeLiters: 25,
    unitPriceCentavos: 3500,
    quantity: 1,
    lineTotalCentavos: 3500,
    lineVolumeMl: 25000,
    lineVolumeLiters: 25,
  },
  {
    lineIndex: 2,
    kind: "CUSTOM",
    catalogCode: null,
    waterType: "PURIFIED",
    displayLabel: "Custom Purified refill · 11 L",
    unitVolumeMl: 11000,
    unitVolumeLiters: 11,
    unitPriceCentavos: 12000,
    quantity: 2,
    lineTotalCentavos: 24000,
    lineVolumeMl: 22000,
    lineVolumeLiters: 22,
  },
];

function makePendingRecord(overrides: Partial<PendingCheckoutRecovery> = {}): PendingCheckoutRecovery {
  return {
    reference: "HD-1109-042",
    businessDate: "2026-11-09",
    initiatedBy: "cashier1",
    items: [
      { kind: "STANDARD", waterType: "PURIFIED", quantity: 2 },
      { kind: "STANDARD", waterType: "ALKALINE", quantity: 1 },
      { kind: "CUSTOM", waterType: "PURIFIED", unitVolumeLiters: 11, unitPriceCentavos: 12000, quantity: 2 },
    ],
    quoteItems: SAMPLE_ITEMS,
    totalCentavos: 32500,
    totalContainers: 5,
    totalVolumeMl: 97000,
    totalVolumeLiters: 97,
    cashReceivedCentavos: 50000,
    changeCentavos: 17500,
    attemptedAt: "2026-11-09T10:42:00+08:00",
    lastLookup: null,
    lastError: null,
    ...overrides,
  };
}

function makeSale(overrides: Partial<SaleView> = {}): SaleView {
  return {
    reference: "HD-1109-042",
    checkoutReference: "HD-1109-042",
    businessDate: "2026-11-09",
    status: "ACTIVE",
    totalCentavos: 32500,
    cashReceivedCentavos: 50000,
    changeCentavos: 17500,
    totalContainers: 5,
    totalVolumeMl: 97000,
    totalVolumeLiters: 97,
    createdBy: "cashier1",
    createdAt: "2026-11-09T10:42:00+08:00",
    items: SAMPLE_ITEMS,
    actionHistory: [
      {
        action: "SALE_SAVED",
        actor: "cashier1",
        note: null,
        recordedAt: "2026-11-09T10:42:00+08:00",
      },
    ],
    ...overrides,
  };
}

function makeLookup(overrides: Partial<CheckoutLookupView>): CheckoutLookupView {
  const base = makePendingRecord();
  return {
    recoveryState: "SAFE_TO_RETRY",
    reason: "NOT_SAVED",
    canRetry: true,
    ownedByCurrentUser: true,
    checkedAt: "2026-11-09T10:43:00+08:00",
    checkout: {
      reference: base.reference,
      businessDate: base.businessDate,
      status: "DRAFT",
      createdBy: base.initiatedBy,
      createdAt: base.attemptedAt,
      updatedAt: base.attemptedAt,
      totalCentavos: base.totalCentavos,
      totalContainers: base.totalContainers,
      totalVolumeMl: base.totalVolumeMl,
      totalVolumeLiters: base.totalVolumeLiters,
      cashReceivedCentavos: null,
      changeCentavos: null,
      paymentRecordedAt: null,
      resolutionReason: null,
      items: base.quoteItems,
    },
    sale: null,
    ...overrides,
  };
}

describe("POS formatting and exact centavo math", () => {
  it("parses peso inputs without floating-point drift and formats centavos", () => {
    expect(parsePesoInputToCentavos("500")).toBe(50000);
    expect(parsePesoInputToCentavos("325.00")).toBe(32500);
    expect(parsePesoInputToCentavos("₱1,000.5")).toBe(100050);
    expect(parsePesoInputToCentavos("19.99")).toBe(1999);
    expect(parsePesoInputToCentavos("0")).toBeNull();
    expect(parsePesoInputToCentavos("-5")).toBeNull();
    expect(parsePesoInputToCentavos("10.123")).toBeNull();
    expect(parsePesoInputToCentavos("abc")).toBeNull();
    expect(parsePesoInputToCentavos("")).toBeNull();

    expect(formatCentavos(17500)).toBe("₱175.00");
    expect(formatCentavos(5000)).toBe("₱50.00");
    expect(formatCentavos(0)).toBe("₱0.00");
    expect(formatCentavos(100000)).toBe("₱1,000.00");

    expect(parseLitersInput("11")).toBe(11);
    expect(parseLitersInput("18.5")).toBe(18.5);
    expect(parseLitersInput("0")).toBeNull();
    expect(parseLitersInput("11.125")).toBeNull();
  });

  it("calculates exact change as cash minus total (₱500 - ₱325 = ₱175) and rejects insufficient cash", () => {
    expect(computeCashSummary(32500, 50000)).toEqual({
      sufficient: true,
      changeCentavos: 17500,
      shortfallCentavos: 0,
    });
    expect(computeCashSummary(5000, 10000)).toEqual({
      sufficient: true,
      changeCentavos: 5000,
      shortfallCentavos: 0,
    });
    expect(computeCashSummary(5000, 4999)).toEqual({
      sufficient: false,
      changeCentavos: null,
      shortfallCentavos: 1,
    });
    expect(computeCashSummary(5000, null)).toEqual({
      sufficient: false,
      changeCentavos: null,
      shortfallCentavos: 5000,
    });
  });
});

describe("POS recovery state presentation and account guard", () => {
  it("shows Check transaction status and disables retry when status is unknown or save is in progress", () => {
    const unknown = resolveRecoveryPresentation(makePendingRecord(), "cashier1");
    expect(unknown).toMatchObject({
      screen: "UNKNOWN",
      isDifferentAccount: false,
      canCheckStatus: true,
      canRetry: false,
      canContinueSaved: false,
      blocksNewSale: true,
      statusPillLabel: "Not yet verified",
      amounts: {
        totalCentavos: 32500,
        cashReceivedCentavos: 50000,
        changeCentavos: 17500,
        totalContainers: 5,
        totalVolumeLiters: 97,
      },
    });

    const inFlight = resolveRecoveryPresentation(
      makePendingRecord({
        lastLookup: makeLookup({
          recoveryState: "UNRESOLVED",
          reason: "SAVE_IN_PROGRESS",
          canRetry: false,
          checkout: {
            ...makeLookup({}).checkout,
            cashReceivedCentavos: 50000,
            changeCentavos: 17500,
          },
        }),
      }),
      "cashier1",
    );
    expect(inFlight).toMatchObject({
      screen: "UNKNOWN",
      canCheckStatus: true,
      canRetry: false,
      canContinueSaved: false,
      blocksNewSale: true,
      statusPillLabel: "Saving in progress",
      amounts: {
        totalCentavos: 32500,
        cashReceivedCentavos: 50000,
        changeCentavos: 17500,
      },
    });
  });

  it("uses persisted sale amounts consistently when server confirms SAVED", () => {
    const persistedSale = makeSale({
      totalCentavos: 32500,
      cashReceivedCentavos: 50000,
      changeCentavos: 17500,
    });
    // Even if local change was somehow stale, presentation must strictly use persisted sale amounts.
    const saved = resolveRecoveryPresentation(
      makePendingRecord({
        changeCentavos: 7500,
        lastLookup: makeLookup({
          recoveryState: "SAVED",
          reason: null,
          canRetry: false,
          checkout: {
            ...makeLookup({}).checkout,
            status: "SAVED",
            cashReceivedCentavos: 50000,
            changeCentavos: 17500,
          },
          sale: persistedSale,
        }),
      }),
      "cashier1",
    );

    expect(saved).toMatchObject({
      screen: "SAVED",
      isDifferentAccount: false,
      canCheckStatus: false,
      canRetry: false,
      canContinueSaved: true,
      blocksNewSale: true,
      statusPillLabel: "Saved · verified",
      amounts: {
        totalCentavos: 32500,
        cashReceivedCentavos: 50000,
        changeCentavos: 17500,
      },
    });
    expect(saved.sale?.reference).toBe("HD-1109-042");
  });

  it("allows Retry saving this transaction with preserved reference and cash only when SAFE_TO_RETRY for the initiating account", () => {
    const safeRetry = resolveRecoveryPresentation(
      makePendingRecord({
        lastLookup: makeLookup({
          recoveryState: "SAFE_TO_RETRY",
          reason: "NOT_SAVED",
          canRetry: true,
        }),
      }),
      "cashier1",
    );

    expect(safeRetry).toMatchObject({
      screen: "SAFE_TO_RETRY",
      isDifferentAccount: false,
      canCheckStatus: true,
      canRetry: true,
      canContinueSaved: false,
      blocksNewSale: true,
      statusPillLabel: "Not saved · verified",
      amounts: {
        totalCentavos: 32500,
        cashReceivedCentavos: 50000,
        changeCentavos: 17500,
      },
    });
  });

  it("prevents retry and preserves exact reference/cash/change when the restored account differs from the initiating account", () => {
    const baseRecord = makePendingRecord();

    // Even if a prior lookup said SAFE_TO_RETRY, another signed-in account must never retry it.
    const ownerBeforeCheck = resolveRecoveryPresentation(
      makePendingRecord({
        lastLookup: makeLookup({
          recoveryState: "SAFE_TO_RETRY",
          reason: "NOT_SAVED",
          canRetry: true,
        }),
      }),
      "owner1",
    );
    expect(ownerBeforeCheck).toMatchObject({
      screen: "UNKNOWN",
      isDifferentAccount: true,
      canCheckStatus: true,
      canRetry: false,
      canContinueSaved: false,
      blocksNewSale: true,
      amounts: {
        totalCentavos: baseRecord.totalCentavos,
        cashReceivedCentavos: baseRecord.cashReceivedCentavos,
        changeCentavos: baseRecord.changeCentavos,
      },
    });

    const ownerOwnedByOther = resolveRecoveryPresentation(
      makePendingRecord({
        lastLookup: makeLookup({
          recoveryState: "UNRESOLVED",
          reason: "OWNED_BY_OTHER_ACCOUNT",
          canRetry: false,
          ownedByCurrentUser: false,
        }),
      }),
      "owner1",
    );
    expect(ownerOwnedByOther).toMatchObject({
      screen: "UNKNOWN",
      isDifferentAccount: true,
      canCheckStatus: true,
      canRetry: false,
      blocksNewSale: true,
    });

    // If the original sale WAS saved, even another signed-in operator can continue with the saved sale.
    const ownerSaved = resolveRecoveryPresentation(
      makePendingRecord({
        lastLookup: makeLookup({
          recoveryState: "SAVED",
          reason: null,
          canRetry: false,
          ownedByCurrentUser: false,
          sale: makeSale(),
        }),
      }),
      "owner1",
    );
    expect(ownerSaved).toMatchObject({
      screen: "SAVED",
      isDifferentAccount: true,
      canRetry: false,
      canContinueSaved: true,
      amounts: {
        totalCentavos: 32500,
        cashReceivedCentavos: 50000,
        changeCentavos: 17500,
      },
    });

    // If review is required (e.g., crossed midnight or day closed), preserve cash & reference for Owner review.
    const ownerReview = resolveRecoveryPresentation(
      makePendingRecord({
        lastLookup: makeLookup({
          recoveryState: "REVIEW_REQUIRED",
          reason: "BUSINESS_DATE_CROSSED",
          canRetry: false,
          ownedByCurrentUser: false,
          checkout: {
            ...makeLookup({}).checkout,
            status: "REVIEW_REQUIRED",
            resolutionReason: "BUSINESS_DATE_CROSSED",
            cashReceivedCentavos: 50000,
            changeCentavos: 17500,
          },
        }),
      }),
      "owner1",
    );
    expect(ownerReview).toMatchObject({
      screen: "REVIEW_REQUIRED",
      isDifferentAccount: true,
      canCheckStatus: true,
      canRetry: false,
      canContinueSaved: false,
      blocksNewSale: true,
      amounts: {
        totalCentavos: 32500,
        cashReceivedCentavos: 50000,
        changeCentavos: 17500,
      },
    });
  });
});

describe("account-scoped unpaid cart and workstation recovery storage", () => {
  it("scopes unpaid carts strictly to the initiating account and preserves workstation recovery across refresh", () => {
    const sessionStore = makeMemoryStorage();
    const localStore = makeMemoryStorage();

    const lines: CartDraftLine[] = [
      {
        id: "std-PURIFIED",
        kind: "STANDARD",
        waterType: "PURIFIED",
        displayName: "Purified refill · 25 L",
        unitVolumeMl: 25000,
        unitVolumeLiters: 25,
        unitPriceCentavos: 2500,
        quantity: 2,
      },
    ];

    saveUnpaidCart(
      {
        ownerUsername: "cashier1",
        businessDate: "2026-11-09",
        lines,
        preparedCheckout: null,
        prepareKey: "prep-1",
        prepareSignature: cartLinesSignature(lines),
      },
      sessionStore,
    );

    // Owner does not receive Cashier's unpaid cart, and Cashier's cart remains intact.
    expect(loadUnpaidCart("owner1", sessionStore)).toBeNull();
    const restoredCashier = loadUnpaidCart("CASHIER1", sessionStore);
    expect(restoredCashier?.lines).toEqual(lines);

    clearUnpaidCart("owner1", sessionStore);
    expect(loadUnpaidCart("cashier1", sessionStore)?.lines).toEqual(lines);

    // Workstation pending recovery survives simulated page refresh / account switch.
    const pending = makePendingRecord();
    savePendingRecovery(pending, localStore);
    const loaded = loadPendingRecovery(localStore);
    expect(loaded).toEqual(pending);

    clearPendingRecovery(localStore);
    expect(loadPendingRecovery(localStore)).toBeNull();
  });
});
