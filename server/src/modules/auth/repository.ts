import type { Queryable } from "../../db/database.js";
import type { Role } from "./policy.js";

export interface UserRecord {
  id: string;
  username: string;
  role: Role;
  passwordHash: string;
  mustChangePassword: boolean;
  disabledAt: Date | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: Date;
  lastActivityAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

export interface ThrottleRecord {
  key: string;
  failures: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
}

const USER_COLUMNS = `
  u.id, u.username, u.role, u.password_hash AS "passwordHash",
  u.must_change_password AS "mustChangePassword", u.disabled_at AS "disabledAt"`;

const SESSION_COLUMNS = `
  s.id, s.user_id AS "userId", s.csrf_token AS "csrfToken", s.created_at AS "createdAt",
  s.last_activity_at AS "lastActivityAt", s.absolute_expires_at AS "absoluteExpiresAt",
  s.revoked_at AS "revokedAt"`;

/** PostgreSQL adapter for accounts, sessions and sign-in throttling. */
export const authRepository = {
  async findUserByUsername(db: Queryable, username: string): Promise<UserRecord | undefined> {
    const { rows } = await db.query<UserRecord>(
      `SELECT ${USER_COLUMNS} FROM app_users u WHERE u.username_key = lower($1)`,
      [username],
    );
    return rows[0];
  },

  async insertUser(
    db: Queryable,
    input: { username: string; role: Role; passwordHash: string; mustChangePassword: boolean },
  ): Promise<UserRecord> {
    const { rows } = await db.query<UserRecord>(
      `INSERT INTO app_users AS u (username, username_key, role, password_hash, must_change_password)
       VALUES ($1, lower($1), $2, $3, $4)
       RETURNING ${USER_COLUMNS}`,
      [input.username, input.role, input.passwordHash, input.mustChangePassword],
    );
    return rows[0]!;
  },

  /** Replaces a password. A temporary password keeps must_change_password true. */
  async setPassword(
    db: Queryable,
    userId: string,
    passwordHash: string,
    mustChangePassword: boolean,
    now: Date,
  ): Promise<void> {
    await db.query(
      `UPDATE app_users
          SET password_hash = $2, must_change_password = $3, password_changed_at = $4
        WHERE id = $1`,
      [userId, passwordHash, mustChangePassword, now],
    );
  },

  async insertSession(
    db: Queryable,
    input: { userId: string; tokenHash: string; csrfToken: string; now: Date; absoluteExpiresAt: Date },
  ): Promise<SessionRecord> {
    const { rows } = await db.query<SessionRecord>(
      `INSERT INTO auth_sessions AS s
         (user_id, token_hash, csrf_token, created_at, last_activity_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $4, $5)
       RETURNING ${SESSION_COLUMNS}`,
      [input.userId, input.tokenHash, input.csrfToken, input.now, input.absoluteExpiresAt],
    );
    return rows[0]!;
  },

  async findSessionByTokenHash(
    db: Queryable,
    tokenHash: string,
  ): Promise<{ session: SessionRecord; user: UserRecord } | undefined> {
    const { rows } = await db.query<SessionRecord & { user: UserRecord }>(
      `SELECT ${SESSION_COLUMNS},
              json_build_object(
                'id', u.id, 'username', u.username, 'role', u.role,
                'passwordHash', u.password_hash,
                'mustChangePassword', u.must_change_password,
                'disabledAt', u.disabled_at
              ) AS "user"
         FROM auth_sessions s JOIN app_users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return undefined;
    const { user, ...session } = row;
    const parsedUser = typeof user === "string" ? (JSON.parse(user) as UserRecord) : user;
    return {
      session,
      user: { ...parsedUser, disabledAt: parsedUser.disabledAt ? new Date(parsedUser.disabledAt) : null },
    };
  },

  /** Records active use. Never moves activity backwards. */
  async touchSession(db: Queryable, sessionId: string, now: Date): Promise<void> {
    await db.query(
      `UPDATE auth_sessions
          SET last_activity_at = GREATEST(last_activity_at, $2)
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, now],
    );
  },

  async revokeSession(db: Queryable, sessionId: string, now: Date, reason: string): Promise<void> {
    await db.query(
      `UPDATE auth_sessions SET revoked_at = $2, revoke_reason = $3
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, now, reason],
    );
  },

  async revokeUserSessions(db: Queryable, userId: string, now: Date, reason: string): Promise<void> {
    await db.query(
      `UPDATE auth_sessions SET revoked_at = $2, revoke_reason = $3
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, now, reason],
    );
  },

  async findThrottles(db: Queryable, keys: string[]): Promise<ThrottleRecord[]> {
    const { rows } = await db.query<ThrottleRecord>(
      `SELECT key, failures, window_started_at AS "windowStartedAt", locked_until AS "lockedUntil"
         FROM login_throttle WHERE key = ANY($1::text[])`,
      [keys],
    );
    return rows;
  },

  /**
   * Counts one failure inside the current window (restarting an expired
   * window) and locks the key once `limit` failures accumulate.
   */
  async recordFailure(
    db: Queryable,
    key: string,
    input: { now: Date; windowStartCutoff: Date; limit: number; lockedUntil: Date },
  ): Promise<void> {
    await db.query(
      `INSERT INTO login_throttle AS t (key, failures, window_started_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN t.window_started_at <= $3 THEN 1 ELSE t.failures + 1 END,
         window_started_at = CASE WHEN t.window_started_at <= $3 THEN $2 ELSE t.window_started_at END`,
      [key, input.now, input.windowStartCutoff],
    );
    await db.query(
      `UPDATE login_throttle
          SET locked_until = $3, failures = 0, window_started_at = $2
        WHERE key = $1 AND failures >= $4`,
      [key, input.now, input.lockedUntil, input.limit],
    );
  },

  async clearThrottle(db: Queryable, key: string): Promise<void> {
    await db.query(`DELETE FROM login_throttle WHERE key = $1`, [key]);
  },
};
