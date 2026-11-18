import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "./api";
import { LogoutErrorBanner, useAuth, useSignedInUser } from "./auth/AuthContext";
import type { RemindersResponse } from "./calendar/calendarView";

export type ModuleState = "open" | "read-only" | "locked" | "coming-later";

export interface ModuleEntry {
  key: "pos" | "dashboard" | "calendar" | "inventory";
  name: string;
  description: string;
  state: ModuleState;
  path?: string;
}

export interface StationStatus {
  isOpen: boolean;
  label: string;
  detail?: string;
}

export interface ModulesResponse {
  modules: ModuleEntry[];
  stationStatus: StationStatus | null;
}

export function useModulesData() {
  const [data, setData] = useState<ModulesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api<ModulesResponse>("/api/modules");
      setData(response);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load workspace modules.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, reload: load };
}

function formatManilaToday(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

function userInitials(username: string): string {
  const cleaned = username.trim().replace(/[^A-Za-z0-9]/g, "");
  return (cleaned.slice(0, 2) || "HD").toUpperCase();
}

function roleLabel(role: "OWNER" | "CASHIER"): string {
  return role === "OWNER" ? "Owner" : "Cashier";
}

function moduleBadgeText(state: ModuleState): string {
  switch (state) {
    case "open":
      return "Available";
    case "read-only":
      return "View only";
    case "locked":
      return "Locked — Owner only";
    case "coming-later":
      return "Coming later";
  }
}

function sidebarHint(state: ModuleState): string | null {
  switch (state) {
    case "open":
      return null;
    case "read-only":
      return "View";
    case "locked":
      return "Locked";
    case "coming-later":
      return "Later";
  }
}

export interface AppShellProps {
  activeKey: "home" | ModuleEntry["key"];
  sectionName?: string;
  modulesData?: ModulesResponse | null;
  children: ReactNode;
}

export function AppShell({ activeKey, sectionName, modulesData, children }: AppShellProps) {
  const user = useSignedInUser();
  const { logout, loggingOut } = useAuth();
  const [fetchedModules, setFetchedModules] = useState<ModulesResponse | null>(null);

  useEffect(() => {
    if (modulesData !== undefined) return;
    api<ModulesResponse>("/api/modules", { background: true })
      .then(setFetchedModules)
      .catch(() => undefined);
  }, [modulesData]);

  const effective = modulesData !== undefined ? modulesData : fetchedModules;
  const modules = effective?.modules ?? [];
  const stationStatus = effective?.stationStatus ?? null;
  const todayManila = formatManilaToday();

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Workspace navigation">
        <div className="sidebar__top">
          <div className="brand">
            <span className="brand__name">Hydrop Deepo</span>
            <span className="brand__tag">WATER REFILLING STATION</span>
          </div>

          <div className="sidebar__section-label">WORKSPACE</div>
          <nav className="sidebar__nav">
            <Link
              to="/"
              className={`nav-item ${activeKey === "home" ? "nav-item--active" : ""}`}
              aria-current={activeKey === "home" ? "page" : undefined}
            >
              <span className="nav-item__label">Choose Module</span>
            </Link>

            {modules.map((mod) => {
              const isActive = activeKey === mod.key;
              const hint = sidebarHint(mod.state);
              if (mod.path && (mod.state === "open" || mod.state === "read-only")) {
                return (
                  <Link
                    key={mod.key}
                    to={mod.path}
                    className={`nav-item ${isActive ? "nav-item--active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span className="nav-item__label">{mod.name}</span>
                    {hint && <span className="nav-item__tag">{hint}</span>}
                  </Link>
                );
              }
              return (
                <div key={mod.key} className="nav-item nav-item--disabled" aria-disabled="true">
                  <span className="nav-item__label">{mod.name}</span>
                  {hint && <span className="nav-item__tag">{hint}</span>}
                </div>
              );
            })}
          </nav>

          {stationStatus !== null && (
            <div className="station-card" role="status">
              <span className={`station-pill ${stationStatus.isOpen ? "station-pill--open" : "station-pill--closed"}`}>
                {stationStatus.label}
              </span>
              {stationStatus.detail && <p className="station-card__detail">{stationStatus.detail}</p>}
            </div>
          )}
        </div>

        <div className="sidebar__footer">
          <div className="operator">
            <div className="operator__avatar" aria-hidden="true">
              {userInitials(user.username)}
            </div>
            <div className="operator__meta">
              <span className="operator__name">{user.username}</span>
              <span className="operator__role">{roleLabel(user.role)}</span>
            </div>
          </div>
          <button
            className="logout-button"
            type="button"
            disabled={loggingOut}
            onClick={() => void logout()}
          >
            {loggingOut ? "Signing out…" : "Logout"}
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            {sectionName ? (
              <>
                <Link to="/" className="breadcrumb__link">
                  Workspace
                </Link>
                <span className="breadcrumb__sep" aria-hidden="true">
                  ›
                </span>
                <span className="breadcrumb__current">{sectionName}</span>
              </>
            ) : (
              <span className="breadcrumb__current">Workspace</span>
            )}
          </nav>
          <div className="topbar__date">{todayManila}</div>
        </header>

        <main className="content">
          <LogoutErrorBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

export function ChooseModule() {
  const user = useSignedInUser();
  const { data, loading, error, reload } = useModulesData();
  const [reminders, setReminders] = useState<RemindersResponse | null>(null);
  const [remindersError, setRemindersError] = useState(false);

  const loadReminders = useCallback(async () => {
    setRemindersError(false);
    try {
      setReminders(await api<RemindersResponse>("/api/calendar/reminders", { background: true }));
    } catch {
      setRemindersError(true);
    }
  }, []);

  useEffect(() => {
    void loadReminders();
  }, [loadReminders]);

  return (
    <AppShell activeKey="home" modulesData={data}>
      <section className="page-header">
        <div>
          <h1>Choose Module</h1>
          <p className="page-subtitle">
            Signed in as <strong>{user.username}</strong> ({roleLabel(user.role)}). Opening this menu or Activity Calendar
            does not open the sales day.
          </p>
        </div>
      </section>

      {error && (
        <div className="alert alert--error" role="alert">
          <span>{error}</span>{" "}
          <button
            className="button button--ghost button--sm"
            type="button"
            onClick={() => {
              void reload();
              void loadReminders();
            }}
          >
            Retry
          </button>
        </div>
      )}

      {loading && !data ? (
        <div className="card">
          <p className="muted">Loading available modules…</p>
        </div>
      ) : (
        <div className="module-grid">
          {(data?.modules ?? []).map((mod) => {
            const canOpen = Boolean(mod.path && (mod.state === "open" || mod.state === "read-only"));
            return (
              <article
                key={mod.key}
                className={`card module-card ${canOpen ? "module-card--available" : "module-card--muted"}`}
              >
                <div className="module-card__header">
                  <h2>{mod.name}</h2>
                  <span className={`badge badge--${mod.state}`}>{moduleBadgeText(mod.state)}</span>
                </div>
                <p className="module-card__desc">{mod.description}</p>
                {mod.key === "calendar" && (
                  <div className="module-card__reminders" aria-label="Activity Calendar reminder summary">
                    {reminders ? (
                      <>
                        <span className={`pill ${reminders.overdueCount > 0 ? "pill--overdue" : "pill--neutral"}`}>
                          {reminders.overdueCount} overdue
                        </span>
                        <span className={`pill ${reminders.upcomingCount > 0 ? "pill--scheduled" : "pill--neutral"}`}>
                          {reminders.upcomingCount} upcoming
                        </span>
                      </>
                    ) : remindersError ? (
                      <span className="module-card__note">Could not load reminder counts.</span>
                    ) : (
                      <span className="module-card__note">Checking reminders…</span>
                    )}
                  </div>
                )}
                <div className="module-card__footer">
                  {canOpen && mod.path ? (
                    <Link to={mod.path} className="button button--primary">
                      Open {mod.name}
                    </Link>
                  ) : mod.state === "locked" ? (
                    <span className="module-card__note">Restricted to Owner account.</span>
                  ) : (
                    <span className="module-card__note">Planned for a later slice.</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
