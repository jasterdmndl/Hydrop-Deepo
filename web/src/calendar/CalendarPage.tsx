import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useSignedInUser } from "../auth/AuthContext";
import { AppShell, useModulesData } from "../ChooseModule";
import { nextNoticeId, type NoticeEnvelope, wrapNotice } from "../notifications/noticeTiming";
import { TemporaryNotice } from "../notifications/TemporaryNotice";
import {
  type ActivitiesMonthResponse,
  type ActivityChangeView,
  type ActivityCompletionCorrectionView,
  type ActivityView,
  buildMonthGrid,
  createRequestTracker,
  currentManilaDateAndTime,
  formatLongDate,
  formatManilaTimestamp,
  formatMonthHeading,
  formatRecurrenceLabel,
  formatScopeLabel,
  formatShortDateTime,
  formatTime12h,
  type MutationSaveResponse,
  reminderBadgeLabel,
  type RemindersResponse,
  resolveSelectedActivityForDate,
  type ScheduleSaveResponse,
  shiftMonth,
} from "./calendarView";
import { ManageActivityForm } from "./ManageActivityForm";
import { RecordCompletionForm } from "./RecordCompletionForm";
import { ScheduleActivityForm } from "./ScheduleActivityForm";

interface CalendarAccess {
  canView: boolean;
  canManage: boolean;
}

type CalendarTab = "calendar" | "history" | "cancelled";
type CalendarMode = "overview" | "schedule" | "complete" | "correct" | "edit" | "cancel";

type BannerState =
  | { id: number; kind: "scheduled"; activity: ActivityView; count: number }
  | { id: number; kind: "edited"; activity: ActivityView; count: number }
  | { id: number; kind: "cancelled"; activity: ActivityView; count: number }
  | { id: number; kind: "completed"; activity: ActivityView }
  | { id: number; kind: "corrected"; activity: ActivityView }
  | null;

const WEEKDAY_HEADERS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

function statusBadgeLabel(status: ActivityView["status"]): string {
  switch (status) {
    case "SCHEDULED":
      return "Scheduled";
    case "OVERDUE":
      return "Overdue";
    case "COMPLETED":
      return "Completed";
    case "CANCELLED":
      return "Cancelled";
  }
}

function statusPillClass(status: ActivityView["status"]): string {
  switch (status) {
    case "SCHEDULED":
      return "pill--scheduled";
    case "OVERDUE":
      return "pill--overdue";
    case "COMPLETED":
      return "pill--completed";
    case "CANCELLED":
      return "pill--cancelled";
  }
}

