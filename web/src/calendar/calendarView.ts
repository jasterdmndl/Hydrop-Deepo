/** Pure Asia/Manila formatting, month-grid, and draft helpers for Activity Calendar. */

export type ActivityStatus = "SCHEDULED" | "OVERDUE" | "COMPLETED";
export type ReminderStatus = "UPCOMING" | "OVERDUE";

export interface ActivityCompletionView {
  actualCompletedAt: string;
  completedDate: string;
  completedTime: string;
  notes: string;
  completionNotes: string;
  recordedBy: string;
  recordedAt: string;
}

export interface ActivityView {
  reference: string;
  name: string;
  scheduledAt: string;
  scheduledDate: string;
  scheduledTime: string;
  scheduleNotes: string | null;
  status: ActivityStatus;
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

export interface ActivitiesMonthResponse {
  month: string;
  scheduledActivities: ActivityView[];
  completedActivities: ActivityView[];
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

function parseYyyyMmDd(dateStr: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
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
  const parts = parseYyyyMmDd(dateStr);
  if (!parts) return dateStr;
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const monthName = MONTH_NAMES[parts.month - 1];
  if (!includeWeekday) return `${monthName} ${parts.day}, ${parts.year}`;
  const weekday = WEEKDAYS[utc.getUTCDay()];
  return `${weekday}, ${monthName} ${parts.day}, ${parts.year}`;
}

export function formatShortDateTime(dateStr: string, timeStr: string): string {
  const parts = parseYyyyMmDd(dateStr);
  if (!parts) return `${dateStr} · ${formatTime12h(timeStr)}`;
  return `${SHORT_MONTHS[parts.month - 1]} ${parts.day} · ${formatTime12h(timeStr)}`;
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
  const parts = parseYyyyMmDd(dateStr);
  if (!parts) return "";
  const prev = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1));
  return formatUtcYyyyMmDd(prev);
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
}): string {
  return JSON.stringify([
    draft.name.trim(),
    draft.scheduledDate.trim(),
    draft.scheduledTime.trim(),
    draft.scheduleNotes.trim(),
  ]);
}
