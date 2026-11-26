import { describe, expect, it } from "vitest";
import type { ReminderItem } from "../calendar/calendarView";
import type { InventoryItemView, PosSectionView } from "../inventory/inventoryView";
import {
  buildStocksSnapshot,
  describeTrendLeader,
  formatComparisonChangeSummary,
  formatDashboardPeso,
  formatDashboardPesoCompact,
  formatManilaDateRange,
  formatStockMovementTypeLabel,
  formatWaterLiters,
  sortStationReminders,
  validateCustomRange,
} from "./dashboardView";

function makeItem(overrides: Partial<InventoryItemView> & Pick<InventoryItemView, "code" | "name">): InventoryItemView {
  return {
    category: "MERCHANDISE",
    shape: null,
    unit: "pcs",
    unitPriceCentavos: 2000,
    showInPos: true,
    posSection: "TAKIP_ACCESSORIES",
    status: "INITIALIZED",
    currentQuantity: 10,
    openingStock: {
      quantity: 10,
      unit: "pcs",
      recordedBy: "owner1",
      recordedAt: "2026-11-22T09:00:00+08:00",
    },
    archivedAt: null,
    ...overrides,
  };
}

describe("dashboardView helpers", () => {
  it("formats peso amounts, water liters, and Manila date ranges cleanly", () => {
    expect(formatDashboardPeso(2450000)).toBe("₱24,500.00");
    expect(formatDashboardPesoCompact(2450000)).toBe("₱24,500");
    expect(formatDashboardPesoCompact(21550)).toBe("₱215.50");
    expect(formatWaterLiters(33000)).toBe("33 L");
    expect(formatWaterLiters(22500000)).toBe("22,500 L");
    expect(formatWaterLiters(1250)).toBe("1.25 L");
    expect(formatWaterLiters(0)).toBe("0 L");

    expect(formatManilaDateRange("2026-11-09", "2026-11-09")).toBe("Nov 9, 2026");
    expect(formatManilaDateRange("2026-11-03", "2026-11-09")).toBe("Nov 3 – 9, 2026");
    expect(formatManilaDateRange("2026-10-28", "2026-11-03")).toBe("Oct 28 – Nov 3, 2026");
    expect(formatManilaDateRange("2025-12-30", "2026-01-03")).toBe("Dec 30, 2025 – Jan 3, 2026");
  });

  it("validates custom date ranges against empty, reversed, future, and excessive spans", () => {
    expect(validateCustomRange("", "2026-11-10", "2026-11-15")).toBe("Select both From and To dates.");
    expect(validateCustomRange("2026-11-15", "2026-11-10", "2026-11-15")).toBe(
      "From date cannot be after To date.",
    );
    expect(validateCustomRange("2026-11-10", "2026-11-16", "2026-11-15")).toBe(
      "Future dates cannot be selected.",
    );
    expect(validateCustomRange("2025-10-01", "2026-11-15", "2026-11-15")).toBe(
      "Custom range cannot exceed 366 days.",
    );
    expect(validateCustomRange("2026-11-09", "2026-11-15", "2026-11-15")).toBeNull();
  });

  it("describes trend leaders, fair ties, zero days, and unrecorded ranges", () => {
    expect(
      describeTrendLeader([
        {
          businessDate: "2026-11-09",
          hasBusinessDay: false,
          dayStatus: "NO_RECORD",
          salesCentavos: null,
          transactions: null,
        },
      ]),
    ).toBe("No station business days were recorded in this date range.");

    expect(
      describeTrendLeader([
        {
          businessDate: "2026-11-09",
          hasBusinessDay: true,
          dayStatus: "CLOSED",
          salesCentavos: 0,
          transactions: 0,
        },
        {
          businessDate: "2026-11-10",
          hasBusinessDay: false,
          dayStatus: "NO_RECORD",
          salesCentavos: null,
          transactions: null,
        },
      ]),
    ).toBe("Mon, Nov 9, 2026 recorded ₱0 in sales.");

    expect(
      describeTrendLeader([
        {
          businessDate: "2026-11-13",
          hasBusinessDay: true,
          dayStatus: "CLOSED",
          salesCentavos: 410000,
          transactions: 12,
        },
        {
          businessDate: "2026-11-14",
          hasBusinessDay: true,
          dayStatus: "CLOSED",
          salesCentavos: 410000,
          transactions: 15,
        },
      ]),
    ).toBe("2 days tied for peak daily sales at ₱4,100.");

    expect(
      describeTrendLeader([
        {
          businessDate: "2026-11-14",
          hasBusinessDay: true,
          dayStatus: "CLOSED",
          salesCentavos: 410000,
          transactions: 15,
        },
      ]),
    ).toBe("Saturday (November 14) led with ₱4,100 in sales.");
  });

  it("sorts Station Reminders with overdue items strictly before upcoming items", () => {
    const reminders: ReminderItem[] = [
      {
        reference: "ACT-1124-01",
        name: "Water quality check",
        scheduledAt: "2026-11-24T09:00:00+08:00",
        scheduledDate: "2026-11-24",
        scheduledTime: "09:00",
        scheduleNotes: null,
        status: "UPCOMING",
      },
      {
        reference: "ACT-1120-02",
        name: "Filter housing cleaning",
        scheduledAt: "2026-11-20T16:00:00+08:00",
        scheduledDate: "2026-11-20",
        scheduledTime: "16:00",
        scheduleNotes: null,
        status: "OVERDUE",
      },
      {
        reference: "ACT-1119-01",
        name: "Tank flushing",
        scheduledAt: "2026-11-19T10:00:00+08:00",
        scheduledDate: "2026-11-19",
        scheduledTime: "10:00",
        scheduleNotes: null,
        status: "OVERDUE",
      },
    ];
    expect(sortStationReminders(reminders).map((r) => r.reference)).toEqual([
      "ACT-1119-01",
      "ACT-1120-02",
      "ACT-1124-01",
    ]);
  });

  it("builds Stocks snapshot keeping units separate, counting Round/Slim once, including hidden active items, excluding archived items, and preserving negative balances", () => {
    const sections: PosSectionView[] = [
      { code: "CONTAINERS", name: "Containers", isBuiltIn: true, sortOrder: 10 },
      { code: "TAKIP_ACCESSORIES", name: "Takip Types / Accessories", isBuiltIn: true, sortOrder: 20 },
      { code: "CHANGE_OF_GRIPO", name: "Change of Gripo", isBuiltIn: true, sortOrder: 30 },
      { code: "CUSTOM_SUPPLIES", name: "Station Supplies", isBuiltIn: false, sortOrder: 100 },
    ];

    const round = makeItem({
      id: "id-round",
      code: "ROUND_CONTAINER",
      name: "Round Container",
      category: "CONTAINER",
      shape: "ROUND",
      unit: "containers",
      unitPriceCentavos: null,
      posSection: "CONTAINERS",
      status: "INITIALIZED",
      currentQuantity: 0,
      openingStock: {
        quantity: 0,
        unit: "containers",
        recordedBy: "owner1",
        recordedAt: "2026-11-22T09:00:00+08:00",
      },
    });
    const slim = makeItem({
      id: "id-slim",
      code: "SLIM_CONTAINER",
      name: "Slim Container",
      category: "CONTAINER",
      shape: "SLIM",
      unit: "containers",
      unitPriceCentavos: null,
      posSection: "CONTAINERS",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    });
    const hiddenBrush = makeItem({
      id: "id-brush",
      code: "BOTTLE_BRUSH",
      name: "Bottle Brush",
      unit: "pcs",
      showInPos: false,
      posSection: null,
      currentQuantity: 3,
    });
    const salt = makeItem({
      id: "id-salt",
      code: "WATER_SALT",
      name: "Purifying Salt",
      unit: "sacks",
      showInPos: false,
      posSection: "CUSTOM_SUPPLIES",
      currentQuantity: 5,
    });
    const negativeSupply = makeItem({
      id: "id-soap",
      code: "DISHWASH_SOAP",
      name: "Dishwashing Liquid",
      unit: "gallons",
      showInPos: false,
      posSection: "CUSTOM_SUPPLIES",
      currentQuantity: -2,
    });
    const archivedItem = makeItem({
      id: "id-archived",
      code: "OLD_CAP",
      name: "Discontinued Cap",
      unit: "pcs",
      currentQuantity: 99,
      archivedAt: "2026-11-22T10:00:00+08:00",
    });

    // Pass a duplicate reference to slim to verify single-count deduplication by key
    const snapshot = buildStocksSnapshot(
      [round, slim, slim, hiddenBrush, salt, negativeSupply, archivedItem],
      sections,
    );

    expect(snapshot.counts).toEqual({
      totalProducts: 5,
      inStock: 2,
      outOfStock: 1,
      notSet: 1,
      needsReconciliation: 1,
    });

    expect(snapshot.overviewGroups.map((g) => ({ key: g.key, productCount: g.productCount }))).toEqual([
      { key: "CONTAINER", productCount: 2 },
      { key: "CUSTOM_SUPPLIES", productCount: 2 },
      { key: "OTHER", productCount: 1 },
    ]);

    // Units stay strictly separate (containers, sacks, gallons, pcs never summed)
    expect(
      snapshot.categoryUnits.map((u) => ({
        groupKey: u.groupKey,
        unit: u.unit,
        totalQuantity: u.totalQuantity,
        unsetCount: u.unsetCount,
        hasNegative: u.hasNegative,
      })),
    ).toEqual([
      { groupKey: "CONTAINER", unit: "containers", totalQuantity: 0, unsetCount: 1, hasNegative: false },
      { groupKey: "CUSTOM_SUPPLIES", unit: "sacks", totalQuantity: 5, unsetCount: 0, hasNegative: false },
      { groupKey: "CUSTOM_SUPPLIES", unit: "gallons", totalQuantity: -2, unsetCount: 0, hasNegative: true },
      { groupKey: "OTHER", unit: "pcs", totalQuantity: 3, unsetCount: 0, hasNegative: false },
    ]);

    expect(snapshot.alerts.map((a) => ({ productName: a.productName, severity: a.severity, quantity: a.quantity }))).toEqual([
      { productName: "Dishwashing Liquid", severity: "NEEDS_RECONCILIATION", quantity: -2 },
      { productName: "Round Container", severity: "OUT_OF_STOCK", quantity: 0 },
      { productName: "Slim Container", severity: "NOT_SET", quantity: null },
    ]);
  });

  it("derives Low Stock alerts for positive initialized quantities at or below lowStockLevel while keeping them in In Stock (DEC-090)", () => {
    const level = 5;
    const above = makeItem({ id: "a6", code: "A6", name: "Item Six", currentQuantity: 6, lowStockLevel: level });
    const atLevel = makeItem({ id: "a5", code: "A5", name: "Item Five", currentQuantity: 5, lowStockLevel: level });
    const oneLeft = makeItem({ id: "a1", code: "A1", name: "Item One", currentQuantity: 1, lowStockLevel: level });
    const zeroLeft = makeItem({ id: "a0", code: "A0", name: "Item Zero", currentQuantity: 0, lowStockLevel: level });
    const notSet = makeItem({
      id: "anull",
      code: "ANULL",
      name: "Item Unset",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
      lowStockLevel: level,
    });

    const snapshot = buildStocksSnapshot([above, atLevel, oneLeft, zeroLeft, notSet]);
    expect(snapshot.counts).toEqual({
      totalProducts: 5,
      inStock: 3, // 6, 5, and 1 are all positive and remain in In Stock
      outOfStock: 1,
      notSet: 1,
      needsReconciliation: 0,
    });
    expect(snapshot.alerts.map((a) => ({ productName: a.productName, severity: a.severity, badgeLabel: a.badgeLabel }))).toEqual([
      { productName: "Item Zero", severity: "OUT_OF_STOCK", badgeLabel: "Out of Stock" },
      { productName: "Item Five", severity: "LOW_STOCK", badgeLabel: "Low Stock" },
      { productName: "Item One", severity: "LOW_STOCK", badgeLabel: "Low Stock" },
      { productName: "Item Unset", severity: "NOT_SET", badgeLabel: "Not Set" },
    ]);

    // Clearing the lowStockLevel removes Low Stock alerts for 5 and 1
    const cleared = buildStocksSnapshot([
      above,
      { ...atLevel, lowStockLevel: null },
      { ...oneLeft, lowStockLevel: null },
    ]);
    expect(cleared.alerts).toEqual([]);
  });

    it("formats comparison summaries with matched clock cutoffs vs whole-day labels and stock movement labels cleanly", () => {
      expect(
        formatComparisonChangeSummary({
          available: true,
          unavailableReason: null,
          unavailableMessage: null,
          currentRange: {
            from: "2026-11-09",
            to: "2026-11-11",
            isPartialEndDay: true,
            cutoffAt: "2026-11-11T14:00:00+08:00",
          },
          previousRange: {
            from: "2026-11-02",
            to: "2026-11-04",
            isPartialEndDay: true,
            cutoffAt: "2026-11-04T14:00:00+08:00",
          },
          currentTotalSalesCentavos: 9000,
          previousTotalSalesCentavos: 10000,
          amountChangeCentavos: -1000,
          percentChange: -10,
        }),
      ).toEqual({
        tone: "negative",
        headline: "−₱10 (−10%)",
        rangeSummary: "Nov 9 – 11, 2026 (through 2:00 PM) vs Nov 2 – 4, 2026 (through 2:00 PM)",
      });

      expect(
        formatComparisonChangeSummary({
          available: true,
          unavailableReason: null,
          unavailableMessage: null,
          currentRange: {
            from: "2026-11-04",
            to: "2026-11-04",
            isPartialEndDay: false,
            cutoffAt: "2026-11-04T23:59:59+08:00",
          },
          previousRange: {
            from: "2026-11-03",
            to: "2026-11-03",
            isPartialEndDay: false,
            cutoffAt: "2026-11-03T23:59:59+08:00",
          },
          currentTotalSalesCentavos: 5000,
          previousTotalSalesCentavos: 0,
          amountChangeCentavos: 5000,
          percentChange: null,
        }),
      ).toEqual({
        tone: "positive",
        headline: "+₱50 (vs ₱0)",
        rangeSummary: "Nov 4, 2026 (full day) vs Nov 3, 2026 (full day)",
      });

      expect(
        formatComparisonChangeSummary({
          available: true,
          unavailableReason: null,
          unavailableMessage: null,
          currentRange: {
            from: "2026-11-09",
            to: "2026-11-10",
            isPartialEndDay: false,
            cutoffAt: "2026-11-10T23:59:59+08:00",
          },
          previousRange: {
            from: "2026-11-07",
            to: "2026-11-08",
            isPartialEndDay: false,
            cutoffAt: "2026-11-08T23:59:59+08:00",
          },
          currentTotalSalesCentavos: 10000,
          previousTotalSalesCentavos: 10000,
          amountChangeCentavos: 0,
          percentChange: 0,
        }),
      ).toEqual({
        tone: "neutral",
        headline: "₱0 (0%)",
        rangeSummary: "Nov 9 – 10, 2026 (full days) vs Nov 7 – 8, 2026 (full days)",
      });

      expect(
        formatComparisonChangeSummary({
          available: false,
          unavailableReason: "MISSING_STATION_DAY",
          unavailableMessage: "Comparison Unavailable",
          currentRange: {
            from: "2026-11-09",
            to: "2026-11-11",
            isPartialEndDay: true,
            cutoffAt: "2026-11-11T14:00:00+08:00",
          },
          previousRange: {
            from: "2026-11-02",
            to: "2026-11-04",
            isPartialEndDay: true,
            cutoffAt: "2026-11-04T14:00:00+08:00",
          },
          currentTotalSalesCentavos: 7500,
          previousTotalSalesCentavos: null,
          amountChangeCentavos: null,
          percentChange: null,
        }),
      ).toEqual({
        tone: "unavailable",
        headline: "Comparison Unavailable",
        rangeSummary: "Nov 9 – 11, 2026 (through 2:00 PM) vs Nov 2 – 4, 2026 (through 2:00 PM)",
      });

      expect(formatStockMovementTypeLabel("PRIOR_DAY_SETTLEMENT")).toBe("Prior-Day Settlement");
      expect(formatStockMovementTypeLabel("SALE_ACTION_DEDUCTION")).toBe("Sale Correction Deduction");
      expect(formatStockMovementTypeLabel("SALE_ACTION_RESTORATION")).toBe("Sale Return Restoration");
    });
  });
