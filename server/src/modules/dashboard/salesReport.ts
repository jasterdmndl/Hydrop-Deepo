import {
  type ContainerPackageCode,
  type ContainerShape,
  type FaucetReportingType,
  formatManilaDate,
  formatManilaIso,
  type ItemKind,
  isValidCalendarDate,
  type PosSection,
  type WaterType,
} from "../pos/sales.js";

/**
 * Pure domain rules, matched Manila date-range comparison, integer aggregation,
 * and rule-based recommendations for the final Owner Dashboard Sales report
 * (DEC-076, DEC-086 through DEC-088, DEC-091 through DEC-093, DASH-001..003).
 */

export type DashboardPeriod = "today" | "week" | "month" | "custom";
export type DashboardDayStatus = "OPEN" | "CLOSED" | "NO_RECORD";
export type ComparisonUnavailableReason =
  | "NO_EQUIVALENT_PREVIOUS_MONTH_DATE"
  | "MISSING_STATION_DAY";
export type ContainerFillType = "EMPTY" | "PURIFIED" | "ALKALINE";
export type DashboardRecommendationType =
  | "OVERDUE_ACTIVITIES"
  | "SALES_DECLINE"
  | "REFILL_LEADER"
  | "FAUCET_LEADER";

export const MAX_CUSTOM_RANGE_DAYS = 366;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

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

export interface DashboardComparisonRange {
  from: string;
  to: string;
  isPartialEndDay: boolean;
  cutoffAt: string;
}

export interface DashboardSalesComparison {
  available: boolean;
  unavailableReason: ComparisonUnavailableReason | null;
  unavailableMessage: string | null;
  currentRange: DashboardComparisonRange;
  previousRange: DashboardComparisonRange | null;
  currentTotalSalesCentavos: number;
  previousTotalSalesCentavos: number | null;
  amountChangeCentavos: number | null;
  percentChange: number | null;
}

export interface DashboardFaucetBreakdownItem {
  type: FaucetReportingType;
  label: "Push-Type Faucet" | "Twist-Type Faucet";
  units: number;
  salesCentavos: number;
  sharePercent: number | null;
}

export interface DashboardFaucetSales {
  totalUnits: number;
  totalSalesCentavos: number;
  leader: FaucetReportingType | "TIE" | null;
  unclassifiedUnits: number;
  unclassifiedSalesCentavos: number;
  items: DashboardFaucetBreakdownItem[];
}

export interface DashboardContainerSalesItem {
  packageCode: ContainerPackageCode;
  shape: ContainerShape;
  fillType: ContainerFillType;
  label: string;
  units: number;
  salesCentavos: number;
  waterVolumeMl: number;
}

export interface DashboardContainerSales {
  totalUnits: number;
  totalSalesCentavos: number;
  items: DashboardContainerSalesItem[];
}

export interface DashboardRecommendation {
  id: string;
  type: DashboardRecommendationType;
  title: string;
  observation: string;
  suggestedAction: string;
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
  comparison: DashboardSalesComparison;
  trend: DashboardSalesTrendPoint[];
  service: DashboardServiceBreakdown[];
  faucetSales: DashboardFaucetSales;
  containerSales: DashboardContainerSales;
  recommendations: DashboardRecommendation[];
  priorDaySettlements: DashboardPriorDaySettlement[];
}

export interface ResolvedComparisonTarget {
  from: string;
  to: string;
  isPartialEndDay: boolean;
  endCutoffDate: Date;
  cutoffAt: string;
  dates: string[];
}

export interface ResolvedSalesReportRange {
  period: DashboardPeriod;
  from: string;
  to: string;
  todayDate: string;
  isPartialEndDay: boolean;
  cutoffDate: Date;
  cutoffAt: string;
  dates: string[];
  comparisonTarget: ResolvedComparisonTarget | null;
  noEquivalentMonthDate: boolean;
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
  catalogCode: string | null;
  faucetReportingType: FaucetReportingType | "NONE" | null;
  posSection: PosSection | null;
  displayLabel: string;
  quantity: number;
  volumeMl: number;
  salesCentavos: number;
}

