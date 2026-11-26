import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { advanceAuthGeneration, api, ApiError, onIdleExpiry, onSessionEnded, setCsrfToken } from "../api";
import { nextNoticeId } from "../notifications/noticeTiming";
import { clockOffsetMs, resolveLogoutOutcome, shouldSendHeartbeat } from "./idle";

export type Role = "OWNER" | "EMPLOYEE";

export interface SessionUser {
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

interface SessionTiming {
  serverNow: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

interface SessionResponse {
  user: SessionUser;
  csrfToken: string;
  session: SessionTiming;
}

type AuthState =
  | { status: "loading" }
  | { status: "signed-out"; notice?: string; noticeId?: number }
  | { status: "signed-in"; user: SessionUser; idleExpiresAt: number };

interface AuthContextValue {
  state: AuthState;
  /** Server clock minus device clock, for the idle warning. */
  clockOffset: number;
  logoutError: string | null;
  loggingOut: boolean;
  clearLogoutError(): void;
  clearNotice(): void;
  login(username: string, password: string): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  logout(): Promise<void>;
  continueWorking(): Promise<void>;
  /** Re-reads the session without counting as active use. */
  refreshSession(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const EXPIRED_NOTICE = "You were signed out because the session ended. Please sign in again.";
const REPLACED_NOTICE = "Your account was signed in on another device.";
const SESSION_POLL_MS = 10_000;

function sessionEndedNotice(code: string): string | undefined {
  if (code === "SESSION_REPLACED") return REPLACED_NOTICE;
  if (code === "SESSION_EXPIRED") return EXPIRED_NOTICE;
  return undefined;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [clockOffset, setClockOffset] = useState(0);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const lastHeartbeat = useRef(Date.now());
  const sessionEpochRef = useRef(0);
  const refreshInFlightRef = useRef(false);

  const accept = useCallback((data: SessionResponse, options?: { touchHeartbeat?: boolean }) => {
    setCsrfToken(data.csrfToken);
    setClockOffset(clockOffsetMs(data.session.serverNow, Date.now()));
    setLogoutError(null);
    if (options?.touchHeartbeat !== false) {
      lastHeartbeat.current = Date.now();
    }
    setState({ status: "signed-in", user: data.user, idleExpiresAt: Date.parse(data.session.idleExpiresAt) });
  }, []);

  const signOutLocally = useCallback((notice?: string) => {
    advanceAuthGeneration();
    sessionEpochRef.current += 1;
    setCsrfToken(null);
    setLogoutError(null);
    setState({ status: "signed-out", notice, noticeId: notice ? nextNoticeId() : undefined });
  }, []);

  const clearLogoutError = useCallback(() => {
    setLogoutError(null);
  }, []);

  const clearNotice = useCallback(() => {
    setState((current) =>
      current.status === "signed-out" && current.notice ? { status: "signed-out" } : current,
    );
  }, []);

  const refreshSession = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    const epoch = sessionEpochRef.current;
    refreshInFlightRef.current = true;
    try {
      const data = await api<SessionResponse>("/api/auth/session", { background: true });
      if (epoch !== sessionEpochRef.current) return;
      accept(data, { touchHeartbeat: false });
    } catch (error) {
      if (epoch !== sessionEpochRef.current) return;
      if (error instanceof ApiError && error.status === 401) return; // handled by onSessionEnded
      throw error;
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [accept]);

  // Initial session check (survives page reloads and server restarts).
  useEffect(() => {
    const epoch = sessionEpochRef.current;
    api<SessionResponse>("/api/auth/session", { background: true })
      .then((data) => {
        if (epoch !== sessionEpochRef.current) return;
        accept(data);
      })
      .catch((error) => {
        if (epoch !== sessionEpochRef.current) return;
        signOutLocally(error instanceof ApiError ? sessionEndedNotice(error.code) : undefined);
      });
  }, [accept, signOutLocally]);

  useEffect(
    () =>
      onSessionEnded((code) => {
        setLogoutError(null);
        setState((current) => {
          if (current.status !== "signed-in") return current;
          advanceAuthGeneration();
          sessionEpochRef.current += 1;
          setCsrfToken(null);
          const notice = sessionEndedNotice(code);
          return {
            status: "signed-out",
            notice,
            noticeId: notice ? nextNoticeId() : undefined,
          };
        });
      }),
    [],
  );

  useEffect(
    () =>
      onIdleExpiry((iso) => {
        setState((current) =>
          current.status === "signed-in" ? { ...current, idleExpiresAt: Date.parse(iso) } : current,
        );
      }),
    [],
  );

  const continueWorking = useCallback(async () => {
    lastHeartbeat.current = Date.now();
    await api<{ session: SessionTiming }>("/api/auth/activity", { method: "POST" });
  }, []);

  // Active use on screen (taps, typing) resets the idle timer via a throttled heartbeat.
  const signedIn = state.status === "signed-in";
  useEffect(() => {
    if (!signedIn) return;
    const onUse = () => {
      if (shouldSendHeartbeat(lastHeartbeat.current, Date.now())) {
        continueWorking().catch(() => undefined);
      }
    };
    window.addEventListener("pointerdown", onUse);
    window.addEventListener("keydown", onUse);
    return () => {
      window.removeEventListener("pointerdown", onUse);
      window.removeEventListener("keydown", onUse);
    };
  }, [signedIn, continueWorking]);

  // Check session state without extending the idle timer when returning to the tab or periodically while visible.
  useEffect(() => {
    if (!signedIn) return;
    const checkSessionInBackground = () => {
      if (document.visibilityState !== "visible" || refreshInFlightRef.current) return;
      void refreshSession().catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkSessionInBackground();
      }
    };
    const onFocus = () => {
      checkSessionInBackground();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(checkSessionInBackground, SESSION_POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [signedIn, refreshSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      clockOffset,
      logoutError,
      loggingOut,
      clearLogoutError,
      clearNotice,
      refreshSession,
      continueWorking,
      async login(username, password) {
        const data = await api<SessionResponse>("/api/auth/login", { method: "POST", body: { username, password } });
        advanceAuthGeneration();
        sessionEpochRef.current += 1;
        accept(data);
        navigate("/", { replace: true });
      },
      async changePassword(currentPassword, newPassword) {
        const data = await api<SessionResponse>("/api/auth/password", {
          method: "POST",
          body: { currentPassword, newPassword },
        });
        advanceAuthGeneration();
        sessionEpochRef.current += 1;
        accept(data);
        navigate("/", { replace: true });
      },
      async logout() {
        setLoggingOut(true);
        setLogoutError(null);
        try {
          await api("/api/auth/logout", { method: "POST" });
          signOutLocally("You have signed out.");
        } catch (error) {
          const outcome = resolveLogoutOutcome(error);
          if (outcome.signedOut) {
            signOutLocally(error instanceof ApiError ? sessionEndedNotice(error.code) : undefined);
          } else {
            setLogoutError(outcome.errorMessage);
          }
        } finally {
          setLoggingOut(false);
        }
      },
    }),
    [state, clockOffset, logoutError, loggingOut, clearLogoutError, clearNotice, refreshSession, continueWorking, accept, signOutLocally, navigate],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function LogoutErrorBanner() {
  const { logoutError, loggingOut, logout, clearLogoutError } = useAuth();
  if (!logoutError) return null;

  return (
    <div className="alert alert--error logout-error" role="alert">
      <p className="logout-error__message">{logoutError}</p>
      <div className="logout-error__actions">
        <button className="button button--primary button--sm" type="button" disabled={loggingOut} onClick={() => void logout()}>
          {loggingOut ? "Signing out…" : "Retry sign out"}
        </button>
        <button className="button button--ghost button--sm" type="button" disabled={loggingOut} onClick={clearLogoutError}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

export function useSignedInUser(): SessionUser {
  const { state } = useAuth();
  if (state.status !== "signed-in") throw new Error("Not signed in");
  return state.user;
}
