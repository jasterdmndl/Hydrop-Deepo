import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import {
  type ActivityEditScope,
  type ActivityView,
  type BulkPreviewResponse,
  cancelDraftSignature,
  createRequestTracker,
  editDraftSignature,
  formatLongDate,
  formatRecurrenceLabel,
  formatShortDateTime,
  formatTime12h,
  makeRequestKey,
  type MutationSaveResponse,
} from "./calendarView";

interface ManageActivityFormProps {
  mode: "edit" | "cancel";
  activity: ActivityView;
  onCancel: () => void;
  onSaved: (mode: "edit" | "cancel", result: MutationSaveResponse) => void;
  onActivityReloaded: (latest: ActivityView) => void;
}

interface ConflictState {
  message: string;
  conflicts: ActivityView[];
  conflictReferences: string[];
  conflictDates: string[];
}

export function ManageActivityForm({
  mode,
  activity,
  onCancel,
  onSaved,
  onActivityReloaded,
}: ManageActivityFormProps) {
  const isRepeating = activity.recurrence !== "ONE_TIME";
  const [scope, setScope] = useState<ActivityEditScope>("THIS_OCCURRENCE");
  const [name, setName] = useState(activity.name);
  const [scheduledDate, setScheduledDate] = useState(activity.scheduledDate);
  const [scheduledTime, setScheduledTime] = useState(activity.scheduledTime);
  const [scheduleNotes, setScheduleNotes] = useState(activity.scheduleNotes ?? "");
  const [reason, setReason] = useState("");

  const [previewData, setPreviewData] = useState<BulkPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleWarning, setStaleWarning] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);

  const previewTrackerRef = useRef(createRequestTracker());
  const requestKeyRef = useRef<{ signature: string; key: string } | null>(null);
  const timeInputRef = useRef<HTMLInputElement | null>(null);

  const fetchPreview = useCallback(
    async (target: ActivityView, selectedScope: ActivityEditScope) => {
      if (target.recurrence === "ONE_TIME" || selectedScope === "THIS_OCCURRENCE") {
        setPreviewData(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      const requestId = previewTrackerRef.current.next();
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const res =
          mode === "edit"
            ? await api<BulkPreviewResponse>(`/api/calendar/activities/${encodeURIComponent(target.reference)}`, {
                method: "PATCH",
                body: {
                  preview: true,
                  expectedVersion: target.version,
                  scope: selectedScope,
                  name: name.trim() || target.name,
                  scheduledDate,
                  scheduledTime,
                  scheduleNotes,
                },
                background: true,
              })
            : await api<BulkPreviewResponse>(
                `/api/calendar/activities/${encodeURIComponent(target.reference)}/cancellation`,
                {
                  method: "POST",
                  body: {
                    preview: true,
                    expectedVersion: target.version,
                    scope: selectedScope,
                  },
                  background: true,
                },
              );
        if (!previewTrackerRef.current.isCurrent(requestId)) return;
        setPreviewData(res);
      } catch (err) {
        if (!previewTrackerRef.current.isCurrent(requestId)) return;
        setPreviewData(null);
        setPreviewError(err instanceof ApiError ? err.message : "Could not load affected activities preview.");
      } finally {
        if (previewTrackerRef.current.isCurrent(requestId)) {
          setPreviewLoading(false);
        }
      }
    },
    [mode, name, scheduleNotes, scheduledDate, scheduledTime],
  );

  useEffect(() => {
    void fetchPreview(activity, scope);
  }, [activity, scope, fetchPreview]);

  function getStableRequestKey(): string {
    const signature =
      mode === "edit"
        ? editDraftSignature({
            reference: activity.reference,
            expectedVersion: activity.version,
            scope,
            name,
            scheduledDate,
            scheduledTime,
            scheduleNotes,
            expectedAffectedReferences: previewData?.affectedReferences,
          })
        : cancelDraftSignature({
            reference: activity.reference,
            expectedVersion: activity.version,
            scope,
            reason,
            expectedAffectedReferences: previewData?.affectedReferences,
          });
    if (requestKeyRef.current && requestKeyRef.current.signature === signature) {
      return requestKeyRef.current.key;
    }
    const key = makeRequestKey(mode);
    requestKeyRef.current = { signature, key };
    return key;
  }

  async function handleReloadLatest() {
    setReloading(true);
    setError(null);
    setStaleWarning(null);
    setConflictState(null);
    try {
      const latest = await api<ActivityView>(`/api/calendar/activities/${encodeURIComponent(activity.reference)}`);
      onActivityReloaded(latest);
      setName(latest.name);
      setScheduledDate(latest.scheduledDate);
      setScheduledTime(latest.scheduledTime);
      setScheduleNotes(latest.scheduleNotes ?? "");
      await fetchPreview(latest, scope);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reload the latest activity details.");
    } finally {
      setReloading(false);
    }
  }

  async function submitMutation(acknowledgedRefs?: string[]) {
    setError(null);
    setStaleWarning(null);

    if (mode === "edit") {
      if (!name.trim()) {
        setError("Enter an activity name.");
        return;
      }
      if (!scheduledDate || !scheduledTime) {
        setError("Choose both a scheduled date and time.");
        return;
      }
    } else if (!reason.trim()) {
      setError("Enter a short cancellation reason before cancelling.");
      return;
    }

    if (isRepeating && scope === "THIS_AND_FUTURE") {
      if (previewLoading) {
        setError("Wait for the affected activities preview to finish loading.");
        return;
      }
      if (!previewData) {
        setError("Preview the affected series entries before saving.");
        return;
      }
    }

    setSubmitting(true);
    try {
      const requestKey = getStableRequestKey();
      const bulkFields =
        isRepeating && scope === "THIS_AND_FUTURE" && previewData
          ? {
              expectedAffectedReferences: previewData.affectedReferences,
              expectedAffectedVersions: previewData.affectedVersions,
            }
          : {};

      const saved =
        mode === "edit"
          ? await api<MutationSaveResponse>(`/api/calendar/activities/${encodeURIComponent(activity.reference)}`, {
              method: "PATCH",
              body: {
                requestKey,
                expectedVersion: activity.version,
                scope: isRepeating ? scope : "THIS_OCCURRENCE",
                name: name.trim(),
                scheduledDate,
                scheduledTime,
                scheduleNotes,
                acknowledgedConflictReferences: acknowledgedRefs,
                ...bulkFields,
              },
            })
          : await api<MutationSaveResponse>(
              `/api/calendar/activities/${encodeURIComponent(activity.reference)}/cancellation`,
              {
                method: "POST",
                body: {
                  requestKey,
                  expectedVersion: activity.version,
                  scope: isRepeating ? scope : "THIS_OCCURRENCE",
                  reason: reason.trim(),
                  ...bulkFields,
                },
              },
            );

      onSaved(mode, saved);
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
      } else if (err instanceof ApiError && (err.code === "STALE_ACTIVITY" || err.code === "STALE_SCOPE")) {
        setStaleWarning(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not save changes. Please retry.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleFormSubmit(event: FormEvent) {
    event.preventDefault();
    void submitMutation();
  }

  const affectedPreviewList =
    scope === "THIS_AND_FUTURE" && previewData ? previewData.affectedActivities : [activity];
  const protectedPreviewList =
    scope === "THIS_AND_FUTURE" && previewData ? previewData.protectedActivities : [];

  return (
    <div className="subview">
      <section className="page-header page-header--split">
        <div>
          <p className="eyebrow">
            {mode === "edit" ? "ACTIVITY CALENDAR / EDIT SCHEDULE" : "ACTIVITY CALENDAR / CANCEL ACTIVITY"}
          </p>
          <h1>{mode === "edit" ? "Edit or reschedule activity" : "Cancel activity"}</h1>
          <p className="page-subtitle">
            {mode === "edit"
              ? "Keep the same activity reference while retaining the original schedule in history."
              : "Cancelled entries leave reminders and default views, while staying visible in the Cancelled filter."}
          </p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="button button--ghost" onClick={onCancel} disabled={submitting}>
            ← Back to calendar
          </button>
        </div>
      </section>

      <div className="two-col-layout">
        <form className="card form-card" onSubmit={handleFormSubmit} noValidate>
          <div className="form-card__title-row">
            <h2>{activity.name}</h2>
            <span className={`pill ${activity.status === "OVERDUE" ? "pill--overdue" : "pill--scheduled"}`}>
              {activity.status === "OVERDUE" ? "Overdue" : "Scheduled"}
            </span>
          </div>

          {error && (
            <div className="alert alert--error" role="alert">
              {error}
            </div>
          )}

          {staleWarning && (
            <div className="callout callout--warning" role="alert">
              <p className="callout__title">Activity changed before save</p>
              <p className="callout__body">{staleWarning}</p>
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

          {isRepeating && (
            <fieldset className="scope-fieldset">
              <legend>Apply to repeating series ({formatRecurrenceLabel(activity.recurrence)})</legend>
              <div className="scope-options">
                <label className="scope-option">
                  <input
                    type="radio"
                    name="scope"
                    value="THIS_OCCURRENCE"
                    checked={scope === "THIS_OCCURRENCE"}
                    onChange={() => {
                      setScope("THIS_OCCURRENCE");
                      setConflictState(null);
                      setError(null);
                    }}
                  />
                  <span>
                    <strong>This occurrence only</strong>
                    <span className="muted-sm">Only {activity.reference} changes.</span>
                  </span>
                </label>

                <label className="scope-option">
                  <input
                    type="radio"
                    name="scope"
                    value="THIS_AND_FUTURE"
                    checked={scope === "THIS_AND_FUTURE"}
                    onChange={() => {
                      setScope("THIS_AND_FUTURE");
                      setConflictState(null);
                      setError(null);
                    }}
                  />
                  <span>
                    <strong>This and future occurrences</strong>
                    <span className="muted-sm">
                      Covers this entry and later upcoming unfinished entries. Other overdue and completed entries stay
                      unchanged.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
          )}

          {mode === "edit" ? (
            <>
              <label className="field">
                <span>Activity name *</span>
                <input
                  name="name"
                  type="text"
                  maxLength={120}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setConflictState(null);
                    setError(null);
                  }}
                  required
                />
              </label>

              <div className="field-row">
                <label className="field">
                  <span>Scheduled date *</span>
                  <input
                    name="scheduledDate"
                    type="date"
                    value={scheduledDate}
                    onChange={(e) => {
                      setScheduledDate(e.target.value);
                      setConflictState(null);
                      setError(null);
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
                      setConflictState(null);
                      setError(null);
                    }}
                    required
                  />
                </label>
              </div>

              <label className="field">
                <span>Activity notes</span>
                <textarea
                  name="scheduleNotes"
                  rows={4}
                  maxLength={1000}
                  value={scheduleNotes}
                  onChange={(e) => {
                    setScheduleNotes(e.target.value);
                    setError(null);
                  }}
                />
              </label>

              {conflictState && (
                <div className="callout callout--warning" role="alert">
                  <p className="callout__title">Same-time schedule conflict</p>
                  <p className="callout__body">{conflictState.message}</p>
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
                      onClick={() => void submitMutation(conflictState.conflictReferences)}
                    >
                      {submitting ? "Saving…" : "Continue Anyway"}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <label className="field">
              <span>Cancellation reason *</span>
              <textarea
                name="reason"
                rows={4}
                maxLength={500}
                placeholder="Explain why this activity is being cancelled."
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setError(null);
                }}
                required
              />
            </label>
          )}

          <div className="form-card__footer">
            <span className="muted-sm">* Required fields</span>
            <div className="form-card__buttons">
              <button type="button" className="button button--ghost" onClick={onCancel} disabled={submitting}>
                Back
              </button>
              <button
                type="submit"
                className={mode === "edit" ? "button button--primary" : "button button--danger"}
                disabled={submitting || (isRepeating && scope === "THIS_AND_FUTURE" && previewLoading)}
              >
                {submitting
                  ? mode === "edit"
                    ? "Saving…"
                    : "Cancelling…"
                  : mode === "edit"
                    ? "Save schedule changes"
                    : "Confirm cancellation"}
              </button>
            </div>
          </div>
        </form>

        <aside className="side-stack">
          <section className="card detail-card">
            <h2>Current record</h2>
            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Reference</dt>
                <dd>{activity.reference}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Current schedule</dt>
                <dd>{formatShortDateTime(activity.scheduledDate, activity.scheduledTime)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Original schedule</dt>
                <dd>{formatShortDateTime(activity.originalScheduledDate, activity.originalScheduledTime)}</dd>
              </div>
              {activity.seriesReference && (
                <div className="detail-list__row">
                  <dt>Series</dt>
                  <dd>
                    {formatRecurrenceLabel(activity.recurrence)} · #{activity.seriesIndex}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          {isRepeating && scope === "THIS_AND_FUTURE" && (
            <section className="card preview-card" aria-label="Affected occurrences preview">
              <div className="preview-card__header">
                <h2>{mode === "edit" ? "Affected occurrences" : "Occurrences to cancel"}</h2>
                <span className="pill pill--neutral">
                  {previewLoading ? "Checking…" : `${affectedPreviewList.length} selected`}
                </span>
              </div>

              {previewError && <p className="muted-sm">{previewError}</p>}

              <ul className="preview-dates">
                {affectedPreviewList.map((item) => (
                  <li key={item.reference}>
                    <span>{item.reference}</span>
                    <strong>{item.name}</strong>
                    <span className="muted-sm">{formatShortDateTime(item.scheduledDate, item.scheduledTime)}</span>
                  </li>
                ))}
              </ul>

              {protectedPreviewList.length > 0 && (
                <div className="preview-protected">
                  <h3>Protected (kept unchanged)</h3>
                  <ul className="preview-dates">
                    {protectedPreviewList.map((item) => (
                      <li key={item.reference}>
                        <span>{item.reference}</span>
                        <strong>{item.status}</strong>
                        <span className="muted-sm">{formatShortDateTime(item.scheduledDate, item.scheduledTime)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
