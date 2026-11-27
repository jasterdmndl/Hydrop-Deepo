import {
  fromManilaWallClock,
  manilaParts,
  type RecurrenceRule,
} from "./calendar.js";

export const MAX_SERIES_OCCURRENCES = 1096;

const SERIES_LIMIT_MESSAGE =
  "Repeating schedules can include at most 1,096 occurrences at once. Choose an earlier end date.";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatIsoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function daysInGregorianMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parses a strict YYYY-MM-DD calendar date in Asia/Manila wall-clock space,
 * rejecting impossible dates such as 2026-02-29 or 2026-04-31.
 */
export function parseManilaDateOnly(raw: string): {
  year: number;
  month: number;
  day: number;
  isoDate: string;
} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
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

  return { year, month, day, isoDate: formatIsoDate(year, month, day) };
}

export type GeneratedOccurrenceSchedule =
  | {
      ok: true;
      occurrences: Date[];
      startDate: string;
      endDate: string | null;
      scheduledTime: string;
      preferredDayOfMonth: number | null;
      weekday: number | null;
    }
  | {
      ok: false;
      message: string;
    };

/**
 * Generates inclusive Asia/Manila occurrence timestamps for ONE_TIME, DAILY,
 * WEEKLY, and MONTHLY rules without host-timezone drift.
 */
export function generateOccurrenceSchedule(input: {
  scheduledAt: Date;
  recurrence: RecurrenceRule;
  endDate?: string;
}): GeneratedOccurrenceSchedule {
  const start = manilaParts(input.scheduledAt);
  const startDate = formatIsoDate(start.year, start.month, start.day);
  const scheduledTime = `${pad2(start.hour)}:${pad2(start.minute)}`;
  const rawEndDate = input.endDate?.trim() ?? "";

  if (input.recurrence === "ONE_TIME") {
    if (rawEndDate.length > 0) {
      return { ok: false, message: "One-time activities cannot include an end date." };
    }
    return {
      ok: true,
      occurrences: [input.scheduledAt],
      startDate,
      endDate: null,
      scheduledTime,
      preferredDayOfMonth: null,
      weekday: null,
    };
  }

  if (!rawEndDate) {
    return { ok: false, message: "Enter an end date for repeating activities." };
  }

  const parsedEnd = parseManilaDateOnly(rawEndDate);
  if (!parsedEnd) {
    return { ok: false, message: "Enter a valid end date." };
  }

  if (parsedEnd.isoDate < startDate) {
    return { ok: false, message: "End date must be on or after the start date." };
  }

  const occurrences: Date[] = [];

  if (input.recurrence === "DAILY" || input.recurrence === "WEEKLY") {
    const stepDays = input.recurrence === "DAILY" ? 1 : 7;
    const weekday =
      input.recurrence === "WEEKLY"
        ? new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay()
        : null;

    for (let index = 0; ; index += 1) {
      const candidate = new Date(Date.UTC(start.year, start.month - 1, start.day + index * stepDays));
      const y = candidate.getUTCFullYear();
      const m = candidate.getUTCMonth() + 1;
      const d = candidate.getUTCDate();
      const iso = formatIsoDate(y, m, d);
      if (iso > parsedEnd.isoDate) break;

      if (occurrences.length >= MAX_SERIES_OCCURRENCES) {
        return {
          ok: false,
          message: SERIES_LIMIT_MESSAGE,
        };
      }

      const occurrenceUtc = fromManilaWallClock(y, m, d, start.hour, start.minute);
      if (!occurrenceUtc) {
        return { ok: false, message: "Enter a valid scheduled date and time." };
      }
      occurrences.push(occurrenceUtc);
    }

    return {
      ok: true,
      occurrences,
      startDate,
      endDate: parsedEnd.isoDate,
      scheduledTime,
      preferredDayOfMonth: null,
      weekday,
    };
  }

  // Monthly retains the preferred day of the month and clamps shorter months to their last day.
  const preferredDayOfMonth = start.day;
  for (let monthOffset = 0; ; monthOffset += 1) {
    const zeroBasedMonth = start.month - 1 + monthOffset;
    const targetYear = start.year + Math.floor(zeroBasedMonth / 12);
    const targetMonth = (zeroBasedMonth % 12) + 1;
    const targetDay = Math.min(preferredDayOfMonth, daysInGregorianMonth(targetYear, targetMonth));
    const iso = formatIsoDate(targetYear, targetMonth, targetDay);
    if (iso > parsedEnd.isoDate) break;

    if (occurrences.length >= MAX_SERIES_OCCURRENCES) {
      return {
        ok: false,
        message: SERIES_LIMIT_MESSAGE,
      };
    }

    const occurrenceUtc = fromManilaWallClock(targetYear, targetMonth, targetDay, start.hour, start.minute);
    if (!occurrenceUtc) {
      return { ok: false, message: "Enter a valid scheduled date and time." };
    }
    occurrences.push(occurrenceUtc);
  }

  return {
    ok: true,
    occurrences,
    startDate,
    endDate: parsedEnd.isoDate,
    scheduledTime,
    preferredDayOfMonth,
    weekday: null,
  };
}
