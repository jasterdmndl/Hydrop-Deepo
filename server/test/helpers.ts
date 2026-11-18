import { randomBytes } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createPgliteDatabase, type Database } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Role } from "../src/modules/auth/policy.js";
import { AuthService } from "../src/modules/auth/service.js";
import { ManualClock } from "../src/shared/clock.js";

export const START = "2026-11-18T01:00:00.000Z"; // 09:00 Asia/Manila

export interface TestContext {
  db: Database;
  clock: ManualClock;
  app: Express;
  close(): Promise<void>;
}

/** Fresh isolated PostgreSQL (PGlite) with migrations applied. */
export async function createTestContext(
  options: { dataDir?: string; secureCookies?: boolean; clock?: ManualClock } = {},
): Promise<TestContext> {
  const db = await createPgliteDatabase(options.dataDir);
  await runMigrations(db);
  const clock = options.clock ?? new ManualClock(START);
  const app = createApp({ db, clock, secureCookies: options.secureCookies ?? false });
  return { db, clock, app, close: () => db.close() };
}

/** Random throwaway passwords generated per run; never stored in files. */
export function randomPassword(): string {
  return `T-${randomBytes(12).toString("base64url")}`;
}

export async function provision(db: Database, username: string, role: Role) {
  const temporaryPassword = randomPassword();
  await new AuthService(db).provisionAccount({ username, role, temporaryPassword });
  return { username, temporaryPassword };
}

export function sessionCookie(res: request.Response): string {
  const header = res.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith("hd_session=") || c.startsWith("__Host-hd_session="));
  if (!cookie) throw new Error("No session cookie in response");
  return cookie.split(";")[0]!;
}

export interface SignedIn {
  cookie: string;
  csrfToken: string;
  body: Record<string, any>;
}

export async function signIn(app: Express, username: string, password: string): Promise<SignedIn> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  if (res.status !== 200) throw new Error(`Sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { cookie: sessionCookie(res), csrfToken: res.body.csrfToken, body: res.body };
}

/** Provisions an account, signs in, and replaces the temporary password. */
export async function activatedAccount(ctx: TestContext, username: string, role: Role): Promise<SignedIn & { password: string }> {
  const { temporaryPassword } = await provision(ctx.db, username, role);
  const first = await signIn(ctx.app, username, temporaryPassword);
  const password = randomPassword();
  const res = await request(ctx.app)
    .post("/api/auth/password")
    .set("Cookie", first.cookie)
    .set("X-CSRF-Token", first.csrfToken)
    .send({ currentPassword: temporaryPassword, newPassword: password });
  if (res.status !== 200) throw new Error(`Activation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { cookie: sessionCookie(res), csrfToken: res.body.csrfToken, body: res.body, password };
}
