import { describe, expect, it } from "vitest";
import {
  computeLateCoveragePreview,
  computeReconciliationPreview,
  DEFAULT_POS_SECTIONS,
  filterInventoryItems,
  formatAlreadySetNotice,
  formatFaucetReportingTypeLabel,
  formatPesoCentavos,
  formatQuantityLabel,
  formatRecordedAtManila,
  formatSignedDelta,
  getContainerPackageSummary,
  getContainerSubtitle,
  getInventoryLoadPhase,
  getInventorySummaryCounts,
  getOpeningSubmitLabel,
  getPosSectionLabel,
  getStockStatusMeta,
  groupInventoryItems,
  type InventoryItemView,
  isUncertainSubmissionError,
  isValidSavedMovementItemPayload,
  loadPendingMovementAttempts,
  MAX_OPENING_QUANTITY,
  mergeRefreshedInventoryItems,
  parseLowStockLevelInput,
  parseMovementQuantityInput,
  parseOpeningQuantityInput,
  parsePendingMovementCancelResponse,
  parsePendingMovementStatusResponse,
  parsePesoPriceToCentavos,
  parsePhysicalCountInput,
  type PendingStockMovementAttempt,
  type PosSectionView,
  removePendingMovementAttempt,
  requestPendingMovementCancel,
  requestPendingMovementStatus,
  savePendingMovementAttempts,
  type StockMovementView,
  type StorageLike,
  upsertPendingMovementAttempt,
} from "./inventoryView";

