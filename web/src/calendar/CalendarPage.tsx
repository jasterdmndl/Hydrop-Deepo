import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { AppShell, useModulesData } from "../ChooseModule";

interface CalendarAccess {
  canView: boolean;
  canManage: boolean;
}

type CalendarTab = "calendar" | "history";

export function CalendarPage() {
  const { data: modulesData } = useModulesData();
  const [access, setAccess] = useState<CalendarAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<CalendarTab>("calendar");
  const [notice, setNotice] = useState<string | null>(null);

  const loadAccess = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<CalendarAccess>("/api/calendar/access");
      setAccess(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not check Activity Calendar access.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccess();
  }, [loadAccess]);

  return (
    <AppShell activeKey="calendar" sectionName="Activity Calendar" modulesData={modulesData}>
      <section className="page-header page-header--split">
        <div>
          <h1>Activity Calendar</h1>
          <p className="page-subtitle">Plan station care and keep a clear record of completed work.</p>
        </div>

        <div className="page-header__actions">
          {access && (
            <span className={`badge ${access.canManage ? "badge--open" : "badge--read-only"}`}>
              {access.canManage ? "Owner access" : "View-only access"}
            </span>
          )}
          {access?.canManage && (
            <button
              className="button button--primary"
              type="button"
              onClick={() =>
                setNotice("Activity scheduling and completion endpoints will be added in Task 2 and connected in Task 3.")
              }
            >
              + Schedule activity
            </button>
          )}
        </div>
      </section>

      {notice && (
        <p className="alert alert--info" role="status">
          {notice}
        </p>
      )}

      {error && (
        <div className="alert alert--error" role="alert">
          <span>{error}</span>{" "}
          <button className="button button--ghost button--sm" type="button" onClick={() => void loadAccess()}>
            Retry
          </button>
        </div>
      )}

      {access && !access.canManage && (
        <p className="alert alert--info" role="status">
          You have view-only access. You can inspect scheduled activities and completion history; only the Owner can
          schedule activities or record completion.
        </p>
      )}

      <div className="tab-bar" role="tablist" aria-label="Activity Calendar views">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "calendar"}
          className={`tab ${tab === "calendar" ? "tab--active" : ""}`}
          onClick={() => setTab("calendar")}
        >
          Calendar
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "history"}
          className={`tab ${tab === "history" ? "tab--active" : ""}`}
          onClick={() => setTab("history")}
        >
          Completion history
        </button>
      </div>

      {loading ? (
        <div className="card">
          <p className="muted">Verifying Activity Calendar permissions…</p>
        </div>
      ) : access?.canView ? (
        <div className="calendar-layout">
          <section className="card calendar-panel">
            <h2>{tab === "calendar" ? "Monthly schedule overview" : "Completion history"}</h2>
            <p className="muted">
              {tab === "calendar"
                ? "The monthly grid, activity details, and schedule workflow will connect here in Tasks 2 and 3."
                : "Completed activity records and audit details will appear here once Calendar persistence is added in Task 2."}
            </p>
            <div className="calendar-panel__footer">
              <Link to="/" className="button button--ghost">
                Back to Choose Module
              </Link>
            </div>
          </section>

          <aside className="card reminder-panel">
            <h2>Upcoming &amp; overdue</h2>
            <p className="muted">
              Seven-day upcoming and overdue reminders in Asia/Manila will be derived from Calendar occurrences in Task 2.
            </p>
          </aside>
        </div>
      ) : null}
    </AppShell>
  );
}
