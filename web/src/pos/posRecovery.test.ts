import { describe, expect, it } from "vitest";
import {
  cartLinesSignature,
  clearUnpaidCart,
  clearUnpaidCartIfMatchesReference,
  computeCashSummary,
  createServerRecoveryRecord,
  evaluateEndDayGuard,
  formatCentavos,
  formatManilaTimeWithSeconds,
  formatRecoveryCheckFeedback,
  isPosSyncStorageKey,
  LEGACY_PENDING_RECOVERY_STORAGE_KEY,
  loadPendingRecoveries,
  loadPendingRecoveryByReference,
  loadUnpaidCart,
  mergeRecoveryLookup,
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
      "EMPLOYEE",
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
      resolveRecoveryPresentation(cachedOwnerTrue, "cashier1", "EMPLOYEE", "2026-11-10")
        .canSettlePriorDay,
    ).toBe(false);
    expect(
      resolveRecoveryPresentation(cachedOwnerTrue, "cashier1", "EMPLOYEE").canSettlePriorDay,
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
      resolveRecoveryPresentation(merchPending, "cashier1", "EMPLOYEE", "2026-11-10").canSettlePriorDay,
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
      resolveRecoveryPresentation(pkgPending, "cashier1", "EMPLOYEE", "2026-11-10").canSettlePriorDay,
    ).toBe(false);

    // Mixed customer-owned refill + merchandise is now settleable by Owner (DEC-095)
    const mixedCheckout = makeLookup({
      recoveryState: "REVIEW_REQUIRED",
      reason: "BUSINESS_DATE_CROSSED",
      canRetry: false,
      canSettlePriorDay: true,
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
    ).toBe(true);
    expect(
      resolveRecoveryPresentation(mixedPending, "cashier1", "EMPLOYEE", "2026-11-10").canSettlePriorDay,
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
      "EMPLOYEE",
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

  it("exposes Cancelled dismissal only when server verifies an explicit unpaid cancellation", () => {
    const cancelledLookup = makeLookup({
      recoveryState: "CANCELLED",
      reason: "No cash received",
      canRetry: false,
      canSettlePriorDay: false,
      canDismissCancelled: true,
      ownedByCurrentUser: false,
      checkedAt: "2026-11-25T10:05:12+08:00",
      checkout: {
        ...makeLookup({}).checkout,
        reference: "HD-1124-001",
        businessDate: "2026-11-24",
        status: "CANCELLED_DRAFT",
        cashReceivedCentavos: null,
        changeCentavos: null,
        paymentStartedAt: "2026-11-24T17:10:00+08:00",
        paymentRecordedAt: null,
        resolutionReason: "No cash received",
      },
    });
    const record = makePendingRecord({
      reference: "HD-1124-001",
      businessDate: "2026-11-24",
      lastLookup: cancelledLookup,
    });

    const ownerCancelled = resolveRecoveryPresentation(record, "owner1", "OWNER", "2026-11-25");
    expect(ownerCancelled).toMatchObject({
      screen: "CANCELLED",
      canCheckStatus: true,
      canRetry: false,
      canContinueSaved: false,
      canContinueSettled: false,
      canSettlePriorDay: false,
      canDismissCancelled: true,
      statusPillLabel: "Cancelled",
      headline: "Checkout cancelled",
    });
    expect(ownerCancelled.subline).toContain("10:05:12 AM");
    expect(formatRecoveryCheckFeedback(cancelledLookup, ownerCancelled)).toBe(
      "Status confirmed (10:05:12 AM) — checkout was cancelled with no payment recorded.",
    );

    const cashierCancelled = resolveRecoveryPresentation(record, "cashier2", "EMPLOYEE", "2026-11-25");
    expect(cashierCancelled.screen).toBe("CANCELLED");
    expect(cashierCancelled.canDismissCancelled).toBe(true);

    // Must NOT allow dismissal if canDismissCancelled is false/missing (e.g. AUTO_END_DAY / uncertain payment)
    const blockedFlag = resolveRecoveryPresentation(
      makePendingRecord({
        ...record,
        lastLookup: { ...cancelledLookup, canDismissCancelled: false },
      }),
      "owner1",
      "OWNER",
      "2026-11-25",
    );
    expect(blockedFlag.screen).toBe("UNKNOWN");
    expect(blockedFlag.canDismissCancelled).toBe(false);

    // Must NOT allow dismissal if paymentRecordedAt or cashReceivedCentavos is non-null
    const paidCancelled = resolveRecoveryPresentation(
      makePendingRecord({
        ...record,
        lastLookup: {
          ...cancelledLookup,
          checkout: {
            ...cancelledLookup.checkout,
            cashReceivedCentavos: 10000,
            paymentRecordedAt: "2026-11-24T17:11:00+08:00",
          },
        },
      }),
      "owner1",
      "OWNER",
      "2026-11-25",
    );
    expect(paidCancelled.screen).toBe("UNKNOWN");
    expect(paidCancelled.canDismissCancelled).toBe(false);

    // REVIEW_REQUIRED with No cash received reason still stays in REVIEW_REQUIRED (not dismissible)
    const reviewOnly = resolveRecoveryPresentation(
      makePendingRecord({
        ...record,
        lastLookup: {
          ...cancelledLookup,
          recoveryState: "REVIEW_REQUIRED",
          canDismissCancelled: false,
        },
      }),
      "owner1",
      "OWNER",
      "2026-11-25",
    );
    expect(reviewOnly.screen).toBe("REVIEW_REQUIRED");
    expect(reviewOnly.canDismissCancelled).toBe(false);
  });

  describe("DEC-085 fresh-browser server recovery presentation and stale-lookup protection", () => {
    it("createServerRecoveryRecord keeps server-only cash null and marks source as server", () => {
      const checkout = makeLookup({}).checkout;
      const serverRecord = createServerRecoveryRecord({
        ...checkout,
        status: "PAYMENT_PENDING",
        cashReceivedCentavos: null,
        changeCentavos: null,
        paymentStartedAt: "2026-11-09T10:41:00+08:00",
      });

      expect(serverRecord.source).toBe("server");
      expect(serverRecord.cashReceivedCentavos).toBeNull();
      expect(serverRecord.changeCentavos).toBeNull();
      expect(serverRecord.attemptedAt).toBe("2026-11-09T10:41:00+08:00");
    });

    it("blocks retry with missing tender on a fresh device, says Do not take payment again, and directs to original browser", () => {
      const checkout: CheckoutView = {
        ...makeLookup({}).checkout,
        status: "PAYMENT_PENDING",
        cashReceivedCentavos: null,
        changeCentavos: null,
        paymentStartedAt: "2026-11-09T10:41:00+08:00",
      };
      const serverRecord = createServerRecoveryRecord(checkout);

      const beforeLookup = resolveRecoveryPresentation(serverRecord, "cashier1", "EMPLOYEE");
      expect(beforeLookup.screen).toBe("UNKNOWN");
      expect(beforeLookup.canCheckStatus).toBe(true);
      expect(beforeLookup.canRetry).toBe(false);
      expect(beforeLookup.calloutBody).toContain("Do not take payment again.");
      expect(beforeLookup.amounts.cashReceivedCentavos).toBeNull();
      expect(beforeLookup.amounts.changeCentavos).toBeNull();

      const safeLookup = makeLookup({
        recoveryState: "SAFE_TO_RETRY",
        reason: "NOT_SAVED",
        canRetry: true,
        canCancelUnpaid: true,
        ownedByCurrentUser: true,
        checkedAt: "2026-11-09T10:43:00+08:00",
        checkout,
      });
      const safeOnNewDevice = resolveRecoveryPresentation(
        mergeRecoveryLookup(serverRecord, safeLookup),
        "cashier1",
        "EMPLOYEE",
      );
      expect(safeOnNewDevice).toMatchObject({
        screen: "SAFE_TO_RETRY",
        canCheckStatus: true,
        canRetry: false,
        canCancelUnpaid: true,
        needsOriginalBrowserForRetry: true,
        calloutTitle: "Do not take payment again.",
      });
      expect(safeOnNewDevice.calloutBody).toContain("original browser");
      expect(safeOnNewDevice.amounts.cashReceivedCentavos).toBeNull();
      expect(formatRecoveryCheckFeedback(safeLookup, safeOnNewDevice)).toContain(
        "Original cash details are on the original browser.",
      );

      // Ineligible cancellation cases keep canCancelUnpaid false on fresh-device SAFE_TO_RETRY.
      const disallowedFlag = resolveRecoveryPresentation(
        mergeRecoveryLookup(serverRecord, { ...safeLookup, canCancelUnpaid: false }),
        "cashier1",
        "EMPLOYEE",
      );
      expect(disallowedFlag.canCancelUnpaid).toBe(false);

      const withRecordedCash = resolveRecoveryPresentation(
        mergeRecoveryLookup(serverRecord, {
          ...safeLookup,
          checkout: { ...checkout, cashReceivedCentavos: 50000, paymentRecordedAt: "2026-11-09T10:42:00+08:00" },
        }),
        "cashier1",
        "EMPLOYEE",
      );
      expect(withRecordedCash.canCancelUnpaid).toBe(false);
    });

    it("shows saved sale details from a fresh device and preserves Owner vs Cashier review permissions", () => {
      const savedSale = makeSale();
      const checkout: CheckoutView = {
        ...makeLookup({}).checkout,
        status: "SAVED",
        cashReceivedCentavos: 50000,
        changeCentavos: 17500,
      };
      const savedLookup = makeLookup({
        recoveryState: "SAVED",
        reason: null,
        canRetry: false,
        ownedByCurrentUser: true,
        checkout,
        sale: savedSale,
      });
      const savedRecord = createServerRecoveryRecord(checkout, savedLookup);
      const savedPresentation = resolveRecoveryPresentation(savedRecord, "cashier1", "EMPLOYEE");
      expect(savedPresentation).toMatchObject({
        screen: "SAVED",
        canContinueSaved: true,
        canRetry: false,
        amounts: {
          totalCentavos: 32500,
          cashReceivedCentavos: 50000,
          changeCentavos: 17500,
        },
      });

      const priorCheckout: CheckoutView = {
        ...makeLookup({}).checkout,
        businessDate: "2026-11-08",
        status: "REVIEW_REQUIRED",
        resolutionReason: "BUSINESS_DATE_CROSSED",
      };
      const priorLookup = makeLookup({
        recoveryState: "REVIEW_REQUIRED",
        reason: "BUSINESS_DATE_CROSSED",
        canRetry: false,
        canSettlePriorDay: true,
        ownedByCurrentUser: true,
        checkedAt: "2026-11-09T10:43:00+08:00",
        checkout: priorCheckout,
      });
      const priorRecord = createServerRecoveryRecord(priorCheckout, priorLookup);
      expect(
        resolveRecoveryPresentation(priorRecord, "owner1", "OWNER", "2026-11-09").canSettlePriorDay,
      ).toBe(true);
      expect(
        resolveRecoveryPresentation(priorRecord, "cashier1", "EMPLOYEE", "2026-11-09").canSettlePriorDay,
      ).toBe(false);
    });

    it("mergeRecoveryLookup does not allow late or older lookups to overwrite SAVED or SETTLED_PRIOR_DAY", () => {
      const savedLookup = makeLookup({
        recoveryState: "SAVED",
        reason: null,
        canRetry: false,
        checkedAt: "2026-11-09T10:44:00+08:00",
        sale: makeSale(),
      });
      const base = createServerRecoveryRecord(savedLookup.checkout, savedLookup);

      const lateUnresolved = makeLookup({
        recoveryState: "UNRESOLVED",
        reason: "SAVE_IN_PROGRESS",
        canRetry: false,
        checkedAt: "2026-11-09T10:45:00+08:00",
      });
      const mergedAfterSaved = mergeRecoveryLookup(base, lateUnresolved);
      expect(mergedAfterSaved.lastLookup?.recoveryState).toBe("SAVED");

      const olderRetry = makeLookup({
        recoveryState: "SAFE_TO_RETRY",
        reason: "NOT_SAVED",
        canRetry: true,
        checkedAt: "2026-11-09T10:41:00+08:00",
      });
      const pendingBase = createServerRecoveryRecord(
        makeLookup({}).checkout,
        makeLookup({
          recoveryState: "UNRESOLVED",
          reason: "SAVE_IN_PROGRESS",
          checkedAt: "2026-11-09T10:43:00+08:00",
        }),
      );
      expect(mergeRecoveryLookup(pendingBase, olderRetry).lastLookup?.checkedAt).toBe(
        "2026-11-09T10:43:00+08:00",
      );
    });

    it("presents terminal CANCELLED_NO_CASH and REFUNDED_UNSAVED outcomes without payment, refund, or handover prompts", () => {
      const noCashCheckout: CheckoutView = {
        ...makeLookup({}).checkout,
        reference: "HD-1109-201",
        businessDate: "2026-11-09",
        status: "CANCELLED_NO_CASH",
        cashReceivedCentavos: null,
        changeCentavos: null,
        resolutionReason: "PRIOR_DAY_NO_CASH_CANCELLED",
      };
      const noCashLookup = makeLookup({
        recoveryState: "CANCELLED_NO_CASH",
        reason: "PRIOR_DAY_NO_CASH_CANCELLED",
        canRetry: false,
        canCancelUnpaid: false,
        canSettlePriorDay: false,
        canResolveNoCashPriorDay: false,
        canResolveFullRefund: false,
        checkedAt: "2026-11-10T09:00:00+08:00",
        checkout: noCashCheckout,
        resolution: {
          checkoutReference: "HD-1109-201",
          originalBusinessDate: "2026-11-09",
          resolutionDate: "2026-11-10",
          outcome: "NO_CASH_CANCELLED",
          quoteTotalCentavos: 32500,
          cashReceivedCentavos: null,
          changeAlreadyGiven: null,
          changeGivenCentavos: null,
          refundedAmountCentavos: null,
          items: noCashCheckout.items,
          originalActor: "cashier1",
          resolvedBy: "owner1",
          resolvedAt: "2026-11-10T08:55:00+08:00",
          reason: "PRIOR_DAY_NO_CASH_CANCELLED",
          note: null,
          heldItems: [],
        },
      });
      const noCashPres = resolveRecoveryPresentation(
        createServerRecoveryRecord(noCashCheckout, noCashLookup),
        "owner1",
        "OWNER",
        "2026-11-10",
      );
      expect(noCashPres).toMatchObject({
        screen: "CANCELLED_NO_CASH",
        canContinueResolved: true,
        canRetry: false,
        canCancelUnpaid: false,
        canSettlePriorDay: false,
        canResolveNoCashPriorDay: false,
        canResolveFullRefund: false,
      });
      expect(formatRecoveryCheckFeedback(noCashLookup, noCashPres)).toContain(
        "cancelled with no cash received",
      );

      const refundedCheckout: CheckoutView = {
        ...makeLookup({}).checkout,
        reference: "HD-1109-202",
        businessDate: "2026-11-09",
        status: "REFUNDED_UNSAVED",
        totalCentavos: 17500,
        cashReceivedCentavos: 25000,
        changeCentavos: 7500,
        resolutionReason: "UNDELIVERED_FULL_REFUND",
      };
      const refundedLookup = makeLookup({
        recoveryState: "REFUNDED_UNSAVED",
        reason: "UNDELIVERED_FULL_REFUND",
        canRetry: false,
        canCancelUnpaid: false,
        canSettlePriorDay: false,
        canResolveNoCashPriorDay: false,
        canResolveFullRefund: false,
        checkedAt: "2026-11-10T09:05:00+08:00",
        checkout: refundedCheckout,
        resolution: {
          checkoutReference: "HD-1109-202",
          originalBusinessDate: "2026-11-09",
          resolutionDate: "2026-11-10",
          outcome: "FULL_REFUND",
          quoteTotalCentavos: 17500,
          cashReceivedCentavos: 25000,
          changeAlreadyGiven: true,
          changeGivenCentavos: 7500,
          refundedAmountCentavos: 17500,
          items: refundedCheckout.items,
          originalActor: "cashier1",
          resolvedBy: "owner1",
          resolvedAt: "2026-11-10T09:04:00+08:00",
          reason: "UNDELIVERED_FULL_REFUND",
          note: null,
          heldItems: [
            {
              id: "hold-1",
              itemId: "round-1",
              itemName: "Round Container",
              quantity: 1,
              unit: "containers",
              reason: "Cancelled filled order held",
              posReference: "HD-1109-202",
              recordedBy: "owner1",
              recordedAt: "2026-11-10T09:04:00+08:00",
            },
          ],
        },
      });
      const refundedRecord = createServerRecoveryRecord(refundedCheckout, refundedLookup);
      const refundedPres = resolveRecoveryPresentation(
        refundedRecord,
        "owner1",
        "OWNER",
        "2026-11-10",
      );
      expect(refundedPres).toMatchObject({
        screen: "REFUNDED_UNSAVED",
        canContinueResolved: true,
        canRetry: false,
        canSettlePriorDay: false,
        canResolveNoCashPriorDay: false,
        canResolveFullRefund: false,
        amounts: {
          totalCentavos: 17500,
          cashReceivedCentavos: 25000,
          changeCentavos: 7500,
        },
      });
      expect(refundedPres.calloutTitle).toContain("₱175.00 refunded");

      // Terminal REFUNDED_UNSAVED is protected from late non-terminal lookups
      const staleLookup = makeLookup({
        recoveryState: "REVIEW_REQUIRED",
        checkedAt: "2026-11-10T09:06:00+08:00",
      });
      expect(mergeRecoveryLookup(refundedRecord, staleLookup).lastLookup?.recoveryState).toBe(
        "REFUNDED_UNSAVED",
      );

      // Cashier cannot see Owner resolution actions on REVIEW_REQUIRED
      const pendingPrior = createServerRecoveryRecord(
        {
          ...makeLookup({}).checkout,
          reference: "HD-1109-203",
          businessDate: "2026-11-09",
          status: "PAYMENT_PENDING",
          cashReceivedCentavos: null,
          paymentRecordedAt: null,
        },
        makeLookup({
          recoveryState: "REVIEW_REQUIRED",
          reason: "BUSINESS_DATE_CROSSED",
          canResolveNoCashPriorDay: true,
          canResolveFullRefund: true,
          checkout: {
            ...makeLookup({}).checkout,
            reference: "HD-1109-203",
            businessDate: "2026-11-09",
            status: "PAYMENT_PENDING",
            cashReceivedCentavos: null,
            paymentRecordedAt: null,
          },
        }),
      );
      expect(
        resolveRecoveryPresentation(pendingPrior, "owner1", "OWNER", "2026-11-10"),
      ).toMatchObject({
        canResolveNoCashPriorDay: true,
        canResolveFullRefund: true,
      });
      expect(
        resolveRecoveryPresentation(pendingPrior, "cashier1", "EMPLOYEE", "2026-11-10"),
      ).toMatchObject({
        canResolveNoCashPriorDay: false,
        canResolveFullRefund: false,
      });

      // Fresh-browser owned filled DRAFT (same day) allows verified cancellation
      const sameDayDraft = createServerRecoveryRecord(
        {
          ...makeLookup({}).checkout,
          reference: "HD-1110-204",
          businessDate: "2026-11-10",
          status: "DRAFT",
          cashReceivedCentavos: null,
          paymentRecordedAt: null,
        },
        makeLookup({
          recoveryState: "SAFE_TO_RETRY",
          reason: "NOT_SAVED",
          canRetry: true,
          canCancelUnpaid: true,
          checkout: {
            ...makeLookup({}).checkout,
            reference: "HD-1110-204",
            businessDate: "2026-11-10",
            status: "DRAFT",
            cashReceivedCentavos: null,
            paymentRecordedAt: null,
          },
        }),
      );
      expect(
        resolveRecoveryPresentation(sameDayDraft, "cashier1", "EMPLOYEE", "2026-11-10"),
      ).toMatchObject({
        screen: "SAFE_TO_RETRY",
        needsOriginalBrowserForRetry: true,
        canCancelUnpaid: true,
      });

      // Owned filled DRAFT recovered after midnight exposes canCancelUnpaid in REVIEW_REQUIRED
      const midnightDraft = createServerRecoveryRecord(
        {
          ...makeLookup({}).checkout,
          reference: "HD-1109-205",
          businessDate: "2026-11-09",
          status: "DRAFT",
          cashReceivedCentavos: null,
          paymentRecordedAt: null,
        },
        makeLookup({
          recoveryState: "REVIEW_REQUIRED",
          reason: "BUSINESS_DATE_CROSSED",
          canRetry: false,
          canCancelUnpaid: true,
          checkout: {
            ...makeLookup({}).checkout,
            reference: "HD-1109-205",
            businessDate: "2026-11-09",
            status: "DRAFT",
            cashReceivedCentavos: null,
            paymentRecordedAt: null,
          },
        }),
      );
      expect(
        resolveRecoveryPresentation(midnightDraft, "cashier1", "EMPLOYEE", "2026-11-10"),
      ).toMatchObject({
        screen: "REVIEW_REQUIRED",
        canCancelUnpaid: true,
        canResolveNoCashPriorDay: false,
        canResolveFullRefund: false,
      });

      // Prior-day PAYMENT_PENDING remains locked from Cashier unpaid cancellation even in REVIEW_REQUIRED
      const midnightPending = createServerRecoveryRecord(
        pendingPrior.lastLookup!.checkout,
        makeLookup({
          ...pendingPrior.lastLookup!,
          canCancelUnpaid: true,
        }),
      );
      expect(
        resolveRecoveryPresentation(midnightPending, "cashier1", "EMPLOYEE", "2026-11-10"),
      ).toMatchObject({
        screen: "REVIEW_REQUIRED",
        canCancelUnpaid: false,
      });
    });

    it("blocks End Day when a durable Owner sale action is still pending (Task 2)", () => {
      const blocked = evaluateEndDayGuard({
        businessDate: "2026-11-09",
        serverUnresolved: [],
        serverUnpaidDrafts: [],
        serverPendingSaleActions: [
          {
            reference: "HDA-1109-001",
            originalSaleReference: "HD-1109-010",
            originalSaleIsReplacement: false,
            originalBusinessDate: "2026-11-09",
            actionType: "CORRECT",
            status: "PENDING",
            reason: "Customer added refills",
            originalTotalCentavos: 10000,
            originalCashReceivedCentavos: 10000,
            originalChangeCentavos: 0,
            correctedTotalCentavos: 17500,
            cashDifferenceCentavos: 7500,
            cashDirection: "COLLECT",
            correctedItems: null,
            merchandisePlan: {
              hasMerchandise: false,
              retained: [],
              added: [],
              returned: [],
              held: [],
            },
            cashTenderedCentavos: null,
            cashChangeCentavos: null,
            cashRefundedCentavos: null,
            replacementSaleReference: null,
            createdBy: "owner1",
            createdAt: "2026-11-09T14:00:00+08:00",
            completedBy: null,
            completedAt: null,
            cancelledBy: null,
            cancelledAt: null,
            cancelReason: null,
            updatedAt: "2026-11-09T14:00:00+08:00",
          },
        ],
        localPendingRecoveries: [],
        activeConfirming: null,
      });

      expect(blocked.blocked).toBe(true);
      expect(blocked.blockingEntries).toEqual([
        {
          reference: "HDA-1109-001",
          label: "Pending Correct Sale on HD-1109-010 (owner1)",
          source: "server",
        },
      ]);
    });
  });
});
