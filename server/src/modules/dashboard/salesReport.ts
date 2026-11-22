import {
  formatManilaDate,
  formatManilaIso,
  type ItemKind,
  isValidCalendarDate,
  type WaterType,
} from "../pos/sales.js";

/**
 * Pure domain rules, date-range resolution, and integer aggregation
 * for the Owner-only Dashboard v1 Sales report (DEC-076, DASH-001).
 */

export type DashboardPeriod = "today" | "week" | "month" | "custom";
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

export interface ResolvedSalesReportRange {
  period: DashboardPeriod;
  from: string;
  to: string;
  todayDate: string;
  cutoffDate: Date;
  cutoffAt: string;
  dates: string[];
}

export interface BusinessDayRecord {
  businessDate: string;
  closedAt: string | null;
}

export interface DailySalesAggregate {
  businessDate: string;
  salesCentavos: number;
  transactions: number;
}

export interface SaleItemAggregate {
  itemKind: ItemKind;
  waterType: WaterType | null;
  quantity: number;
  volumeMl: number;
  salesCentavos: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { year: y!, month: m!, day: d! };
}

function formatUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function enumerateInclusiveDates(from: string, to: string, maxDays: number): string[] | null {
  const start = parseDateParts(from);
  const end = parseDateParts(to);
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  const totalDays = Math.floor((endMs - startMs) / 86_400_000) + 1;
  if (totalDays < 1 || totalDays > maxDays) {
    return null;
  }
  const dates: string[] = [];
  for (let i = 0; i < totalDays; i += 1) {
    dates.push(formatUtcDate(new Date(startMs + i * 86_400_000)));
  }
  return dates;
}

