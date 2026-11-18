/**
 * Authentication policy values.
 *
 * Approved (AUTH-003): 15-minute inactivity logout, one-minute warning,
 * eight-hour maximum login.
 *
 * Engineering defaults pending review (planning section 6.1 lists password
 * policy and throttling settings as pending engineering specification):
 * password length and failed-sign-in limits below.
 */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const ABSOLUTE_SESSION_MS = 8 * 60 * 60 * 1000;
export const IDLE_WARNING_MS = 60 * 1000;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Failed attempts per account name before a temporary lock. */
export const ACCOUNT_FAILURE_LIMIT = 5;
/** Failed attempts per client address before a temporary lock. */
export const ADDRESS_FAILURE_LIMIT = 20;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

/** OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane). */
export const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const ROLES = ["OWNER", "CASHIER"] as const;
export type Role = (typeof ROLES)[number];
