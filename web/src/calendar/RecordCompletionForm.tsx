import { type FormEvent, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import {
  type ActivityView,
  currentManilaDateAndTime,
  formatLongDate,
  formatShortDateTime,
  formatTime12h,
} from "./calendarView";

interface RecordCompletionFormProps {
  activity: ActivityView;
  operatorUsername: string;
  onCancel: () => void;
  onSaved: (activity: ActivityView) => void;
}

export function RecordCompletionForm({
  activity,
  operatorUsername,
  onCancel,
  onSaved,
}: RecordCompletionFormProps) {
  const defaults = useMemo(() => currentManilaDateAndTime(), []);
  const [completedDate, setCompletedDate] = useState(defaults.date);
  const [completedTime, setCompletedTime] = useState(defaults.time);
  const [completionNotes, setCompletionNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!completedDate || !completedTime) {
      setError("Enter both completion date and completion time.");
      return;
    }
    if (!completionNotes.trim()) {
      setError("Enter completion notes before saving.");
      return;
    }
    if (!confirmed) {
      setError("Confirm that this activity has been completed.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const saved = await api<ActivityView>(
        `/api/calendar/activities/${encodeURIComponent(activity.reference)}/completion`,
        {
          method: "POST",
          body: {
            completedDate,
            completedTime,
            completionNotes: completionNotes.trim(),
            confirmed: true,
          },
        },
      );
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save completion. Please retry.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="subview">
      <section className="page-header page-header--split">
        <div>
          <p className="eyebrow">ACTIVITY CALENDAR / COMPLETE</p>
          <h1>Record activity completion</h1>
          <p className="page-subtitle">Finish the station task first, then save a record of the work.</p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="button button--ghost" onClick={onCancel} disabled={submitting}>
            ← Back to calendar
          </button>
        </div>
      </section>

      <div className="two-col-layout">
        <form className="card form-card" onSubmit={handleSubmit} noValidate>
          <div className="form-card__title-row">
            <h2>{activity.name}</h2>
            <span className={`pill ${activity.status === "OVERDUE" ? "pill--overdue" : "pill--scheduled"}`}>
              {activity.status === "OVERDUE" ? "Overdue" : "Scheduled"}
            </span>
          </div>

          <div className="callout callout--warning">
            <p className="callout__title">
              Originally due {formatLongDate(activity.scheduledDate, false)} at {formatTime12h(activity.scheduledTime)}
            </p>
            <p className="callout__body">The original scheduled date is kept with the completion record.</p>
          </div>

          {error && (
            <div className="alert alert--error" role="alert">
              {error}
            </div>
          )}

          <div className="field-row">
            <label className="field">
              <span>Completion date *</span>
              <input
                name="completedDate"
                type="date"
                value={completedDate}
                onChange={(e) => {
                  setCompletedDate(e.target.value);
                  setError(null);
                }}
                required
              />
            </label>

            <label className="field">
              <span>Completion time *</span>
              <input
                name="completedTime"
                type="time"
                value={completedTime}
                onChange={(e) => {
                  setCompletedTime(e.target.value);
                  setError(null);
                }}
                required
              />
            </label>
          </div>

          <label className="field">
            <span>Completion notes *</span>
            <textarea
              name="completionNotes"
              rows={4}
              maxLength={1000}
              placeholder="Describe the work completed, checks performed, or condition found."
              value={completionNotes}
              onChange={(e) => {
                setCompletionNotes(e.target.value);
                setError(null);
              }}
              required
            />
          </label>

          <label className="checkbox-field">
            <input
              name="confirmed"
              type="checkbox"
              checked={confirmed}
              onChange={(e) => {
                setConfirmed(e.target.checked);
                setError(null);
              }}
            />
            <span>I confirm this activity has been completed.</span>
          </label>

          <div className="form-card__footer">
            <span className="muted-sm">* Required fields</span>
            <div className="form-card__buttons">
              <button type="button" className="button button--ghost" onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="button button--primary" disabled={submitting}>
                {submitting ? "Saving…" : "✓ Save completion"}
              </button>
            </div>
          </div>
        </form>

        <aside className="side-stack">
          <section className="card detail-card">
            <h2>Activity record</h2>
            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Activity reference</dt>
                <dd>{activity.reference}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Scheduled</dt>
                <dd>{formatShortDateTime(activity.scheduledDate, activity.scheduledTime)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Recorded by</dt>
                <dd>{operatorUsername}</dd>
              </div>
            </dl>
            <div className="detail-notes">
              <h3>Original activity notes</h3>
              <p className="muted-sm">{activity.scheduleNotes ?? "No original notes entered."}</p>
            </div>
          </section>

          <section className="callout callout--info">
            <p className="callout__title">Completion keeps the history</p>
            <p className="callout__body">
              This activity will leave reminders and appear in Completion history with its original date, completion
              time, notes, and employee.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
