import type { Response } from "express";

/** Error codes the web client relies on. */
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "INVALID_CREDENTIALS"
  | "LOGIN_LOCKED"
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "PASSWORD_CHANGE_REQUIRED"
  | "FORBIDDEN"
  | "CSRF_INVALID"
  | "ORIGIN_REJECTED"
  | "INVALID_CURRENT_PASSWORD"
  | "SAME_PASSWORD"
  | "WEAK_PASSWORD"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}
