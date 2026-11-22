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
  | "SCHEDULE_CONFLICT"
  | "REQUEST_KEY_CONFLICT"
  | "DAY_NOT_OPEN"
  | "DAY_ALREADY_OPEN"
  | "DAY_ALREADY_CLOSED"
  | "PREVIOUS_DAY_OPEN"
  | "DAY_MISMATCH"
  | "UNRESOLVED_CHECKOUTS"
  | "UNPAID_DRAFTS_PRESENT"
  | "INSUFFICIENT_CASH"
  | "PAYLOAD_MISMATCH"
  | "CHECKOUT_REVIEW_REQUIRED"
  | "CHECKOUT_ALREADY_SAVED"
  | "CHECKOUT_CANCELLED"
  | "CHECKOUT_NOT_CANCELLABLE"
  | "OPENING_STOCK_ALREADY_SET"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}
