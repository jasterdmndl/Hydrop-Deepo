import { timingSafeEqual } from "node:crypto";
import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from "express";
import type { Clock } from "../../shared/clock.js";
import { sendError } from "../../shared/http.js";
import "../../shared/request-context.js";
import type { Role } from "./policy.js";
import type { AuthService, IssuedSession } from "./service.js";

/** Header set by the web client on automatic refresh requests. */
export const BACKGROUND_HEADER = "x-hydrop-background";
export const CSRF_HEADER = "x-csrf-token";
/** Lets the client keep its idle-warning timer aligned with the server. */
export const IDLE_EXPIRES_HEADER = "x-session-idle-expires-at";

export interface CookieSettings {
  name: string;
  secure: boolean;
}

/** `__Host-` cookies require HTTPS, so development over http uses a plain name. */
export function cookieSettings(secure: boolean): CookieSettings {
  return { name: secure ? "__Host-hd_session" : "hd_session", secure };
}

function baseCookieOptions(settings: CookieSettings): CookieOptions {
  return { httpOnly: true, sameSite: "strict", secure: settings.secure, path: "/" };
}

export function setSessionCookie(res: Response, settings: CookieSettings, session: IssuedSession): void {
  res.cookie(settings.name, session.token, {
    ...baseCookieOptions(settings),
    expires: new Date(session.timing.absoluteExpiresAt),
  });
}

export function clearSessionCookie(res: Response, settings: CookieSettings): void {
  res.clearCookie(settings.name, baseCookieOptions(settings));
}

/** Takes the single clock reading used throughout the request. */
export function requestClock(clock: Clock): RequestHandler {
  return (req, _res, next) => {
    req.now = clock.now();
    next();
  };
}

/**
 * Resolves the session cookie into `req.auth`. Requests marked with the
 * background header, or `forceBackground`, do not reset the idle timer.
 */
export function authenticate(
  service: AuthService,
  settings: CookieSettings,
  options: { forceBackground?: boolean } = {},
): RequestHandler {
  return async (req, res, next) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[settings.name];
    const background = options.forceBackground === true || req.get(BACKGROUND_HEADER) === "1";
    const result = await service.authenticate(token, req.now, background);
    if (!result.ok) {
      if (token) clearSessionCookie(res, settings);
      if (result.reason === "SESSION_EXPIRED") {
        sendError(res, 401, "SESSION_EXPIRED", "Your session has ended. Please sign in again.");
      } else if (result.reason === "SESSION_REPLACED") {
        sendError(res, 401, "SESSION_REPLACED", "Your account was signed in on another device.");
      } else {
        sendError(res, 401, "UNAUTHENTICATED", "Please sign in.");
      }
      return;
    }
    req.auth = result.session;
    res.setHeader(IDLE_EXPIRES_HEADER, result.session.timing.idleExpiresAt);
    next();
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cookie-authenticated writes must echo the session's CSRF token. */
export const requireCsrf: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const sent = req.get(CSRF_HEADER);
  if (!req.auth || !sent || !safeEqual(sent, req.auth.csrfToken)) {
    sendError(res, 403, "CSRF_INVALID", "This request could not be verified. Refresh the page and try again.");
    return;
  }
  next();
};

/**
 * Rejects cross-site writes before a session exists (sign-in). Browsers send
 * Origin on cross-origin and same-origin POSTs; it must match this host.
 */
export const requireSameOrigin: RequestHandler = (req, res, next) => {
  const origin = req.get("origin");
  if (origin) {
    let host: string | undefined;
    try {
      host = new URL(origin).host;
    } catch {
      host = undefined;
    }
    if (host !== req.get("host")) {
      sendError(res, 403, "ORIGIN_REJECTED", "This request came from another site.");
      return;
    }
  }
  next();
};

/** Temporary passwords must be replaced before any module access. */
export const requireActivatedAccount: RequestHandler = (req, res, next) => {
  if (req.auth?.user.mustChangePassword) {
    sendError(res, 403, "PASSWORD_CHANGE_REQUIRED", "Set a new password before continuing.");
    return;
  }
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.user.role)) {
      sendError(res, 403, "FORBIDDEN", "Your account does not have permission for this action.");
      return;
    }
    next();
  };
}

/** Shared guard chain for module APIs: signed in, CSRF-checked, activated. */
export function moduleAccess(service: AuthService, settings: CookieSettings): RequestHandler[] {
  return [authenticate(service, settings), requireCsrf, requireActivatedAccount];
}
