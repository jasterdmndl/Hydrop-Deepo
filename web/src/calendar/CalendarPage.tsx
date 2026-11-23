import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useSignedInUser } from "../auth/AuthContext";
import { AppShell, useModulesData } from "../ChooseModule";
import { nextNoticeId, type NoticeEnvelope, wrapNotice } from "../notifications/noticeTiming";
import { TemporaryNotice } from "../notifications/TemporaryNotice";
import {
  type ActivitiesMonthResponse,
  type ActivityView,
  buildMonthGrid,
  createRequestTracker,
  currentManilaDateAndTime,
  formatLongDate,
  formatMonthHeading,
  formatShortDateTime,
  formatTime12h,
  reminderBadgeLabel,
  type RemindersResponse,
  resolveSelectedActivityForDate,
  shiftMonth,
} from "./calendarView";
import { RecordCompletionForm } from "./RecordCompletionForm";
import { ScheduleActivityForm } from "./ScheduleActivityForm";

interface CalendarAccess {
  canView: boolean;
  canManage: boolean;
}

type CalendarTab = "calendar" | "history";
type CalendarMode = "overview" | "schedule" | "complete";

type BannerState =
  | { id: number; kind: "scheduled"; activity: ActivityView }
  | { id: number; kind: "completed"; activity: ActivityView }
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
  }
}

