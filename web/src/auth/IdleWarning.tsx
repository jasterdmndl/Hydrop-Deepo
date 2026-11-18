import { useEffect, useState } from "react";
import { LogoutErrorBanner, useAuth } from "./AuthContext";
import { idlePhase } from "./idle";

/** One-minute warning before the 15-minute inactivity sign-out (AUTH-003). */
export function IdleWarning() {
  const { state, clockOffset, continueWorking, refreshSession, logout, loggingOut } = useAuth();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const idleExpiresAt = state.status === "signed-in" ? state.idleExpiresAt : null;
  const { phase, secondsLeft } =
    idleExpiresAt === null ? { phase: "active" as const, secondsLeft: 0 } : idlePhase(now + clockOffset, idleExpiresAt);

  // At expiry, confirm with the server (which enforces it) without counting as use.
  useEffect(() => {
    if (phase === "expired") void refreshSession().catch(() => undefined);
  }, [phase, refreshSession]);

  if (phase !== "warning") return null;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="idle-title" aria-describedby="idle-body">
        <h2 id="idle-title">Still working?</h2>
        <p id="idle-body">
          For security, you will be signed out in <strong>{secondsLeft}</strong> second{secondsLeft === 1 ? "" : "s"}.
        </p>
        <LogoutErrorBanner />
        <div className="modal__actions">
          <button className="button button--ghost" type="button" disabled={loggingOut} onClick={() => void logout()}>
            {loggingOut ? "Signing out…" : "Sign out"}
          </button>
          <button className="button button--primary" type="button" autoFocus onClick={() => void continueWorking()}>
            Continue Working
          </button>
        </div>
      </div>
    </div>
  );
}
