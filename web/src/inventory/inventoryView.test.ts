import { describe, expect, it } from "vitest";
import {
  computeReconciliationPreview,
  DEFAULT_POS_SECTIONS,
  filterInventoryItems,
  formatAlreadySetNotice,
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
  MAX_OPENING_QUANTITY,
  mergeRefreshedInventoryItems,
  parseOpeningQuantityInput,
  parsePesoPriceToCentavos,
  type PosSectionView,
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
});
