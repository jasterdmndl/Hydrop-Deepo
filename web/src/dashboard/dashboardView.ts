import type { ReminderItem } from "../calendar/calendarView";
import {
  formatQuantityLabel,
  getPosSectionLabel,
  groupInventoryItems,
  type InventoryItemView,
  type PosSectionView,
} from "../inventory/inventoryView";
import type { WaterType } from "../pos/posRecovery";

/**
 * Pure formatting, custom date validation, trend interpretation, reminder ordering,
 * and Inventory-to-Stocks snapshot helpers for Dashboard v1 (DEC-076).
 */

export type DashboardPeriod = "today" | "week" | "month" | "custom";
export type DashboardViewMode = "sales" | "stocks";
export type DashboardDayStatus = "OPEN" | "CLOSED" | "NO_RECORD";

export const MAX_CUSTOM_RANGE_DAYS = 366;

export interface DashboardSalesTrendPoint {
  businessDate: string;
  hasBusinessDay: boolean;
  dayStatus: DashboardDayStatus;
  salesCentavos: number | null;
  transactions: number | null;
}

export interface DashboardServiceBreakdown {
  waterType: WaterType;
  containers: number;
  waterVolumeMl: number;
  salesCentavos: number;
  sharePercent: number | null;
}

export interface DashboardPriorDaySettlement {
  checkoutReference: string;
  originalBusinessDate: string;
  settlementDate: string;
  netAmountKeptCentavos: number;
  settledBy: string;
  settledAt: string;
  note: string | null;
}

export interface DashboardSalesReport {
  range: {
    period: DashboardPeriod;
    from: string;
    to: string;
    todayDate: string;
    cutoffAt: string;
    recordedDayCount: number;
    missingDayCount: number;
  };
  totals: {
    salesCentavos: number;
    containersRefilled: number;
    waterVolumeMl: number;
    transactions: number;
  };
  trend: DashboardSalesTrendPoint[];
  service: DashboardServiceBreakdown[];
  priorDaySettlements: DashboardPriorDaySettlement[];
}

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const FULL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const FULL_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const STOCK_CHART_COLORS = ["#1d63dc", "#3b82f6", "#60a5fa", "#93c5fd", "#0f2a4a", "#bfdbfe"] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseYyyyMmDd(dateStr: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(check.getTime()) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function getTodayManilaDate(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

export function getDefaultWeekStartManila(now: Date = new Date()): string {
  const today = getTodayManilaDate(now);
  const parts = parseYyyyMmDd(today)!;
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const offset = (utc.getUTCDay() + 6) % 7;
  const monday = new Date(utc.getTime() - offset * 86_400_000);
  return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
}

export function formatDashboardPeso(centavos: number): string {
  const truncated = Math.trunc(centavos);
  const sign = truncated < 0 ? "−" : "";
  const abs = Math.abs(truncated);
  const pesos = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}₱${pesos.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
}

export function formatDashboardPesoCompact(centavos: number): string {
  const truncated = Math.trunc(centavos);
  const sign = truncated < 0 ? "−" : "";
  const abs = Math.abs(truncated);
  const pesos = Math.floor(abs / 100);
  const rem = abs % 100;
  if (rem === 0) {
    return `${sign}₱${pesos.toLocaleString("en-US")}`;
  }
  return `${sign}₱${pesos.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
}

export function formatWaterLiters(ml: number): string {
  const truncated = Math.trunc(ml);
  const sign = truncated < 0 ? "−" : "";
  const abs = Math.abs(truncated);
  const whole = Math.floor(abs / 1000);
  const rem = abs % 1000;
  if (rem === 0) {
    return `${sign}${whole.toLocaleString("en-US")} L`;
  }
  const decimal = String(rem).padStart(3, "0").replace(/0+$/, "");
  return `${sign}${whole.toLocaleString("en-US")}.${decimal} L`;
}

export function formatManilaDateRange(from: string, to: string): string {
  const start = parseYyyyMmDd(from);
  const end = parseYyyyMmDd(to);
  if (!start || !end) {
    return from === to ? from : `${from} – ${to}`;
  }
  const startMonth = SHORT_MONTHS[start.month - 1]!;
  const endMonth = SHORT_MONTHS[end.month - 1]!;
  if (from === to) {
    return `${startMonth} ${start.day}, ${start.year}`;
  }
  if (start.year === end.year && start.month === end.month) {
    return `${startMonth} ${start.day} – ${end.day}, ${start.year}`;
  }
  if (start.year === end.year) {
    return `${startMonth} ${start.day} – ${endMonth} ${end.day}, ${start.year}`;
  }
  return `${startMonth} ${start.day}, ${start.year} – ${endMonth} ${end.day}, ${end.year}`;
}

export function formatTrendAxisLabel(businessDate: string, compact: boolean): string {
  const parts = parseYyyyMmDd(businessDate);
  if (!parts) return businessDate;
  if (compact) {
    return `${SHORT_MONTHS[parts.month - 1]} ${parts.day}`;
  }
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return `${SHORT_WEEKDAYS[utc.getUTCDay()]} ${parts.day}`;
}

export function formatFullManilaDateLabel(businessDate: string): string {
  const parts = parseYyyyMmDd(businessDate);
  if (!parts) return businessDate;
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return `${SHORT_WEEKDAYS[utc.getUTCDay()]}, ${SHORT_MONTHS[parts.month - 1]} ${parts.day}, ${parts.year}`;
}

export function formatCutoffClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const shifted = new Date(ms + MANILA_OFFSET_MS);
  const hour24 = shifted.getUTCHours();
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minute} ${period}`;
}

export function validateCustomRange(from: string, to: string, todayDate: string): string | null {
  const f = from.trim();
  const t = to.trim();
  if (!f || !t) {
    return "Select both From and To dates.";
  }
  const start = parseYyyyMmDd(f);
  const end = parseYyyyMmDd(t);
  if (!start || !end) {
    return "Enter valid calendar dates.";
  }
  if (f > t) {
    return "From date cannot be after To date.";
  }
  if (f > todayDate || t > todayDate) {
    return "Future dates cannot be selected.";
  }
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  const days = Math.floor((endMs - startMs) / 86_400_000) + 1;
  if (days > MAX_CUSTOM_RANGE_DAYS) {
    return `Custom range cannot exceed ${MAX_CUSTOM_RANGE_DAYS} days.`;
  }
  return null;
}

export function describeTrendLeader(trend: DashboardSalesTrendPoint[]): string | null {
  const operational = trend.filter(
    (point) => point.hasBusinessDay && point.salesCentavos !== null,
  );
  if (operational.length === 0) {
    return "No station business days were recorded in this date range.";
  }
  let maxSales = 0;
  for (const point of operational) {
    if ((point.salesCentavos ?? 0) > maxSales) {
      maxSales = point.salesCentavos ?? 0;
    }
  }
  if (maxSales === 0) {
    return operational.length === 1
      ? `${formatFullManilaDateLabel(operational[0]!.businessDate)} recorded ₱0 in sales.`
      : "All recorded business days in this range had ₱0 in sales.";
  }
  const leaders = operational.filter((point) => point.salesCentavos === maxSales);
  if (leaders.length === 1) {
    const leader = leaders[0]!;
    const parts = parseYyyyMmDd(leader.businessDate);
    if (!parts) {
      return `${leader.businessDate} led with ${formatDashboardPesoCompact(maxSales)} in sales.`;
    }
    const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const dayName = FULL_WEEKDAYS[utc.getUTCDay()]!;
    const monthName = FULL_MONTHS[parts.month - 1]!;
    return `${dayName} (${monthName} ${parts.day}) led with ${formatDashboardPesoCompact(maxSales)} in sales.`;
  }
  return `${leaders.length} days tied for peak daily sales at ${formatDashboardPesoCompact(maxSales)}.`;
}

export function sortStationReminders(items: ReminderItem[]): ReminderItem[] {
  return [...items].sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "OVERDUE" ? -1 : 1;
    }
    if (a.scheduledAt !== b.scheduledAt) {
      return a.scheduledAt.localeCompare(b.scheduledAt);
    }
    return a.reference.localeCompare(b.reference);
  });
}

