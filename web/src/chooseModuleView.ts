import type { RemindersResponse } from "./calendar/calendarView";
import type { PendingCheckoutRecovery, PosDayResponse } from "./pos/posRecovery";

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

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const SIDEBAR_ORDER = ["dashboard", "pos", "calendar", "inventory"] as const;
const HOME_CARD_ORDER = ["pos", "dashboard", "calendar", "inventory"] as const;

function manilaParts(now: Date = new Date()): {
  year: number;
  monthIndex: number;
  day: number;
  weekdayIndex: number;
  hour: number;
} {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekdayIndex: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
  };
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

export function manilaGreeting(now: Date = new Date()): "Good morning" | "Good afternoon" | "Good evening" {
  const { hour } = manilaParts(now);
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function formatManilaFullDate(now: Date = new Date()): string {
  const parts = manilaParts(now);
  return `${WEEKDAYS[parts.weekdayIndex]}, ${MONTH_NAMES[parts.monthIndex]} ${parts.day}, ${parts.year}`;
}

export function formatManilaBannerDate(now: Date = new Date()): string {
  const parts = manilaParts(now);
  return `${WEEKDAYS[parts.weekdayIndex]}, ${MONTH_NAMES[parts.monthIndex]} ${parts.day}`;
}

export function formatDueDateForCallout(scheduledDate: string, now: Date = new Date()): string {
  const parsed = parseYyyyMmDd(scheduledDate);
  if (!parsed) return scheduledDate;
  const monthName = MONTH_NAMES[parsed.month - 1]!;
  const currentManilaYear = manilaParts(now).year;
  if (parsed.year === currentManilaYear) {
    return `${monthName} ${parsed.day}`;
  }
  return `${monthName} ${parsed.day}, ${parsed.year}`;
}

export function orderSidebarModules<T extends { key: string }>(modules: T[]): T[] {
  const byKey = new Map<string, T>();
  const extras: T[] = [];
  for (const mod of modules) {
    if ((SIDEBAR_ORDER as readonly string[]).includes(mod.key) && !byKey.has(mod.key)) {
      byKey.set(mod.key, mod);
    } else {
      extras.push(mod);
    }
  }
  const ordered: T[] = [];
  for (const key of SIDEBAR_ORDER) {
    const entry = byKey.get(key);
    if (entry) ordered.push(entry);
  }
  return [...ordered, ...extras];
}

export function selectHomeCardModules<T extends { key: string }>(modules: T[]): T[] {
  const byKey = new Map(modules.map((mod) => [mod.key, mod]));
  const selected: T[] = [];
  for (const key of HOME_CARD_ORDER) {
    const entry = byKey.get(key);
    if (entry) selected.push(entry);
  }
  return selected;
}

export interface OverdueAttentionView {
  title: string;
  body: string;
  overdueCount: number;
}

export function buildOverdueAttention(
  reminders: RemindersResponse | null,
  role: "OWNER" | "CASHIER",
  now: Date = new Date(),
): OverdueAttentionView | null {
  if (!reminders || reminders.overdueCount <= 0) return null;
  const firstOverdue = reminders.items.find((item) => item.status === "OVERDUE");
  if (!firstOverdue) return null;

  const title =
    reminders.overdueCount === 1
      ? "One activity needs your attention"
      : `${reminders.overdueCount} activities need your attention`;

  const dueText = formatDueDateForCallout(firstOverdue.scheduledDate, now);
  const extra = reminders.overdueCount > 1 ? ` (+${reminders.overdueCount - 1} more overdue)` : "";
  const body =
    role === "OWNER"
      ? `${firstOverdue.name} was due ${dueText}${extra}. Open Activity Calendar to review and record completion.`
      : `${firstOverdue.name} was due ${dueText}${extra}. Open Activity Calendar to view details. Only the Owner can record completion.`;

  return {
    title,
    body,
    overdueCount: reminders.overdueCount,
  };
}

export function collectPendingPaymentReferences(
  localRecoveries: PendingCheckoutRecovery[],
  posDay: PosDayResponse | null,
): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];

  const addRef = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const normalized = trimmed.toUpperCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    refs.push(trimmed);
  };

  for (const recovery of localRecoveries) {
    addRef(recovery.reference);
  }
  for (const checkout of posDay?.unresolvedCheckouts ?? []) {
    addRef(checkout.reference);
  }

  return refs;
}

export interface SidebarPresentationState {
  drawerActive: boolean;
  sidebarCollapsed: boolean;
  sidebarHidden: boolean;
  sidebarExpanded: boolean;
  toggleLabel: string;
}

export function resolveSidebarState(
  isDrawerMode: boolean,
  drawerOpen: boolean,
  wideSidebarOpen: boolean,
): SidebarPresentationState {
  const drawerActive = isDrawerMode && drawerOpen;
  const sidebarCollapsed = !isDrawerMode && !wideSidebarOpen;
  const sidebarHidden = isDrawerMode ? !drawerOpen : !wideSidebarOpen;
  const sidebarExpanded = isDrawerMode ? drawerActive : wideSidebarOpen;
  const toggleLabel = isDrawerMode
    ? "Open navigation menu"
    : wideSidebarOpen
      ? "Hide navigation sidebar"
      : "Show navigation sidebar";
  return { drawerActive, sidebarCollapsed, sidebarHidden, sidebarExpanded, toggleLabel };
}
