import { type FormEvent, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import {
  type ActivityView,
  correctionDraftSignature,
  currentManilaDateAndTime,
  formatLongDate,
  formatManilaTimestamp,
  formatShortDateTime,
  formatTime12h,
  makeRequestKey,
} from "./calendarView";

interface RecordCompletionFormProps {
  mode?: "record" | "correct";
  activity: ActivityView;
  operatorUsername: string;
  onCancel: () => void;
  onSaved: (activity: ActivityView) => void;
  onActivityReloaded?: (latest: ActivityView) => void;
}

export function RecordCompletionForm({
  mode = "record",
  activity,
  operatorUsername,
  onCancel,
  onSaved,
  onActivityReloaded,
}: RecordCompletionFormProps) {
  const isCorrection = mode === "correct";
  const defaults = useMemo(() => currentManilaDateAndTime(), []);
  const [completedDate, setCompletedDate] = useState(
    isCorrection ? (activity.completedDate ?? defaults.date) : defaults.date,
  );
  const [completedTime, setCompletedTime] = useState(
    isCorrection ? (activity.completedTime ?? defaults.time) : defaults.time,
  );
  const [completionNotes, setCompletionNotes] = useState(isCorrection ? (activity.completionNotes ?? "") : "");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);

  const requestKeyRef = useRef<{ signature: string; key: string } | null>(null);

  function getCorrectionRequestKey(): string {
    const signature = correctionDraftSignature({
      reference: activity.reference,
      expectedVersion: activity.version,
      completedDate,
      completedTime,
      completionNotes,
      reason,
    });
    if (requestKeyRef.current && requestKeyRef.current.signature === signature) {
      return requestKeyRef.current.key;
    }
    const key = makeRequestKey("corr");
    requestKeyRef.current = { signature, key };
    return key;
  }

  async function handleReloadLatest() {
    setReloading(true);
    setError(null);
    setStaleMessage(null);
    try {
      const latest = await api<ActivityView>(`/api/calendar/activities/${encodeURIComponent(activity.reference)}`);
      if (isCorrection && latest.completion) {
        setCompletedDate(latest.completion.completedDate);
        setCompletedTime(latest.completion.completedTime);
        setCompletionNotes(latest.completion.completionNotes);
      }
      onActivityReloaded?.(latest);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reload the latest activity.");
    } finally {
      setReloading(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setStaleMessage(null);
    if (!completedDate || !completedTime) {
      setError("Enter both completion date and completion time.");
      return;
    }
    if (!completionNotes.trim()) {
      setError("Enter completion notes before saving.");
      return;
    }
    if (isCorrection && !reason.trim()) {
      setError("Enter a reason for correcting completion details.");
      return;
    }
    if (!confirmed) {
      setError(
        isCorrection
          ? "Confirm the corrected completion details before saving."
          : "Confirm that this activity has been completed.",
      );
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const saved = isCorrection
        ? await api<ActivityView>(`/api/calendar/activities/${encodeURIComponent(activity.reference)}/completion`, {
            method: "PATCH",
            body: {
              requestKey: getCorrectionRequestKey(),
              expectedVersion: activity.version,
              completedDate,
              completedTime,
              completionNotes: completionNotes.trim(),
              reason: reason.trim(),
              confirmed: true,
            },
          })
        : await api<ActivityView>(`/api/calendar/activities/${encodeURIComponent(activity.reference)}/completion`, {
            method: "POST",
            body: {
              expectedVersion: activity.version,
              completedDate,
              completedTime,
              completionNotes: completionNotes.trim(),
              confirmed: true,
            },
          });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.code === "STALE_ACTIVITY") {
        setStaleMessage(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not save completion. Please retry.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="subview">
      <section className="page-header page-header--split">
        <div>
          <p className="eyebrow">
            {isCorrection ? "ACTIVITY CALENDAR / CORRECT COMPLETION" : "ACTIVITY CALENDAR / COMPLETE"}
          </p>
          <h1>{isCorrection ? "Correct completion details" : "Record activity completion"}</h1>
          <p className="page-subtitle">
            {isCorrection
              ? "Update the actual completion time or notes with a reason. The original record and every correction stay visible."
              : "Finish the station task first, then save a record of the work."}
          </p>
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
            <span
              className={`pill ${
                activity.status === "COMPLETED"
                  ? "pill--completed"
                  : activity.status === "OVERDUE"
                    ? "pill--overdue"
                    : "pill--scheduled"
              }`}
            >
              {activity.status === "COMPLETED" ? "Completed" : activity.status === "OVERDUE" ? "Overdue" : "Scheduled"}
            </span>
          </div>

          <div className="callout callout--warning">
            <p className="callout__title">
              Scheduled {formatLongDate(activity.scheduledDate, false)} at {formatTime12h(activity.scheduledTime)}
            </p>
            <p className="callout__body">
              {isCorrection
                ? "The activity stays completed and keeps its original completion record."
                : "The original scheduled date is kept with the completion record."}
            </p>
          </div>

          {error && (
            <div className="alert alert--error" role="alert">
              {error}
            </div>
          )}

          {staleMessage && (
            <div className="callout callout--warning" role="alert">
              <p className="callout__title">Activity changed before save</p>
              <p className="callout__body">{staleMessage}</p>
              <div className="callout__actions">
                <button
                  type="button"
                  className="button button--primary button--sm"
                  disabled={reloading}
                  onClick={() => void handleReloadLatest()}
                >
                  {reloading ? "Reloading…" : "Reload latest activity"}
                </button>
              </div>
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

          {isCorrection && (
            <label className="field">
              <span>Reason for correction *</span>
              <textarea
                name="reason"
                rows={3}
                maxLength={500}
                placeholder="Explain what was inaccurate in the saved completion details."
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setError(null);
                }}
                required
              />
            </label>
          )}

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
            <span>
              {isCorrection
                ? "I confirm these corrected completion details are accurate."
                : "I confirm this activity has been completed."}
            </span>
          </label>

          <div className="form-card__footer">
            <span className="muted-sm">* Required fields</span>
            <div className="form-card__buttons">
              <button type="button" className="button button--ghost" onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
              {!isCorrection && activity.status === "COMPLETED" ? (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => onActivityReloaded?.(activity)}
                >
                  View completion history
                </button>
              ) : (
                <button type="submit" className="button button--primary" disabled={submitting}>
                  {submitting
                    ? "Saving…"
                    : isCorrection
                      ? "Save completion correction"
                      : "✓ Save completion"}
                </button>
              )}
            </div>
          </div>
          {!isCorrection && activity.status === "COMPLETED" && (
            <div className="callout callout--info" role="status">
              <p className="callout__title">This activity is already completed</p>
              <p className="callout__body">Review its saved completion record in Completion history.</p>
            </div>
          )}
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
                <dt>{isCorrection ? "Correcting as" : "Recorded by"}</dt>
                <dd>{operatorUsername}</dd>
              </div>
              {isCorrection && activity.completion && (
                <>
                  <div className="detail-list__row">
                    <dt>Original completion</dt>
                    <dd>
                      {formatShortDateTime(
                        activity.completion.originalCompletedDate,
                        activity.completion.originalCompletedTime,
                      )}
                    </dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Initially recorded</dt>
                    <dd>{formatManilaTimestamp(activity.completion.recordedAt)}</dd>
                  </div>
                </>
              )}
            </dl>
            <div className="detail-notes">
              <h3>Original activity notes</h3>
              <p className="muted-sm">{activity.scheduleNotes ?? "No original notes entered."}</p>
            </div>
            {isCorrection && activity.completion && (
              <div className="detail-notes">
                <h3>Original completion notes</h3>
                <p className="muted-sm">{activity.completion.originalCompletionNotes}</p>
              </div>
            )}
          </section>

          <section className="callout callout--info">
            <p className="callout__title">Completion keeps the history</p>
            <p className="callout__body">
              {isCorrection
                ? "Original creation time, initial recording time, and every correction stay visible to both Owner and Employee."
                : "This activity will leave reminders and appear in Completion history with its original date, completion time, notes, and actor."}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
