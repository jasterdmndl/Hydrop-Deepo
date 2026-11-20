import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, ApiError } from "./api";
import { LogoutErrorBanner, useAuth, useSignedInUser } from "./auth/AuthContext";
import { idlePhase } from "./auth/idle";
import type { RemindersResponse } from "./calendar/calendarView";
import {
  loadPendingRecovery,
  type PosDayResponse,
  stationStatusFromDay,
} from "./pos/posRecovery";

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
  tone?: "open" | "closed" | "warning";
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
  stationStatusOverride?: StationStatus | null;
  children: ReactNode;
}

const DRAWER_MEDIA_QUERY = "(max-width: 799px), (orientation: portrait) and (max-width: 900px)";
const FOCUSABLE_SELECTOR = 'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function AppShell({ activeKey, sectionName, modulesData, stationStatusOverride, children }: AppShellProps) {
  const user = useSignedInUser();
  const { state, clockOffset, logout, loggingOut, logoutError } = useAuth();
  const location = useLocation();
  const [fetchedModules, setFetchedModules] = useState<ModulesResponse | null>(null);
  const [fetchedStationStatus, setFetchedStationStatus] = useState<StationStatus | null>(null);
  const [isDrawerMode, setIsDrawerMode] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(DRAWER_MEDIA_QUERY).matches
      : false,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusOnCloseRef = useRef(false);

  const closeDrawer = useCallback((restoreFocus: boolean) => {
    restoreFocusOnCloseRef.current = restoreFocus;
    setDrawerOpen(false);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DRAWER_MEDIA_QUERY);
    const update = () => {
      setIsDrawerMode(media.matches);
      if (!media.matches) {
        restoreFocusOnCloseRef.current = false;
        setDrawerOpen(false);
      }
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (logoutError) setDrawerOpen(false);
  }, [logoutError]);

  useEffect(() => {
    const workspace = workspaceRef.current as (HTMLDivElement & { inert: boolean }) | null;
    if (workspace) {
      workspace.inert = isDrawerMode && drawerOpen;
    }
    const drawer = drawerRef.current as (HTMLElement & { inert: boolean }) | null;
    if (drawer) {
      drawer.inert = isDrawerMode && !drawerOpen;
    }
    if (isDrawerMode && !drawerOpen && restoreFocusOnCloseRef.current) {
      restoreFocusOnCloseRef.current = false;
      menuButtonRef.current?.focus();
    }
  }, [isDrawerMode, drawerOpen]);

  useEffect(() => {
    if (!isDrawerMode || !drawerOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const rafId = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="alertdialog"]')) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer(true);
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusables = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null,
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(rafId);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isDrawerMode, drawerOpen, closeDrawer]);

  useEffect(() => {
    if (!isDrawerMode || !drawerOpen || state.status !== "signed-in") return;
    const idleExpiresAt = state.idleExpiresAt;
    const checkIdle = () => {
      if (idlePhase(Date.now() + clockOffset, idleExpiresAt).phase === "warning") {
        setDrawerOpen(false);
      }
    };
    checkIdle();
    const timer = window.setInterval(checkIdle, 1000);
    return () => window.clearInterval(timer);
  }, [isDrawerMode, drawerOpen, state, clockOffset]);

  useEffect(() => {
    if (modulesData !== undefined) return;
    api<ModulesResponse>("/api/modules", { background: true })
      .then(setFetchedModules)
      .catch(() => undefined);
  }, [modulesData]);

  const effective = modulesData !== undefined ? modulesData : fetchedModules;
  const effectiveModuleStation = effective?.stationStatus ?? null;

  useEffect(() => {
    if (stationStatusOverride !== undefined || effectiveModuleStation !== null) return;
    let cancelled = false;
    api<PosDayResponse>("/api/pos/day", { background: true })
      .then((day) => {
        if (!cancelled) setFetchedStationStatus(stationStatusFromDay(day));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [stationStatusOverride, effectiveModuleStation]);

  const modules = effective?.modules ?? [];
  const stationStatus =
    stationStatusOverride !== undefined ? stationStatusOverride : (effectiveModuleStation ?? fetchedStationStatus);
  const todayManila = formatManilaToday();
  const drawerActive = isDrawerMode && drawerOpen;

  const normalizePath = (path: string) => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);

  const handleDrawerLinkClick = (event: MouseEvent<HTMLAnchorElement>, targetPath: string) => {
    if (!isDrawerMode) return;
    const isSamePage = normalizePath(location.pathname) === normalizePath(targetPath);
    const isPlainClick = !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
    if (isSamePage && isPlainClick) {
      event.preventDefault();
    }
    closeDrawer(isSamePage);
  };

  return (
    <div className="shell">
      {drawerActive && (
        <div className="drawer-backdrop" aria-hidden="true" onClick={() => closeDrawer(true)} />
      )}
      <aside
        id="workspace-sidebar"
        ref={drawerRef}
        className={drawerActive ? "sidebar sidebar--open" : "sidebar"}
        role={drawerActive ? "dialog" : undefined}
        aria-modal={drawerActive ? true : undefined}
        aria-label="Workspace navigation"
        aria-hidden={isDrawerMode && !drawerOpen ? true : undefined}
      >
        <div className="sidebar__top">
          <div className="sidebar__brand-row">
            <div className="brand">
              <span className="brand__name">Hydrop Deepo</span>
              <span className="brand__tag">WATER REFILLING STATION</span>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className="drawer-close"
              aria-label="Close navigation menu"
              onClick={() => closeDrawer(true)}
            >
              ✕
            </button>
          </div>

          <div className="sidebar__section-label">WORKSPACE</div>
          <nav className="sidebar__nav">
            <Link
              to="/"
              className={`nav-item ${activeKey === "home" ? "nav-item--active" : ""}`}
              aria-current={activeKey === "home" ? "page" : undefined}
              onClick={(event) => handleDrawerLinkClick(event, "/")}
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
                    onClick={(event) => handleDrawerLinkClick(event, mod.path!)}
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
              <span
                className={`station-pill ${
                  stationStatus.tone === "warning"
                    ? "station-pill--warning"
                    : stationStatus.isOpen
                      ? "station-pill--open"
                      : "station-pill--closed"
                }`}
              >
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

      <div className="workspace" ref={workspaceRef}>
        <header className="topbar">
          <div className="topbar__start">
            <button
              ref={menuButtonRef}
              type="button"
              className="menu-button"
              aria-label="Open navigation menu"
              aria-expanded={drawerActive}
              aria-controls="workspace-sidebar"
              onClick={() => setDrawerOpen(true)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
              <span>Menu</span>
            </button>
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
          </div>
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
  const [posDay, setPosDay] = useState<PosDayResponse | null>(null);
  const [posDayError, setPosDayError] = useState(false);
  const [pendingRecovery] = useState(() => loadPendingRecovery());

  const loadReminders = useCallback(async () => {
    setRemindersError(false);
    try {
      setReminders(await api<RemindersResponse>("/api/calendar/reminders", { background: true }));
    } catch {
      setRemindersError(true);
    }
  }, []);

  const loadPosDay = useCallback(async () => {
    setPosDayError(false);
    try {
      setPosDay(await api<PosDayResponse>("/api/pos/day", { background: true }));
    } catch {
      setPosDayError(true);
    }
  }, []);

  useEffect(() => {
    void loadReminders();
    void loadPosDay();
  }, [loadReminders, loadPosDay]);

  const stationStatus = posDay ? stationStatusFromDay(posDay) : null;

  return (
    <AppShell activeKey="home" modulesData={data} stationStatusOverride={stationStatus}>
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
              void loadPosDay();
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
                {mod.key === "pos" && (
                  <div className="module-card__reminders" aria-label="Station business day summary">
                    {posDay ? (
                      <span
                        className={`pill ${
                          posDay.state === "OPEN"
                            ? "pill--completed"
                            : posDay.state === "PREVIOUS_DAY_OPEN"
                              ? "pill--overdue"
                              : "pill--neutral"
                        }`}
                      >
                        {stationStatusFromDay(posDay).label}
                      </span>
                    ) : posDayError ? (
                      <span className="module-card__note">Could not load station status.</span>
                    ) : (
                      <span className="module-card__note">Checking station day…</span>
                    )}
                    {pendingRecovery && (
                      <span className="pill pill--overdue">Pending recovery: {pendingRecovery.reference}</span>
                    )}
                  </div>
                )}
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
