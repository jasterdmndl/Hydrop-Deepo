import type { Role } from "../auth/policy.js";

/**
 * Calendar domain rules and Asia/Manila time calculations
 * (CAL-001, CAL-002, CAL-003 one-time, planning sections 13.4 and 13.5).
 */
export interface CalendarPermissions {
  canView: boolean;
  /** Schedule activities and record completion (Owner only, NAV-001). */
  canManage: boolean;
}

export function calendarPermissions(role: Role): CalendarPermissions {
  return { canView: true, canManage: role === "OWNER" };
}

export type ActivityStatus = "SCHEDULED" | "OVERDUE" | "COMPLETED" | "CANCELLED";
export type ReminderStatus = "UPCOMING" | "OVERDUE";
export type RecurrenceRule = "ONE_TIME" | "DAILY" | "WEEKLY" | "MONTHLY";
export type ActivityEditScope = "THIS_OCCURRENCE" | "THIS_AND_FUTURE";

export interface ActivitySeriesSummary {
  reference: string;
  recurrence: Exclude<RecurrenceRule, "ONE_TIME">;
  startDate: string;
  endDate: string;
  scheduledTime: string;
  occurrenceCount: number;
  occurrenceReferences: string[];
}

export interface ActivityCancellationView {
  reason: string;
  cancelledBy: string;
  cancelledAt: string;
}

export interface ActivityChangeView {
  id: string;
  changeType: "EDIT" | "CANCEL";
  scope: ActivityEditScope;
  previousName: string;
  newName: string;
  previousScheduledAt: string;
  previousScheduledDate: string;
  previousScheduledTime: string;
  newScheduledAt: string;
  newScheduledDate: string;
  newScheduledTime: string;
  previousScheduleNotes: string | null;
  newScheduleNotes: string | null;
  reason: string | null;
  changedBy: string;
  changedAt: string;
}

export interface ActivityCompletionCorrectionView {
  id: string;
  previousActualCompletedAt: string;
  previousCompletedDate: string;
  previousCompletedTime: string;
  previousCompletionNotes: string;
  newActualCompletedAt: string;
  newCompletedDate: string;
  newCompletedTime: string;
  newCompletionNotes: string;
  reason: string;
  correctedBy: string;
  correctedAt: string;
}

export interface ActivityCompletionView {
  actualCompletedAt: string;
  completedDate: string;
  completedTime: string;
  notes: string;
  completionNotes: string;
  recordedBy: string;
  recordedAt: string;
  originalActualCompletedAt: string;
  originalCompletedDate: string;
  originalCompletedTime: string;
  originalCompletionNotes: string;
  corrections: ActivityCompletionCorrectionView[];
}

export interface ActivityView {
  reference: string;
  version: number;
  name: string;
  scheduledAt: string;
  scheduledDate: string;
  scheduledTime: string;
  scheduleNotes: string | null;
  originalName: string;
  originalScheduledAt: string;
  originalScheduledDate: string;
  originalScheduledTime: string;
  originalScheduleNotes: string | null;
  status: ActivityStatus;
  recurrence: RecurrenceRule;
  seriesReference: string | null;
  seriesIndex: number | null;
  seriesEndDate: string | null;
  cancellation: ActivityCancellationView | null;
  scheduleHistory: ActivityChangeView[];
  createdBy: string;
  createdAt: string;
  actualCompletedAt: string | null;
  completedDate: string | null;
  completedTime: string | null;
  completionNotes: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
  completion: ActivityCompletionView | null;
}

export interface ReminderItem {
  reference: string;
  name: string;
  scheduledAt: string;
  scheduledDate: string;
  scheduledTime: string;
  scheduleNotes: string | null;
  status: ReminderStatus;
}

// Asia/Manila is fixed UTC+08:00 with no daylight saving transitions.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function manilaParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const shifted = new Date(date.getTime() + MANILA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

