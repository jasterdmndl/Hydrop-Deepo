/** Pure Asia/Manila formatting, month-grid, recurrence preview, and draft helpers for Activity Calendar. */

export type ActivityStatus = "SCHEDULED" | "OVERDUE" | "COMPLETED" | "CANCELLED";
export type ReminderStatus = "UPCOMING" | "OVERDUE";
export type RecurrenceRule = "ONE_TIME" | "DAILY" | "WEEKLY" | "MONTHLY";
export type ActivityEditScope = "THIS_OCCURRENCE" | "THIS_AND_FUTURE";

export const MAX_SERIES_OCCURRENCES = 1096;

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

export interface ScheduleSaveResponse extends ActivityView {
  activity: ActivityView;
  activities: ActivityView[];
  series: ActivitySeriesSummary | null;
  replayed: boolean;
}

export interface MutationSaveResponse extends ActivityView {
  activity: ActivityView;
  activities: ActivityView[];
  affectedReferences: string[];
  replayed: boolean;
}

export interface BulkPreviewResponse {
  preview: true;
  scope: ActivityEditScope;
  targetReference: string;
  affectedReferences: string[];
  affectedVersions: Record<string, number>;
  affectedActivities: ActivityView[];
  protectedActivities: ActivityView[];
  conflicts?: ActivityView[];
  conflictReferences?: string[];
  conflictDates?: string[];
}

