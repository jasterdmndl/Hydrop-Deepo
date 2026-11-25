import { describe, expect, it } from "vitest";
import {
  cartLinesSignature,
  clearUnpaidCart,
  clearUnpaidCartIfMatchesReference,
  computeCashSummary,
  evaluateEndDayGuard,
  formatCentavos,
  formatManilaTimeWithSeconds,
  formatRecoveryCheckFeedback,
  isPosSyncStorageKey,
  LEGACY_PENDING_RECOVERY_STORAGE_KEY,
  loadPendingRecoveries,
  loadPendingRecoveryByReference,
  loadUnpaidCart,
  notifyPosStateChanged,
  parseLitersInput,
  parsePesoInputToCentavos,
  POS_SYNC_STORAGE_KEY,
  reconcileRecoveryTodayDate,
  removePendingRecovery,
  resolveRecoveryPresentation,
  savePendingRecovery,
  saveUnpaidCart,
  toCartItemInputs,
  type CartDraftLine,
  type CheckoutLookupView,
  type CheckoutView,
  type PendingCheckoutRecovery,
  type QuoteLineItem,
  type SaleView,
  type StorageLike,
} from "./posRecovery";

function makeMemoryStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
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
      paymentStartedAt: null,
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
    expect(loadPendingRecoveryByReference(pending.reference, localStore)).toEqual(pending);
    expect(loadPendingRecoveries(localStore)).toEqual([pending]);

    removePendingRecovery(pending.reference, localStore);
    expect(loadPendingRecoveryByReference(pending.reference, localStore)).toBeNull();
    expect(loadPendingRecoveries(localStore)).toEqual([]);
  });

  it("clears a stored unpaid cart only when its preparedCheckout reference matches the resolved reference", () => {
    const sessionStore = makeMemoryStorage();
    const lines: CartDraftLine[] = [
      {
        id: "std-PURIFIED",
        kind: "STANDARD",
        waterType: "PURIFIED",
        displayName: "Purified refill · 25 L",
        unitVolumeMl: 25000,
        unitVolumeLiters: 25,
        unitPriceCentavos: 2500,
        quantity: 1,
      },
    ];

    // Unrelated cart without preparedCheckout must be preserved.
    saveUnpaidCart(
      {
        ownerUsername: "owner1",
        businessDate: "2026-11-22",
        lines,
        preparedCheckout: null,
        prepareKey: null,
        prepareSignature: null,
      },
      sessionStore,
    );
    expect(clearUnpaidCartIfMatchesReference("owner1", "HD-1121-001", sessionStore)).toBe(false);
    expect(loadUnpaidCart("owner1", sessionStore)?.lines).toEqual(lines);

    // Unrelated cart with a different preparedCheckout reference must also be preserved.
    const otherCheckout: CheckoutView = {
      ...makeLookup({}).checkout,
      reference: "HD-1122-001",
      businessDate: "2026-11-22",
      status: "DRAFT",
    };
    saveUnpaidCart(
      {
        ownerUsername: "owner1",
        businessDate: "2026-11-22",
        lines,
        preparedCheckout: otherCheckout,
        prepareKey: "prep-other",
        prepareSignature: cartLinesSignature(lines),
      },
      sessionStore,
    );
    expect(clearUnpaidCartIfMatchesReference("owner1", "HD-1121-001", sessionStore)).toBe(false);
    expect(loadUnpaidCart("owner1", sessionStore)?.preparedCheckout?.reference).toBe("HD-1122-001");

    // Cart tied to the resolved reference (case/whitespace insensitive) must be discarded.
    const tiedCheckout: CheckoutView = {
      ...otherCheckout,
      reference: "HD-1121-001",
      businessDate: "2026-11-21",
    };
    saveUnpaidCart(
      {
        ownerUsername: "owner1",
        businessDate: "2026-11-22",
        lines,
        preparedCheckout: tiedCheckout,
        prepareKey: "prep-tied",
        prepareSignature: cartLinesSignature(lines),
      },
      sessionStore,
    );
    expect(clearUnpaidCartIfMatchesReference("owner1", " hd-1121-001 ", sessionStore)).toBe(true);
    expect(loadUnpaidCart("owner1", sessionStore)).toBeNull();
  });

  it("preserves multiple concurrent pending references across two tabs and clears only the resolved reference", () => {
    const localStore = makeMemoryStorage();

    const first = makePendingRecord({
      reference: "HD-1109-001",
      totalCentavos: 5000,
      cashReceivedCentavos: 10000,
      changeCentavos: 5000,
      attemptedAt: "2026-11-09T09:10:00+08:00",
    });
    const second = makePendingRecord({
      reference: "HD-1109-002",
      totalCentavos: 7000,
      cashReceivedCentavos: 20000,
      changeCentavos: 13000,
      attemptedAt: "2026-11-09T09:12:00+08:00",
    });
    // Also include a legacy v1 record for a third reference to ensure selective migration/removal.
    const legacyThird = makePendingRecord({
      reference: "HD-1109-003",
      totalCentavos: 2500,
      cashReceivedCentavos: 5000,
      changeCentavos: 2500,
      attemptedAt: "2026-11-09T09:14:00+08:00",
    });
    localStore.setItem(LEGACY_PENDING_RECOVERY_STORAGE_KEY, JSON.stringify(legacyThird));

    savePendingRecovery(first, localStore);
    savePendingRecovery(second, localStore);

    expect(loadPendingRecoveries(localStore).map((r) => r.reference)).toEqual([
      "HD-1109-001",
      "HD-1109-002",
      "HD-1109-003",
    ]);

    // Resolving/removing HD-1109-002 must leave HD-1109-001 (and HD-1109-003) completely intact.
    removePendingRecovery("HD-1109-002", localStore);
    expect(loadPendingRecoveries(localStore).map((r) => r.reference)).toEqual([
      "HD-1109-001",
      "HD-1109-003",
    ]);
    expect(loadPendingRecoveryByReference("HD-1109-001", localStore)).toMatchObject({
      reference: "HD-1109-001",
      totalCentavos: 5000,
      cashReceivedCentavos: 10000,
      changeCentavos: 5000,
      initiatedBy: "cashier1",
    });

    // Removing HD-1109-001 must leave legacy HD-1109-003 untouched; removing HD-1109-003 clears it cleanly.
    removePendingRecovery("HD-1109-001", localStore);
    expect(loadPendingRecoveries(localStore).map((r) => r.reference)).toEqual(["HD-1109-003"]);
    removePendingRecovery("HD-1109-003", localStore);
    expect(loadPendingRecoveries(localStore)).toEqual([]);
  });

  it("blocks End Day immediately while confirmation is active, on pending local recovery, or on server PAYMENT_PENDING", () => {
    const confirming = makePendingRecord({ reference: "HD-1109-010", businessDate: "2026-11-09" });
    const draftSameRef: CheckoutView = {
      ...makeLookup({}).checkout,
      reference: "HD-1109-010",
      businessDate: "2026-11-09",
      status: "DRAFT",
    };
    const unpaidDraftOther: CheckoutView = {
      ...makeLookup({}).checkout,
      reference: "HD-1109-011",
      businessDate: "2026-11-09",
      status: "DRAFT",
    };

    // Even if server still reports HD-1109-010 as unpaid DRAFT while confirm is held in browser,
    // End Day must block it and NEVER list it under clearableDrafts.
    const duringConfirm = evaluateEndDayGuard({
      businessDate: "2026-11-09",
      serverUnresolved: [],
      serverUnpaidDrafts: [draftSameRef, unpaidDraftOther],
      localPendingRecoveries: [confirming],
      activeConfirming: confirming,
    });
    expect(duringConfirm.blocked).toBe(true);
    expect(duringConfirm.blockingEntries).toEqual([
      {
        reference: "HD-1109-010",
        label: "Confirmation in progress (cashier1)",
        source: "local-confirming",
      },
    ]);
    expect(duringConfirm.clearableDrafts.map((d) => d.reference)).toEqual(["HD-1109-011"]);

    // When local storage is empty (e.g., another device), server PAYMENT_PENDING blocks End Day.
    const serverPendingOnly: CheckoutView = {
      ...draftSameRef,
      status: "PAYMENT_PENDING",
      paymentStartedAt: "2026-11-09T09:15:00+08:00",
    };
    const fromServerOnly = evaluateEndDayGuard({
      businessDate: "2026-11-09",
      serverUnresolved: [serverPendingOnly],
      serverUnpaidDrafts: [unpaidDraftOther],
      localPendingRecoveries: [],
      activeConfirming: null,
    });
    expect(fromServerOnly.blocked).toBe(true);
    expect(fromServerOnly.blockingEntries).toEqual([
      {
        reference: "HD-1109-010",
        label: "Cash payment started (cashier1)",
        source: "server",
      },
    ]);

    // When neither local nor server has unresolved items, genuine unpaid drafts remain clearable.
    const onlyUnpaidDraft = evaluateEndDayGuard({
      businessDate: "2026-11-09",
      serverUnresolved: [],
      serverUnpaidDrafts: [unpaidDraftOther],
      localPendingRecoveries: [],
      activeConfirming: null,
    });
    expect(onlyUnpaidDraft.blocked).toBe(false);
    expect(onlyUnpaidDraft.blockingEntries).toEqual([]);
    expect(onlyUnpaidDraft.clearableDrafts.map((d) => d.reference)).toEqual(["HD-1109-011"]);
  });

  it("emits POS state sync notifications without interfering with recovery or cart storage", () => {
    const localStore = makeMemoryStorage();
    const sessionStore = makeMemoryStorage();

    expect(isPosSyncStorageKey(POS_SYNC_STORAGE_KEY)).toBe(true);
    expect(isPosSyncStorageKey(null)).toBe(true);
    expect(isPosSyncStorageKey("unrelated-key")).toBe(false);

    notifyPosStateChanged("sale-saved", localStore);
    const raw = localStore.getItem(POS_SYNC_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ reason: "sale-saved" });

    expect(loadPendingRecoveries(localStore)).toEqual([]);
    expect(loadUnpaidCart("cashier1", sessionStore)).toBeNull();
  });

  it("gates prior-day settlement eligibility to Owner and presents SETTLED_PRIOR_DAY without repeat collection", () => {
    const priorDayReview = makePendingRecord({
      reference: "HD-1109-050",
      businessDate: "2026-11-09",
      totalCentavos: 5000,
      cashReceivedCentavos: 10000,
      changeCentavos: 5000,
      lastLookup: makeLookup({
        recoveryState: "REVIEW_REQUIRED",
        reason: "BUSINESS_DATE_CROSSED",
        canRetry: false,
        canSettlePriorDay: true,
        ownedByCurrentUser: false,
        checkout: {
          ...makeLookup({}).checkout,
          reference: "HD-1109-050",
          businessDate: "2026-11-09",
          status: "REVIEW_REQUIRED",
          totalCentavos: 5000,
          cashReceivedCentavos: 10000,
          changeCentavos: 5000,
          resolutionReason: "BUSINESS_DATE_CROSSED",
        },
      }),
    });

    const ownerView = resolveRecoveryPresentation(
      priorDayReview,
      "owner1",
      "OWNER",
      "2026-11-10",
    );
    expect(ownerView).toMatchObject({
      screen: "REVIEW_REQUIRED",
      canSettlePriorDay: true,
      canRetry: false,
    });

    const cashierFallback = resolveRecoveryPresentation(
      makePendingRecord({
        ...priorDayReview,
        lastLookup: {
          ...priorDayReview.lastLookup!,
          canSettlePriorDay: undefined,
        },
      }),
      "cashier1",
      "CASHIER",
      "2026-11-10",
    );
    expect(cashierFallback.canSettlePriorDay).toBe(false);

    const sameDayOwner = resolveRecoveryPresentation(
      makePendingRecord({
        ...priorDayReview,
        lastLookup: {
          ...priorDayReview.lastLookup!,
          canSettlePriorDay: undefined,
        },
      }),
      "owner1",
      "OWNER",
      "2026-11-09",
    );
    expect(sameDayOwner.canSettlePriorDay).toBe(false);

    const settledPresentation = resolveRecoveryPresentation(
      makePendingRecord({
        reference: "HD-1109-050",
        businessDate: "2026-11-09",
        totalCentavos: 5000,
        cashReceivedCentavos: 10000,
        changeCentavos: 5000,
        lastLookup: makeLookup({
          recoveryState: "SETTLED_PRIOR_DAY",
          reason: "SETTLED_PRIOR_DAY_PAID_AND_DELIVERED",
          canRetry: false,
          canSettlePriorDay: false,
          checkout: {
            ...makeLookup({}).checkout,
            reference: "HD-1109-050",
            businessDate: "2026-11-09",
            status: "SETTLED_PRIOR_DAY",
            totalCentavos: 5000,
            cashReceivedCentavos: 10000,
            changeCentavos: 5000,
          },
          settlement: {
            checkoutReference: "HD-1109-050",
            originalBusinessDate: "2026-11-09",
            settlementDate: "2026-11-10",
            outcome: "PAID_AND_DELIVERED",
            netAmountKeptCentavos: 5000,
            cashReceivedCentavos: 10000,
            changeCentavos: 5000,
            totalContainers: 2,
            totalVolumeMl: 50000,
            totalVolumeLiters: 50,
            items: [SAMPLE_ITEMS[0]!],
            originalActor: "cashier1",
            originalPaymentRecordedAt: "2026-11-09T23:55:00+08:00",
            paymentKeptConfirmed: true,
            refillDeliveredConfirmed: true,
            settledBy: "owner1",
            settledAt: "2026-11-10T08:15:00+08:00",
            note: null,
          },
        }),
      }),
      "owner1",
      "OWNER",
      "2026-11-10",
    );

    expect(settledPresentation).toMatchObject({
      screen: "SETTLED_PRIOR_DAY",
      canContinueSettled: true,
      canRetry: false,
      canSettlePriorDay: false,
      statusPillLabel: "Settled · prior day",
      calloutTitle: "No further payment collected",
      amounts: {
        totalCentavos: 5000,
        cashReceivedCentavos: 10000,
        changeCentavos: 5000,
        totalContainers: 2,
        totalVolumeLiters: 50,
      },
    });
    expect(settledPresentation.settlement?.settlementDate).toBe("2026-11-10");
  });

  it("refreshes prior-day settlement permission strictly from current role on account switch in both directions", () => {
    const cachedOwnerTrue = makePendingRecord({
      reference: "HD-1109-051",
      businessDate: "2026-11-09",
      lastLookup: makeLookup({
        recoveryState: "REVIEW_REQUIRED",
        reason: "BUSINESS_DATE_CROSSED",
        canRetry: false,
        canSettlePriorDay: true,
        ownedByCurrentUser: false,
        checkedAt: "2026-11-10T08:15:00+08:00",
        checkout: {
          ...makeLookup({}).checkout,
          reference: "HD-1109-051",
          businessDate: "2026-11-09",
          status: "REVIEW_REQUIRED",
          resolutionReason: "BUSINESS_DATE_CROSSED",
        },
      }),
    });

    // Cached Owner true must NOT expose settle button when switched to Cashier.
    expect(
      resolveRecoveryPresentation(cachedOwnerTrue, "cashier1", "CASHIER", "2026-11-10")
        .canSettlePriorDay,
    ).toBe(false);
    expect(
      resolveRecoveryPresentation(cachedOwnerTrue, "cashier1", "CASHIER").canSettlePriorDay,
    ).toBe(false);

    const cachedCashierFalse = makePendingRecord({
      ...cachedOwnerTrue,
      lastLookup: {
        ...cachedOwnerTrue.lastLookup!,
        canSettlePriorDay: false,
      },
    });

    // Cached Cashier false MUST unlock settle control when switched to Owner (with or without todayDate).
    expect(
      resolveRecoveryPresentation(cachedCashierFalse, "owner1", "OWNER", "2026-11-10")
        .canSettlePriorDay,
    ).toBe(true);
    expect(
      resolveRecoveryPresentation(cachedCashierFalse, "owner1", "OWNER").canSettlePriorDay,
    ).toBe(true);
  });

  it("maps merchandise cart lines cleanly and excludes merchandise checkouts from prior-day refill settlement", () => {
    const merchDraft: CartDraftLine[] = [
      {
        id: "merch-faucet-1",
        kind: "MERCHANDISE",
        productId: "11111111-1111-4111-8111-111111111111",
        displayName: "Push-Type Faucet",
        description: "Press to dispense water",
        stockUnit: "pcs",
        posSection: "CHANGE_OF_GRIPO",
        unitPriceCentavos: 4000,
        quantity: 2,
      },
    ];
    expect(toCartItemInputs(merchDraft)).toEqual([
      {
        kind: "MERCHANDISE",
        productId: "11111111-1111-4111-8111-111111111111",
        quantity: 2,
      },
    ]);

    const merchCheckout = makeLookup({
      recoveryState: "REVIEW_REQUIRED",
      reason: "BUSINESS_DATE_CROSSED",
      canRetry: false,
      canSettlePriorDay: false,
      checkout: {
        ...makeLookup({}).checkout,
        reference: "HD-1109-099",
        businessDate: "2026-11-09",
        status: "REVIEW_REQUIRED",
        totalCentavos: 8000,
        totalContainers: 0,
        totalVolumeMl: 0,
        totalVolumeLiters: 0,
        items: [
          {
            lineIndex: 0,
            kind: "MERCHANDISE",
            catalogCode: null,
            waterType: null,
            productId: "11111111-1111-4111-8111-111111111111",
            stockUnit: "pcs",
            posSection: "CHANGE_OF_GRIPO",
            displayLabel: "Push-Type Faucet",
            unitVolumeMl: 0,
            unitVolumeLiters: 0,
            unitPriceCentavos: 4000,
            quantity: 2,
            lineTotalCentavos: 8000,
            lineVolumeMl: 0,
            lineVolumeLiters: 0,
          },
        ],
      },
    });
    const merchPending = makePendingRecord({
      reference: "HD-1109-099",
      items: toCartItemInputs(merchDraft),
      quoteItems: merchCheckout.checkout.items,
      totalCentavos: 8000,
      totalContainers: 0,
      totalVolumeMl: 0,
      totalVolumeLiters: 0,
      lastLookup: merchCheckout,
    });

    expect(
      resolveRecoveryPresentation(merchPending, "owner1", "OWNER", "2026-11-10").canSettlePriorDay,
    ).toBe(true);
    expect(
      resolveRecoveryPresentation(merchPending, "cashier1", "CASHIER", "2026-11-10").canSettlePriorDay,
    ).toBe(false);
  });

  it("maps container package cart lines cleanly with included gripo choices and excludes container package checkouts from prior-day refill settlement", () => {
    const pkgDraft: CartDraftLine[] = [
      {
        id: "pkg-ROUND_EMPTY-PUSH_TYPE",
        kind: "CONTAINER_PACKAGE",
        packageCode: "ROUND_EMPTY",
        includedGripo: "PUSH_TYPE",
        productId: "22222222-2222-4222-8222-222222222222",
        displayName: "Empty Round Container · Push-Type gripo",
        unitVolumeMl: 0,
        unitVolumeLiters: 0,
        unitPriceCentavos: 17500,
        stockUnit: "containers",
        quantity: 1,
      },
      {
        id: "pkg-ROUND_EMPTY-TWIST_TYPE",
        kind: "CONTAINER_PACKAGE",
        packageCode: "ROUND_EMPTY",
        includedGripo: "TWIST_TYPE",
        productId: "22222222-2222-4222-8222-222222222222",
        displayName: "Empty Round Container · Twist-Type gripo",
        unitVolumeMl: 0,
        unitVolumeLiters: 0,
        unitPriceCentavos: 17500,
        stockUnit: "containers",
        quantity: 1,
      },
    ];
    expect(toCartItemInputs(pkgDraft)).toEqual([
      {
        kind: "CONTAINER_PACKAGE",
        packageCode: "ROUND_EMPTY",
        includedGripo: "PUSH_TYPE",
        quantity: 1,
      },
      {
        kind: "CONTAINER_PACKAGE",
        packageCode: "ROUND_EMPTY",
        includedGripo: "TWIST_TYPE",
        quantity: 1,
      },
    ]);

    const pkgCheckout = makeLookup({
      recoveryState: "REVIEW_REQUIRED",
      reason: "BUSINESS_DATE_CROSSED",
      canRetry: false,
      canSettlePriorDay: false,
      checkout: {
        ...makeLookup({}).checkout,
        reference: "HD-1109-100",
        businessDate: "2026-11-09",
        status: "REVIEW_REQUIRED",
        totalCentavos: 35000,
        totalContainers: 0,
        totalVolumeMl: 0,
        totalVolumeLiters: 0,
        items: [
          {
            lineIndex: 0,
            kind: "CONTAINER_PACKAGE",
            catalogCode: "ROUND_EMPTY",
            waterType: null,
            productId: "22222222-2222-4222-8222-222222222222",
            stockUnit: "containers",
            posSection: "CONTAINERS",
            includedGripo: "PUSH_TYPE",
            displayLabel: "Empty Round Container · Push-Type gripo",
            unitVolumeMl: 0,
            unitVolumeLiters: 0,
            unitPriceCentavos: 17500,
            quantity: 1,
            lineTotalCentavos: 17500,
            lineVolumeMl: 0,
            lineVolumeLiters: 0,
          },
          {
            lineIndex: 1,
            kind: "CONTAINER_PACKAGE",
            catalogCode: "ROUND_EMPTY",
            waterType: null,
            productId: "22222222-2222-4222-8222-222222222222",
            stockUnit: "containers",
            posSection: "CONTAINERS",
            includedGripo: "TWIST_TYPE",
            displayLabel: "Empty Round Container · Twist-Type gripo",
            unitVolumeMl: 0,
            unitVolumeLiters: 0,
            unitPriceCentavos: 17500,
            quantity: 1,
            lineTotalCentavos: 17500,
            lineVolumeMl: 0,
            lineVolumeLiters: 0,
          },
        ],
      },
    });
    const pkgPending = makePendingRecord({
      reference: "HD-1109-100",
      items: toCartItemInputs(pkgDraft),
      quoteItems: pkgCheckout.checkout.items,
      totalCentavos: 35000,
      totalContainers: 0,
      totalVolumeMl: 0,
      totalVolumeLiters: 0,
      lastLookup: pkgCheckout,
    });

    expect(
      resolveRecoveryPresentation(pkgPending, "owner1", "OWNER", "2026-11-10").canSettlePriorDay,
    ).toBe(true);
    expect(
      resolveRecoveryPresentation(pkgPending, "cashier1", "CASHIER", "2026-11-10").canSettlePriorDay,
    ).toBe(false);

    // Mixed customer-owned refill + merchandise remains blocked pending a separate approval
    const mixedCheckout = makeLookup({
      recoveryState: "REVIEW_REQUIRED",
      reason: "BUSINESS_DATE_CROSSED",
      canRetry: false,
      canSettlePriorDay: false,
      checkout: {
        ...makeLookup({}).checkout,
        reference: "HD-1109-101",
        status: "REVIEW_REQUIRED",
        businessDate: "2026-11-09",
        totalCentavos: 37500,
        totalContainers: 1,
        totalVolumeMl: 25000,
        totalVolumeLiters: 25,
        items: [
          {
            lineIndex: 0,
            kind: "STANDARD",
            catalogCode: "PURIFIED_25L",
            waterType: "PURIFIED",
            displayLabel: "Purified Water 25 L",
            unitVolumeMl: 25000,
            unitVolumeLiters: 25,
            unitPriceCentavos: 2500,
            quantity: 1,
            lineTotalCentavos: 2500,
            lineVolumeMl: 25000,
            lineVolumeLiters: 25,
          },
          ...pkgCheckout.checkout.items,
        ],
      },
    });
    const mixedPending = makePendingRecord({
      reference: "HD-1109-101",
      items: [
        { kind: "STANDARD", waterType: "PURIFIED", quantity: 1 },
        ...toCartItemInputs(pkgDraft),
      ],
      quoteItems: mixedCheckout.checkout.items,
      totalCentavos: 37500,
      totalContainers: 1,
      totalVolumeMl: 25000,
      totalVolumeLiters: 25,
      lastLookup: mixedCheckout,
    });

    expect(
      resolveRecoveryPresentation(mixedPending, "owner1", "OWNER", "2026-11-10").canSettlePriorDay,
    ).toBe(false);
  });

  it("formats recovery check times with seconds, reconciles midnight dates, and builds visible check feedback", () => {
    expect(formatManilaTimeWithSeconds("2026-11-25T00:00:15+08:00")).toBe("12:00:15 AM");
    expect(formatManilaTimeWithSeconds("2026-11-25T00:00:05+08:00")).toBe("12:00:05 AM");

    // Reconciles stale pre-midnight snapshot date with post-midnight lookup timestamp.
    expect(reconcileRecoveryTodayDate("2026-11-24", "2026-11-25T00:00:15+08:00")).toBe("2026-11-25");
    expect(reconcileRecoveryTodayDate("2026-11-24", "2026-11-24T23:59:55+08:00")).toBe("2026-11-24");

    // Eligible Owner refill across midnight unlocks settlement even if dayStatus.todayDate is stale.
    const refillAcrossMidnight = makePendingRecord({
      reference: "HD-1124-001",
      businessDate: "2026-11-24",
      lastLookup: makeLookup({
        recoveryState: "REVIEW_REQUIRED",
        reason: "BUSINESS_DATE_CROSSED",
        canRetry: false,
        canSettlePriorDay: true,
        checkedAt: "2026-11-25T00:00:15+08:00",
        checkout: {
          ...makeLookup({}).checkout,
          reference: "HD-1124-001",
          businessDate: "2026-11-24",
          status: "REVIEW_REQUIRED",
          resolutionReason: "BUSINESS_DATE_CROSSED",
        },
      }),
    });

    const ownerPresentation = resolveRecoveryPresentation(
      refillAcrossMidnight,
      "owner1",
      "OWNER",
      "2026-11-24",
    );
    expect(ownerPresentation.canSettlePriorDay).toBe(true);
    expect(ownerPresentation.subline).toContain("12:00:15 AM");
    expect(formatRecoveryCheckFeedback(refillAcrossMidnight.lastLookup!, ownerPresentation)).toBe(
      "Status confirmed (12:00:15 AM) — still requires Owner review. Prior-day settlement is available below.",
    );

    // Cashier on the same crossed-midnight refill still cannot settle.
    const cashierPresentation = resolveRecoveryPresentation(
      refillAcrossMidnight,
      "cashier1",
      "CASHIER",
      "2026-11-24",
    );
    expect(cashierPresentation.canSettlePriorDay).toBe(false);
    expect(formatRecoveryCheckFeedback(refillAcrossMidnight.lastLookup!, cashierPresentation)).toBe(
      "Status confirmed (12:00:15 AM) — still requires Owner review.",
    );

    // DEC-075 merchandise-only checkout across midnight unlocks settlement for Owner even with stale todayDate.
    const merchAcrossMidnight = makePendingRecord({
      reference: "HD-1124-002",
      businessDate: "2026-11-24",
      quoteItems: [
        {
          lineIndex: 0,
          kind: "MERCHANDISE",
          catalogCode: null,
          waterType: null,
          productId: "11111111-1111-4111-8111-111111111111",
          stockUnit: "pcs",
          posSection: "CHANGE_OF_GRIPO",
          displayLabel: "Push-Type Faucet",
          unitVolumeMl: 0,
          unitVolumeLiters: 0,
          unitPriceCentavos: 4000,
          quantity: 1,
          lineTotalCentavos: 4000,
          lineVolumeMl: 0,
          lineVolumeLiters: 0,
        },
      ],
      lastLookup: makeLookup({
        recoveryState: "REVIEW_REQUIRED",
        reason: "BUSINESS_DATE_CROSSED",
        canRetry: false,
        canSettlePriorDay: true,
        checkedAt: "2026-11-25T00:00:20+08:00",
        checkout: {
          ...makeLookup({}).checkout,
          reference: "HD-1124-002",
          businessDate: "2026-11-24",
          status: "REVIEW_REQUIRED",
          resolutionReason: "BUSINESS_DATE_CROSSED",
          items: [
            {
              lineIndex: 0,
              kind: "MERCHANDISE",
              catalogCode: null,
              waterType: null,
              productId: "11111111-1111-4111-8111-111111111111",
              stockUnit: "pcs",
              posSection: "CHANGE_OF_GRIPO",
              displayLabel: "Push-Type Faucet",
              unitVolumeMl: 0,
              unitVolumeLiters: 0,
              unitPriceCentavos: 4000,
              quantity: 1,
              lineTotalCentavos: 4000,
              lineVolumeMl: 0,
              lineVolumeLiters: 0,
            },
          ],
        },
      }),
    });
    expect(
      resolveRecoveryPresentation(merchAcrossMidnight, "owner1", "OWNER", "2026-11-24")
        .canSettlePriorDay,
    ).toBe(true);

    // Other recovery states produce distinct, timestamped feedback messages.
    const retryLookup = makeLookup({
      recoveryState: "SAFE_TO_RETRY",
      reason: "NOT_SAVED",
      canRetry: true,
      checkedAt: "2026-11-25T00:01:02+08:00",
    });
    const retryPresentation = resolveRecoveryPresentation(
      makePendingRecord({ lastLookup: retryLookup }),
      "cashier1",
    );
    expect(formatRecoveryCheckFeedback(retryLookup, retryPresentation)).toBe(
      "Status confirmed (12:01:02 AM) — not saved yet. Safe to retry.",
    );

    const savedLookup = makeLookup({
      recoveryState: "SAVED",
      reason: null,
      canRetry: false,
      checkedAt: "2026-11-25T00:01:05+08:00",
      sale: makeSale(),
    });
    const savedPresentation = resolveRecoveryPresentation(
      makePendingRecord({ lastLookup: savedLookup }),
      "cashier1",
    );
    expect(formatRecoveryCheckFeedback(savedLookup, savedPresentation)).toBe(
      "Status confirmed (12:01:05 AM) — sale is already saved.",
    );

    const inFlightLookup = makeLookup({
      recoveryState: "UNRESOLVED",
      reason: "SAVE_IN_PROGRESS",
      canRetry: false,
      checkedAt: "2026-11-25T00:01:08+08:00",
    });
    const inFlightPresentation = resolveRecoveryPresentation(
      makePendingRecord({ lastLookup: inFlightLookup }),
      "cashier1",
    );
    expect(formatRecoveryCheckFeedback(inFlightLookup, inFlightPresentation)).toBe(
      "Status confirmed (12:01:08 AM) — save is still in progress.",
    );
  });
});