describe("inventoryView helpers", () => {
  it("parses explicit zero and positive whole container quantities while rejecting invalid inputs", () => {
    expect(parseOpeningQuantityInput("0")).toEqual({ ok: true, quantity: 0 });
    expect(parseOpeningQuantityInput(" 00 ")).toEqual({ ok: true, quantity: 0 });
    expect(parseOpeningQuantityInput("24")).toEqual({ ok: true, quantity: 24 });
    expect(parseOpeningQuantityInput(String(MAX_OPENING_QUANTITY))).toEqual({
      ok: true,
      quantity: MAX_OPENING_QUANTITY,
    });

    expect(parseOpeningQuantityInput("")).toEqual({
      ok: false,
      message: "Enter the actual container count (0 or more).",
    });
    expect(parseOpeningQuantityInput("   ")).toEqual({
      ok: false,
      message: "Enter the actual container count (0 or more).",
    });
    expect(parseOpeningQuantityInput("-1").ok).toBe(false);
    expect(parseOpeningQuantityInput("1.5").ok).toBe(false);
    expect(parseOpeningQuantityInput("12 containers").ok).toBe(false);
    expect(parseOpeningQuantityInput(String(MAX_OPENING_QUANTITY + 1)).ok).toBe(false);
  });

  it("formats Not Set separately from explicit zero and pluralizes containers", () => {
    expect(formatQuantityLabel(null, "containers")).toBe("Not Set");
    expect(formatQuantityLabel(0, "containers")).toBe("0 containers");
    expect(formatQuantityLabel(1, "containers")).toBe("1 container");
    expect(formatQuantityLabel(18, "containers")).toBe("18 containers");
  });

  it("formats timestamps in Asia/Manila regardless of local system timezone", () => {
    expect(formatRecordedAtManila("2026-11-22T09:05:00+08:00")).toBe("Nov 22, 2026 · 9:05 AM");
    expect(formatRecordedAtManila("2026-11-22T16:30:00.000Z")).toBe("Nov 23, 2026 · 12:30 AM");
    expect(formatRecordedAtManila("not-a-timestamp")).toBe("not-a-timestamp");
  });

  it("formats conflict notices with rejected quantity, saved balance, and fallback", () => {
    const slimInitialized: InventoryItemView = {
      code: "SLIM",
      name: "Slim Container",
      category: "CONTAINER",
      shape: "SLIM",
      unit: "containers",
      status: "INITIALIZED",
      currentQuantity: 14,
      openingStock: {
        quantity: 14,
        unit: "containers",
        recordedBy: "owner_a",
        recordedAt: "2026-11-22T14:30:00+08:00",
      },
    };
    expect(
      formatAlreadySetNotice(
        "Slim Container",
        22,
        "containers",
        slimInitialized,
        "Opening stock for Slim Container is already set.",
      ),
    ).toBe(
      "Your entry of 22 containers was not saved. Opening stock for Slim Container is already set to 14 containers (recorded by owner_a).",
    );

    const roundZero: InventoryItemView = {
      code: "ROUND",
      name: "Round Container",
      category: "CONTAINER",
      shape: "ROUND",
      unit: "containers",
      status: "INITIALIZED",
      currentQuantity: 0,
      openingStock: {
        quantity: 0,
        unit: "containers",
        recordedBy: "owner_a",
        recordedAt: "2026-11-22T14:30:00+08:00",
      },
    };
    expect(
      formatAlreadySetNotice(
        "Round Container",
        1,
        "containers",
        roundZero,
        "Opening stock for Round Container is already set.",
      ),
    ).toBe(
      "Your entry of 1 container was not saved. Opening stock for Round Container is already set to 0 containers (recorded by owner_a).",
    );

    expect(
      formatAlreadySetNotice(
        "Slim Container",
        22,
        "containers",
        null,
        "Opening stock for Slim Container is already set.",
      ),
    ).toBe("Opening stock for Slim Container is already set.");
  });

  it("maps status metadata and counts for Not Set, No Stock, and In Stock states", () => {
    const unsetItem: InventoryItemView = {
      code: "ROUND",
      name: "Round Container",
      category: "CONTAINER",
      shape: "ROUND",
      unit: "containers",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    };
    const zeroItem: InventoryItemView = {
      code: "SLIM",
      name: "Slim Container",
      category: "CONTAINER",
      shape: "SLIM",
      unit: "containers",
      status: "INITIALIZED",
      currentQuantity: 0,
      openingStock: {
        quantity: 0,
        unit: "containers",
        recordedBy: "owner_a",
        recordedAt: "2026-11-22T14:30:00+08:00",
      },
    };
    const positiveItem: InventoryItemView = {
      ...zeroItem,
      currentQuantity: 25,
      openingStock: {
        quantity: 25,
        unit: "containers",
        recordedBy: "owner_a",
        recordedAt: "2026-11-22T14:30:00+08:00",
      },
    };

    expect(getStockStatusMeta(unsetItem)).toEqual({ tone: "unset", label: "Not Set" });
    expect(getStockStatusMeta(zeroItem)).toEqual({ tone: "out", label: "No Stock" });
    expect(getStockStatusMeta(positiveItem)).toEqual({ tone: "in", label: "In Stock" });

    expect(getInventorySummaryCounts([unsetItem, zeroItem, positiveItem])).toEqual({
      total: 3,
      notSet: 1,
      noStock: 1,
      inStock: 1,
    });
  });

  it("provides container subtitles and category filtering", () => {
    const items: InventoryItemView[] = [
      {
        code: "ROUND",
        name: "Round Container",
        category: "CONTAINER",
        shape: "ROUND",
        unit: "containers",
        status: "NOT_SET",
        currentQuantity: null,
        openingStock: null,
      },
      {
        code: "SLIM",
        name: "Slim Container",
        category: "CONTAINER",
        shape: "SLIM",
        unit: "containers",
        status: "NOT_SET",
        currentQuantity: null,
        openingStock: null,
      },
    ];

    expect(getContainerSubtitle("ROUND")).toBe("Round water container");
    expect(getContainerSubtitle("SLIM")).toBe("Slim water container");
    expect(filterInventoryItems(items, "ALL")).toHaveLength(2);
    expect(filterInventoryItems(items, "CONTAINER")).toHaveLength(2);
  });

  it("derives Inventory load phases for initial loading, initial error, ready, and refresh error", () => {
    expect(getInventoryLoadPhase({ hasLoaded: false, loading: true, loadError: null })).toBe("initial-loading");
    expect(getInventoryLoadPhase({ hasLoaded: false, loading: false, loadError: null })).toBe("initial-loading");
    expect(
      getInventoryLoadPhase({ hasLoaded: false, loading: false, loadError: "Inventory temporarily unavailable." }),
    ).toBe("initial-error");
    expect(getInventoryLoadPhase({ hasLoaded: true, loading: false, loadError: null })).toBe("ready");
    expect(getInventoryLoadPhase({ hasLoaded: true, loading: true, loadError: null })).toBe("ready");
    expect(
      getInventoryLoadPhase({ hasLoaded: true, loading: true, loadError: "Inventory temporarily unavailable." }),
    ).toBe("ready");
    expect(
      getInventoryLoadPhase({ hasLoaded: true, loading: false, loadError: "Inventory temporarily unavailable." }),
    ).toBe("refresh-error");
  });

  it("formats concise opening-count submit button labels", () => {
    expect(getOpeningSubmitLabel("ROUND", false)).toBe("Save Round Opening Count");
    expect(getOpeningSubmitLabel("SLIM", false)).toBe("Save Slim Opening Count");
    expect(getOpeningSubmitLabel("ROUND", true)).toBe("Saving opening count…");
    expect(getOpeningSubmitLabel("SLIM", true)).toBe("Saving opening count…");
  });

  it("merges refreshed items monotonically without reverting confirmed opening counts", () => {
    const roundNotSet: InventoryItemView = {
      code: "ROUND",
      name: "Round Container",
      category: "CONTAINER",
      shape: "ROUND",
      unit: "containers",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    };
    const slimNotSet: InventoryItemView = {
      code: "SLIM",
      name: "Slim Container",
      category: "CONTAINER",
      shape: "SLIM",
      unit: "containers",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    };
    const roundZero: InventoryItemView = {
      ...roundNotSet,
      status: "INITIALIZED",
      currentQuantity: 0,
      openingStock: {
        quantity: 0,
        unit: "containers",
        recordedBy: "owner-a",
        recordedAt: "2026-11-22T14:30:00+08:00",
      },
    };
    const slimInitialized: InventoryItemView = {
      ...slimNotSet,
      status: "INITIALIZED",
      currentQuantity: 14,
      openingStock: {
        quantity: 14,
        unit: "containers",
        recordedBy: "owner-a",
        recordedAt: "2026-11-22T14:31:00+08:00",
      },
    };

    expect(mergeRefreshedInventoryItems([], [roundNotSet, slimNotSet])).toEqual([roundNotSet, slimNotSet]);
    expect(mergeRefreshedInventoryItems([roundNotSet, slimNotSet], [roundZero, slimInitialized])).toEqual([
      roundZero,
      slimInitialized,
    ]);
    expect(mergeRefreshedInventoryItems([roundZero, slimNotSet], [roundNotSet, slimInitialized])).toEqual([
      roundZero,
      slimInitialized,
    ]);
    expect(mergeRefreshedInventoryItems([roundZero, slimInitialized], [roundNotSet, slimNotSet])).toEqual([
      roundZero,
      slimInitialized,
    ]);
  });

  it("parses and formats peso prices, groups merchandise by POS section, and merges merchandise by id", () => {
    expect(parsePesoPriceToCentavos("40")).toBe(4000);
    expect(parsePesoPriceToCentavos("₱15.50")).toBe(1550);
    expect(parsePesoPriceToCentavos("0")).toBeNull();
    expect(parsePesoPriceToCentavos("-5")).toBeNull();
    expect(parsePesoPriceToCentavos("12.345")).toBeNull();
    expect(formatPesoCentavos(4000)).toBe("₱40.00");
    expect(formatPesoCentavos(1550)).toBe("₱15.50");

    expect(getPosSectionLabel("CHANGE_OF_GRIPO")).toBe("Change of Gripo");
    expect(getPosSectionLabel("TAKIP_ACCESSORIES")).toBe("Takip Types / Accessories");

    const round: InventoryItemView = {
      id: "id-round",
      code: "ROUND",
      name: "Round Container",
      category: "CONTAINER",
      shape: "ROUND",
      unit: "containers",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    };
    const faucetNotSet: InventoryItemView = {
      id: "id-faucet",
      code: "MERCH-1",
      name: "Push-Type Faucet",
      category: "MERCHANDISE",
      shape: null,
      unit: "pcs",
      unitPriceCentavos: 4000,
      showInPos: true,
      posSection: "CHANGE_OF_GRIPO",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    };
    const faucetInitialized: InventoryItemView = {
      ...faucetNotSet,
      status: "INITIALIZED",
      currentQuantity: 10,
      openingStock: {
        quantity: 10,
        unit: "pcs",
        recordedBy: "owner1",
        recordedAt: "2026-11-22T09:00:00+08:00",
      },
    };
    const divider: InventoryItemView = {
      id: "id-divider",
      code: "MERCH-2",
      name: "Divider",
      category: "MERCHANDISE",
      shape: null,
      unit: "pcs",
      unitPriceCentavos: 1500,
      showInPos: false,
      posSection: "TAKIP_ACCESSORIES",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    };

    const groups = groupInventoryItems([round, faucetInitialized, divider], "ALL");
    expect(groups.map((g) => g.title)).toEqual([
      "Containers",
      "Takip Types / Accessories",
      "Change of Gripo",
    ]);
    expect(filterInventoryItems([round, faucetInitialized, divider], "CHANGE_OF_GRIPO")).toEqual([
      faucetInitialized,
    ]);
    expect(getOpeningSubmitLabel(faucetNotSet, false)).toBe("Save Opening Count");
    expect(mergeRefreshedInventoryItems([faucetInitialized], [faucetNotSet])).toEqual([
      faucetInitialized,
    ]);
  });

  it("supports custom POS sections, container package summaries, physical-count previews, and revision-safe refreshes", () => {
    expect(getContainerPackageSummary("ROUND")).toContain("Empty ₱175");
    expect(getContainerPackageSummary("SLIM")).toContain("Empty ₱200");

    const customSections: PosSectionView[] = [
      ...DEFAULT_POS_SECTIONS,
      { code: "CUSTOM_CLEANING", name: "Cleaning Supplies", isBuiltIn: false, sortOrder: 100 },
    ];
    expect(getPosSectionLabel("CUSTOM_CLEANING", customSections)).toBe("Cleaning Supplies");

    const sponge: InventoryItemView = {
      id: "id-sponge",
      code: "MERCH-3",
      name: "Bottle Brush",
      category: "MERCHANDISE",
      shape: null,
      unit: "pcs",
      unitPriceCentavos: 6500,
      showInPos: true,
      posSection: "CUSTOM_CLEANING",
      status: "INITIALIZED",
      currentQuantity: 50,
      stockRevision: 2,
      openingStock: {
        quantity: 50,
        unit: "pcs",
        recordedBy: "owner1",
        recordedAt: "2026-11-22T09:00:00+08:00",
      },
    };
    const groups = groupInventoryItems([sponge], "ALL", customSections);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "CUSTOM_CLEANING",
      title: "Cleaning Supplies",
      metaPrefix: "Custom POS section",
    });

    expect(computeReconciliationPreview(50, 5)).toEqual({
      before: 50,
      physicalCount: 5,
      delta: -45,
      after: 5,
    });
    expect(formatSignedDelta(-45, "pcs")).toBe("−45 pcs");
    expect(formatSignedDelta(4, "containers")).toBe("+4 containers");
    expect(formatSignedDelta(0, "pcs")).toBe("0 pcs (Verified match)");

    const staleSponge: InventoryItemView = {
      ...sponge,
      currentQuantity: 60,
      stockRevision: 1,
    };
    expect(mergeRefreshedInventoryItems([sponge], [staleSponge])).toEqual([sponge]);
  });

  it("parses optional low stock alert levels and formats faucet reporting type labels", () => {
    expect(parseLowStockLevelInput("", "pcs")).toEqual({ ok: true, value: null });
    expect(parseLowStockLevelInput("   ", "containers")).toEqual({ ok: true, value: null });
    expect(parseLowStockLevelInput("5", "containers")).toEqual({ ok: true, value: 5 });
    expect(parseLowStockLevelInput(String(MAX_OPENING_QUANTITY), "pcs")).toEqual({
      ok: true,
      value: MAX_OPENING_QUANTITY,
    });
    expect(parseLowStockLevelInput("0", "pcs").ok).toBe(false);
    expect(parseLowStockLevelInput("-3", "pcs").ok).toBe(false);
    expect(parseLowStockLevelInput("2.5", "pcs").ok).toBe(false);
    expect(parseLowStockLevelInput("abc", "pcs").ok).toBe(false);
    expect(parseLowStockLevelInput(String(MAX_OPENING_QUANTITY + 1), "pcs").ok).toBe(false);

    expect(formatFaucetReportingTypeLabel("PUSH_TYPE")).toBe("Push-Type Faucet");
    expect(formatFaucetReportingTypeLabel("TWIST_TYPE")).toBe("Twist-Type Faucet");
    expect(formatFaucetReportingTypeLabel(null)).toBe("Not classified");
  });

  it("supports decimal supply inputs, negative discrepancy badges, and Operating Supplies grouping", () => {
    expect(parseOpeningQuantityInput("1.25", "L", true)).toEqual({ ok: true, quantity: 1.25 });
    expect(parseOpeningQuantityInput("1.25", "pcs", false).ok).toBe(false);
    expect(parseOpeningQuantityInput("1.12345", "L", true).ok).toBe(false);
    expect(parsePhysicalCountInput("0.5", "kg", true)).toEqual({ ok: true, quantity: 0.5 });
    expect(parseMovementQuantityInput("0", "L", true).ok).toBe(false);
    expect(parseMovementQuantityInput("1.5", "L", true)).toEqual({ ok: true, quantity: 1.5 });
    expect(parseMovementQuantityInput("1.5", "pcs", false).ok).toBe(false);
    expect(parseLowStockLevelInput("0.5", "L", true)).toEqual({ ok: true, value: 0.5 });

    expect(formatQuantityLabel(-0.25, "L")).toBe("−0.25 L");
    expect(formatSignedDelta(-0.25, "L")).toBe("−0.25 L");
    expect(computeReconciliationPreview(-0.25, 2)).toEqual({
      before: -0.25,
      physicalCount: 2,
      delta: 2.25,
      after: 2,
    });

    const flaggedSupply: InventoryItemView = {
      id: "supply-1",
      code: "SUPPLY-1",
      name: "Dishwashing Liquid",
      category: "OPERATING_SUPPLY",
      shape: null,
      unit: "L",
      allowDecimalQuantity: true,
      needsReconciliation: true,
      lowStockLevel: 0.5,
      status: "INITIALIZED",
      currentQuantity: -0.25,
      openingStock: {
        quantity: 1.25,
        unit: "L",
        recordedBy: "owner1",
        recordedAt: "2026-11-27T09:00:00+08:00",
      },
    };
    expect(getStockStatusMeta(flaggedSupply)).toEqual({
      tone: "discrepancy",
      label: "Needs Reconciliation",
    });

    const lowSupply: InventoryItemView = {
      ...flaggedSupply,
      needsReconciliation: false,
      currentQuantity: 0.5,
    };
    expect(getStockStatusMeta(lowSupply)).toEqual({
      tone: "low",
      label: "Low Stock",
    });

    const groups = groupInventoryItems([flaggedSupply], "ALL");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "OPERATING_SUPPLY",
      title: "Operating Supplies",
      metaPrefix: "Station supplies",
    });
    expect(filterInventoryItems([flaggedSupply], "OPERATING_SUPPLY")).toEqual([flaggedSupply]);

    // Finding 1 helper: network/5xx errors are uncertain (preserve requestKey & effectiveDate), 4xx are definitive.
    expect(isUncertainSubmissionError({ status: 0, code: "NETWORK_ERROR" })).toBe(true);
    expect(isUncertainSubmissionError({ status: 503, code: "HTTP_ERROR" })).toBe(true);
    expect(isUncertainSubmissionError(new Error("timeout"))).toBe(true);
    expect(isUncertainSubmissionError({ status: 400, code: "VALIDATION_FAILED" })).toBe(false);
    expect(isUncertainSubmissionError({ status: 409, code: "STALE_STOCK_BALANCE" })).toBe(false);
  });

  it("persists unresolved movement attempts per account across reloads and isolates accounts", () => {
    const store = new Map<string, string>();
    const memoryStorage: StorageLike = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    };

    const empAttempt: PendingStockMovementAttempt = {
      movementType: "STOCK_USED",
      itemKey: "supply-1",
      itemName: "Dishwashing Liquid",
      unit: "L",
      quantityInput: "1.5",
      noteOrPurposeInput: "Evening wash",
      effectiveDate: "2026-11-27",
      requestKey: "req-emp-1",
      expectedRevision: 3,
      expectedCurrentQuantity: 10,
    };
    const ownerAttempt: PendingStockMovementAttempt = {
      movementType: "STOCK_RECEIVED",
      itemKey: "supply-1",
      itemName: "Dishwashing Liquid",
      unit: "L",
      quantityInput: "5",
      noteOrPurposeInput: "Delivery",
      effectiveDate: "2026-11-27",
      requestKey: "req-owner-1",
      expectedRevision: 3,
      expectedCurrentQuantity: 10,
    };

    const empList = upsertPendingMovementAttempt([], empAttempt);
    savePendingMovementAttempts("emp1", empList, memoryStorage);
    savePendingMovementAttempts("owner1", [ownerAttempt], memoryStorage);

    // Reloading reads back the exact persisted attempt and requestKey for that account only.
    expect(loadPendingMovementAttempts("emp1", memoryStorage)).toEqual([empAttempt]);
    expect(loadPendingMovementAttempts("owner1", memoryStorage)).toEqual([ownerAttempt]);

    // Clearing emp1's resolved attempt leaves owner1's attempt untouched.
    const clearedEmp = removePendingMovementAttempt(empList, "STOCK_USED", "supply-1");
    savePendingMovementAttempts("emp1", clearedEmp, memoryStorage);
    expect(loadPendingMovementAttempts("emp1", memoryStorage)).toEqual([]);
    expect(loadPendingMovementAttempts("owner1", memoryStorage)).toEqual([ownerAttempt]);
  });

  it("Finding 1: preserves original reference unless SAVED response includes required fields and matches pending attempt", async () => {
    const store = new Map<string, string>();
    const memoryStorage: StorageLike = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    };

    const empAttempt: PendingStockMovementAttempt = {
      movementType: "STOCK_USED",
      itemKey: "supply-1",
      itemName: "Dishwashing Liquid",
      unit: "L",
      quantityInput: "1",
      noteOrPurposeInput: "Bottle rinse",
      effectiveDate: "2026-11-27",
      requestKey: "cancel-truncate-1",
      expectedRevision: 2,
      expectedCurrentQuantity: 10,
    };
    const otherAttempt: PendingStockMovementAttempt = {
      movementType: "STOCK_USED",
      itemKey: "supply-2",
      itemName: "Sanitizer",
      unit: "L",
      quantityInput: "1",
      noteOrPurposeInput: "Bottle rinse",
      effectiveDate: "2026-11-27",
      requestKey: "unsaved-other-key",
      expectedRevision: 1,
      expectedCurrentQuantity: 5,
    };
    savePendingMovementAttempts("emp1", upsertPendingMovementAttempt([], empAttempt), memoryStorage);

    const savedItem: InventoryItemView = {
      id: "supply-1",
      code: "SUPPLY-1",
      name: "Dishwashing Liquid",
      category: "OPERATING_SUPPLY",
      shape: null,
      unit: "L",
      allowDecimalQuantity: true,
      status: "INITIALIZED",
      currentQuantity: 9,
      stockRevision: 3,
      openingStock: {
        quantity: 10,
        unit: "L",
        recordedBy: "owner1",
        recordedAt: "2026-11-27T08:00:00+08:00",
      },
    };
    const savedMovement: StockMovementView = {
      id: "mov-1",
      itemId: "supply-1",
      movementType: "STOCK_USED",
      quantity: 1,
      quantityDelta: -1,
      balanceBefore: 10,
      balanceAfter: 9,
      unit: "L",
      effectiveDate: "2026-11-27",
      note: "Bottle rinse",
      recordedBy: "emp1",
      recordedAt: "2026-11-27T09:05:00+08:00",
    };

    // Malformed minimal SAVED payload (like Sol's reproduction omitting item.id, currentQuantity, openingStock, movement.itemId).
    const malformedMinimalSaved = {
      status: "SAVED",
      item: { code: "SUPPLY-1", name: "Dishwashing Liquid", unit: "L", status: "INITIALIZED" },
      movement: { id: "mov-1", movementType: "STOCK_USED", quantity: 1, unit: "L" },
    };
    const missingMovementBalanceSaved = {
      status: "SAVED",
      item: savedItem,
      movement: {
        id: "mov-1",
        itemId: "supply-1",
        movementType: "STOCK_USED",
        quantity: 1,
        quantityDelta: -1,
        unit: "L",
        effectiveDate: "2026-11-27",
        note: "Bottle rinse",
        recordedBy: "emp1",
        recordedAt: "2026-11-27T09:05:00+08:00",
      },
    };
    const validCompleteSaved = {
      status: "SAVED",
      item: savedItem,
      movement: savedMovement,
    };

    // Strict parser checks on both endpoints.
    expect(parsePendingMovementCancelResponse({}, empAttempt)).toEqual({ kind: "UNEXPECTED" });
    expect(parsePendingMovementCancelResponse(null, empAttempt)).toEqual({ kind: "UNEXPECTED" });
    expect(parsePendingMovementCancelResponse({ status: "NOT_FOUND" }, empAttempt)).toEqual({
      kind: "UNEXPECTED",
    });
    expect(parsePendingMovementCancelResponse({ status: "OTHER" }, empAttempt)).toEqual({
      kind: "UNEXPECTED",
    });
    expect(parsePendingMovementCancelResponse(malformedMinimalSaved, empAttempt)).toEqual({
      kind: "UNEXPECTED",
    });
    expect(parsePendingMovementCancelResponse(missingMovementBalanceSaved, empAttempt)).toEqual({
      kind: "UNEXPECTED",
    });
    expect(parsePendingMovementCancelResponse({ status: "CANCELLED" }, empAttempt)).toEqual({
      kind: "CANCELLED",
    });
    expect(parsePendingMovementStatusResponse({}, empAttempt)).toEqual({ kind: "UNEXPECTED" });
    expect(parsePendingMovementStatusResponse(malformedMinimalSaved, empAttempt)).toEqual({
      kind: "UNEXPECTED",
    });
    expect(parsePendingMovementStatusResponse(missingMovementBalanceSaved, empAttempt)).toEqual({
      kind: "UNEXPECTED",
    });
    expect(parsePendingMovementStatusResponse({ status: "NOT_FOUND" }, empAttempt)).toEqual({
      kind: "NOT_FOUND",
    });
    // Cross-item complete SAVED payload must NOT match another item's pending attempt.
    expect(parsePendingMovementStatusResponse(validCompleteSaved, otherAttempt)).toEqual({
      kind: "UNEXPECTED",
    });
    expect(parsePendingMovementCancelResponse(validCompleteSaved, otherAttempt)).toEqual({
      kind: "UNEXPECTED",
    });

    const originalFetch = globalThis.fetch;
    let mockPayload:
      | { kind: "truncated" }
      | { kind: "json"; body: unknown } = { kind: "truncated" };
    globalThis.fetch = (async () => {
      if (mockPayload.kind === "truncated") {
        return new Response('{"status":"SAVED","item":{"id":"supply-1","currentQuantity":9', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(mockPayload.body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      // 1. Truncated HTTP 200 SAVED on BOTH cancel and status endpoints returns UNEXPECTED.
      mockPayload = { kind: "truncated" };
      expect(await requestPendingMovementCancel(empAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(empAttempt)).toEqual({ kind: "UNEXPECTED" });
      expect(loadPendingMovementAttempts("emp1", memoryStorage)).toEqual([empAttempt]);

      // 2. Readable malformed/incomplete SAVED on BOTH cancel and status endpoints returns UNEXPECTED.
      mockPayload = { kind: "json", body: malformedMinimalSaved };
      expect(await requestPendingMovementCancel(empAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(empAttempt)).toEqual({ kind: "UNEXPECTED" });
      mockPayload = { kind: "json", body: missingMovementBalanceSaved };
      expect(await requestPendingMovementCancel(empAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(empAttempt)).toEqual({ kind: "UNEXPECTED" });
      expect(loadPendingMovementAttempts("emp1", memoryStorage)).toEqual([empAttempt]);

      // 3. Complete valid SAVED belonging to a different item, wrong quantity, or wrong note/date on BOTH endpoints returns UNEXPECTED.
      mockPayload = { kind: "json", body: validCompleteSaved };
      expect(await requestPendingMovementCancel(otherAttempt, "supply-2")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(otherAttempt)).toEqual({ kind: "UNEXPECTED" });

      const wrongQtyAttempt: PendingStockMovementAttempt = { ...empAttempt, quantityInput: "2" };
      expect(await requestPendingMovementCancel(wrongQtyAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(wrongQtyAttempt)).toEqual({ kind: "UNEXPECTED" });

      const wrongTypeAttempt: PendingStockMovementAttempt = {
        ...empAttempt,
        movementType: "STOCK_RECEIVED",
      };
      expect(await requestPendingMovementCancel(wrongTypeAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(wrongTypeAttempt)).toEqual({ kind: "UNEXPECTED" });

      const wrongDateAttempt: PendingStockMovementAttempt = {
        ...empAttempt,
        effectiveDate: "2026-11-26",
      };
      expect(await requestPendingMovementCancel(wrongDateAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(wrongDateAttempt)).toEqual({ kind: "UNEXPECTED" });

      const wrongNoteAttempt: PendingStockMovementAttempt = {
        ...empAttempt,
        noteOrPurposeInput: "Different purpose",
      };
      expect(await requestPendingMovementCancel(wrongNoteAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(wrongNoteAttempt)).toEqual({ kind: "UNEXPECTED" });

      // 4. Over-precision (>4 decimals) quantities, deltas, or balances on BOTH endpoints must return UNEXPECTED.
      const overPrecisionQuantityAndDelta = {
        status: "SAVED",
        item: savedItem,
        movement: {
          ...savedMovement,
          quantity: 1.00001,
          quantityDelta: -1.00001,
          balanceAfter: 8.99999,
        },
      };
      mockPayload = { kind: "json", body: overPrecisionQuantityAndDelta };
      expect(await requestPendingMovementCancel(empAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(empAttempt)).toEqual({ kind: "UNEXPECTED" });

      const overPrecisionWithRoundedBalance = {
        status: "SAVED",
        item: savedItem,
        movement: {
          ...savedMovement,
          quantity: 1.00001,
          quantityDelta: -1.00001,
          balanceAfter: 9,
        },
      };
      mockPayload = { kind: "json", body: overPrecisionWithRoundedBalance };
      expect(await requestPendingMovementCancel(empAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(empAttempt)).toEqual({ kind: "UNEXPECTED" });

      const overPrecisionDeltaOnly = {
        status: "SAVED",
        item: savedItem,
        movement: {
          ...savedMovement,
          quantity: 1,
          quantityDelta: -1.00001,
        },
      };
      mockPayload = { kind: "json", body: overPrecisionDeltaOnly };
      expect(await requestPendingMovementCancel(empAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(empAttempt)).toEqual({ kind: "UNEXPECTED" });

      const overPrecisionItemBalance = {
        status: "SAVED",
        item: {
          ...savedItem,
          currentQuantity: 9.00001,
        },
        movement: savedMovement,
      };
      mockPayload = { kind: "json", body: overPrecisionItemBalance };
      expect(await requestPendingMovementCancel(empAttempt, "supply-1")).toEqual({
        kind: "UNEXPECTED",
      });
      expect(await requestPendingMovementStatus(empAttempt)).toEqual({ kind: "UNEXPECTED" });
      expect(loadPendingMovementAttempts("emp1", memoryStorage)).toEqual([empAttempt]);

      // 5. Readable, complete, matching SAVED response recovers on BOTH endpoints.
      mockPayload = { kind: "json", body: validCompleteSaved };
      expect(await requestPendingMovementStatus(empAttempt)).toEqual({
        kind: "SAVED",
        item: savedItem,
        movement: savedMovement,
      });
      expect(await requestPendingMovementCancel(empAttempt, "supply-1")).toEqual({
        kind: "SAVED",
        item: savedItem,
        movement: savedMovement,
      });

      // Exact 4-decimal valid quantity recovers cleanly on both endpoints too.
      const exactFourDecAttempt: PendingStockMovementAttempt = {
        ...empAttempt,
        quantityInput: "1.0001",
      };
      const exactFourDecSaved = {
        status: "SAVED",
        item: { ...savedItem, currentQuantity: 8.9999 },
        movement: {
          ...savedMovement,
          quantity: 1.0001,
          quantityDelta: -1.0001,
          balanceBefore: 10,
          balanceAfter: 8.9999,
        },
      };
      mockPayload = { kind: "json", body: exactFourDecSaved };
      expect(await requestPendingMovementStatus(exactFourDecAttempt)).toEqual({
        kind: "SAVED",
        item: exactFourDecSaved.item,
        movement: exactFourDecSaved.movement,
      });
      expect(await requestPendingMovementCancel(exactFourDecAttempt, "supply-1")).toEqual({
        kind: "SAVED",
        item: exactFourDecSaved.item,
        movement: exactFourDecSaved.movement,
      });

      // Task 2: PENDING_REVIEW and FULL-coverage zero-delta movements match when delta is 0.
      const pendingSaved = {
        status: "SAVED",
        item: { ...savedItem, currentQuantity: 10 },
        movement: {
          ...savedMovement,
          entryStatus: "PENDING_REVIEW",
          coverageMode: "UNCLEAR",
          quantity: 1,
          quantityDelta: 0,
          balanceBefore: 10,
          balanceAfter: 10,
        },
      };
      mockPayload = { kind: "json", body: pendingSaved };
      expect(await requestPendingMovementStatus(empAttempt)).toEqual({
        kind: "SAVED",
        item: pendingSaved.item,
        movement: pendingSaved.movement,
      });
      expect(await requestPendingMovementCancel(empAttempt, "supply-1")).toEqual({
        kind: "SAVED",
        item: pendingSaved.item,
        movement: pendingSaved.movement,
      });

      // Task 2: PARTIAL coverage (entered 5, covered 2 -> +3 delta) matches cleanly.
      const ownerRecvAttempt: PendingStockMovementAttempt = {
        ...empAttempt,
        movementType: "STOCK_RECEIVED",
        quantityInput: "5",
      };
      const partialSaved = {
        status: "SAVED",
        item: { ...savedItem, currentQuantity: 13 },
        movement: {
          ...savedMovement,
          movementType: "STOCK_RECEIVED",
          entryStatus: "APPLIED",
          coverageMode: "PARTIAL",
          quantity: 5,
          coveredQuantity: 2,
          quantityDelta: 3,
          balanceBefore: 10,
          balanceAfter: 13,
        },
      };
      mockPayload = { kind: "json", body: partialSaved };
      expect(await requestPendingMovementStatus(ownerRecvAttempt)).toEqual({
        kind: "SAVED",
        item: partialSaved.item,
        movement: partialSaved.movement,
      });

      // Task 2 Finding 2 regression: Employee OPERATING_SUPPLY SAVED payloads redact openingStock to null,
      // while still rejecting missing/null openingStock on initialized CONTAINER/MERCHANDISE items.
      const redactedEmployeeSaved = {
        status: "SAVED",
        item: {
          ...savedItem,
          currentQuantity: 9,
          openingStock: null,
        },
        movement: {
          ...savedMovement,
          quantity: 1,
          quantityDelta: -1,
          balanceBefore: 10,
          balanceAfter: 9,
        },
      };
      mockPayload = { kind: "json", body: redactedEmployeeSaved };
      expect(await requestPendingMovementStatus(empAttempt)).toEqual({
        kind: "SAVED",
        item: redactedEmployeeSaved.item,
        movement: redactedEmployeeSaved.movement,
      });
      expect(await requestPendingMovementCancel(empAttempt, "supply-1")).toEqual({
        kind: "SAVED",
        item: redactedEmployeeSaved.item,
        movement: redactedEmployeeSaved.movement,
      });

      expect(
        isValidSavedMovementItemPayload({
          ...savedItem,
          category: "CONTAINER",
          openingStock: null,
        }),
      ).toBe(false);
      expect(
        isValidSavedMovementItemPayload({
          ...savedItem,
          openingStock: { quantity: 10 },
        }),
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refreshes initialized operating supplies whose openingStock is redacted for Employee", () => {
    const existingSupply: InventoryItemView = {
      id: "supply-1",
      code: "SALT",
      name: "Industrial Salt",
      category: "OPERATING_SUPPLY",
      shape: null,
      unit: "kg",
      allowDecimalQuantity: true,
      status: "INITIALIZED",
      currentQuantity: 10,
      stockRevision: 1,
      openingStock: null,
      latestReconciliation: null,
      needsReconciliation: false,
    };
    const refreshedSupply: InventoryItemView = {
      ...existingSupply,
      currentQuantity: 8.5,
      stockRevision: 2,
    };
    expect(mergeRefreshedInventoryItems([existingSupply], [refreshedSupply])).toEqual([
      refreshedSupply,
    ]);
  });

  it("computes exact late-entry count coverage previews for receiving and usage (Task 2)", () => {
    // Late receipt of 5 with 2 covered adds 3 (balance 9 -> 12).
    expect(
      computeLateCoveragePreview({
        movementType: "STOCK_RECEIVED",
        currentQuantity: 9,
        enteredQuantity: 5,
        coverageMode: "PARTIAL",
        coveredQuantity: 2,
      }),
    ).toEqual({
      enteredQuantity: 5,
      coveredQuantity: 2,
      uncoveredQuantity: 3,
      signedDelta: 3,
      projectedBalance: 12,
      pendingReview: false,
    });

    // Full coverage leaves zero stock effect.
    expect(
      computeLateCoveragePreview({
        movementType: "STOCK_USED",
        currentQuantity: 8,
        enteredQuantity: 2,
        coverageMode: "FULL",
        coveredQuantity: 2,
      }),
    ).toEqual({
      enteredQuantity: 2,
      coveredQuantity: 2,
      uncoveredQuantity: 0,
      signedDelta: 0,
      projectedBalance: 8,
      pendingReview: false,
    });

    // Unclear marks pending review with zero stock change.
    expect(
      computeLateCoveragePreview({
        movementType: "STOCK_USED",
        currentQuantity: 8,
        enteredQuantity: 3,
        coverageMode: "UNCLEAR",
      }),
    ).toEqual({
      enteredQuantity: 3,
      coveredQuantity: 0,
      uncoveredQuantity: 0,
      signedDelta: 0,
      projectedBalance: 8,
      pendingReview: true,
    });

    // Partial with invalid or >= entered covered quantity returns null.
    expect(
      computeLateCoveragePreview({
        movementType: "STOCK_RECEIVED",
        currentQuantity: 9,
        enteredQuantity: 5,
        coverageMode: "PARTIAL",
        coveredQuantity: 5,
      }),
    ).toBeNull();
  });
});
