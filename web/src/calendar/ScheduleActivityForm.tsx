import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import {
  type ActivitiesMonthResponse,
  type ActivityView,
  createRequestTracker,
  currentManilaDateAndTime,
  formatLongDate,
  formatRecurrenceLabel,
  formatTime12h,
  makeRequestKey,
  previewRepeatSchedule,
  type RecurrenceRule,
  type ScheduleSaveResponse,
  scheduleDraftSignature,
} from "./calendarView";

interface ScheduleActivityFormProps {
  initialDate?: string;
  onCancel: () => void;
  onSaved: (result: ScheduleSaveResponse) => void;
}

interface ConflictState {
  message: string;
  conflicts: ActivityView[];
  conflictReferences: string[];
  conflictDates: string[];
}

export function ScheduleActivityForm({ initialDate, onCancel, onSaved }: ScheduleActivityFormProps) {
  const defaults = useMemo(() => currentManilaDateAndTime(), []);
  const [name, setName] = useState("");
  const [scheduledDate, setScheduledDate] = useState(initialDate ?? defaults.date);
  const [scheduledTime, setScheduledTime] = useState("14:00");
  const [recurrence, setRecurrence] = useState<RecurrenceRule>("ONE_TIME");
  const [endDate, setEndDate] = useState(initialDate ?? defaults.date);
  const [scheduleNotes, setScheduleNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);
  const [sameDayActivities, setSameDayActivities] = useState<ActivityView[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  const timeInputRef = useRef<HTMLInputElement | null>(null);
  const requestKeyRef = useRef<{ signature: string; key: string } | null>(null);
  const dayTrackerRef = useRef(createRequestTracker());

  const previewMonth = /^\d{4}-\d{2}-\d{2}$/.test(scheduledDate) ? scheduledDate.slice(0, 7) : defaults.month;

  useEffect(() => {
    const requestId = dayTrackerRef.current.next();
    setPreviewLoading(true);
    api<ActivitiesMonthResponse>(`/api/calendar/activities?month=${encodeURIComponent(previewMonth)}`, {
      background: true,
    })
      .then((res) => {
        if (!dayTrackerRef.current.isCurrent(requestId)) return;
        setSameDayActivities(res.scheduledActivities.filter((a) => a.scheduledDate === scheduledDate));
      })
      .catch(() => {
        if (dayTrackerRef.current.isCurrent(requestId)) {
          setSameDayActivities([]);
        }
      })
      .finally(() => {
        if (dayTrackerRef.current.isCurrent(requestId)) {
          setPreviewLoading(false);
        }
      });
  }, [previewMonth, scheduledDate]);

  const repeatPreview = useMemo(
    () => previewRepeatSchedule({ scheduledDate, recurrence, endDate }),
    [scheduledDate, recurrence, endDate],
  );

  function getStableRequestKey(): string {
    const signature = scheduleDraftSignature({
      name,
      scheduledDate,
      scheduledTime,
      scheduleNotes,
      recurrence,
      endDate,
    });
    if (requestKeyRef.current && requestKeyRef.current.signature === signature) {
      return requestKeyRef.current.key;
    }
    const key = makeRequestKey("sched");
    requestKeyRef.current = { signature, key };
    return key;
  }

  function clearTransientConflict() {
    setConflictState(null);
    setError(null);
  }

  async function submitSchedule(acknowledgedRefs?: string[]) {
    if (!name.trim()) {
      setError("Enter an activity name.");
      return;
    }
    if (!scheduledDate || !scheduledTime) {
      setError("Choose both a scheduled date and time.");
      return;
    }
    if (!repeatPreview.ok) {
      setError(repeatPreview.message);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const requestKey = getStableRequestKey();
      const saved = await api<ScheduleSaveResponse>("/api/calendar/activities", {
        method: "POST",
        body: {
          requestKey,
          name: name.trim(),
          scheduledDate,
          scheduledTime,
          recurrence,
          endDate: recurrence === "ONE_TIME" ? undefined : endDate,
          scheduleNotes: scheduleNotes.trim() || undefined,
          acknowledgedConflictReferences: acknowledgedRefs,
        },
      });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.code === "SCHEDULE_CONFLICT") {
        const conflicts = Array.isArray(err.details?.conflicts) ? (err.details.conflicts as ActivityView[]) : [];
        const conflictReferences = Array.isArray(err.details?.conflictReferences)
          ? (err.details.conflictReferences as string[])
          : conflicts.map((c) => c.reference);
        const conflictDates = Array.isArray(err.details?.conflictDates)
          ? (err.details.conflictDates as string[])
          : Array.from(new Set(conflicts.map((c) => c.scheduledDate)));
        setConflictState({
          message: err.message,
          conflicts,
          conflictReferences,
          conflictDates,
        });
      } else {
        setError(err instanceof ApiError ? err.message : "Could not save the activity. Please retry.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    void submitSchedule();
  }

  const unfinishedOnDate = sameDayActivities.filter((a) => a.status !== "COMPLETED");
  const exactOverlapCount = unfinishedOnDate.filter((a) => a.scheduledTime === scheduledTime).length;
  const formattedDay = /^\d{4}-\d{2}-\d{2}$/.test(scheduledDate) ? formatLongDate(scheduledDate) : "Selected date";

  return (
    <div className="subview">
      <section className="page-header page-header--split">
        <div>
          <p className="eyebrow">ACTIVITY CALENDAR / SCHEDULE</p>
          <h1>Schedule an activity</h1>
          <p className="page-subtitle">Add one-time or repeating station work. All dates follow Asia/Manila time.</p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="button button--ghost" onClick={onCancel} disabled={submitting}>
            ← Back to calendar
          </button>
        </div>
      </section>

      <div className="two-col-layout">
        <form className="card form-card" onSubmit={handleFormSubmit} noValidate>
          <h2>Activity details</h2>

          {error && (
            <div className="alert alert--error" role="alert">
              {error}
            </div>
          )}

          <label className="field">
            <span>Activity name *</span>
            <input
              name="name"
              type="text"
              maxLength={120}
              placeholder="e.g. Filter replacement"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearTransientConflict();
              }}
              required
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>{recurrence === "ONE_TIME" ? "Scheduled date *" : "First scheduled date *"}</span>
              <input
                name="scheduledDate"
                type="date"
                value={scheduledDate}
                onChange={(e) => {
                  const nextDate = e.target.value;
                  setScheduledDate(nextDate);
                  if (recurrence !== "ONE_TIME" && (!endDate || endDate < nextDate)) {
                    setEndDate(nextDate);
                  }
                  clearTransientConflict();
                }}
                required
              />
            </label>

            <label className="field">
              <span>Time *</span>
              <input
                ref={timeInputRef}
                name="scheduledTime"
                type="time"
                value={scheduledTime}
                onChange={(e) => {
                  setScheduledTime(e.target.value);
                  clearTransientConflict();
                }}
                required
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Repeat</span>
              <select
                name="recurrence"
                value={recurrence}
                onChange={(e) => {
                  const nextRule = e.target.value as RecurrenceRule;
                  setRecurrence(nextRule);
                  if (nextRule !== "ONE_TIME" && (!endDate || endDate < scheduledDate)) {
                    setEndDate(scheduledDate);
                  }
                  clearTransientConflict();
                }}
              >
                <option value="ONE_TIME">One-time</option>
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </label>

            {recurrence !== "ONE_TIME" && (
              <label className="field">
                <span>End date *</span>
                <input
                  name="endDate"
                  type="date"
                  min={scheduledDate || undefined}
                  value={endDate}
                  onChange={(e) => {
                    setEndDate(e.target.value);
                    clearTransientConflict();
                  }}
                  required
                />
              </label>
            )}
          </div>

          <label className="field">
            <span>Activity notes</span>
            <textarea
              name="scheduleNotes"
              rows={4}
              maxLength={1000}
              placeholder="Include what needs to be checked or replaced."
              value={scheduleNotes}
              onChange={(e) => {
                setScheduleNotes(e.target.value);
                clearTransientConflict();
              }}
            />
          </label>

          {conflictState ? (
            <div className="callout callout--warning" role="alert">
              <p className="callout__title">Same-time schedule conflict</p>
              <p className="callout__body">{conflictState.message}</p>
              {conflictState.conflictDates.length > 0 && recurrence !== "ONE_TIME" && (
                <p className="callout__body">
                  Conflicting {conflictState.conflictDates.length === 1 ? "date" : "dates"}:{" "}
                  {conflictState.conflictDates.map((d) => formatLongDate(d, false)).join(", ")}
                </p>
              )}
              {conflictState.conflicts.length > 0 && (
                <ul className="conflict-list">
                  {conflictState.conflicts.map((item) => (
                    <li key={item.reference}>
                      <strong>{item.name}</strong> ({item.reference}) on {formatLongDate(item.scheduledDate, false)} at{" "}
                      {formatTime12h(item.scheduledTime)}
                    </li>
                  ))}
                </ul>
              )}
              <div className="callout__actions">
                <button
                  type="button"
                  className="button button--ghost button--sm"
                  disabled={submitting}
                  onClick={() => {
                    setConflictState(null);
                    timeInputRef.current?.focus();
                  }}
                >
                  Revise
                </button>
                <button
                  type="button"
                  className="button button--primary button--sm"
                  disabled={submitting}
                  onClick={() => void submitSchedule(conflictState.conflictReferences)}
                >
                  {submitting ? "Saving…" : "Continue Anyway"}
                </button>
              </div>
            </div>
          ) : (
            <div className="callout callout--info">
              <p className="callout__title">
                {recurrence === "ONE_TIME"
                  ? "Ready to schedule"
                  : `${formatRecurrenceLabel(recurrence)} repeat preview`}
              </p>
              <p className="callout__body">
                {!repeatPreview.ok
                  ? repeatPreview.message
                  : recurrence === "ONE_TIME"
                    ? `${formattedDay} at ${scheduledTime ? formatTime12h(scheduledTime) : "—"}. The activity will remain scheduled until completion is recorded.`
                    : `${repeatPreview.dates.length} ${repeatPreview.dates.length === 1 ? "occurrence" : "occurrences"} from ${formatLongDate(repeatPreview.dates[0]!, false)} through ${formatLongDate(repeatPreview.dates[repeatPreview.dates.length - 1]!, false)} at ${scheduledTime ? formatTime12h(scheduledTime) : "—"}.`}
              </p>
            </div>
          )}

          <div className="form-card__footer">
            <span className="muted-sm">* Required fields</span>
            <div className="form-card__buttons">
              <button type="button" className="button button--ghost" onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="button button--primary" disabled={submitting || !repeatPreview.ok}>
                {submitting
                  ? "Saving…"
                  : recurrence === "ONE_TIME"
                    ? "Save activity"
                    : `Save ${repeatPreview.ok ? repeatPreview.dates.length : ""} activities`.trim()}
              </button>
            </div>
          </div>
        </form>

        <aside className="side-stack">
          {recurrence !== "ONE_TIME" && (
            <section className="card preview-card" aria-label="Repeating schedule preview">
              <div className="preview-card__header">
                <h2>{formatRecurrenceLabel(recurrence)} dates</h2>
                <span className="pill pill--neutral">
                  {repeatPreview.ok ? `${repeatPreview.dates.length} scheduled` : "Check end date"}
                </span>
              </div>

              {repeatPreview.ok ? (
                <>
                  <ul className="preview-dates">
                    {repeatPreview.dates.slice(0, 6).map((dateStr, idx) => (
                      <li key={dateStr}>
                        <span>#{idx + 1}</span>
                        <strong>{formatLongDate(dateStr, false)}</strong>
                        <span className="muted-sm">{scheduledTime ? formatTime12h(scheduledTime) : "—"}</span>
                      </li>
                    ))}
                  </ul>
                  {repeatPreview.dates.length > 6 && (
                    <p className="muted-sm">
                      +{repeatPreview.dates.length - 6} more through{" "}
                      {formatLongDate(repeatPreview.dates[repeatPreview.dates.length - 1]!, false)}.
                    </p>
                  )}
                </>
              ) : (
                <p className="muted-sm">{repeatPreview.message}</p>
              )}
            </section>
          )}

          <section className="card preview-card">
            <div className="preview-card__header">
              <h2>{formattedDay}</h2>
              <span className="pill pill--neutral">
                {previewLoading
                  ? "Checking schedule…"
                  : sameDayActivities.length === 1
                    ? "1 activity already scheduled"
                    : `${sameDayActivities.length} activities already scheduled`}
              </span>
            </div>

            {sameDayActivities.length > 0 ? (
              <div className="preview-list">
                {sameDayActivities.map((item) => (
                  <div key={item.reference} className="preview-item">
                    <div className="preview-item__meta">
                      <span className="preview-item__time">{formatTime12h(item.scheduledTime)}</span>
                      {item.status === "COMPLETED" && <span className="pill pill--completed">Completed</span>}
                    </div>
                    <strong className="preview-item__title">{item.name}</strong>
                    {item.scheduleNotes && <p className="preview-item__notes">{item.scheduleNotes}</p>}
                  </div>
                ))}
              </div>
            ) : (
              !previewLoading && <p className="muted-sm">No other activities scheduled on this date.</p>
            )}

            <div className="preview-draft">
              <span className="eyebrow">YOUR NEW ACTIVITY</span>
              <strong className="preview-draft__name">{name.trim() || "Untitled activity"}</strong>
              <span className="muted-sm">
                {scheduledTime ? formatTime12h(scheduledTime) : "Select time"} ·{" "}
                {exactOverlapCount > 0
                  ? `Matches ${exactOverlapCount} unfinished ${exactOverlapCount === 1 ? "activity" : "activities"} at this time`
                  : "No time overlap"}
              </span>
            </div>
          </section>

          <section className="callout callout--info">
            <p className="callout__title">Keep notes practical</p>
            <p className="callout__body">
              Include what needs to be checked so any employee can complete the activity confidently.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