export function CalendarPage() {
  const user = useSignedInUser();
  const { data: modulesData } = useModulesData();
  const manilaNow = useMemo(() => currentManilaDateAndTime(), []);

  const [access, setAccess] = useState<CalendarAccess | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(manilaNow.month);
  const [historyMonth, setHistoryMonth] = useState(manilaNow.month);
  const [monthData, setMonthData] = useState<ActivitiesMonthResponse | null>(null);
  const [historyData, setHistoryData] = useState<ActivitiesMonthResponse | null>(null);
  const [reminders, setReminders] = useState<RemindersResponse | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<CalendarTab>("calendar");
  const [mode, setMode] = useState<CalendarMode>("overview");

  const [selectedDate, setSelectedDate] = useState<string>(manilaNow.date);
  const [selectedActivity, setSelectedActivity] = useState<ActivityView | null>(null);
  const [completionTarget, setCompletionTarget] = useState<ActivityView | null>(null);
  const [banner, setBanner] = useState<BannerState>(null);
  const [justScheduledRef, setJustScheduledRef] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<NoticeEnvelope<string> | null>(null);
  const loadTrackerRef = useRef(createRequestTracker());
  const detailTrackerRef = useRef(createRequestTracker());

  const loadAll = useCallback(
    async (calMonth: string, histMonth: string) => {
      const requestId = loadTrackerRef.current.next();
      setLoading(true);
      setError(null);
      try {
        const [acc, calRes, remRes, histRes] = await Promise.all([
          api<CalendarAccess>("/api/calendar/access", { background: true }),
          api<ActivitiesMonthResponse>(`/api/calendar/activities?month=${encodeURIComponent(calMonth)}`),
          api<RemindersResponse>("/api/calendar/reminders", { background: true }),
          histMonth === calMonth
            ? Promise.resolve<ActivitiesMonthResponse | null>(null)
            : api<ActivitiesMonthResponse>(`/api/calendar/activities?month=${encodeURIComponent(histMonth)}`),
        ]);
        if (!loadTrackerRef.current.isCurrent(requestId)) return;
        setAccess(acc);
        setMonthData(calRes);
        setReminders(remRes);
        setHistoryData(histRes ?? calRes);
      } catch (err) {
        if (!loadTrackerRef.current.isCurrent(requestId)) return;
        setError(err instanceof ApiError ? err.message : "Could not load Activity Calendar.");
      } finally {
        if (loadTrackerRef.current.isCurrent(requestId)) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void loadAll(calendarMonth, historyMonth);
  }, [calendarMonth, historyMonth, loadAll]);

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

  // Default selected completion record in history tab when none selected or outside current month list.
  const activeHistoryActivity = useMemo(() => {
    if (selectedActivity && completedList.some((item) => item.reference === selectedActivity.reference)) {
      return selectedActivity;
    }
    return completedList[0] ?? null;
  }, [completedList, selectedActivity]);

  async function openActivityDetail(reference: string) {
    const requestId = detailTrackerRef.current.next();
    setDetailError(null);
    const localMatch =
      monthData?.scheduledActivities.find((a) => a.reference === reference) ??
      historyData?.completedActivities.find((a) => a.reference === reference);
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
      setDetailError(
        wrapNotice(err instanceof ApiError ? err.message : "Could not load activity details."),
      );
    }
  }

  async function startCompletion(reference: string) {
    setDetailError(null);
    const localMatch =
      monthData?.scheduledActivities.find((a) => a.reference === reference) ??
      (selectedActivity?.reference === reference ? selectedActivity : undefined);
    if (localMatch) {
      setCompletionTarget(localMatch);
      setMode("complete");
      return;
    }
    try {
      const detail = await api<ActivityView>(`/api/calendar/activities/${encodeURIComponent(reference)}`);
      setCompletionTarget(detail);
      setMode("complete");
    } catch (err) {
      setDetailError(
        wrapNotice(err instanceof ApiError ? err.message : "Could not open completion form."),
      );
    }
  }

  async function handleScheduleSaved(saved: ActivityView) {
    const savedMonth = saved.scheduledDate.slice(0, 7);
    setCalendarMonth(savedMonth);
    setSelectedDate(saved.scheduledDate);
    setSelectedActivity(saved);
    setJustScheduledRef(saved.reference);
    setBanner({ id: nextNoticeId(), kind: "scheduled", activity: saved });
    setTab("calendar");
    setMode("overview");
    await loadAll(savedMonth, historyMonth);
  }

  async function handleCompletionSaved(saved: ActivityView) {
    const completionMonth = (saved.completedDate ?? manilaNow.date).slice(0, 7);
    setHistoryMonth(completionMonth);
    setSelectedActivity(saved);
    setCompletionTarget(null);
    setJustScheduledRef(null);
    setBanner({ id: nextNoticeId(), kind: "completed", activity: saved });
    setTab("history");
    setMode("overview");
    await loadAll(calendarMonth, completionMonth);
  }

  function selectCalendarDate(date: string, dayActivities: ActivityView[]) {
    setSelectedDate(date);
    setSelectedActivity((prev) => resolveSelectedActivityForDate(prev, date, dayActivities));
  }

  function handleTodayClick() {
    const todayActivities = calendarMonth === manilaNow.month ? (activitiesByDate.get(manilaNow.date) ?? []) : [];
    setCalendarMonth(manilaNow.month);
    selectCalendarDate(manilaNow.date, todayActivities);
    setBanner(null);
  }

  const scheduledCount = (monthData?.scheduledActivities ?? []).filter((a) => a.status === "SCHEDULED").length;
  const overdueMonthCount = (monthData?.scheduledActivities ?? []).filter((a) => a.status === "OVERDUE").length;
  const completedMonthCount = (monthData?.completedActivities ?? []).length;

  const firstOverdueReminder = useMemo(
    () => (reminders?.items ?? []).find((item) => item.status === "OVERDUE") ?? null,
    [reminders],
  );

  if (mode === "schedule" && access?.canManage) {
    return (
      <AppShell activeKey="calendar" sectionName="Activity Calendar" modulesData={modulesData}>
        <ScheduleActivityForm
          initialDate={selectedDate}
          onCancel={() => setMode("overview")}
          onSaved={(saved) => void handleScheduleSaved(saved)}
        />
      </AppShell>
    );
  }

  if (mode === "complete" && access?.canManage && completionTarget) {
    return (
      <AppShell activeKey="calendar" sectionName="Activity Calendar" modulesData={modulesData}>
        <RecordCompletionForm
          activity={completionTarget}
          operatorUsername={user.username}
          onCancel={() => {
            setCompletionTarget(null);
            setMode("overview");
          }}
          onSaved={(saved) => void handleCompletionSaved(saved)}
        />
      </AppShell>
    );
  }

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
            onClick={() => void loadAll(calendarMonth, historyMonth)}
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
          View-only access: you can view scheduled activities and completion history; only the Owner can schedule
          activities or record completion.
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
              if (tab !== "history") {
                setBanner(null);
                setDetailError(null);
                setTab("history");
              }
            }}
          >
            Completion history
          </button>
        </div>

        <div className="summary-pills" aria-label="Month activity totals">
          <span className="pill pill--scheduled">{scheduledCount} scheduled</span>
          <span className="pill pill--overdue">{overdueMonthCount} overdue</span>
          <span className="pill pill--completed">{completedMonthCount} completed</span>
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
                  onClick={() => setCalendarMonth((m) => shiftMonth(m, -1))}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Next month"
                  onClick={() => setCalendarMonth((m) => shiftMonth(m, 1))}
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
                      onClick={() => setSelectedActivity(item)}
                    >
                      <span className="selected-day-item__main">
                        <strong>{item.name}</strong>
                        <span className="muted-sm">
                          {item.reference} · {formatTime12h(item.scheduledTime)}
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
            {banner?.kind === "scheduled" && (
              <TemporaryNotice
                occurrenceId={banner.id}
                duration="brief"
                className="callout callout--success"
                role="status"
                closeLabel="Close scheduled activity notice"
                onDismiss={() => setBanner(null)}
              >
                <p className="callout__title">{banner.activity.name} scheduled</p>
                <p className="callout__body">
                  Saved for {formatLongDate(banner.activity.scheduledDate)} at{" "}
                  {formatTime12h(banner.activity.scheduledTime)}. You can find it in the calendar and upcoming
                  activities.
                </p>
              </TemporaryNotice>
            )}

            {banner?.kind !== "scheduled" && firstOverdueReminder && (
              <div className="callout callout--danger" role="status">
                <p className="callout__title">{firstOverdueReminder.name} is overdue</p>
                <p className="callout__body">
                  Due {formatLongDate(firstOverdueReminder.scheduledDate, false)} at{" "}
                  {formatTime12h(firstOverdueReminder.scheduledTime)}. Complete the activity, then record it to retain
                  its history.
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
                <p className="detail-card__ref">{selectedActivity.reference}</p>

                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>Scheduled</dt>
                    <dd>{formatShortDateTime(selectedActivity.scheduledDate, selectedActivity.scheduledTime)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Scheduled by</dt>
                    <dd>{selectedActivity.createdBy}</dd>
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

                {selectedActivity.completion && (
                  <div className="detail-notes">
                    <h3>Completion notes</h3>
                    <p className="muted-sm">{selectedActivity.completion.notes}</p>
                  </div>
                )}

                {access?.canManage && selectedActivity.status !== "COMPLETED" && (
                  <button
                    type="button"
                    className="button button--primary button--block"
                    onClick={() => void startCompletion(selectedActivity.reference)}
                  >
                    Record completion →
                  </button>
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
                            onClick={() => void startCompletion(item.reference)}
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

            <p className="muted-sm">Completed activities stay in Completion history and are not deleted.</p>
          </aside>
        </div>
      ) : (
        <div className="calendar-layout">
          <section className="card history-panel">
            <div className="calendar-toolbar">
              <h2>Completed activities</h2>
              <div className="calendar-toolbar__controls">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Previous history month"
                  onClick={() => setHistoryMonth((m) => shiftMonth(m, -1))}
                >
                  ‹
                </button>
                <span className="month-pill">{formatMonthHeading(historyMonth)}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Next history month"
                  onClick={() => setHistoryMonth((m) => shiftMonth(m, 1))}
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
                          onClick={() => setSelectedActivity(item)}
                        >
                          <td className="history-td history-td--activity" data-label="Activity">
                            <button
                              type="button"
                              className="history-row__button"
                              aria-pressed={isSelected}
                              onClick={(e) => {
                                e.stopPropagation();
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
            {banner?.kind === "completed" && (
              <TemporaryNotice
                occurrenceId={banner.id}
                duration="brief"
                className="callout callout--success"
                role="status"
                closeLabel="Close completion confirmation"
                onDismiss={() => setBanner(null)}
              >
                <p className="callout__title">Completion saved. History retained.</p>
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
                    <dt>Originally scheduled</dt>
                    <dd>{formatShortDateTime(activeHistoryActivity.scheduledDate, activeHistoryActivity.scheduledTime)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Completed</dt>
                    <dd>
                      {activeHistoryActivity.completedDate && activeHistoryActivity.completedTime
                        ? formatShortDateTime(activeHistoryActivity.completedDate, activeHistoryActivity.completedTime)
                        : "—"}
                    </dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Recorded by</dt>
                    <dd>{activeHistoryActivity.recordedBy ?? "—"}</dd>
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
                The original schedule and completion details remain available here.
              </p>
            </section>
          </aside>
        </div>
      )}
    </AppShell>
  );
}
