/** Thin client for the Express API: CSRF header, background flag, session events. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  /** Automatic refreshes must not count as active use (AUTH-003). */
  background?: boolean;
}

type SessionEndedListener = (code: string) => void;
type IdleExpiryListener = (idleExpiresAt: string) => void;

let csrfToken: string | null = null;
let authGeneration = 0;
const sessionEndedListeners = new Set<SessionEndedListener>();
const idleExpiryListeners = new Set<IdleExpiryListener>();

export function advanceAuthGeneration(): number {
  authGeneration += 1;
  return authGeneration;
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function onSessionEnded(listener: SessionEndedListener): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

export function onIdleExpiry(listener: IdleExpiryListener): () => void {
  idleExpiryListeners.add(listener);
  return () => idleExpiryListeners.delete(listener);
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const requestGeneration = authGeneration;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  if (options.background) headers["X-Hydrop-Background"] = "1";

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the station server. Check the connection and try again.");
  }

  const idleExpiresAt = response.headers.get("X-Session-Idle-Expires-At");
  if (idleExpiresAt && requestGeneration === authGeneration) {
    idleExpiryListeners.forEach((l) => l(idleExpiresAt));
  }

  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { code: string; message: string };
  };
  if (!response.ok) {
    const code = payload.error?.code ?? "HTTP_ERROR";
    const message = payload.error?.message ?? "Something went wrong. Please try again.";
    // A failed sign-in attempt is not the end of a session, and stale responses after reauth are ignored.
    if (response.status === 401 && path !== "/api/auth/login" && requestGeneration === authGeneration) {
      sessionEndedListeners.forEach((l) => l(code));
    }
    throw new ApiError(response.status, code, message, payload);
  }
  return payload as T;
}
