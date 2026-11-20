import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, ApiError } from "./api";
import { LogoutErrorBanner, useAuth, useSignedInUser } from "./auth/AuthContext";
import { idlePhase } from "./auth/idle";
import { createRequestTracker, type RemindersResponse } from "./calendar/calendarView";
import {
  buildOverdueAttention,
  collectPendingPaymentReferences,
  formatManilaBannerDate,
  formatManilaFullDate,
  manilaGreeting,
  orderSidebarModules,
  selectHomeCardModules,
} from "./chooseModuleView";
import {
  isPendingRecoveryStorageKey,
  isPosSyncStorageKey,
  loadPendingRecoveries,
  type PendingCheckoutRecovery,
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

function ModuleIcon({ moduleKey }: { moduleKey: ModuleEntry["key"] }) {
  switch (moduleKey) {
    case "dashboard":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "pos":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="19.5" r="1.5" />
          <circle cx="17.5" cy="19.5" r="1.5" />
          <path d="M2.5 4h2.6l2.2 10.4a1.5 1.5 0 0 0 1.5 1.2h8.8a1.5 1.5 0 0 0 1.4-1.1l1.5-6.5H6" />
        </svg>
      );
    case "calendar":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3.5" y="4.5" width="17" height="16" rx="2" />
          <path d="M8 2.5v4" />
          <path d="M16 2.5v4" />
          <path d="M3.5 10h17" />
          <path d="M8 14h2" />
          <path d="M12 14h4" />
          <path d="M8 17.5h4" />
        </svg>
      );
    case "inventory":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6h11" />
          <path d="M9 12h11" />
          <path d="M9 18h11" />
          <circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

function LogoutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

function TopbarCalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="16" rx="2" />
      <path d="M8 2.5v4" />
      <path d="M16 2.5v4" />
      <path d="M3.5 10h17" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 4.5 6.2v5.4c0 4.6 3.2 8.7 7.5 9.9 4.3-1.2 7.5-5.3 7.5-9.9V6.2L12 3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function homeCardDescription(mod: ModuleEntry): string {
  switch (mod.key) {
    case "pos":
      return "Select a refill service, receive cash, and save each sale with confidence.";
    case "dashboard":
      return mod.state === "locked"
        ? "Owner-only sales summaries, refill quantities, and station trends."
        : "See your sales, refill quantities, and trends for any reporting period.";
    case "calendar":
      return mod.state === "read-only"
        ? "View scheduled station activities and completion history. Only the Owner can schedule or record work."
        : "Keep track of station activities, schedule work, and record completion.";
    case "inventory":
      return "Track stock on hand, receiving, and operating supplies used.";
  }
}

export interface AppShellProps {
  activeKey: "home" | ModuleEntry["key"];
  sectionName?: string;
  pageLabel?: string;
  modulesData?: ModulesResponse | null;
  stationStatusOverride?: StationStatus | null;
  children: ReactNode;
}

const DRAWER_MEDIA_QUERY = "(max-width: 799px), (orientation: portrait) and (max-width: 900px)";
const FOCUSABLE_SELECTOR = 'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function AppShell({
  activeKey,
  sectionName,
  pageLabel,
  modulesData,
  stationStatusOverride,
  children,
}: AppShellProps) {
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
  const stationTrackerRef = useRef(createRequestTracker());

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
    let active = true;
    const refreshStation = () => {
      const requestId = stationTrackerRef.current.next();
      api<PosDayResponse>("/api/pos/day", { background: true })
        .then((day) => {
          if (active && stationTrackerRef.current.isCurrent(requestId)) {
            setFetchedStationStatus(stationStatusFromDay(day));
          }
        })
        .catch(() => undefined);
    };
    refreshStation();
    const onStorage = (event: StorageEvent) => {
      if (isPendingRecoveryStorageKey(event.key) || isPosSyncStorageKey(event.key)) {
        refreshStation();
      }
    };
    const onReturn = () => {
      if (document.visibilityState === "visible") {
        refreshStation();
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      active = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [stationStatusOverride, effectiveModuleStation]);

  const isHome = activeKey === "home";
  const modules = effective?.modules ?? [];
  const sidebarModules = orderSidebarModules(modules);
  const stationStatus =
    stationStatusOverride !== undefined ? stationStatusOverride : (effectiveModuleStation ?? fetchedStationStatus);
  const todayManila = formatManilaFullDate();
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
    <div className={isHome ? "shell shell--home" : "shell"}>
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
            {sidebarModules.map((mod) => {
              const isActive = activeKey === mod.key;
              const hint = sidebarHint(mod.state);
              const labelContent = (
                <span className="nav-item__main">
                  <span className="nav-item__icon" aria-hidden="true">
                    <ModuleIcon moduleKey={mod.key} />
                  </span>
                  <span className="nav-item__label">{mod.name}</span>
                </span>
              );

              if (mod.path && (mod.state === "open" || mod.state === "read-only")) {
                return (
                  <Link
                    key={mod.key}
                    to={mod.path}
                    className={`nav-item ${isActive ? "nav-item--active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                    onClick={(event) => handleDrawerLinkClick(event, mod.path!)}
                  >
                    {labelContent}
                    {hint && <span className="nav-item__tag">{hint}</span>}
                  </Link>
                );
              }
              return (
                <div key={mod.key} className="nav-item nav-item--disabled" aria-disabled="true">
                  {labelContent}
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
            <span className="logout-button__icon" aria-hidden="true">
              <LogoutIcon />
            </span>
            <span>{loggingOut ? "Signing out…" : "Logout"}</span>
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
                  {isHome ? (
                    <span className="breadcrumb__root">Workspace</span>
                  ) : (
                    <Link to="/" className="breadcrumb__link">
                      Workspace
                    </Link>
                  )}
                  <span className="breadcrumb__sep" aria-hidden="true">
                    ›
                  </span>
                  <span className="breadcrumb__current" aria-current={isHome ? "page" : undefined}>
                    {sectionName}
                  </span>
                </>
              ) : (
                <span className="breadcrumb__current">Workspace</span>
              )}
            </nav>
          </div>
          <div className="topbar__date">
            {isHome && (
              <span className="topbar__date-icon" aria-hidden="true">
                <TopbarCalendarIcon />
              </span>
            )}
            <span>{todayManila}</span>
          </div>
        </header>

        <main className="content" aria-label={pageLabel}>
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
  const [pendingRecoveries, setPendingRecoveries] = useState<PendingCheckoutRecovery[]>(() =>
    loadPendingRecoveries(),
  );
  const posDayTrackerRef = useRef(createRequestTracker());
  const remindersTrackerRef = useRef(createRequestTracker());

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Choose Module — Hydrop Deepo";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const loadReminders = useCallback(async () => {
    const requestId = remindersTrackerRef.current.next();
    setRemindersError(false);
    try {
      const next = await api<RemindersResponse>("/api/calendar/reminders", { background: true });
      if (!remindersTrackerRef.current.isCurrent(requestId)) return;
      setReminders(next);
    } catch {
      if (!remindersTrackerRef.current.isCurrent(requestId)) return;
      setRemindersError(true);
    }
  }, []);

  const loadPosDay = useCallback(async () => {
    const requestId = posDayTrackerRef.current.next();
    setPosDayError(false);
    try {
      const next = await api<PosDayResponse>("/api/pos/day", { background: true });
      if (!posDayTrackerRef.current.isCurrent(requestId)) return;
      setPosDay(next);
    } catch {
      if (!posDayTrackerRef.current.isCurrent(requestId)) return;
      setPosDayError(true);
    }
  }, []);

  useEffect(() => {
    void loadReminders();
    void loadPosDay();
    setPendingRecoveries(loadPendingRecoveries());
    const onStorage = (event: StorageEvent) => {
      if (isPendingRecoveryStorageKey(event.key) || isPosSyncStorageKey(event.key)) {
        setPendingRecoveries(loadPendingRecoveries());
        void loadPosDay();
      }
    };
    const onReturn = () => {
      if (document.visibilityState === "visible") {
        setPendingRecoveries(loadPendingRecoveries());
        void loadPosDay();
        void loadReminders();
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [loadReminders, loadPosDay]);

  const stationStatus = posDay ? stationStatusFromDay(posDay) : null;
  const cardModules = selectHomeCardModules(data?.modules ?? []);
  const pendingRefs = collectPendingPaymentReferences(pendingRecoveries, posDay);
  const overdueAttention = buildOverdueAttention(reminders, user.role);

  return (
    <AppShell
      activeKey="home"
      sectionName="Choose module"
      pageLabel="Choose Module"
      modulesData={data}
      stationStatusOverride={stationStatus}
    >
      <section className="home-greeting">
        <p className="home-greeting__eyebrow">YOU’RE LOGGED IN</p>
        <h1>
          {manilaGreeting()}, {user.username}
        </h1>
        <p className="home-greeting__subtitle">
          Choose where you’d like to start. Everything your station needs, in one place.
        </p>
      </section>

      <section className="home-hero" aria-label="Station overview">
        <span className="home-hero__date">{formatManilaBannerDate()}</span>
        <h2 className="home-hero__title">A fresh day at Hydrop Deepo.</h2>
        <p className="home-hero__subtitle">Take a sale, check your progress, or plan the day ahead.</p>
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
        <div className="module-grid home-module-grid">
          {cardModules.map((mod) => {
            const canOpen = Boolean(mod.path && (mod.state === "open" || mod.state === "read-only"));
            return (
              <article
                key={mod.key}
                className={`home-card ${canOpen ? "home-card--available" : "home-card--unavailable"}`}
              >
                <div className="home-card__top">
                  <span
                    className={`home-card__icon ${canOpen ? "" : "home-card__icon--muted"}`}
                    aria-hidden="true"
                  >
                    <ModuleIcon moduleKey={mod.key} />
                  </span>
                  {mod.state !== "open" && (
                    <span className={`badge badge--${mod.state}`}>{moduleBadgeText(mod.state)}</span>
                  )}
                </div>

                <h2>{mod.name}</h2>
                <p className="home-card__desc">{homeCardDescription(mod)}</p>

                <div className="home-card__bottom">
                  <div className="home-card__status">
                    {mod.key === "pos" && (
                      <div aria-label="Station business day summary">
                        {posDay ? (
                          posDay.state === "OPEN" ? (
                            <span className="home-card__status-text home-card__status-text--accent">
                              Station open · Ready for the next refill
                            </span>
                          ) : posDay.state === "PREVIOUS_DAY_OPEN" ? (
                            <span className="home-card__status-text home-card__status-text--warning">
                              Previous day open · Close {posDay.day?.businessDate ?? "prior day"} first
                            </span>
                          ) : posDay.state === "CLOSED" ? (
                            <span className="home-card__status-text home-card__status-text--muted">
                              Station closed · Today’s business day is closed
                            </span>
                          ) : (
                            <span className="home-card__status-text home-card__status-text--muted">
                              Station closed · Start Day in POS when ready
                            </span>
                          )
                        ) : posDayError ? (
                          <div className="home-card__status-error">
                            <span className="home-card__status-text home-card__status-text--muted">
                              Could not load station status.
                            </span>
                            <button
                              type="button"
                              className="button button--ghost button--sm"
                              onClick={() => void loadPosDay()}
                            >
                              Retry
                            </button>
                          </div>
                        ) : (
                          <span className="home-card__status-text home-card__status-text--muted">
                            Checking station day…
                          </span>
                        )}
                      </div>
                    )}

                    {mod.key === "pos" && pendingRefs.length === 1 && (
                      <span className="pill pill--warning home-card__pending-pill">
                        Pending payment: {pendingRefs[0]}
                      </span>
                    )}
                    {mod.key === "pos" && pendingRefs.length > 1 && (
                      <span className="pill pill--warning home-card__pending-pill">
                        {pendingRefs.length} pending payments ({pendingRefs.join(", ")})
                      </span>
                    )}

                    {mod.key === "dashboard" && (
                      <span
                        id="dashboard-availability-reason"
                        className="home-card__status-text home-card__status-text--muted"
                      >
                        {mod.state === "locked" ? "Restricted to Owner account." : "Planned for a later slice."}
                      </span>
                    )}

                    {mod.key === "inventory" && (
                      <span
                        id="inventory-availability-reason"
                        className="home-card__status-text home-card__status-text--muted"
                      >
                        Planned for a later slice.
                      </span>
                    )}

                    {mod.key === "calendar" && (
                      <div aria-label="Activity Calendar reminder summary">
                        {reminders ? (
                          <div className="home-card__status-row">
                            <span className="home-card__status-text home-card__status-text--accent">
                              {reminders.upcomingCount} upcoming
                            </span>
                            <span className="home-card__status-dot" aria-hidden="true">
                              ·
                            </span>
                            <span
                              className={`home-card__status-text ${
                                reminders.overdueCount > 0
                                  ? "home-card__status-text--warning"
                                  : "home-card__status-text--accent"
                              }`}
                            >
                              {reminders.overdueCount} overdue
                            </span>
                          </div>
                        ) : remindersError ? (
                          <div className="home-card__status-error">
                            <span className="home-card__status-text home-card__status-text--muted">
                              Could not load reminder counts.
                            </span>
                            <button
                              type="button"
                              className="button button--ghost button--sm"
                              onClick={() => void loadReminders()}
                            >
                              Retry
                            </button>
                          </div>
                        ) : (
                          <span className="home-card__status-text home-card__status-text--muted">
                            Checking reminders…
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {canOpen && mod.path ? (
                    <Link to={mod.path} className="button button--primary button--block home-card__action">
                      <span className="home-card__action__icon" aria-hidden="true">
                        <ArrowRightIcon />
                      </span>
                      <span>
                        {mod.key === "pos"
                          ? posDay?.state === "OPEN"
                            ? "Start a sale"
                            : "Open POS"
                          : mod.state === "read-only"
                            ? "View calendar"
                            : "Open calendar"}
                      </span>
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="button button--block home-card__action home-card__action--disabled"
                      disabled
                      aria-describedby={`${mod.key}-availability-reason`}
                    >
                      <span className="home-card__action__icon" aria-hidden="true">
                        {mod.state === "locked" ? <LockIcon /> : <ClockIcon />}
                      </span>
                      <span>{moduleBadgeText(mod.state)}</span>
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {overdueAttention && (
        <section className="home-attention" role="status" aria-label="Overdue activity reminder">
          <span className="home-attention__icon" aria-hidden="true">
            <ClockIcon />
          </span>
          <div className="home-attention__content">
            <h2 className="home-attention__title">{overdueAttention.title}</h2>
            <p className="home-attention__body">{overdueAttention.body}</p>
          </div>
        </section>
      )}

      <p className="home-footer-note">
        <span className="home-footer-note__icon" aria-hidden="true">
          <ShieldCheckIcon />
        </span>
        <span>
          You’re signed in as <strong>{user.username}</strong> ({roleLabel(user.role)}). Use Logout when leaving this
          station.
        </span>
      </p>
    </AppShell>
  );
}
