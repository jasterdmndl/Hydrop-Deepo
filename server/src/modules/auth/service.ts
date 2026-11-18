import { createHash, randomBytes } from "node:crypto";
import type { Database, Queryable } from "../../db/database.js";
import { hashPassword, passwordProblem, verifyAgainstDummy, verifyPassword } from "./password.js";
import {
  ABSOLUTE_SESSION_MS,
  ACCOUNT_FAILURE_LIMIT,
  ADDRESS_FAILURE_LIMIT,
  FAILURE_WINDOW_MS,
  IDLE_TIMEOUT_MS,
  LOCK_DURATION_MS,
  type Role,
} from "./policy.js";
import { authRepository as repo, type SessionRecord, type UserRecord } from "./repository.js";

/** Identity attached to an authenticated request. Role always comes from the database. */
export interface AuthenticatedUser {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface SessionTiming {
  serverNow: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export interface ActiveSession {
  sessionId: string;
  csrfToken: string;
  user: AuthenticatedUser;
  timing: SessionTiming;
}

export interface IssuedSession extends ActiveSession {
  /** Opaque value for the session cookie. Only its SHA-256 hash is stored. */
  token: string;
}

export type LoginResult =
  | { ok: true; session: IssuedSession }
  | { ok: false; reason: "INVALID_CREDENTIALS" }
  | { ok: false; reason: "LOCKED"; retryAfterSeconds: number };

export type AuthenticateResult =
  | { ok: true; session: ActiveSession }
  | { ok: false; reason: "UNAUTHENTICATED" | "SESSION_EXPIRED" };

export type ChangePasswordResult =
  | { ok: true; session: IssuedSession }
  | { ok: false; reason: "INVALID_CURRENT_PASSWORD" }
  | { ok: false; reason: "SAME_PASSWORD" }
  | { ok: false; reason: "WEAK_PASSWORD"; message: string };

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function toUser(user: UserRecord): AuthenticatedUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

function timing(session: Pick<SessionRecord, "lastActivityAt" | "absoluteExpiresAt">, now: Date): SessionTiming {
  const idle = new Date(session.lastActivityAt).getTime() + IDLE_TIMEOUT_MS;
  const absolute = new Date(session.absoluteExpiresAt).getTime();
  return {
    serverNow: now.toISOString(),
    idleExpiresAt: new Date(Math.min(idle, absolute)).toISOString(),
    absoluteExpiresAt: new Date(absolute).toISOString(),
  };
}

const accountKey = (username: string) => `account:${username.trim().toLowerCase()}`;
const addressKey = (address: string) => `address:${address}`;

/**
 * Sign-in, session and password use cases. HTTP details stay in routes.ts;
 * SQL stays in repository.ts. Every method receives the single clock reading
 * taken for the current request.
 */
export class AuthService {
  constructor(private readonly db: Database) {}

