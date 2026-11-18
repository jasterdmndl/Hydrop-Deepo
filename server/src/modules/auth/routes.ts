import { Router } from "express";
import { z } from "zod";
import { sendError } from "../../shared/http.js";
import {
  authenticate,
  clearSessionCookie,
  type CookieSettings,
  requireCsrf,
  requireSameOrigin,
  setSessionCookie,
} from "./guards.js";
import { PASSWORD_MAX_LENGTH } from "./policy.js";
import type { ActiveSession, AuthService } from "./service.js";

const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH * 2),
});

/** Public view of a session: never includes the cookie token. */
function sessionView(session: ActiveSession) {
  return {
    user: {
      username: session.user.username,
      role: session.user.role,
      mustChangePassword: session.user.mustChangePassword,
    },
    csrfToken: session.csrfToken,
    session: session.timing,
  };
}

export function authRoutes(service: AuthService, cookies: CookieSettings): Router {
  const router = Router();

  router.post("/login", requireSameOrigin, async (req, res) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter your username and password.");
      return;
    }
    const replacingToken = (req.cookies as Record<string, string> | undefined)?.[cookies.name];
    const result = await service.login(
      { ...parsed.data, address: req.ip ?? "unknown", replacingToken },
      req.now,
    );
    if (!result.ok) {
      if (result.reason === "LOCKED") {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
        sendError(res, 429, "LOGIN_LOCKED", "Too many failed sign-in attempts. Please wait and try again.");
      } else {
        sendError(res, 401, "INVALID_CREDENTIALS", "Incorrect username or password.");
      }
      return;
    }
    setSessionCookie(res, cookies, result.session);
    res.json(sessionView(result.session));
  });

  // Reading the session is never counted as active use.
  router.get("/session", authenticate(service, cookies, { forceBackground: true }), (req, res) => {
    res.json(sessionView(req.auth!));
  });

  // Heartbeat for active use on screen, and the Continue Working action.
  router.post("/activity", authenticate(service, cookies), requireCsrf, (req, res) => {
    res.json({ session: req.auth!.timing });
  });

  router.post("/logout", authenticate(service, cookies, { forceBackground: true }), requireCsrf, async (req, res) => {
    await service.logout(req.auth!.sessionId, req.now);
    clearSessionCookie(res, cookies);
    res.status(204).end();
  });

  // Allowed while a temporary password is still active.
  router.post("/password", authenticate(service, cookies), requireCsrf, async (req, res) => {
    const parsed = passwordBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "VALIDATION_FAILED", "Enter your current and new passwords.");
      return;
    }
    const auth = req.auth!;
    const result = await service.changePassword(
      { userId: auth.user.id, username: auth.user.username, ...parsed.data },
      req.now,
    );
    if (!result.ok) {
      if (result.reason === "INVALID_CURRENT_PASSWORD") {
        sendError(res, 400, "INVALID_CURRENT_PASSWORD", "Your current password is incorrect.");
      } else if (result.reason === "SAME_PASSWORD") {
        sendError(res, 400, "SAME_PASSWORD", "Choose a password different from your current one.");
      } else {
        sendError(res, 400, "WEAK_PASSWORD", result.message);
      }
      return;
    }
    setSessionCookie(res, cookies, result.session);
    res.json(sessionView(result.session));
  });

  return router;
}