const CONTAINER_SALES_DEFINITIONS: ReadonlyArray<{
  packageCode: ContainerPackageCode;
  shape: ContainerShape;
  fillType: ContainerFillType;
  label: string;
}> = [
    { packageCode: "ROUND_EMPTY", shape: "ROUND", fillType: "EMPTY", label: "Empty Round" },
    { packageCode: "ROUND_PURIFIED", shape: "ROUND", fillType: "PURIFIED", label: "Purified Round" },
    { packageCode: "ROUND_ALKALINE", shape: "ROUND", fillType: "ALKALINE", label: "Alkaline Round" },
    { packageCode: "SLIM_EMPTY", shape: "SLIM", fillType: "EMPTY", label: "Empty Slim" },
    { packageCode: "SLIM_PURIFIED", shape: "SLIM", fillType: "PURIFIED", label: "Purified Slim" },
    { packageCode: "SLIM_ALKALINE", shape: "SLIM", fillType: "ALKALINE", label: "Alkaline Slim" },
  ];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  return { year: y!, month: m!, day: d! };
}

function manilaTimeParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
} {
  const shifted = new Date(date.getTime() + MANILA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    ms: shifted.getUTCMilliseconds(),
  };
}

function manilaWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - MANILA_OFFSET_MS);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function shiftYyyyMmDd(dateStr: string, deltaDays: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  const utc = Date.UTC(year, month - 1, day + deltaDays);
  return formatUtcDate(new Date(utc));
}