function ScheduleHistorySection({ history }: { history: ActivityChangeView[] }) {
  if (history.length === 0) return null;
  return (
    <div className="detail-notes">
      <h3>Schedule history</h3>
      <ul className="history-timeline">
        {history.map((entry) => (
          <li key={entry.id} className="history-timeline__item">
            <div className="history-timeline__head">
              <strong>{entry.changeType === "CANCEL" ? "Cancelled" : "Rescheduled / edited"}</strong>
              <span className="muted-sm">{formatScopeLabel(entry.scope)}</span>
            </div>
            {entry.changeType === "EDIT" && (
              <p className="muted-sm">
                {formatShortDateTime(entry.previousScheduledDate, entry.previousScheduledTime)} →{" "}
                {formatShortDateTime(entry.newScheduledDate, entry.newScheduledTime)}
                {entry.previousName !== entry.newName ? ` · "${entry.previousName}" → "${entry.newName}"` : ""}
              </p>
            )}
            {entry.reason && <p className="muted-sm">Reason: {entry.reason}</p>}
            <p className="muted-sm">
              By {entry.changedBy} on {formatManilaTimestamp(entry.changedAt)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CompletionCorrectionsSection({ corrections }: { corrections: ActivityCompletionCorrectionView[] }) {
  if (corrections.length === 0) return null;
  return (
    <div className="detail-notes">
      <h3>Completion corrections ({corrections.length})</h3>
      <ul className="history-timeline">
        {corrections.map((corr, index) => (
          <li key={corr.id} className="history-timeline__item">
            <div className="history-timeline__head">
              <strong>Correction #{index + 1}</strong>
              <span className="muted-sm">{formatManilaTimestamp(corr.correctedAt)}</span>
            </div>
            <p className="muted-sm">
              {formatShortDateTime(corr.previousCompletedDate, corr.previousCompletedTime)} →{" "}
              {formatShortDateTime(corr.newCompletedDate, corr.newCompletedTime)}
            </p>
            <p className="muted-sm">
              Notes: {corr.previousCompletionNotes} → {corr.newCompletionNotes}
            </p>
            <p className="muted-sm">Reason: {corr.reason}</p>
            <p className="muted-sm">Corrected by {corr.correctedBy}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CalendarPage() {
  const user = useSignedInUser();
  const { data: modulesData } = useModulesData();
  const manilaNow = useMemo(() => currentManilaDateAndTime(), []);

  const [access, setAccess] = useState<CalendarAccess | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(manilaNow.month);
  const [historyMonth, setHistoryMonth] = useState(manilaNow.month);
  const [cancelledMonth, setCancelledMonth] = useState(manilaNow.month);
  const [monthData, setMonthData] = useState<ActivitiesMonthResponse | null>(null);
  const [historyData, setHistoryData] = useState<ActivitiesMonthResponse | null>(null);
  const [cancelledData, setCancelledData] = useState<ActivitiesMonthResponse | null>(null);
  const [reminders, setReminders] = useState<RemindersResponse | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<CalendarTab>("calendar");
  const [mode, setMode] = useState<CalendarMode>("overview");

  const [selectedDate, setSelectedDate] = useState<string>(manilaNow.date);
  const [selectedActivity, setSelectedActivity] = useState<ActivityView | null>(null);
  const [actionTarget, setActionTarget] = useState<ActivityView | null>(null);
  const [banner, setBanner] = useState<BannerState>(null);
  const [justScheduledRef, setJustScheduledRef] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<NoticeEnvelope<string> | null>(null);
  const loadTrackerRef = useRef(createRequestTracker());
  const detailTrackerRef = useRef(createRequestTracker());
  const actionTrackerRef = useRef(createRequestTracker());

  const invalidatePendingLookups = useCallback(() => {
    detailTrackerRef.current.next();
    actionTrackerRef.current.next();
  }, []);

  useEffect(() => invalidatePendingLookups, [invalidatePendingLookups]);

  const loadAll = useCallback(async (calMonth: string, histMonth: string, cancMonth: string) => {
    const requestId = loadTrackerRef.current.next();
    setLoading(true);
    setError(null);
    try {
      const uniqueMonths = Array.from(new Set([calMonth, histMonth, cancMonth]));
      const [acc, remRes, monthPayloads] = await Promise.all([
        api<CalendarAccess>("/api/calendar/access", { background: true }),
        api<RemindersResponse>("/api/calendar/reminders", { background: true }),
        Promise.all(
          uniqueMonths.map((m) =>
            api<ActivitiesMonthResponse>(`/api/calendar/activities?month=${encodeURIComponent(m)}`),
          ),
        ),
      ]);
      if (!loadTrackerRef.current.isCurrent(requestId)) return;

      const byMonth = new Map<string, ActivitiesMonthResponse>();
      uniqueMonths.forEach((m, idx) => byMonth.set(m, monthPayloads[idx]!));

      const calRes = byMonth.get(calMonth)!;
      const histRes = byMonth.get(histMonth)!;
      const cancRes = byMonth.get(cancMonth)!;

      setAccess(acc);
      setMonthData(calRes);
      setHistoryData(histRes);
      setCancelledData(cancRes);
      setReminders(remRes);

      setSelectedActivity((prev) => {
        if (!prev) return null;
        const pool = [
          ...calRes.scheduledActivities,
          ...histRes.completedActivities,
          ...cancRes.cancelledActivities,
        ];
        return pool.find((item) => item.reference === prev.reference) ?? prev;
      });
    } catch (err) {
      if (!loadTrackerRef.current.isCurrent(requestId)) return;
      setError(err instanceof ApiError ? err.message : "Could not load Activity Calendar.");
    } finally {
      if (loadTrackerRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadAll(calendarMonth, historyMonth, cancelledMonth);
  }, [calendarMonth, historyMonth, cancelledMonth, loadAll]);

  const activitiesByDate = useMemo(() => {
    const map = new Map<string, ActivityView[]>();
    for (const act of monthData?.scheduledActivities ?? []) {
      const list = map.get(act.scheduledDate) ?? [];
      list.push(act);
      map.set(act.scheduledDate, list);
    }
    return map;
  }, [monthData]);

  const gridCells = useMemo(() => buildMonthGrid(calendarMonth), [calendarMonth]);
  const gridWeeks = useMemo(() => {
    const weeks: (typeof gridCells)[] = [];
    for (let i = 0; i < gridCells.length; i += 7) {
      weeks.push(gridCells.slice(i, i + 7));
    }
    return weeks;
  }, [gridCells]);
  const selectedDayActivities = activitiesByDate.get(selectedDate) ?? [];
  const completedList = historyData?.completedActivities ?? [];
  const cancelledList = cancelledData?.cancelledActivities ?? [];

  const activeHistoryActivity = useMemo(() => {
    if (selectedActivity && completedList.some((item) => item.reference === selectedActivity.reference)) {
      return selectedActivity;
    }
    return completedList[0] ?? null;
  }, [completedList, selectedActivity]);

  const activeCancelledActivity = useMemo(() => {
    if (selectedActivity && cancelledList.some((item) => item.reference === selectedActivity.reference)) {
      return selectedActivity;
    }
    return cancelledList[0] ?? null;
  }, [cancelledList, selectedActivity]);

  async function openActivityDetail(reference: string) {
    actionTrackerRef.current.next();
    const requestId = detailTrackerRef.current.next();
    setDetailError(null);
    const localMatch =
      monthData?.scheduledActivities.find((a) => a.reference === reference) ??
      historyData?.completedActivities.find((a) => a.reference === reference) ??
      cancelledData?.cancelledActivities.find((a) => a.reference === reference);
    if (localMatch) {
      setSelectedActivity(localMatch);
      setSelectedDate(localMatch.scheduledDate);
      return;
    }
    try {
      const detail = await api<ActivityView>(`/api/calendar/activities/${encodeURIComponent(reference)}`);
      if (!detailTrackerRef.current.isCurrent(requestId)) return;
      setSelectedActivity(detail);
      setSelectedDate(detail.scheduledDate);
    } catch (err) {
      if (!detailTrackerRef.current.isCurrent(requestId)) return;
      setDetailError(wrapNotice(err instanceof ApiError ? err.message : "Could not load activity details."));
    }
  }

  async function startAction(reference: string, targetMode: Exclude<CalendarMode, "overview" | "schedule">) {
    detailTrackerRef.current.next();
    const requestId = actionTrackerRef.current.next();
    setDetailError(null);
    const localMatch =
      monthData?.scheduledActivities.find((a) => a.reference === reference) ??
      historyData?.completedActivities.find((a) => a.reference === reference) ??
      (selectedActivity?.reference === reference ? selectedActivity : undefined);
    if (localMatch) {
      setActionTarget(localMatch);
      setMode(targetMode);
      return;
    }
    try {
      const detail = await api<ActivityView>(`/api/calendar/activities/${encodeURIComponent(reference)}`);
      if (!actionTrackerRef.current.isCurrent(requestId)) return;
      setActionTarget(detail);
      setMode(targetMode);
    } catch (err) {
      if (!actionTrackerRef.current.isCurrent(requestId)) return;
      setDetailError(wrapNotice(err instanceof ApiError ? err.message : "Could not open activity action."));
    }
  }

  async function handleScheduleSaved(result: ScheduleSaveResponse) {
    invalidatePendingLookups();
    const saved = result.activity ?? result;
    const count = result.activities?.length ?? 1;
    const savedMonth = saved.scheduledDate.slice(0, 7);
    setCalendarMonth(savedMonth);
    setSelectedDate(saved.scheduledDate);
    setSelectedActivity(saved);
    setJustScheduledRef(saved.reference);
    setBanner({ id: nextNoticeId(), kind: "scheduled", activity: saved, count });
    setTab("calendar");
    setMode("overview");
    await loadAll(savedMonth, historyMonth, cancelledMonth);
  }

  async function handleManageSaved(savedMode: "edit" | "cancel", result: MutationSaveResponse) {
    invalidatePendingLookups();
    const saved = result.activity ?? result;
    const count = result.affectedReferences?.length ?? result.activities?.length ?? 1;
    const targetMonth = saved.scheduledDate.slice(0, 7);
    setSelectedActivity(saved);
    setActionTarget(null);
    setJustScheduledRef(null);
    setMode("overview");

    if (savedMode === "cancel") {
      setCancelledMonth(targetMonth);
      setBanner({ id: nextNoticeId(), kind: "cancelled", activity: saved, count });
      setTab("cancelled");
      await loadAll(calendarMonth, historyMonth, targetMonth);
    } else {
      setCalendarMonth(targetMonth);
      setSelectedDate(saved.scheduledDate);
      setBanner({ id: nextNoticeId(), kind: "edited", activity: saved, count });
      setTab("calendar");
      await loadAll(targetMonth, historyMonth, cancelledMonth);
    }
  }

  async function handleCompletionSaved(saved: ActivityView, isCorrection: boolean) {
    invalidatePendingLookups();
    const completionMonth = (saved.completedDate ?? manilaNow.date).slice(0, 7);
    setHistoryMonth(completionMonth);
    setSelectedActivity(saved);
    setActionTarget(null);
    setJustScheduledRef(null);
    setBanner({ id: nextNoticeId(), kind: isCorrection ? "corrected" : "completed", activity: saved });
    setTab("history");
    setMode("overview");
    await loadAll(calendarMonth, completionMonth, cancelledMonth);
  }

  async function handleReloadedActivity(
    latest: ActivityView,
    currentMode: "edit" | "cancel" | "complete" | "correct",
  ) {
    invalidatePendingLookups();
    if ((currentMode === "complete" || currentMode === "edit" || currentMode === "cancel") && latest.status === "COMPLETED") {
      const completionMonth = (latest.completedDate ?? manilaNow.date).slice(0, 7);
      setHistoryMonth(completionMonth);
      setSelectedActivity(latest);
      setActionTarget(null);
      setJustScheduledRef(null);
      setBanner({ id: nextNoticeId(), kind: "completed", activity: latest });
      setTab("history");
      setMode("overview");
      await loadAll(calendarMonth, completionMonth, cancelledMonth);
      return;
    }
    if (latest.status === "CANCELLED") {
      const targetMonth = latest.scheduledDate.slice(0, 7);
      setCancelledMonth(targetMonth);
      setSelectedActivity(latest);
      setActionTarget(null);
      setJustScheduledRef(null);
      setBanner({ id: nextNoticeId(), kind: "cancelled", activity: latest, count: 1 });
      setTab("cancelled");
      setMode("overview");
      await loadAll(calendarMonth, historyMonth, targetMonth);
      return;
    }
    setActionTarget(latest);
    setSelectedActivity(latest);
  }

  function selectCalendarDate(date: string, dayActivities: ActivityView[]) {
    invalidatePendingLookups();
    setSelectedDate(date);
    setSelectedActivity((prev) => resolveSelectedActivityForDate(prev, date, dayActivities));
  }

  function handleTodayClick() {
    invalidatePendingLookups();
    const todayActivities = calendarMonth === manilaNow.month ? (activitiesByDate.get(manilaNow.date) ?? []) : [];
    setCalendarMonth(manilaNow.month);
    setSelectedDate(manilaNow.date);
    setSelectedActivity((prev) => resolveSelectedActivityForDate(prev, manilaNow.date, todayActivities));
    setBanner(null);
  }

  const scheduledCount = (monthData?.scheduledActivities ?? []).filter((a) => a.status === "SCHEDULED").length;
  const overdueMonthCount = (monthData?.scheduledActivities ?? []).filter((a) => a.status === "OVERDUE").length;
  const completedMonthCount = (monthData?.completedActivities ?? []).length;
  const cancelledMonthCount = (monthData?.cancelledActivities ?? []).length;

  const firstOverdueReminder = useMemo(
    () => (reminders?.items ?? []).find((item) => item.status === "OVERDUE") ?? null,
    [reminders],
  );

  if (mode === "schedule" && access?.canManage) {
    return (
      <AppShell activeKey="calendar" sectionName="Activity Calendar" modulesData={modulesData}>
        <ScheduleActivityForm
          initialDate={selectedDate}
          onCancel={() => {
            invalidatePendingLookups();
            setMode("overview");
          }}
          onSaved={(saved) => void handleScheduleSaved(saved)}
        />
      </AppShell>
    );
  }

  if ((mode === "edit" || mode === "cancel") && access?.canManage && actionTarget) {
    return (
      <AppShell activeKey="calendar" sectionName="Activity Calendar" modulesData={modulesData}>
        <ManageActivityForm
          key={`${mode}:${actionTarget.reference}`}
          mode={mode}
          activity={actionTarget}
          onCancel={() => {
            invalidatePendingLookups();
            setActionTarget(null);
            setMode("overview");
          }}
          onSaved={(savedMode, res) => void handleManageSaved(savedMode, res)}
          onActivityReloaded={(latest) => void handleReloadedActivity(latest, mode)}
        />
      </AppShell>
    );
  }

  if ((mode === "complete" || mode === "correct") && access?.canManage && actionTarget) {
    return (
      <AppShell activeKey="calendar" sectionName="Activity Calendar" modulesData={modulesData}>
        <RecordCompletionForm
          key={`${mode}:${actionTarget.reference}`}
          mode={mode === "correct" ? "correct" : "record"}
          activity={actionTarget}
          operatorUsername={user.username}
          onCancel={() => {
            invalidatePendingLookups();
            setActionTarget(null);
            setMode("overview");
          }}
          onSaved={(saved) => void handleCompletionSaved(saved, mode === "correct")}
          onActivityReloaded={(latest) => void handleReloadedActivity(latest, mode)}
        />
      </AppShell>
    );
  }

  const showOriginalSchedule =
    selectedActivity !== null &&
    (selectedActivity.originalScheduledAt !== selectedActivity.scheduledAt ||
      selectedActivity.originalName !== selectedActivity.name);

  return (
    <AppShell activeKey="calendar" sectionName="Activity Calendar" modulesData={modulesData}>
      <section className="page-header page-header--split">
        <div>
          <h1>Activity Calendar</h1>
          <p className="page-subtitle">Plan station care and keep a clear record of completed work.</p>
        </div>

        <div className="page-header__actions">
          {access && !access.canManage && <span className="badge badge--read-only">View-only access</span>}
          {access?.canManage && (
            <button
              className="button button--primary"
              type="button"
              onClick={() => {
                invalidatePendingLookups();
                setBanner(null);
                setMode("schedule");
              }}
            >
              + Schedule activity
            </button>
          )}
        </div>
      </section>

      {error && (
        <div className="alert alert--error" role="alert">
          <span>{error}</span>{" "}
          <button
            className="button button--ghost button--sm"
            type="button"
            onClick={() => void loadAll(calendarMonth, historyMonth, cancelledMonth)}
          >
            Retry
          </button>
        </div>
      )}

      {detailError && (
        <TemporaryNotice
          occurrenceId={detailError.id}
          duration="brief"
          className="alert alert--error"
          role="alert"
          closeLabel="Close activity detail error"
          onDismiss={() => setDetailError(null)}
        >
          {detailError.data}
        </TemporaryNotice>
      )}

      {access && !access.canManage && (
        <p className="alert alert--info" role="status">
          View-only access: you can view scheduled activities, cancelled records, and completion history; only the Owner
          can schedule, edit, cancel, or record completion.
        </p>
      )}

      <div className="tabs-header">
        <div className="tab-bar" role="tablist" aria-label="Activity Calendar views">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "calendar"}
            className={`tab ${tab === "calendar" ? "tab--active" : ""}`}
            onClick={() => {
              invalidatePendingLookups();
              if (tab !== "calendar") {
                setBanner(null);
                setDetailError(null);
                setTab("calendar");
              }
            }}
          >
            Calendar
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "history"}
            className={`tab ${tab === "history" ? "tab--active" : ""}`}
            onClick={() => {
              invalidatePendingLookups();
              if (tab !== "history") {
                setBanner(null);
                setDetailError(null);
                setTab("history");
              }
            }}
          >
            Completion history
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "cancelled"}
            className={`tab ${tab === "cancelled" ? "tab--active" : ""}`}
            onClick={() => {
              invalidatePendingLookups();
              if (tab !== "cancelled") {
                setBanner(null);
                setDetailError(null);
                setTab("cancelled");
              }
            }}
          >
            Cancelled
          </button>
        </div>

        <div className="summary-pills" aria-label="Month activity totals">
          <span className="pill pill--scheduled">{scheduledCount} scheduled</span>
          <span className="pill pill--overdue">{overdueMonthCount} overdue</span>
          <span className="pill pill--completed">{completedMonthCount} completed</span>
          {cancelledMonthCount > 0 && <span className="pill pill--cancelled">{cancelledMonthCount} cancelled</span>}
        </div>
      </div>

      {loading && !monthData ? (
        <div className="card">
          <p className="muted">Loading Activity Calendar…</p>
        </div>
      ) : tab === "calendar" ? (
        <div className="calendar-layout">
          <section className="card calendar-panel">
            <div className="calendar-toolbar">
              <h2>{formatMonthHeading(calendarMonth)}</h2>
              <div className="calendar-toolbar__controls">
                <button type="button" className="button button--ghost button--sm" onClick={handleTodayClick}>
                  Today
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Previous month"
                  onClick={() => {
                    invalidatePendingLookups();
                    setCalendarMonth((m) => shiftMonth(m, -1));
                  }}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Next month"
                  onClick={() => {
                    invalidatePendingLookups();
                    setCalendarMonth((m) => shiftMonth(m, 1));
                  }}
                >
                  ›
                </button>
              </div>
            </div>

            <div className="calendar-grid-wrap" role="grid" aria-label={formatMonthHeading(calendarMonth)}>
              <div className="calendar-weekdays" role="row">
                {WEEKDAY_HEADERS.map((day) => (
                  <div key={day} className="calendar-weekday" role="columnheader">
                    {day}
                  </div>
                ))}
              </div>

              <div className="calendar-grid">
                {gridWeeks.map((week, weekIndex) => (
                  <div key={week[0]?.date ?? weekIndex} className="calendar-week" role="row">
                    {week.map((cell) => {
                      const dayActivities = activitiesByDate.get(cell.date) ?? [];
                      const isToday = cell.date === manilaNow.date;
                      const isSelected = cell.date === selectedDate;
                      const hasOverdue = dayActivities.some((a) => a.status === "OVERDUE");
                      const visible = dayActivities.slice(0, 2);
                      const hiddenCount = dayActivities.length - visible.length;

                      return (
                        <div
                          key={cell.date}
                          role="gridcell"
                          aria-selected={isSelected || undefined}
                          className={`day-cell ${cell.inCurrentMonth ? "" : "day-cell--outside"} ${
                            isToday ? "day-cell--today" : ""
                          } ${isSelected ? "day-cell--selected" : ""}`}
                        >
                          <button
                            type="button"
                            className={`day-number ${isToday ? "day-number--today" : ""} ${
                              hasOverdue && !isToday ? "day-number--overdue" : ""
                            }`}
                            aria-label={`${formatLongDate(cell.date)}${
                              dayActivities.length > 0
                                ? `, ${dayActivities.length} ${dayActivities.length === 1 ? "activity" : "activities"}${
                                    hasOverdue ? ", includes overdue" : ""
                                  }`
                                : ""
                            }`}
                            onClick={() => selectCalendarDate(cell.date, dayActivities)}
                          >
                            <span className="day-number__value">{cell.dayNumber}</span>
                            {dayActivities.length > 0 && (
                              <span className="day-dots" aria-hidden="true">
                                {dayActivities.slice(0, 3).map((act) => (
                                  <span key={act.reference} className={`day-dot day-dot--${act.status.toLowerCase()}`} />
                                ))}
                              </span>
                            )}
                          </button>

                          <div className="day-events">
                            {visible.map((act) => (
                              <button
                                key={act.reference}
                                type="button"
                                className={`day-event day-event--${act.status.toLowerCase()}`}
                                title={`${formatTime12h(act.scheduledTime)} — ${act.name}`}
                                onClick={() => {
                                  invalidatePendingLookups();
                                  setSelectedDate(act.scheduledDate);
                                  setSelectedActivity(act);
                                }}
                              >
                                {act.name}
                              </button>
                            ))}
                            {hiddenCount > 0 && (
                              <button
                                type="button"
                                className="day-event-more"
                                onClick={() => {
                                  invalidatePendingLookups();
                                  setSelectedDate(cell.date);
                                  setSelectedActivity(dayActivities[0] ?? null);
                                }}
                              >
                                +{hiddenCount} more
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div className="calendar-legend">
              <span className="pill pill--scheduled">Scheduled</span>
              <span className="pill pill--overdue">Overdue</span>
              <span className="pill pill--completed">Completed</span>
              <span className="muted-sm">All times are station local time</span>
            </div>

            {selectedDayActivities.length > 0 ? (
              <div className="selected-day-list">
                <h3>{formatLongDate(selectedDate)}</h3>
                <div className="selected-day-items">
                  {selectedDayActivities.map((item) => (
                    <button
                      key={item.reference}
                      type="button"
                      className={`selected-day-item ${
                        selectedActivity?.reference === item.reference ? "selected-day-item--active" : ""
                      }`}
                      onClick={() => {
                        invalidatePendingLookups();
                        setSelectedActivity(item);
                      }}
                    >
                      <span className="selected-day-item__main">
                        <strong>{item.name}</strong>
                        <span className="muted-sm">
                          {item.reference} · {formatTime12h(item.scheduledTime)}
                          {item.recurrence !== "ONE_TIME" ? ` · ${formatRecurrenceLabel(item.recurrence)}` : ""}
                        </span>
                      </span>
                      <span className={`pill ${statusPillClass(item.status)}`}>{statusBadgeLabel(item.status)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="selected-day-list selected-day-list--empty">
                <h3>{formatLongDate(selectedDate)}</h3>
                <p className="muted-sm">No activities scheduled for this date.</p>
              </div>
            )}
          </section>

          <aside className="side-stack">
            {(banner?.kind === "scheduled" || banner?.kind === "edited") && (
              <TemporaryNotice
                occurrenceId={banner.id}
                duration="brief"
                className="callout callout--success"
                role="status"
                closeLabel="Close activity confirmation"
                onDismiss={() => setBanner(null)}
              >
                <p className="callout__title">
                  {banner.kind === "edited"
                    ? `${banner.activity.name} updated`
                    : banner.count > 1
                      ? `${banner.activity.name} scheduled (${banner.count} occurrences)`
                      : `${banner.activity.name} scheduled`}
                </p>
                <p className="callout__body">
                  {banner.kind === "edited" && banner.count > 1
                    ? `Updated ${banner.count} series occurrences starting ${formatLongDate(banner.activity.scheduledDate)} at ${formatTime12h(banner.activity.scheduledTime)}.`
                    : `Saved for ${formatLongDate(banner.activity.scheduledDate)} at ${formatTime12h(banner.activity.scheduledTime)}.`}
                </p>
              </TemporaryNotice>
            )}

            {banner?.kind !== "scheduled" && banner?.kind !== "edited" && firstOverdueReminder && (
              <div className="callout callout--danger" role="status">
                <p className="callout__title">{firstOverdueReminder.name} is overdue</p>
                <p className="callout__body">
                  Due {formatLongDate(firstOverdueReminder.scheduledDate, false)} at{" "}
                  {formatTime12h(firstOverdueReminder.scheduledTime)}. Complete or reschedule the activity to keep
                  reminders accurate.
                </p>
              </div>
            )}

            {selectedActivity && (
              <section className="card detail-card" aria-label="Selected activity details">
                <div className="detail-card__header">
                  <h2>Activity details</h2>
                  <span className={`pill ${statusPillClass(selectedActivity.status)}`}>
                    {statusBadgeLabel(selectedActivity.status)}
                  </span>
                </div>
                <h3 className="detail-card__name">{selectedActivity.name}</h3>
                <p className="detail-card__ref">
                  {selectedActivity.reference}
                  {selectedActivity.recurrence !== "ONE_TIME" &&
                    ` · ${formatRecurrenceLabel(selectedActivity.recurrence)} (#${selectedActivity.seriesIndex})`}
                </p>

                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>Scheduled</dt>
                    <dd>{formatShortDateTime(selectedActivity.scheduledDate, selectedActivity.scheduledTime)}</dd>
                  </div>
                  {showOriginalSchedule && (
                    <div className="detail-list__row">
                      <dt>Original schedule</dt>
                      <dd>
                        {formatShortDateTime(
                          selectedActivity.originalScheduledDate,
                          selectedActivity.originalScheduledTime,
                        )}
                        {selectedActivity.originalName !== selectedActivity.name
                          ? ` (${selectedActivity.originalName})`
                          : ""}
                      </dd>
                    </div>
                  )}
                  <div className="detail-list__row">
                    <dt>Scheduled by</dt>
                    <dd>{selectedActivity.createdBy}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Created at</dt>
                    <dd>{formatManilaTimestamp(selectedActivity.createdAt)}</dd>
                  </div>
                  {selectedActivity.completion && (
                    <>
                      <div className="detail-list__row">
                        <dt>Completed</dt>
                        <dd>
                          {formatShortDateTime(
                            selectedActivity.completion.completedDate,
                            selectedActivity.completion.completedTime,
                          )}
                        </dd>
                      </div>
                      <div className="detail-list__row">
                        <dt>Recorded by</dt>
                        <dd>{selectedActivity.completion.recordedBy}</dd>
                      </div>
                    </>
                  )}
                </dl>

                <div className="detail-notes">
                  <h3>Activity notes</h3>
                  <p className="muted-sm">{selectedActivity.scheduleNotes ?? "No notes recorded."}</p>
                </div>

                <ScheduleHistorySection history={selectedActivity.scheduleHistory} />

                {selectedActivity.completion && (
                  <>
                    <div className="detail-notes">
                      <h3>Completion notes</h3>
                      <p className="muted-sm">{selectedActivity.completion.notes}</p>
                    </div>
                    <CompletionCorrectionsSection corrections={selectedActivity.completion.corrections} />
                  </>
                )}

                {access?.canManage &&
                  selectedActivity.status !== "COMPLETED" &&
                  selectedActivity.status !== "CANCELLED" && (
                    <div className="detail-actions">
                      <button
                        type="button"
                        className="button button--primary button--block"
                        onClick={() => void startAction(selectedActivity.reference, "complete")}
                      >
                        Record completion →
                      </button>
                      <div className="detail-actions__row">
                        <button
                          type="button"
                          className="button button--ghost button--sm"
                          onClick={() => void startAction(selectedActivity.reference, "edit")}
                        >
                          Edit / reschedule
                        </button>
                        <button
                          type="button"
                          className="button button--danger button--sm"
                          onClick={() => void startAction(selectedActivity.reference, "cancel")}
                        >
                          Cancel activity
                        </button>
                      </div>
                    </div>
                  )}

                {access?.canManage && selectedActivity.status === "COMPLETED" && (
                  <div className="detail-actions">
                    <button
                      type="button"
                      className="button button--ghost button--block"
                      onClick={() => void startAction(selectedActivity.reference, "correct")}
                    >
                      Correct completion
                    </button>
                  </div>
                )}
              </section>
            )}

            <section className="card reminder-panel">
              <div className="reminder-panel__header">
                <h2>Upcoming &amp; overdue</h2>
                <span className="pill pill--neutral">
                  {reminders?.items.length ?? 0} {(reminders?.items.length ?? 0) === 1 ? "activity" : "activities"}
                </span>
              </div>

              {(reminders?.items.length ?? 0) === 0 ? (
                <p className="muted-sm">No upcoming or overdue activities in the next 7 days.</p>
              ) : (
                <div className="reminder-list">
                  {reminders!.items.map((item) => {
                    const isJustScheduled = item.reference === justScheduledRef;
                    const label = reminderBadgeLabel(
                      item.scheduledDate,
                      item.status,
                      manilaNow.date,
                      isJustScheduled,
                    );
                    const badgeClass = isJustScheduled
                      ? "pill--completed"
                      : item.status === "OVERDUE"
                        ? "pill--overdue"
                        : "pill--scheduled";

                    return (
                      <div key={item.reference} className="reminder-item">
                        <div className="reminder-item__top">
                          <span className={`pill ${badgeClass}`}>{label}</span>
                          <span className="muted-sm">{formatShortDateTime(item.scheduledDate, item.scheduledTime)}</span>
                        </div>
                        <button
                          type="button"
                          className="reminder-item__title"
                          onClick={() => void openActivityDetail(item.reference)}
                        >
                          {item.name}
                        </button>
                        {access?.canManage && (
                          <button
                            type="button"
                            className="link-action"
                            onClick={() => void startAction(item.reference, "complete")}
                          >
                            Record completion →
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <p className="muted-sm">Completed and cancelled activities keep their records and history.</p>
          </aside>
        </div>
      ) : tab === "history" ? (
        <div className="calendar-layout">
          <section className="card history-panel">
            <div className="calendar-toolbar">
              <h2>Completed activities</h2>
              <div className="calendar-toolbar__controls">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Previous history month"
                  onClick={() => {
                    invalidatePendingLookups();
                    setHistoryMonth((m) => shiftMonth(m, -1));
                  }}
                >
                  ‹
                </button>
                <span className="month-pill">{formatMonthHeading(historyMonth)}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Next history month"
                  onClick={() => {
                    invalidatePendingLookups();
                    setHistoryMonth((m) => shiftMonth(m, 1));
                  }}
                >
                  ›
                </button>
              </div>
            </div>

            {completedList.length === 0 ? (
              <p className="muted">No completed activities recorded for {formatMonthHeading(historyMonth)}.</p>
            ) : (
              <div className="table-wrap">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th scope="col">ACTIVITY</th>
                      <th scope="col">COMPLETED</th>
                      <th scope="col">RECORDED BY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {completedList.map((item) => {
                      const isSelected = activeHistoryActivity?.reference === item.reference;
                      return (
                        <tr
                          key={item.reference}
                          className={isSelected ? "history-row history-row--selected" : "history-row"}
                          onClick={() => {
                        invalidatePendingLookups();
                        setSelectedActivity(item);
                      }}
                        >
                          <td className="history-td history-td--activity" data-label="Activity">
                            <button
                              type="button"
                              className="history-row__button"
                              aria-pressed={isSelected}
                              onClick={(e) => {
                                e.stopPropagation();
                                invalidatePendingLookups();
                                setSelectedActivity(item);
                              }}
                            >
                              <strong>{item.name}</strong>
                              <span className="muted-sm">{item.reference}</span>
                              <span className="pill pill--completed">Completed</span>
                            </button>
                          </td>
                          <td className="history-td history-td--completed" data-label="Completed">
                            <div className="history-cell-stack">
                              <strong>
                                {item.completedDate && item.completedTime
                                  ? formatShortDateTime(item.completedDate, item.completedTime)
                                  : "—"}
                              </strong>
                              <span className="muted-sm">
                                Due {formatShortDateTime(item.scheduledDate, item.scheduledTime)}
                              </span>
                            </div>
                          </td>
                          <td className="history-td history-td--recorder" data-label="Recorded by">
                            {item.recordedBy ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <p className="muted-sm history-footer">
              Showing all {completedList.length} completed {completedList.length === 1 ? "activity" : "activities"} in{" "}
              {formatMonthHeading(historyMonth)}
            </p>
          </section>

          <aside className="side-stack">
            {(banner?.kind === "completed" || banner?.kind === "corrected") && (
              <TemporaryNotice
                occurrenceId={banner.id}
                duration="brief"
                className="callout callout--success"
                role="status"
                closeLabel="Close completion confirmation"
                onDismiss={() => setBanner(null)}
              >
                <p className="callout__title">
                  {banner.kind === "corrected"
                    ? "Completion correction saved. Original record retained."
                    : "Completion saved. History retained."}
                </p>
                <p className="callout__body">
                  {banner.activity.name} was completed on{" "}
                  {banner.activity.completedDate ? formatLongDate(banner.activity.completedDate, false) : "—"} at{" "}
                  {banner.activity.completedTime ? formatTime12h(banner.activity.completedTime) : "—"} by{" "}
                  {banner.activity.recordedBy ?? user.username}.
                </p>
              </TemporaryNotice>
            )}

            {activeHistoryActivity ? (
              <section className="card detail-card" aria-label="Completion details">
                <div className="detail-card__header">
                  <h2>Completion details</h2>
                  <span className="pill pill--completed">Completed</span>
                </div>
                <h3 className="detail-card__name">{activeHistoryActivity.name}</h3>
                <p className="detail-card__ref">{activeHistoryActivity.reference}</p>

                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>Scheduled</dt>
                    <dd>{formatShortDateTime(activeHistoryActivity.scheduledDate, activeHistoryActivity.scheduledTime)}</dd>
                  </div>
                  {(activeHistoryActivity.originalScheduledAt !== activeHistoryActivity.scheduledAt ||
                    activeHistoryActivity.originalName !== activeHistoryActivity.name) && (
                    <div className="detail-list__row">
                      <dt>Original schedule</dt>
                      <dd>
                        {formatShortDateTime(
                          activeHistoryActivity.originalScheduledDate,
                          activeHistoryActivity.originalScheduledTime,
                        )}
                      </dd>
                    </div>
                  )}
                  <div className="detail-list__row">
                    <dt>Activity created</dt>
                    <dd>{formatManilaTimestamp(activeHistoryActivity.createdAt)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Actual completion</dt>
                    <dd>
                      {activeHistoryActivity.completedDate && activeHistoryActivity.completedTime
                        ? formatShortDateTime(activeHistoryActivity.completedDate, activeHistoryActivity.completedTime)
                        : "—"}
                    </dd>
                  </div>
                  {activeHistoryActivity.completion &&
                    activeHistoryActivity.completion.corrections.length > 0 && (
                      <div className="detail-list__row">
                        <dt>Original completion</dt>
                        <dd>
                          {formatShortDateTime(
                            activeHistoryActivity.completion.originalCompletedDate,
                            activeHistoryActivity.completion.originalCompletedTime,
                          )}
                        </dd>
                      </div>
                    )}
                  <div className="detail-list__row">
                    <dt>Recorded by</dt>
                    <dd>
                      {activeHistoryActivity.recordedBy ?? "—"}
                      {activeHistoryActivity.recordedAt
                        ? ` (${formatManilaTimestamp(activeHistoryActivity.recordedAt)})`
                        : ""}
                    </dd>
                  </div>
                </dl>

                {activeHistoryActivity.scheduleNotes && (
                  <div className="detail-notes">
                    <h3>Original activity notes</h3>
                    <p className="muted-sm">{activeHistoryActivity.scheduleNotes}</p>
                  </div>
                )}

                <div className="detail-notes">
                  <h3>Completion notes</h3>
                  <p className="muted-sm">{activeHistoryActivity.completionNotes ?? "—"}</p>
                </div>

                {activeHistoryActivity.completion &&
                  activeHistoryActivity.completion.corrections.length > 0 && (
                    <div className="detail-notes">
                      <h3>Original completion notes</h3>
                      <p className="muted-sm">{activeHistoryActivity.completion.originalCompletionNotes}</p>
                    </div>
                  )}

                <ScheduleHistorySection history={activeHistoryActivity.scheduleHistory} />
                {activeHistoryActivity.completion && (
                  <CompletionCorrectionsSection corrections={activeHistoryActivity.completion.corrections} />
                )}

                {access?.canManage && (
                  <div className="detail-actions">
                    <button
                      type="button"
                      className="button button--ghost button--block"
                      onClick={() => void startAction(activeHistoryActivity.reference, "correct")}
                    >
                      Correct completion
                    </button>
                  </div>
                )}
              </section>
            ) : (
              <section className="card detail-card">
                <h2>Completion details</h2>
                <p className="muted-sm">Select a completed activity to inspect its original schedule and notes.</p>
              </section>
            )}

            <section className="callout callout--info">
              <p className="callout__title">Retained for your records</p>
              <p className="callout__body">
                Creation time, original schedule, original completion, and every correction stay visible to both roles.
              </p>
            </section>
          </aside>
        </div>
      ) : (
        <div className="calendar-layout">
          <section className="card history-panel">
            <div className="calendar-toolbar">
              <h2>Cancelled activities</h2>
              <div className="calendar-toolbar__controls">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Previous cancelled month"
                  onClick={() => {
                    invalidatePendingLookups();
                    setCancelledMonth((m) => shiftMonth(m, -1));
                  }}
                >
                  ‹
                </button>
                <span className="month-pill">{formatMonthHeading(cancelledMonth)}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Next cancelled month"
                  onClick={() => {
                    invalidatePendingLookups();
                    setCancelledMonth((m) => shiftMonth(m, 1));
                  }}
                >
                  ›
                </button>
              </div>
            </div>

            {cancelledList.length === 0 ? (
              <p className="muted">No cancelled activities in {formatMonthHeading(cancelledMonth)}.</p>
            ) : (
              <div className="table-wrap">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th scope="col">ACTIVITY</th>
                      <th scope="col">SCHEDULED</th>
                      <th scope="col">REASON</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cancelledList.map((item) => {
                      const isSelected = activeCancelledActivity?.reference === item.reference;
                      return (
                        <tr
                          key={item.reference}
                          className={isSelected ? "history-row history-row--selected" : "history-row"}
                          onClick={() => {
                        invalidatePendingLookups();
                        setSelectedActivity(item);
                      }}
                        >
                          <td className="history-td history-td--activity" data-label="Activity">
                            <button
                              type="button"
                              className="history-row__button"
                              aria-pressed={isSelected}
                              onClick={(e) => {
                                e.stopPropagation();
                                invalidatePendingLookups();
                                setSelectedActivity(item);
                              }}
                            >
                              <strong>{item.name}</strong>
                              <span className="muted-sm">{item.reference}</span>
                              <span className="pill pill--cancelled">Cancelled</span>
                            </button>
                          </td>
                          <td className="history-td history-td--completed" data-label="Scheduled">
                            <div className="history-cell-stack">
                              <strong>{formatShortDateTime(item.scheduledDate, item.scheduledTime)}</strong>
                              <span className="muted-sm">
                                Cancelled by {item.cancellation?.cancelledBy ?? "—"}
                              </span>
                            </div>
                          </td>
                          <td className="history-td history-td--recorder" data-label="Reason">
                            {item.cancellation?.reason ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <p className="muted-sm history-footer">
              Showing {cancelledList.length} cancelled {cancelledList.length === 1 ? "activity" : "activities"} in{" "}
              {formatMonthHeading(cancelledMonth)}
            </p>
          </section>

          <aside className="side-stack">
            {banner?.kind === "cancelled" && (
              <TemporaryNotice
                occurrenceId={banner.id}
                duration="brief"
                className="callout callout--success"
                role="status"
                closeLabel="Close cancellation confirmation"
                onDismiss={() => setBanner(null)}
              >
                <p className="callout__title">
                  {banner.count > 1
                    ? `${banner.count} occurrences cancelled`
                    : `${banner.activity.name} cancelled`}
                </p>
                <p className="callout__body">
                  Removed from reminders and the default calendar. The cancellation record stays here.
                </p>
              </TemporaryNotice>
            )}

            {activeCancelledActivity ? (
              <section className="card detail-card" aria-label="Cancelled activity details">
                <div className="detail-card__header">
                  <h2>Cancellation details</h2>
                  <span className="pill pill--cancelled">Cancelled</span>
                </div>
                <h3 className="detail-card__name">{activeCancelledActivity.name}</h3>
                <p className="detail-card__ref">{activeCancelledActivity.reference}</p>

                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>Scheduled for</dt>
                    <dd>{formatShortDateTime(activeCancelledActivity.scheduledDate, activeCancelledActivity.scheduledTime)}</dd>
                  </div>
                  {(activeCancelledActivity.originalScheduledAt !== activeCancelledActivity.scheduledAt ||
                    activeCancelledActivity.originalName !== activeCancelledActivity.name) && (
                    <div className="detail-list__row">
                      <dt>Original schedule</dt>
                      <dd>
                        {formatShortDateTime(
                          activeCancelledActivity.originalScheduledDate,
                          activeCancelledActivity.originalScheduledTime,
                        )}
                      </dd>
                    </div>
                  )}
                  <div className="detail-list__row">
                    <dt>Cancelled by</dt>
                    <dd>{activeCancelledActivity.cancellation?.cancelledBy ?? "—"}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Cancelled at</dt>
                    <dd>
                      {activeCancelledActivity.cancellation
                        ? formatManilaTimestamp(activeCancelledActivity.cancellation.cancelledAt)
                        : "—"}
                    </dd>
                  </div>
                </dl>

                <div className="detail-notes">
                  <h3>Cancellation reason</h3>
                  <p className="muted-sm">{activeCancelledActivity.cancellation?.reason ?? "—"}</p>
                </div>

                {activeCancelledActivity.scheduleNotes && (
                  <div className="detail-notes">
                    <h3>Activity notes</h3>
                    <p className="muted-sm">{activeCancelledActivity.scheduleNotes}</p>
                  </div>
                )}

                <ScheduleHistorySection history={activeCancelledActivity.scheduleHistory} />
              </section>
            ) : (
              <section className="card detail-card">
                <h2>Cancellation details</h2>
                <p className="muted-sm">Select a cancelled activity to inspect its reason and schedule history.</p>
              </section>
            )}
          </aside>
        </div>
      )}
    </AppShell>
  );
}
