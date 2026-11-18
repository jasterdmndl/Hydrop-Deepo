import { type FormEvent, useState } from "react";
import { ApiError } from "../api";
import { LogoutErrorBanner, useAuth, useSignedInUser } from "./AuthContext";

/** Must match the server's PASSWORD_MIN_LENGTH; the server enforces it. */
const MIN_LENGTH = 10;

export function ChangePasswordPage() {
  const { changePassword, logout, loggingOut } = useAuth();
  const user = useSignedInUser();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (next !== confirm) return setError("The new passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change the password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="brand brand--dark">
          <span className="brand__name">Hydrop Deepo</span>
          <span className="brand__tag">Water refilling station</span>
        </div>
        <h1>Set your new password</h1>
        <p className="muted">
          Signed in as <strong>{user.username}</strong>. Replace the temporary password before using the app.
        </p>
        <LogoutErrorBanner />
        {error && (
          <p className="alert alert--error" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>Temporary password</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          <span>New password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-describedby="password-rule"
          />
          <small id="password-rule">At least {MIN_LENGTH} characters, not your username.</small>
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <button className="button button--primary button--block" type="submit" disabled={busy || loggingOut || !current || !next || !confirm}>
          {busy ? "Saving…" : "Save new password"}
        </button>
        <button className="button button--ghost button--block" type="button" disabled={busy || loggingOut} onClick={() => void logout()}>
          {loggingOut ? "Signing out…" : "Sign out"}
        </button>
      </form>
    </main>
  );
}