function endOfManilaDayCutoff(dateStr: string): Date {
  const { year, month, day } = parseDateParts(dateStr);
  return manilaWallClockToUtc(year, month, day, 23, 59, 59, 999);
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

function formatPesosForMessage(centavos: number): string {
  const abs = Math.abs(Math.trunc(centavos));
  const pesos = Math.floor(abs / 100);
  const rem = abs % 100;
  const sign = centavos < 0 ? "−" : "";
  if (rem === 0) {
    return `${sign}₱${pesos.toLocaleString("en-US")}`;
  }
  return `${sign}₱${pesos.toLocaleString("en-US")}.${pad2(rem)}`;
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
  const nowParts = manilaTimeParts(now);

  if (period === "today") {
    const prevDate = shiftYyyyMmDd(todayDate, -1);
    const prevCutoff = new Date(now.getTime() - 86_400_000);
    return {
      ok: true,
      range: {
        period,
        from: todayDate,
        to: todayDate,
        todayDate,
        isPartialEndDay: true,
        cutoffDate: now,
        cutoffAt,
        dates: [todayDate],
        noEquivalentMonthDate: false,
        comparisonTarget: {
          from: prevDate,
          to: prevDate,
          isPartialEndDay: true,
          endCutoffDate: prevCutoff,
          cutoffAt: formatManilaIso(prevCutoff),
          dates: [prevDate],
        },
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

    const prevFrom = shiftYyyyMmDd(from, -7);
    const prevTo = shiftYyyyMmDd(todayDate, -7);
    const prevCutoff = new Date(now.getTime() - 7 * 86_400_000);

    return {
      ok: true,
      range: {
        period,
        from,
        to: todayDate,
        todayDate,
        isPartialEndDay: true,
        cutoffDate: now,
        cutoffAt,
        dates,
        noEquivalentMonthDate: false,
        comparisonTarget: {
          from: prevFrom,
          to: prevTo,
          isPartialEndDay: true,
          endCutoffDate: prevCutoff,
          cutoffAt: formatManilaIso(prevCutoff),
          dates: enumerateInclusiveDates(prevFrom, prevTo, 7)!,
        },
      },
    };
  }

  if (period === "month") {
    const { year, month, day } = parseDateParts(todayDate);
    const from = `${year}-${pad2(month)}-01`;
    const dates = enumerateInclusiveDates(from, todayDate, 31)!;

    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const maxPrevDay = daysInMonth(prevYear, prevMonth);

    if (day > maxPrevDay) {
      return {
        ok: true,
        range: {
          period,
          from,
          to: todayDate,
          todayDate,
          isPartialEndDay: true,
          cutoffDate: now,
          cutoffAt,
          dates,
          noEquivalentMonthDate: true,
          comparisonTarget: null,
        },
      };
    }

    const prevFrom = `${prevYear}-${pad2(prevMonth)}-01`;
    const prevTo = `${prevYear}-${pad2(prevMonth)}-${pad2(day)}`;
    const prevCutoff = manilaWallClockToUtc(
      prevYear,
      prevMonth,
      day,
      nowParts.hour,
      nowParts.minute,
      nowParts.second,
      nowParts.ms,
    );

    return {
      ok: true,
      range: {
        period,
        from,
        to: todayDate,
        todayDate,
        isPartialEndDay: true,
        cutoffDate: now,
        cutoffAt,
        dates,
        noEquivalentMonthDate: false,
        comparisonTarget: {
          from: prevFrom,
          to: prevTo,
          isPartialEndDay: true,
          endCutoffDate: prevCutoff,
          cutoffAt: formatManilaIso(prevCutoff),
          dates: enumerateInclusiveDates(prevFrom, prevTo, 31)!,
        },
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

  const isPartialEndDay = rawTo === todayDate;
  const currentCutoff = isPartialEndDay ? now : endOfManilaDayCutoff(rawTo);
  const prevTo = shiftYyyyMmDd(rawFrom, -1);
  const prevFrom = shiftYyyyMmDd(prevTo, -(dates.length - 1));
  const prevDates = enumerateInclusiveDates(prevFrom, prevTo, MAX_CUSTOM_RANGE_DAYS)!;
  const prevToParts = parseDateParts(prevTo);
  const prevCutoff = isPartialEndDay
    ? manilaWallClockToUtc(
      prevToParts.year,
      prevToParts.month,
      prevToParts.day,
      nowParts.hour,
      nowParts.minute,
      nowParts.second,
      nowParts.ms,
    )
    : endOfManilaDayCutoff(prevTo);

  return {
    ok: true,
    range: {
      period,
      from: rawFrom,
      to: rawTo,
      todayDate,
      isPartialEndDay,
      cutoffDate: currentCutoff,
      cutoffAt,
      dates,
      noEquivalentMonthDate: false,
      comparisonTarget: {
        from: prevFrom,
        to: prevTo,
        isPartialEndDay,
        endCutoffDate: prevCutoff,
        cutoffAt: formatManilaIso(prevCutoff),
        dates: prevDates,
      },
    },
  };
}

const FIT_PREPOSITION_RE =
  /(?:\s*\(\s*|\s+)\b(?:for|fits|compatible\s+with|para\s+sa|with)\b(?:\s+|$)/i;
const FAUCET_NOUN_RE = /\b(?:faucet|gripo)s?\b/gi;
const ALLOWED_TRAILING_FAUCET_TOKENS = new Set([
  "push",
  "twist",
  "type",
  "style",
  "slim",
  "round",
  "standard",
  "regular",
  "universal",
  "only",
  "standalone",
  "pc",
  "pcs",
  "piece",
  "pieces",
  "unit",
  "units",
  "new",
  "old",
  "v1",
  "v2",
  "heavy",
  "duty",
  "original",
  "generic",
  "special",
  "plastic",
  "stainless",
  "metal",
  "chrome",
  "white",
  "blue",
  "red",
  "black",
  "green",
  "clear",
  "transparent",
  "small",
  "medium",
  "large",
  "sm",
  "md",
  "lg",
  "replacement",
]);
const NON_FAUCET_SUBJECT_RE =
  /\b(?:seals?|gaskets?|washers?|o-?rings?|caps?|takips?|covers?|dividers?|springs?|adapters?|hoses?|tubes?|pipes?|nuts?|bolts?|screws?|wrench(?:es)?|spanners?|tools?|openers?|holders?|handles?|brush(?:es)?|cleaners?|racks?|stands?|containers?|gallons?|jugs?|bottles?|kits?|repairs?|parts?)\b/i;

export function classifyStandaloneMerchandiseFaucet(agg: {
  itemKind: ItemKind;
  faucetReportingType: FaucetReportingType | "NONE" | null;
  posSection: PosSection | null;
  displayLabel: string;
}):
  | { kind: "TYPED"; type: FaucetReportingType }
  | { kind: "UNCLASSIFIED_FAUCET" }
  | { kind: "NOT_FAUCET" } {
  if (agg.itemKind !== "MERCHANDISE") {
    return { kind: "NOT_FAUCET" };
  }
  if (agg.faucetReportingType === "PUSH_TYPE" || agg.faucetReportingType === "TWIST_TYPE") {
    return { kind: "TYPED", type: agg.faucetReportingType };
  }

  const label = agg.displayLabel.trim().toLowerCase();
  const primarySubject = (label.split(FIT_PREPOSITION_RE)[0] ?? "").trim();

  let lastFaucetMatchEnd = -1;
  for (const match of primarySubject.matchAll(FAUCET_NOUN_RE)) {
    if (match.index !== undefined) {
      lastFaucetMatchEnd = match.index + match[0].length;
    }
  }

  if (lastFaucetMatchEnd >= 0) {
    const afterFaucet = primarySubject.slice(lastFaucetMatchEnd);
    const trailingTokens = afterFaucet.match(/[a-z0-9]+/gi) ?? [];
    const hasDisallowedTrailingToken = trailingTokens.some(
      (token) => !/^\d+(?:pcs?)?$/i.test(token) && !ALLOWED_TRAILING_FAUCET_TOKENS.has(token),
    );
    if (hasDisallowedTrailingToken) {
      return { kind: "NOT_FAUCET" };
    }

    if (agg.faucetReportingType === "NONE") {
      // Deliberately saved untyped: never infer Push/Twist, but report known standalone faucets under unclassified coverage.
      return { kind: "UNCLASSIFIED_FAUCET" };
    }

    // Historical/legacy sale line with NULL faucet_reporting_type: infer Push/Twist only from the item's own subject.
    const hasPush = /\bpush(?:[-\s]*type)?\b/i.test(primarySubject);
    const hasTwist = /\btwist(?:[-\s]*type)?\b/i.test(primarySubject);
    if (hasPush && !hasTwist) {
      return { kind: "TYPED", type: "PUSH_TYPE" };
    }
    if (hasTwist && !hasPush) {
      return { kind: "TYPED", type: "TWIST_TYPE" };
    }
    return { kind: "UNCLASSIFIED_FAUCET" };
  }

  if (NON_FAUCET_SUBJECT_RE.test(primarySubject)) {
    return { kind: "NOT_FAUCET" };
  }
  if (agg.posSection === "CHANGE_OF_GRIPO") {
    return { kind: "UNCLASSIFIED_FAUCET" };
  }
  return { kind: "NOT_FAUCET" };
}

export function assembleSalesReport(input: {
  range: ResolvedSalesReportRange;
  businessDays: BusinessDayRecord[];
  salesByDate: DailySalesAggregate[];
  itemAggregates: SaleItemAggregate[];
  priorDaySettlements: DashboardPriorDaySettlement[];
  previousBusinessDays?: BusinessDayRecord[];
  previousTotalSalesCentavos?: number;
  calendarOverdueCount?: number | null;
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

  const faucetAccum: Record<FaucetReportingType, { units: number; salesCentavos: number }> = {
    PUSH_TYPE: { units: 0, salesCentavos: 0 },
    TWIST_TYPE: { units: 0, salesCentavos: 0 },
  };
  let unclassifiedFaucetUnits = 0;
  let unclassifiedFaucetSalesCentavos = 0;

  const containerAccum = new Map<
    ContainerPackageCode,
    { units: number; salesCentavos: number; waterVolumeMl: number }
  >();
  for (const def of CONTAINER_SALES_DEFINITIONS) {
    containerAccum.set(def.packageCode, { units: 0, salesCentavos: 0, waterVolumeMl: 0 });
  }

  for (const agg of input.itemAggregates) {
    totalWaterVolumeMl += agg.volumeMl;
    if (agg.itemKind === "STANDARD" || agg.itemKind === "CUSTOM") {
      containersRefilled += agg.quantity;
      if (agg.waterType === "PURIFIED" || agg.waterType === "ALKALINE") {
        serviceAccum[agg.waterType].containers += agg.quantity;
        serviceAccum[agg.waterType].waterVolumeMl += agg.volumeMl;
        serviceAccum[agg.waterType].salesCentavos += agg.salesCentavos;
      }
      continue;
    }
    if (agg.itemKind === "CONTAINER_PACKAGE" && agg.catalogCode) {
      const bucket = containerAccum.get(agg.catalogCode as ContainerPackageCode);
      if (bucket) {
        bucket.units += agg.quantity;
        bucket.salesCentavos += agg.salesCentavos;
        bucket.waterVolumeMl += agg.volumeMl;
      }
      continue;
    }
    if (agg.itemKind === "MERCHANDISE") {
      const classification = classifyStandaloneMerchandiseFaucet(agg);
      if (classification.kind === "TYPED") {
        faucetAccum[classification.type].units += agg.quantity;
        faucetAccum[classification.type].salesCentavos += agg.salesCentavos;
      } else if (classification.kind === "UNCLASSIFIED_FAUCET") {
        unclassifiedFaucetUnits += agg.quantity;
        unclassifiedFaucetSalesCentavos += agg.salesCentavos;
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

  const typedFaucetUnits = faucetAccum.PUSH_TYPE.units + faucetAccum.TWIST_TYPE.units;
  const typedFaucetSalesCentavos =
    faucetAccum.PUSH_TYPE.salesCentavos + faucetAccum.TWIST_TYPE.salesCentavos;
  let pushSharePercent: number | null = null;
  let twistSharePercent: number | null = null;
  let faucetLeader: FaucetReportingType | "TIE" | null = null;
  if (typedFaucetUnits > 0) {
    const pushTenths = Math.round((faucetAccum.PUSH_TYPE.units * 1000) / typedFaucetUnits);
    const twistTenths = 1000 - pushTenths;
    pushSharePercent = pushTenths / 10;
    twistSharePercent = twistTenths / 10;
    if (faucetAccum.PUSH_TYPE.units > faucetAccum.TWIST_TYPE.units) {
      faucetLeader = "PUSH_TYPE";
    } else if (faucetAccum.TWIST_TYPE.units > faucetAccum.PUSH_TYPE.units) {
      faucetLeader = "TWIST_TYPE";
    } else {
      faucetLeader = "TIE";
    }
  }

  const faucetSales: DashboardFaucetSales = {
    totalUnits: typedFaucetUnits,
    totalSalesCentavos: typedFaucetSalesCentavos,
    leader: faucetLeader,
    unclassifiedUnits: unclassifiedFaucetUnits,
    unclassifiedSalesCentavos: unclassifiedFaucetSalesCentavos,
    items: [
      {
        type: "PUSH_TYPE",
        label: "Push-Type Faucet",
        units: faucetAccum.PUSH_TYPE.units,
        salesCentavos: faucetAccum.PUSH_TYPE.salesCentavos,
        sharePercent: pushSharePercent,
      },
      {
        type: "TWIST_TYPE",
        label: "Twist-Type Faucet",
        units: faucetAccum.TWIST_TYPE.units,
        salesCentavos: faucetAccum.TWIST_TYPE.salesCentavos,
        sharePercent: twistSharePercent,
      },
    ],
  };

  let containerTotalUnits = 0;
  let containerTotalSalesCentavos = 0;
  const containerItems: DashboardContainerSalesItem[] = CONTAINER_SALES_DEFINITIONS.map((def) => {
    const bucket = containerAccum.get(def.packageCode)!;
    containerTotalUnits += bucket.units;
    containerTotalSalesCentavos += bucket.salesCentavos;
    return {
      packageCode: def.packageCode,
      shape: def.shape,
      fillType: def.fillType,
      label: def.label,
      units: bucket.units,
      salesCentavos: bucket.salesCentavos,
      waterVolumeMl: bucket.waterVolumeMl,
    };
  });

  const containerSales: DashboardContainerSales = {
    totalUnits: containerTotalUnits,
    totalSalesCentavos: containerTotalSalesCentavos,
    items: containerItems,
  };

  const currentComparisonRange: DashboardComparisonRange = {
    from: input.range.from,
    to: input.range.to,
    isPartialEndDay: input.range.isPartialEndDay,
    cutoffAt: formatManilaIso(input.range.cutoffDate),
  };

  let comparison: DashboardSalesComparison;
  if (input.range.noEquivalentMonthDate || !input.range.comparisonTarget) {
    comparison = {
      available: false,
      unavailableReason: "NO_EQUIVALENT_PREVIOUS_MONTH_DATE",
      unavailableMessage:
        "Comparison Unavailable — the previous month has no equivalent calendar date for this month-to-date window.",
      currentRange: currentComparisonRange,
      previousRange: null,
      currentTotalSalesCentavos: totalSalesCentavos,
      previousTotalSalesCentavos: null,
      amountChangeCentavos: null,
      percentChange: null,
    };
  } else {
    const target = input.range.comparisonTarget;
    const prevDaySet = new Set((input.previousBusinessDays ?? []).map((d) => d.businessDate));
    const missingPrevCount = target.dates.filter((d) => !prevDaySet.has(d)).length;
    const previousRange: DashboardComparisonRange = {
      from: target.from,
      to: target.to,
      isPartialEndDay: target.isPartialEndDay,
      cutoffAt: target.cutoffAt,
    };

    if (missingDayCount > 0 || missingPrevCount > 0) {
      comparison = {
        available: false,
        unavailableReason: "MISSING_STATION_DAY",
        unavailableMessage:
          "Comparison Unavailable — station-day records are missing for one or more dates in the matched periods.",
        currentRange: currentComparisonRange,
        previousRange,
        currentTotalSalesCentavos: totalSalesCentavos,
        previousTotalSalesCentavos: null,
        amountChangeCentavos: null,
        percentChange: null,
      };
    } else {
      const prevSales = input.previousTotalSalesCentavos ?? 0;
      const diff = totalSalesCentavos - prevSales;
      const percentChange =
        prevSales > 0 ? Math.round((diff * 1000) / prevSales) / 10 : null;
      comparison = {
        available: true,
        unavailableReason: null,
        unavailableMessage: null,
        currentRange: currentComparisonRange,
        previousRange,
        currentTotalSalesCentavos: totalSalesCentavos,
        previousTotalSalesCentavos: prevSales,
        amountChangeCentavos: diff,
        percentChange,
      };
    }
  }

  const recommendations: DashboardRecommendation[] = [];
  const overdueCount = input.calendarOverdueCount ?? null;
  if (overdueCount !== null && overdueCount > 0) {
    recommendations.push({
      id: "overdue-activities",
      type: "OVERDUE_ACTIVITIES",
      title: `Overdue station ${overdueCount === 1 ? "activity" : "activities"}`,
      observation: `${overdueCount} scheduled ${overdueCount === 1 ? "activity is" : "activities are"} overdue in Activity Calendar.`,
      suggestedAction:
        "Review Station Reminders and complete or reschedule overdue tasks in Activity Calendar.",
    });
  }

  if (
    comparison.available &&
    comparison.previousTotalSalesCentavos !== null &&
    comparison.previousTotalSalesCentavos > 0 &&
    comparison.amountChangeCentavos !== null &&
    comparison.amountChangeCentavos * 10 <= -comparison.previousTotalSalesCentavos
  ) {
    const pctLabel =
      comparison.percentChange !== null
        ? `${Math.abs(comparison.percentChange).toFixed(1).replace(/\.0$/, "")}%`
        : "10%+";
    recommendations.push({
      id: "sales-decline",
      type: "SALES_DECLINE",
      title: `Total sales declined by ${pctLabel}`,
      observation: `Total sales decreased by ${formatPesosForMessage(Math.abs(comparison.amountChangeCentavos))} compared with the matched previous period (${formatPesosForMessage(comparison.currentTotalSalesCentavos)} vs ${formatPesosForMessage(comparison.previousTotalSalesCentavos)}).`,
      suggestedAction:
        "Review daily POS transactions, voided receipts, and closed-day records to inspect where sales changed.",
    });
  }

  if (
    containersRefilled > 0 &&
    serviceAccum.PURIFIED.containers !== serviceAccum.ALKALINE.containers
  ) {
    const winner =
      serviceAccum.PURIFIED.containers > serviceAccum.ALKALINE.containers
        ? service[0]!
        : service[1]!;
    const winnerLabel = winner.waterType === "PURIFIED" ? "Purified" : "Alkaline";
    recommendations.push({
      id: "refill-leader",
      type: "REFILL_LEADER",
      title: `${winnerLabel} leads standalone refills`,
      observation: `${winnerLabel} accounted for ${winner.containers.toLocaleString("en-US")} of ${containersRefilled.toLocaleString("en-US")} standalone refills (${winner.sharePercent}%).`,
      suggestedAction: `Check ${winnerLabel.toLowerCase()} refill readiness and related caps or seals in Inventory.`,
    });
  }

  if (
    faucetSales.totalUnits > 0 &&
    (faucetSales.leader === "PUSH_TYPE" || faucetSales.leader === "TWIST_TYPE")
  ) {
    const winner = faucetSales.items.find((item) => item.type === faucetSales.leader)!;
    recommendations.push({
      id: "faucet-leader",
      type: "FAUCET_LEADER",
      title: `${winner.label} leads standalone faucet sales`,
      observation: `${winner.label} recorded ${winner.units.toLocaleString("en-US")} of ${faucetSales.totalUnits.toLocaleString("en-US")} typed standalone faucet units (${winner.sharePercent}%).`,
      suggestedAction: `Check ${winner.label.toLowerCase()} stock availability in Inventory.`,
    });
  }

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
    comparison,
    trend,
    service,
    faucetSales,
    containerSales,
    recommendations: recommendations.slice(0, 3),
    priorDaySettlements: input.priorDaySettlements,
  };
}