export interface ActivitiesMonthResponse {
  month: string;
  scheduledActivities: ActivityView[];
  completedActivities: ActivityView[];
  cancelledActivities: ActivityView[];
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

export interface RemindersResponse {
  upcomingCount: number;
  overdueCount: number;
  items: ReminderItem[];
}

export interface MonthCell {
  date: string;
  dayNumber: number;
  inCurrentMonth: boolean;
}

export interface RequestTracker {
  next(): number;
  isCurrent(id: number): boolean;
}

export function createRequestTracker(): RequestTracker {
  let latest = 0;
  return {
    next() {
      latest += 1;
      return latest;
    },
    isCurrent(id: number) {
      return id === latest;
    },
  };
}

export function makeRequestKey(prefix = "cal"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

const MONTH_NAMES = [
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

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function parseYyyyMm(month: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Invalid month "${month}"`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

function parseYyyyMmDdStrict(dateStr: string): { year: number; month: number; day: number; isoDate: string } | null {
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
  return { year, month, day, isoDate: `${year}-${pad2(month)}-${pad2(day)}` };
}

function formatUtcYyyyMmDd(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function currentManilaDateAndTime(now: Date = new Date()): {
  date: string;
  time: string;
  month: string;
} {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hour = pad2(shifted.getUTCHours());
  const minute = pad2(shifted.getUTCMinutes());
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    month: `${year}-${month}`,
  };
}

export function shiftMonth(month: string, deltaMonths: number): string {
  const parsed = parseYyyyMm(month);
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1 + deltaMonths, 1));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}`;
}

export function formatMonthHeading(month: string): string {
  const parsed = parseYyyyMm(month);
  return `${MONTH_NAMES[parsed.month - 1]} ${parsed.year}`;
}

/** Builds a Sunday-first calendar grid (35 or 42 cells) for `YYYY-MM`. */
export function buildMonthGrid(month: string): MonthCell[] {
  const parsed = parseYyyyMm(month);
  const firstOfMonth = new Date(Date.UTC(parsed.year, parsed.month - 1, 1));
  const startWeekday = firstOfMonth.getUTCDay();
  const daysInMonth = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate();
  const totalCells = startWeekday + daysInMonth > 35 ? 42 : 35;

  const cells: MonthCell[] = [];
  for (let i = 0; i < totalCells; i += 1) {
    const cellDate = new Date(Date.UTC(parsed.year, parsed.month - 1, 1 - startWeekday + i));
    const cellMonth = `${cellDate.getUTCFullYear()}-${pad2(cellDate.getUTCMonth() + 1)}`;
    cells.push({
      date: formatUtcYyyyMmDd(cellDate),
      dayNumber: cellDate.getUTCDate(),
      inCurrentMonth: cellMonth === month,
    });
  }
  return cells;
}

export function formatTime12h(timeStr: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return timeStr;
  const hour24 = Number(match[1]);
  const minute = match[2];
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minute} ${period}`;
}

export function formatLongDate(dateStr: string, includeWeekday = true): string {
  const parts = parseYyyyMmDdStrict(dateStr);
  if (!parts) return dateStr;
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const monthName = MONTH_NAMES[parts.month - 1];
  if (!includeWeekday) return `${monthName} ${parts.day}, ${parts.year}`;
  const weekday = WEEKDAYS[utc.getUTCDay()];
  return `${weekday}, ${monthName} ${parts.day}, ${parts.year}`;
}

export function formatShortDateTime(dateStr: string, timeStr: string): string {
  const parts = parseYyyyMmDdStrict(dateStr);
  if (!parts) return `${dateStr} · ${formatTime12h(timeStr)}`;
  return `${SHORT_MONTHS[parts.month - 1]} ${parts.day} · ${formatTime12h(timeStr)}`;
}

export function formatManilaTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const manila = currentManilaDateAndTime(parsed);
  const dateParts = parseYyyyMmDdStrict(manila.date);
  if (!dateParts) return iso;
  return `${SHORT_MONTHS[dateParts.month - 1]} ${dateParts.day}, ${dateParts.year} · ${formatTime12h(manila.time)}`;
}

export function formatRecurrenceLabel(recurrence: RecurrenceRule): string {
  switch (recurrence) {
    case "ONE_TIME":
      return "One-time";
    case "DAILY":
      return "Daily";
    case "WEEKLY":
      return "Weekly";
    case "MONTHLY":
      return "Monthly";
  }
}

export function formatScopeLabel(scope: ActivityEditScope): string {
  return scope === "THIS_AND_FUTURE" ? "This and future occurrences" : "This occurrence only";
}

export function reminderBadgeLabel(scheduledDate: string, status: ReminderStatus, todayDate: string, justScheduled: boolean): string {
  if (justScheduled) return "Just scheduled";
  if (status === "OVERDUE") {
    const yesterday = previousDateStr(todayDate);
    return scheduledDate === yesterday ? "Due yesterday" : "Overdue";
  }
  return scheduledDate === todayDate ? "Today" : "Scheduled";
}

function previousDateStr(dateStr: string): string {
  const parts = parseYyyyMmDdStrict(dateStr);
  if (!parts) return "";
  const prev = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1));
  return formatUtcYyyyMmDd(prev);
}

export type RepeatSchedulePreview =
  | { ok: true; dates: string[] }
  | { ok: false; message: string };

/**
 * Mirrors the server recurrence preview rules so the Owner sees exact occurrence
 * dates and the 1,096-occurrence limit before saving.
 */
export function previewRepeatSchedule(input: {
  scheduledDate: string;
  recurrence: RecurrenceRule;
  endDate: string;
}): RepeatSchedulePreview {
  const start = parseYyyyMmDdStrict(input.scheduledDate);
  if (!start) {
    return { ok: false, message: "Choose a valid scheduled date." };
  }

  if (input.recurrence === "ONE_TIME") {
    return { ok: true, dates: [start.isoDate] };
  }

  if (!input.endDate.trim()) {
    return { ok: false, message: "Enter an end date for repeating activities." };
  }

  const end = parseYyyyMmDdStrict(input.endDate);
  if (!end) {
    return { ok: false, message: "Enter a valid end date." };
  }
  if (end.isoDate < start.isoDate) {
    return { ok: false, message: "End date must be on or after the start date." };
  }

  const dates: string[] = [];
  if (input.recurrence === "DAILY" || input.recurrence === "WEEKLY") {
    const step = input.recurrence === "DAILY" ? 1 : 7;
    for (let i = 0; ; i += 1) {
      const candidate = new Date(Date.UTC(start.year, start.month - 1, start.day + i * step));
      const iso = formatUtcYyyyMmDd(candidate);
      if (iso > end.isoDate) break;
      if (dates.length >= MAX_SERIES_OCCURRENCES) {
        return {
          ok: false,
          message: "Repeating schedules can include at most 1,096 occurrences at once. Choose an earlier end date.",
        };
      }
      dates.push(iso);
    }
    return { ok: true, dates };
  }

  const preferredDay = start.day;
  for (let monthOffset = 0; ; monthOffset += 1) {
    const zeroBasedMonth = start.month - 1 + monthOffset;
    const targetYear = start.year + Math.floor(zeroBasedMonth / 12);
    const targetMonth = (zeroBasedMonth % 12) + 1;
    const daysInMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    const targetDay = Math.min(preferredDay, daysInMonth);
    const iso = `${targetYear}-${pad2(targetMonth)}-${pad2(targetDay)}`;
    if (iso > end.isoDate) break;
    if (dates.length >= MAX_SERIES_OCCURRENCES) {
      return {
        ok: false,
        message: "Repeating schedules can include at most 1,096 occurrences at once. Choose an earlier end date.",
      };
    }
    dates.push(iso);
  }
  return { ok: true, dates };
}

/**
 * Canonical draft signature for requestKey preservation: retries and
 * conflict-continuation submissions for the same draft keep the same key,
 * while editing any field produces a fresh signature and key.
 */
export function scheduleDraftSignature(draft: {
  name: string;
  scheduledDate: string;
  scheduledTime: string;
  scheduleNotes: string;
  recurrence?: RecurrenceRule;
  endDate?: string;
}): string {
  const recurrence = draft.recurrence ?? "ONE_TIME";
  const endDate = recurrence === "ONE_TIME" ? "" : (draft.endDate ?? "").trim();
  return JSON.stringify([
    draft.name.trim(),
    draft.scheduledDate.trim(),
    draft.scheduledTime.trim(),
    draft.scheduleNotes.trim(),
    recurrence,
    endDate,
  ]);
}

export function editDraftSignature(draft: {
  reference: string;
  expectedVersion: number;
  scope: ActivityEditScope;
  name: string;
  scheduledDate: string;
  scheduledTime: string;
  scheduleNotes: string;
  expectedAffectedReferences?: string[];
}): string {
  return JSON.stringify([
    draft.reference,
    draft.expectedVersion,
    draft.scope,
    draft.name.trim(),
    draft.scheduledDate.trim(),
    draft.scheduledTime.trim(),
    draft.scheduleNotes.trim(),
    draft.expectedAffectedReferences ?? [],
  ]);
}

export function cancelDraftSignature(draft: {
  reference: string;
  expectedVersion: number;
  scope: ActivityEditScope;
  reason: string;
  expectedAffectedReferences?: string[];
}): string {
  return JSON.stringify([
    draft.reference,
    draft.expectedVersion,
    draft.scope,
    draft.reason.trim(),
    draft.expectedAffectedReferences ?? [],
  ]);
}

export function correctionDraftSignature(draft: {
  reference: string;
  expectedVersion: number;
  completedDate: string;
  completedTime: string;
  completionNotes: string;
  reason: string;
}): string {
  return JSON.stringify([
    draft.reference,
    draft.expectedVersion,
    draft.completedDate.trim(),
    draft.completedTime.trim(),
    draft.completionNotes.trim(),
    draft.reason.trim(),
  ]);
}

/**
 * Resolves the selected activity when focusing a calendar date so stale details
 * from another date are cleared whenever the chosen date is empty or ambiguous.
 */
export function resolveSelectedActivityForDate(
  current: ActivityView | null,
  date: string,
  dayActivities: ActivityView[],
): ActivityView | null {
  if (dayActivities.length === 1) {
    return dayActivities[0]!;
  }
  if (current && current.scheduledDate === date && dayActivities.some((item) => item.reference === current.reference)) {
    return current;
  }
  return null;
}