  async login(
    input: { username: string; password: string; address: string; replacingToken?: string },
    now: Date,
  ): Promise<LoginResult> {
    const keys = [accountKey(input.username), addressKey(input.address)];
    const throttles = await repo.findThrottles(this.db, keys);
    const lockedUntil = throttles
      .map((t) => (t.lockedUntil ? new Date(t.lockedUntil).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    if (lockedUntil > now.getTime()) {
      return { ok: false, reason: "LOCKED", retryAfterSeconds: Math.ceil((lockedUntil - now.getTime()) / 1000) };
    }

    const user = await repo.findUserByUsername(this.db, input.username.trim());
    const valid =
      user && !user.disabledAt
        ? await verifyPassword(user.passwordHash, input.password)
        : (await verifyAgainstDummy(input.password), false);

    if (!user || !valid) {
      const windowStartCutoff = new Date(now.getTime() - FAILURE_WINDOW_MS);
      const lockUntil = new Date(now.getTime() + LOCK_DURATION_MS);
      await this.db.transaction(async (tx) => {
        await repo.recordFailure(tx, keys[0]!, { now, windowStartCutoff, limit: ACCOUNT_FAILURE_LIMIT, lockedUntil: lockUntil });
        await repo.recordFailure(tx, keys[1]!, { now, windowStartCutoff, limit: ADDRESS_FAILURE_LIMIT, lockedUntil: lockUntil });
      });
      return { ok: false, reason: "INVALID_CREDENTIALS" };
    }

    const session = await this.db.transaction(async (tx) => {
      await repo.clearThrottle(tx, keys[0]!);
      if (input.replacingToken) {
        const previous = await repo.findSessionByTokenHash(tx, hashToken(input.replacingToken));
        if (previous) await repo.revokeSession(tx, previous.session.id, now, "replaced_by_login");
      }
      return this.issueSession(tx, user, now);
    });
    return { ok: true, session };
  }

  /**
   * Validates the session cookie. `background` requests (automatic refreshes)
   * do not count as active use; all other requests reset the idle timer.
   */
  async authenticate(token: string | undefined, now: Date, background: boolean): Promise<AuthenticateResult> {
    if (!token) return { ok: false, reason: "UNAUTHENTICATED" };
    const found = await repo.findSessionByTokenHash(this.db, hashToken(token));
    if (!found || found.session.revokedAt) return { ok: false, reason: "UNAUTHENTICATED" };
    const { session, user } = found;

    if (user.disabledAt) {
      await repo.revokeSession(this.db, session.id, now, "account_disabled");
      return { ok: false, reason: "UNAUTHENTICATED" };
    }
    const nowMs = now.getTime();
    if (nowMs >= new Date(session.absoluteExpiresAt).getTime()) {
      await repo.revokeSession(this.db, session.id, now, "absolute_timeout");
      return { ok: false, reason: "SESSION_EXPIRED" };
    }
    if (nowMs - new Date(session.lastActivityAt).getTime() >= IDLE_TIMEOUT_MS) {
      await repo.revokeSession(this.db, session.id, now, "idle_timeout");
      return { ok: false, reason: "SESSION_EXPIRED" };
    }

    let lastActivityAt = session.lastActivityAt;
    if (!background) {
      await repo.touchSession(this.db, session.id, now);
      if (nowMs > new Date(lastActivityAt).getTime()) lastActivityAt = now;
    }
    return {
      ok: true,
      session: {
        sessionId: session.id,
        csrfToken: session.csrfToken,
        user: toUser(user),
        timing: timing({ lastActivityAt, absoluteExpiresAt: session.absoluteExpiresAt }, now),
      },
    };
  }

  async logout(sessionId: string, now: Date): Promise<void> {
    await repo.revokeSession(this.db, sessionId, now, "logout");
  }

  /**
   * Replaces the signed-in account's password. Ends every session of that
   * account and issues a fresh one for the current device.
   */
  async changePassword(
    input: { userId: string; username: string; currentPassword: string; newPassword: string },
    now: Date,
  ): Promise<ChangePasswordResult> {
    const user = await repo.findUserByUsername(this.db, input.username);
    if (!user || user.id !== input.userId || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
      return { ok: false, reason: "INVALID_CURRENT_PASSWORD" };
    }
    const problem = passwordProblem(input.newPassword, user.username);
    if (problem) return { ok: false, reason: "WEAK_PASSWORD", message: problem };
    if (input.newPassword === input.currentPassword) return { ok: false, reason: "SAME_PASSWORD" };

    const passwordHash = await hashPassword(input.newPassword);
    const session = await this.db.transaction(async (tx) => {
      await repo.setPassword(tx, user.id, passwordHash, false, now);
      await repo.revokeUserSessions(tx, user.id, now, "password_changed");
      return this.issueSession(tx, { ...user, mustChangePassword: false }, now);
    });
    return { ok: true, session };
  }

  /** Creates an account with a temporary password (local provisioning only). */
  async provisionAccount(input: { username: string; role: Role; temporaryPassword: string }): Promise<AuthenticatedUser> {
    const passwordHash = await hashPassword(input.temporaryPassword);
    const user = await repo.insertUser(this.db, {
      username: input.username.trim(),
      role: input.role,
      passwordHash,
      mustChangePassword: true,
    });
    return toUser(user);
  }

  private async issueSession(tx: Queryable, user: UserRecord, now: Date): Promise<IssuedSession> {
    const token = newSecret();
    const record = await repo.insertSession(tx, {
      userId: user.id,
      tokenHash: hashToken(token),
      csrfToken: newSecret(),
      now,
      absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_SESSION_MS),
    });
    return {
      token,
      sessionId: record.id,
      csrfToken: record.csrfToken,
      user: toUser(user),
      timing: timing(record, now),
    };
  }
}
