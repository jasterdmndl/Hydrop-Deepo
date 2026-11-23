import { type FormEvent, useState } from "react";
import { ApiError } from "../api";
import { nextNoticeId } from "../notifications/noticeTiming";
import { TemporaryNotice } from "../notifications/TemporaryNotice";
import { useAuth } from "./AuthContext";
import loginLogoUrl from "./login-logo.png";

interface LoginErrorState {
  id: number;
  code: string;
  message: string;
}

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.4 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.6 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

export function LoginPage({ notice, noticeId }: { notice?: string; noticeId?: number }) {
  const { login, clearNotice } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<LoginErrorState | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { id: nextNoticeId(), code: err.code, message: err.message }
          : {
              id: nextNoticeId(),
              code: "UNKNOWN",
              message: "Sign-in failed. Please try again.",
            },
      );
      setPassword("");
      setShowPassword(false);
    } finally {
      setBusy(false);
    }
  }

  const isInvalidCredentials = error?.code === "INVALID_CREDENTIALS";
  const inputWrapClass = isInvalidCredentials ? "login-input-wrap login-input-wrap--error" : "login-input-wrap";

  return (
    <main className="login-page">
      <section className="login-brand-panel" aria-label="Station overview">
        <div className="login-brand-panel__brand">
          <span className="login-brand-panel__name">Hydrop Deepo</span>
          <span className="login-brand-panel__tag">WATER REFILLING STATION</span>
        </div>

        <div className="login-brand-panel__body">
          <h2 className="login-brand-panel__headline">
            Fresh water.{" "}
            <br />
            Smooth operations.
          </h2>
          <p className="login-brand-panel__lead">
            Your everyday workspace for refills, sales insights, and station activities.
          </p>

          <ul className="login-brand-panel__features">
            <li>
              <span className="login-brand-panel__feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="20" r="1.5" />
                  <circle cx="18" cy="20" r="1.5" />
                  <path d="M2.5 4h2.6l2.3 10.6a1.5 1.5 0 0 0 1.5 1.2h8.9a1.5 1.5 0 0 0 1.4-1.1l1.6-6.7H6.1" />
                </svg>
              </span>
              <span>Simple, cash-only checkout</span>
            </li>
            <li>
              <span className="login-brand-panel__feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 20h16" />
                  <path d="M7 20v-6" />
                  <path d="M12 20V10" />
                  <path d="M17 20V6" />
                  <path d="m4 11 5-4 4 2 7-5" />
                </svg>
              </span>
              <span>A clearer view of every sale</span>
            </li>
            <li>
              <span className="login-brand-panel__feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="17" rx="2" />
                  <path d="M16 2v4" />
                  <path d="M8 2v4" />
                  <path d="M3 10h18" />
                  <path d="m9.5 15.5 1.8 1.8 3.7-3.8" />
                </svg>
              </span>
              <span>Station care, right on schedule</span>
            </li>
          </ul>
        </div>

        <p className="login-brand-panel__footer">Hydrop Deepo · Water Refilling Station Management System</p>
      </section>

      <section className="login-form-panel">
        <form className="login-form" onSubmit={submit} noValidate>
          <div className="login-logo-wrap">
            <img className="login-logo" src={loginLogoUrl} alt="Hydrop Deepo" />
          </div>

          <div className="login-header">
            <h1>Welcome back</h1>
            <p className="login-subtitle">Log in to keep your station running smoothly.</p>
          </div>

          {notice && (
            <TemporaryNotice
              occurrenceId={noticeId ?? notice}
              duration="brief"
              className="alert alert--info login-notice"
              role="status"
              closeLabel="Close session notice"
              onDismiss={clearNotice}
            >
              {notice}
            </TemporaryNotice>
          )}

          {error && (
            <TemporaryNotice
              occurrenceId={error.id}
              duration="brief"
              className="alert alert--error login-error"
              role="alert"
              closeLabel="Close login error"
              onDismiss={() => setError(null)}
            >
              <span className="login-error__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9.5" />
                  <line x1="12" y1="8" x2="12" y2="12.5" />
                  <circle cx="12" cy="16" r="0.8" fill="currentColor" stroke="none" />
                </svg>
              </span>
              <div className="login-error__content">
                <p className="login-error__title">{error.message}</p>
                {isInvalidCredentials && (
                  <p className="login-error__detail">Check your credentials and try again.</p>
                )}
              </div>
            </TemporaryNotice>
          )}

          <label className="field login-field" htmlFor="login-username">
            <span>Username</span>
            <div className={inputWrapClass}>
              <input
                id="login-username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
              <span className="login-input-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M5 20a7 7 0 0 1 14 0" />
                </svg>
              </span>
            </div>
          </label>

          <div className="login-password-group">
            <label className="field login-field" htmlFor="login-password">
              <span>Password</span>
              <div className={inputWrapClass}>
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <span
                  className="login-input-icon login-input-icon--interactive"
                  aria-hidden="true"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  <EyeIcon open={showPassword} />
                </span>
              </div>
            </label>

            <button
              type="button"
              className="login-password-toggle"
              aria-controls="login-password"
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
            >
              <span className="login-password-toggle__icon" aria-hidden="true">
                <EyeIcon open={!showPassword} />
              </span>
              <span>{showPassword ? "Hide password" : "Show password"}</span>
            </button>
          </div>

          <button
            className="button button--primary button--block login-submit"
            type="submit"
            disabled={busy || !username || !password}
            data-busy={busy ? "true" : undefined}
          >
            <span className="login-submit__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m13 6 6 6-6 6" />
              </svg>
            </span>
            <span>{busy ? "Signing in…" : "Login"}</span>
          </button>

          <p className="login-meta-note">
            <span className="login-meta-note__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            </span>
            <span>Authorized station employees only</span>
          </p>

          <p className="login-help-note">Having trouble? Contact your station administrator.</p>
        </form>
      </section>
    </main>
  );
}