export interface StockOverviewGroup {
  key: string;
  title: string;
  productCount: number;
  sharePercent: number;
  color: string;
}

export interface StockCategoryUnitRow {
  key: string;
  groupKey: string;
  groupTitle: string;
  unit: string;
  totalQuantity: number | null;
  unitMaxQuantity: number;
  isUnsetOnly: boolean;
  unsetCount: number;
  itemCount: number;
  hasNegative: boolean;
}

export type StockAlertSeverity = "NEEDS_RECONCILIATION" | "OUT_OF_STOCK" | "NOT_SET";

export interface StockAlertItem {
  key: string;
  productName: string;
  groupTitle: string;
  severity: StockAlertSeverity;
  badgeLabel: "Needs reconciliation" | "Out of Stock" | "Not Set";
  detail: string;
  quantity: number | null;
  unit: string;
}

export interface StocksSnapshot {
  counts: {
    totalProducts: number;
    inStock: number;
    outOfStock: number;
    notSet: number;
    needsReconciliation: number;
  };
  overviewGroups: StockOverviewGroup[];
  categoryUnits: StockCategoryUnitRow[];
  alerts: StockAlertItem[];
}

function getItemMergeKey(item: InventoryItemView): string {
  return item.id ?? item.shape ?? item.code;
}

function alertSeverityRank(severity: StockAlertSeverity): number {
  switch (severity) {
    case "NEEDS_RECONCILIATION":
      return 0;
    case "OUT_OF_STOCK":
      return 1;
    case "NOT_SET":
      return 2;
  }
}