function parseQueryString(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSalesReportRange(
  query: { period?: unknown; from?: unknown; to?: unknown },
  now: Date,
): { ok: true; range: ResolvedSalesReportRange } | { ok: false; message: string } {
  const rawPeriod = parseQueryString(query.period);
  if (rawPeriod === null) {
    return { ok: false, message: "Use today, week, month, or custom for the period filter." };
  }

  const periodNormalized = (rawPeriod ?? "week").toLowerCase();
  if (
    periodNormalized !== "today" &&
    periodNormalized !== "week" &&
    periodNormalized !== "month" &&
    periodNormalized !== "custom"
  ) {
    return { ok: false, message: "Use today, week, month, or custom for the period filter." };
  }

  const period: DashboardPeriod = periodNormalized;
  const todayDate = formatManilaDate(now);
  const cutoffAt = formatManilaIso(now);

  if (period === "today") {
    return {
      ok: true,
      range: {
        period,
        from: todayDate,
        to: todayDate,
        todayDate,
        cutoffDate: now,
        cutoffAt,
        dates: [todayDate],
      },
    };
  }

  if (period === "week") {
    const { year, month, day } = parseDateParts(todayDate);
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    const offsetFromMonday = (utcDate.getUTCDay() + 6) % 7;
    const mondayUtc = new Date(utcDate.getTime() - offsetFromMonday * 86_400_000);
    const from = formatUtcDate(mondayUtc);
    const dates = enumerateInclusiveDates(from, todayDate, 7)!;
    return {
      ok: true,
      range: {
        period,
        from,
        to: todayDate,
        todayDate,
        cutoffDate: now,
        cutoffAt,
        dates,
      },
    };
  }

  if (period === "month") {
    const { year, month } = parseDateParts(todayDate);
    const from = `${year}-${pad2(month)}-01`;
    const dates = enumerateInclusiveDates(from, todayDate, 31)!;
    return {
      ok: true,
      range: {
        period,
        from,
        to: todayDate,
        todayDate,
        cutoffDate: now,
        cutoffAt,
        dates,
      },
    };
  }

  const rawFrom = parseQueryString(query.from);
  const rawTo = parseQueryString(query.to);
  if (!rawFrom || !rawTo) {
    return { ok: false, message: "Select both start and end dates (YYYY-MM-DD) for a custom range." };
  }
  if (!isValidCalendarDate(rawFrom) || !isValidCalendarDate(rawTo)) {
    return { ok: false, message: "Enter valid calendar dates in YYYY-MM-DD format." };
  }
  if (rawFrom > rawTo) {
    return { ok: false, message: "The start date cannot be after the end date." };
  }
  if (rawFrom > todayDate || rawTo > todayDate) {
    return { ok: false, message: "Future dates cannot be selected in Dashboard sales reports." };
  }

  const dates = enumerateInclusiveDates(rawFrom, rawTo, MAX_CUSTOM_RANGE_DAYS);
  if (!dates) {
    return {
      ok: false,
      message: `Custom date ranges cannot exceed ${MAX_CUSTOM_RANGE_DAYS} days.`,
    };
  }

  return {
    ok: true,
    range: {
      period,
      from: rawFrom,
      to: rawTo,
      todayDate,
      cutoffDate: now,
      cutoffAt,
      dates,
    },
  };
}

export function assembleSalesReport(input: {
  range: ResolvedSalesReportRange;
  businessDays: BusinessDayRecord[];
  salesByDate: DailySalesAggregate[];
  itemAggregates: SaleItemAggregate[];
  priorDaySettlements: DashboardPriorDaySettlement[];
}): DashboardSalesReport {
  const dayMap = new Map<string, BusinessDayRecord>(
    input.businessDays.map((day) => [day.businessDate, day]),
  );
  const dailySalesMap = new Map<string, DailySalesAggregate>(
    input.salesByDate.map((row) => [row.businessDate, row]),
  );

  let recordedDayCount = 0;
  let missingDayCount = 0;
  const trend: DashboardSalesTrendPoint[] = input.range.dates.map((businessDate) => {
    const day = dayMap.get(businessDate);
    if (!day) {
      missingDayCount += 1;
      return {
        businessDate,
        hasBusinessDay: false,
        dayStatus: "NO_RECORD",
        salesCentavos: null,
        transactions: null,
      };
    }
    recordedDayCount += 1;
    const agg = dailySalesMap.get(businessDate);
    return {
      businessDate,
      hasBusinessDay: true,
      dayStatus: day.closedAt !== null ? "CLOSED" : "OPEN",
      salesCentavos: agg?.salesCentavos ?? 0,
      transactions: agg?.transactions ?? 0,
    };
  });

  let totalSalesCentavos = 0;
  let totalTransactions = 0;
  for (const row of input.salesByDate) {
    totalSalesCentavos += row.salesCentavos;
    totalTransactions += row.transactions;
  }

  let containersRefilled = 0;
  let totalWaterVolumeMl = 0;
  const serviceAccum: Record<WaterType, { containers: number; waterVolumeMl: number; salesCentavos: number }> = {
    PURIFIED: { containers: 0, waterVolumeMl: 0, salesCentavos: 0 },
    ALKALINE: { containers: 0, waterVolumeMl: 0, salesCentavos: 0 },
  };

  for (const agg of input.itemAggregates) {
    totalWaterVolumeMl += agg.volumeMl;
    if (agg.itemKind === "STANDARD" || agg.itemKind === "CUSTOM") {
      containersRefilled += agg.quantity;
      if (agg.waterType === "PURIFIED" || agg.waterType === "ALKALINE") {
        serviceAccum[agg.waterType].containers += agg.quantity;
        serviceAccum[agg.waterType].waterVolumeMl += agg.volumeMl;
        serviceAccum[agg.waterType].salesCentavos += agg.salesCentavos;
      }
    }
  }

  let purifiedSharePercent: number | null = null;
  let alkalineSharePercent: number | null = null;
  if (containersRefilled > 0) {
    const purifiedTenths = Math.round((serviceAccum.PURIFIED.containers * 1000) / containersRefilled);
    const alkalineTenths = 1000 - purifiedTenths;
    purifiedSharePercent = purifiedTenths / 10;
    alkalineSharePercent = alkalineTenths / 10;
  }

  const service: DashboardServiceBreakdown[] = [
    {
      waterType: "PURIFIED",
      containers: serviceAccum.PURIFIED.containers,
      waterVolumeMl: serviceAccum.PURIFIED.waterVolumeMl,
      salesCentavos: serviceAccum.PURIFIED.salesCentavos,
      sharePercent: purifiedSharePercent,
    },
    {
      waterType: "ALKALINE",
      containers: serviceAccum.ALKALINE.containers,
      waterVolumeMl: serviceAccum.ALKALINE.waterVolumeMl,
      salesCentavos: serviceAccum.ALKALINE.salesCentavos,
      sharePercent: alkalineSharePercent,
    },
  ];

  return {
    range: {
      period: input.range.period,
      from: input.range.from,
      to: input.range.to,
      todayDate: input.range.todayDate,
      cutoffAt: input.range.cutoffAt,
      recordedDayCount,
      missingDayCount,
    },
    totals: {
      salesCentavos: totalSalesCentavos,
      containersRefilled,
      waterVolumeMl: totalWaterVolumeMl,
      transactions: totalTransactions,
    },
    trend,
    service,
    priorDaySettlements: input.priorDaySettlements,
  };
}
