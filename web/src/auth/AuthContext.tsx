import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, onIdleExpiry, onSessionEnded, setCsrfToken } from "../api";
import { clockOffsetMs, resolveLogoutOutcome, shouldSendHeartbeat } from "./idle";

export type Role = "OWNER" | "CASHIER";

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
  | { status: "signed-out"; notice?: string }
  | { status: "signed-in"; user: SessionUser; idleExpiresAt: number };

interface AuthContextValue {
  state: AuthState;
  /** Server clock minus device clock, for the idle warning. */
  clockOffset: number;
  logoutError: string | null;
  loggingOut: boolean;
  clearLogoutError(): void;
  login(username: string, password: string): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  logout(): Promise<void>;
  continueWorking(): Promise<void>;
  /** Re-reads the session without counting as active use. */
  refreshSession(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const EXPIRED_NOTICE = "You were signed out because the session ended. Please sign in again.";

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [clockOffset, setClockOffset] = useState(0);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const lastHeartbeat = useRef(Date.now());

  const accept = useCallback((data: SessionResponse) => {
    setCsrfToken(data.csrfToken);
    setClockOffset(clockOffsetMs(data.session.serverNow, Date.now()));
    setLogoutError(null);
    lastHeartbeat.current = Date.now();
    setState({ status: "signed-in", user: data.user, idleExpiresAt: Date.parse(data.session.idleExpiresAt) });
  }, []);

  const signOutLocally = useCallback((notice?: string) => {
    setCsrfToken(null);
    setLogoutError(null);
    setState({ status: "signed-out", notice });
  }, []);

  const clearLogoutError = useCallback(() => {
    setLogoutError(null);
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      accept(await api<SessionResponse>("/api/auth/session", { background: true }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return; // handled by onSessionEnded
      throw error;
    }
  }, [accept]);

  // Initial session check (survives page reloads and server restarts).
  useEffect(() => {
    api<SessionResponse>("/api/auth/session", { background: true })
      .then(accept)
      .catch(() => signOutLocally());
  }, [accept, signOutLocally]);

  useEffect(
    () =>
      onSessionEnded((code) => {
        setLogoutError(null);
        setState((current) => {
          if (current.status !== "signed-in") return current;
          setCsrfToken(null);
          return { status: "signed-out", notice: code === "SESSION_EXPIRED" ? EXPIRED_NOTICE : undefined };
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

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      clockOffset,
      logoutError,
      loggingOut,
      clearLogoutError,
      refreshSession,
      continueWorking,
      async login(username, password) {
        accept(await api<SessionResponse>("/api/auth/login", { method: "POST", body: { username, password } }));
        navigate("/", { replace: true });
      },
      async changePassword(currentPassword, newPassword) {
        accept(
          await api<SessionResponse>("/api/auth/password", {
            method: "POST",
            body: { currentPassword, newPassword },
          }),
        );
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
            signOutLocally(
              error instanceof ApiError && error.code === "SESSION_EXPIRED" ? EXPIRED_NOTICE : undefined,
            );
          } else {
            setLogoutError(outcome.errorMessage);
          }
        } finally {
          setLoggingOut(false);
        }
      },
    }),
    [state, clockOffset, logoutError, loggingOut, clearLogoutError, refreshSession, continueWorking, accept, signOutLocally, navigate],
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