export function buildStocksSnapshot(
  items: InventoryItemView[],
  posSections: PosSectionView[] = [],
): StocksSnapshot {
  const dedupedByKey = new Map<string, InventoryItemView>();
  for (const item of items) {
    if (item.archivedAt !== null && item.archivedAt !== undefined) continue;
    const key = getItemMergeKey(item);
    if (!dedupedByKey.has(key)) {
      dedupedByKey.set(key, item);
    }
  }
  const activeItems = Array.from(dedupedByKey.values());

  let inStock = 0;
  let outOfStock = 0;
  let notSet = 0;
  let needsReconciliation = 0;

  for (const item of activeItems) {
    if (item.status === "NOT_SET" || item.currentQuantity === null) {
      notSet += 1;
    } else if (item.currentQuantity < 0) {
      needsReconciliation += 1;
    } else if (item.currentQuantity === 0) {
      outOfStock += 1;
    } else {
      inStock += 1;
    }
  }

  const buckets = groupInventoryItems(activeItems, "ALL", posSections);
  const totalProducts = activeItems.length;

  const overviewGroups: StockOverviewGroup[] = buckets.map((bucket, index) => {
    const productCount = bucket.items.length;
    const sharePercent =
      totalProducts > 0 ? Math.round((productCount / totalProducts) * 1000) / 10 : 0;
    return {
      key: bucket.key,
      title: bucket.title,
      productCount,
      sharePercent,
      color: STOCK_CHART_COLORS[index % STOCK_CHART_COLORS.length]!,
    };
  });

  const rawUnitRows: Array<Omit<StockCategoryUnitRow, "unitMaxQuantity"> & { unitNorm: string }> = [];
  const maxByUnit = new Map<string, number>();

  for (const bucket of buckets) {
    const unitGroups = new Map<
      string,
      { displayUnit: string; items: InventoryItemView[] }
    >();

    for (const item of bucket.items) {
      const displayUnit = item.unit.trim() || "units";
      const unitNorm = displayUnit.toLowerCase();
      const existing = unitGroups.get(unitNorm);
      if (existing) {
        existing.items.push(item);
      } else {
        unitGroups.set(unitNorm, { displayUnit, items: [item] });
      }
    }

    for (const [unitNorm, unitGroup] of unitGroups.entries()) {
      let initializedCount = 0;
      let unsetCount = 0;
      let sum = 0;
      let hasNegative = false;

      for (const item of unitGroup.items) {
        if (item.status === "NOT_SET" || item.currentQuantity === null) {
          unsetCount += 1;
        } else {
          initializedCount += 1;
          sum += item.currentQuantity;
          if (item.currentQuantity < 0) {
            hasNegative = true;
          }
        }
      }

      const isUnsetOnly = initializedCount === 0;
      const totalQuantity = isUnsetOnly ? null : sum;
      if (totalQuantity !== null && totalQuantity > 0) {
        const prevMax = maxByUnit.get(unitNorm) ?? 0;
        if (totalQuantity > prevMax) {
          maxByUnit.set(unitNorm, totalQuantity);
        }
      }

      rawUnitRows.push({
        key: `${bucket.key}::${unitNorm}`,
        groupKey: bucket.key,
        groupTitle: bucket.title,
        unit: unitGroup.displayUnit,
        unitNorm,
        totalQuantity,
        isUnsetOnly,
        unsetCount,
        itemCount: unitGroup.items.length,
        hasNegative,
      });
    }
  }

  const categoryUnits: StockCategoryUnitRow[] = rawUnitRows.map(({ unitNorm, ...rest }) => ({
    ...rest,
    unitMaxQuantity: maxByUnit.get(unitNorm) ?? 0,
  }));

  const alerts: StockAlertItem[] = [];
  for (const item of activeItems) {
    const groupTitle =
      item.category === "CONTAINER"
        ? "Containers"
        : getPosSectionLabel(item.posSection, posSections);
    const key = getItemMergeKey(item);

    if (item.status === "NOT_SET" || item.currentQuantity === null) {
      alerts.push({
        key,
        productName: item.name,
        groupTitle,
        severity: "NOT_SET",
        badgeLabel: "Not Set",
        detail: "Opening count not recorded yet",
        quantity: null,
        unit: item.unit,
      });
    } else if (item.currentQuantity < 0) {
      alerts.push({
        key,
        productName: item.name,
        groupTitle,
        severity: "NEEDS_RECONCILIATION",
        badgeLabel: "Needs reconciliation",
        detail: `Recorded ${formatQuantityLabel(item.currentQuantity, item.unit)} · Physical count reconciliation required (INV-008/009)`,
        quantity: item.currentQuantity,
        unit: item.unit,
      });
    } else if (item.currentQuantity === 0) {
      alerts.push({
        key,
        productName: item.name,
        groupTitle,
        severity: "OUT_OF_STOCK",
        badgeLabel: "Out of Stock",
        detail: `Out of stock · ${formatQuantityLabel(0, item.unit)} remaining`,
        quantity: 0,
        unit: item.unit,
      });
    }
  }

  alerts.sort((a, b) => {
    const rankDiff = alertSeverityRank(a.severity) - alertSeverityRank(b.severity);
    if (rankDiff !== 0) return rankDiff;
    return a.productName.toLowerCase().localeCompare(b.productName.toLowerCase());
  });

  return {
    counts: {
      totalProducts,
      inStock,
      outOfStock,
      notSet,
      needsReconciliation,
    },
    overviewGroups,
    categoryUnits,
    alerts,
  };
}
