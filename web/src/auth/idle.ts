/** Pure idle-timer and sign-out outcome rules (AUTH-003). The server enforces expiry. */

export const IDLE_WARNING_MS = 60_000;
/** Minimum spacing between activity heartbeats sent for on-screen use. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

export type IdlePhase = "active" | "warning" | "expired";

export type LogoutOutcome =
  | { signedOut: true }
  | { signedOut: false; errorMessage: string };

export function idlePhase(
  serverNowMs: number,
  idleExpiresAtMs: number,
  warningMs = IDLE_WARNING_MS,
): { phase: IdlePhase; secondsLeft: number } {
  const remaining = idleExpiresAtMs - serverNowMs;
  const secondsLeft = Math.max(0, Math.ceil(remaining / 1000));
  if (remaining <= 0) return { phase: "expired", secondsLeft: 0 };
  if (remaining <= warningMs) return { phase: "warning", secondsLeft };
  return { phase: "active", secondsLeft };
}

/** Difference between the server clock and this device's clock. */
export function clockOffsetMs(serverNowIso: string, clientNowMs: number): number {
  return Date.parse(serverNowIso) - clientNowMs;
}

/** On-screen use sends a heartbeat at most once per interval. */
export function shouldSendHeartbeat(lastSentMs: number, nowMs: number, intervalMs = HEARTBEAT_INTERVAL_MS): boolean {
  return nowMs - lastSentMs >= intervalMs;
}

/**
 * Only treat sign-out as complete when the server confirms logout (204 -> undefined)
 * or confirms the session has already ended (401). Keep the operator signed in on
 * network or server errors so they know not to hand over the tablet yet.
 */
export function resolveLogoutOutcome(error: unknown): LogoutOutcome {
  if (error === undefined) {
    return { signedOut: true };
  }
  if (typeof error === "object" && error !== null && "status" in error && (error as { status: unknown }).status === 401) {
    return { signedOut: true };
  }
  const detail =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message: unknown }).message === "string" &&
          (error as { message: string }).message
        ? (error as { message: string }).message
        : "Unexpected error.";
  return {
    signedOut: false,
    errorMessage: `Sign-out was not confirmed: ${detail} Do not hand over the tablet yet—please retry.`,
  };
}

/**
 * Unauthenticated views and the mandatory password-change gate live at "/".
 * Preserves the current path while the initial session check is loading so an
 * authenticated reload on a module route stays on that module (NAV-001).
 */
export function postAuthRedirectPath(
  status: "loading" | "signed-out" | "signed-in",
  mustChangePassword: boolean,
  pathname: string,
): "/" | null {
  if (status === "loading") return null;
  if ((status === "signed-out" || mustChangePassword) && pathname !== "/") {
    return "/";
  }
  return null;
}