export function fromManilaWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
  ms = 0,
): Date | null {
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (
    Number.isNaN(check.getTime()) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return new Date(check.getTime() - MANILA_OFFSET_MS);
}

function parseTimeString(raw: string): { hour: number; minute: number } | null {
  const trimmed = raw.trim();
  const match24 = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (match24) {
    const hour = Number(match24[1]);
    const minute = Number(match24[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
    return null;
  }

  const match12 = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(trimmed);
  if (match12) {
    const rawHour = Number(match12[1]);
    const minute = Number(match12[2]);
    const period = match12[3]!.toUpperCase();
    if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
      return null;
    }
    const hour = period === "AM" ? (rawHour === 12 ? 0 : rawHour) : rawHour === 12 ? 12 : rawHour + 12;
    return { hour, minute };
  }

  return null;
}

function parseDateAndTime(dateStr: string, timeStr: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;
  const parsedTime = parseTimeString(timeStr);
  if (!parsedTime) return null;
  return fromManilaWallClock(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    parsedTime.hour,
    parsedTime.minute,
  );
}

const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/i;

function parseIsoTimestamp(raw: string): Date | null {
  const match = ISO_TIMESTAMP_RE.exec(raw.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] !== undefined ? Number(match[6]) : 0;
  const ms = match[7] !== undefined ? Number(match[7].slice(0, 3).padEnd(3, "0")) : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (match[8]!.toUpperCase() !== "Z") {
    const sign = match[9] === "-" ? -1 : 1;
    const offsetHours = Number(match[10]);
    const offsetMins = Number(match[11]);
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }

  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (
    Number.isNaN(check.getTime()) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }

  return new Date(check.getTime() - offsetMinutes * 60_000);
}

export function parseManilaDateTimeInput(input: {
  date?: string;
  time?: string;
  iso?: string;
  truncateToMinute?: boolean;
}): Date | null {
  const hasDateOrTime = input.date !== undefined || input.time !== undefined;
  let fromParts: Date | null = null;
  if (hasDateOrTime) {
    if (!input.date || !input.time) return null;
    fromParts = parseDateAndTime(input.date, input.time);
    if (!fromParts) return null;
  }

  let fromIso: Date | null = null;
  if (input.iso !== undefined) {
    fromIso = parseIsoTimestamp(input.iso);
    if (!fromIso) return null;
    if (input.truncateToMinute) {
      fromIso = new Date(Math.floor(fromIso.getTime() / 60_000) * 60_000);
    }
  }

  if (fromParts && fromIso) {
    return fromParts.getTime() === fromIso.getTime() ? fromParts : null;
  }
  return fromParts ?? fromIso;
}

export function parseManilaMonth(
  monthParam: string | undefined,
  now: Date,
): { month: string; startUtc: Date; endUtc: Date } | null {
  let year: number;
  let month: number;

  if (monthParam === undefined) {
    const current = manilaParts(now);
    year = current.year;
    month = current.month;
  } else {
    const match = /^(\d{4})-(\d{2})$/.exec(monthParam.trim());
    if (!match) return null;
    year = Number(match[1]);
    month = Number(match[2]);
    if (month < 1 || month > 12) return null;
  }

  const startUtc = fromManilaWallClock(year, month, 1, 0, 0, 0, 0);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endUtc = fromManilaWallClock(nextYear, nextMonth, 1, 0, 0, 0, 0);
  if (!startUtc || !endUtc) return null;

  return {
    month: `${year}-${pad2(month)}`,
    startUtc,
    endUtc,
  };
}

/**
 * Upcoming reminders cover `now` (inclusive) through the end of the 6th following
 * Manila calendar day (7 calendar days including today), meaning strictly before
 * 00:00:00+08:00 on the 7th following Manila day.
 */
export function manilaReminderWindow(now: Date): { nowUtc: Date; upcomingCutoffUtc: Date } {
  const { year, month, day } = manilaParts(now);
  const cutoffMs = Date.UTC(year, month - 1, day + 7, 0, 0, 0, 0) - MANILA_OFFSET_MS;
  return { nowUtc: now, upcomingCutoffUtc: new Date(cutoffMs) };
}

export function formatManilaIso(date: Date): string {
  const p = manilaParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}+08:00`;
}

export function formatManilaDate(date: Date): string {
  const p = manilaParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function formatManilaTime(date: Date): string {
  const p = manilaParts(date);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function manilaMonthDayCode(date: Date): string {
  const p = manilaParts(date);
  return `${pad2(p.month)}${pad2(p.day)}`;
}

export function deriveActivityStatus(
  scheduledAt: Date,
  completed: boolean,
  now: Date,
  cancelled = false,
): ActivityStatus {
  if (cancelled) return "CANCELLED";
  if (completed) return "COMPLETED";
  return scheduledAt.getTime() < now.getTime() ? "OVERDUE" : "SCHEDULED";
}

export function manilaDayDelta(from: Date, to: Date): number {
  const f = manilaParts(from);
  const t = manilaParts(to);
  const fromUtcDay = Date.UTC(f.year, f.month - 1, f.day);
  const toUtcDay = Date.UTC(t.year, t.month - 1, t.day);
  return Math.round((toUtcDay - fromUtcDay) / 86_400_000);
}

export function shiftManilaDateKeepingTime(
  baseDate: Date,
  dayDelta: number,
  hour: number,
  minute: number,
): Date | null {
  const p = manilaParts(baseDate);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + dayDelta));
  return fromManilaWallClock(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    hour,
    minute,
  );
}

export function manilaMonthDelta(from: Date, to: Date): number {
  const f = manilaParts(from);
  const t = manilaParts(to);
  return t.year * 12 + (t.month - 1) - (f.year * 12 + (f.month - 1));
}

export function shiftManilaMonthlyKeepingPreferredDay(
  baseDate: Date,
  monthDelta: number,
  preferredDay: number,
  hour: number,
  minute: number,
): Date | null {
  const p = manilaParts(baseDate);
  const targetZeroBasedMonth = p.year * 12 + (p.month - 1) + monthDelta;
  const targetYear = Math.floor(targetZeroBasedMonth / 12);
  const targetMonth = (targetZeroBasedMonth % 12) + 1;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const clampedDay = Math.min(preferredDay, daysInTargetMonth);
  return fromManilaWallClock(targetYear, targetMonth, clampedDay, hour, minute);
}

export function conflictSetsEqual(acknowledged: string[], actual: string[]): boolean {
  const ackSet = new Set(acknowledged.map((s) => s.trim()).filter(Boolean));
  const actualSet = new Set(actual.map((s) => s.trim()).filter(Boolean));
  if (actualSet.size === 0 || ackSet.size !== actualSet.size) return false;
  for (const ref of actualSet) {
    if (!ackSet.has(ref)) return false;
  }
  return true;
}
