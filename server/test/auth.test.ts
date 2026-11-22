import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { requireRole } from "../src/modules/auth/guards.js";
import { ManualClock } from "../src/shared/clock.js";
import {
  activatedAccount,
  createTestContext,
  provision,
  randomPassword,
  sessionCookie,
  signIn,
  START,
  type TestContext,
} from "./helpers.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("shared sign-in and module entry", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.close();
  });

  describe("accounts and passwords", () => {
    it("stores only an Argon2id hash of the temporary password", async () => {
      const { temporaryPassword } = await provision(ctx.db, "owner1", "OWNER");
      const { rows } = await ctx.db.query<{ password_hash: string; must_change_password: boolean }>(
        "SELECT password_hash, must_change_password FROM app_users WHERE username_key = 'owner1'",
      );
      expect(rows[0]!.password_hash.startsWith("$argon2id$")).toBe(true);
      expect(rows[0]!.password_hash).not.toContain(temporaryPassword);
      expect(rows[0]!.must_change_password).toBe(true);
    });

    it("gives the same answer for a wrong password and an unknown account", async () => {
      await provision(ctx.db, "owner1", "OWNER");
      const wrong = await request(ctx.app).post("/api/auth/login").send({ username: "owner1", password: "not-it-at-all" });
      const unknown = await request(ctx.app).post("/api/auth/login").send({ username: "nobody", password: "not-it-at-all" });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.headers["set-cookie"]).toBeUndefined();
    });

    it("requires a password change before any module access", async () => {
      const { temporaryPassword } = await provision(ctx.db, "cashier1", "CASHIER");
      const first = await signIn(ctx.app, "cashier1", temporaryPassword);
      expect(first.body.user).toEqual({ username: "cashier1", role: "CASHIER", mustChangePassword: true });

      for (const url of ["/api/modules", "/api/calendar/access"]) {
        const res = await request(ctx.app).get(url).set("Cookie", first.cookie);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
      }

      const newPassword = randomPassword();
      const changed = await request(ctx.app)
        .post("/api/auth/password")
        .set("Cookie", first.cookie)
        .set("X-CSRF-Token", first.csrfToken)
        .send({ currentPassword: temporaryPassword, newPassword });
      expect(changed.status).toBe(200);
      expect(changed.body.user.mustChangePassword).toBe(false);
      const cookie = sessionCookie(changed);

      expect((await request(ctx.app).get("/api/modules").set("Cookie", cookie)).status).toBe(200);
      // The session that used the temporary password is replaced.
      expect((await request(ctx.app).get("/api/auth/session").set("Cookie", first.cookie)).status).toBe(401);
      // The temporary password no longer works; the new one does.
      expect((await request(ctx.app).post("/api/auth/login").send({ username: "cashier1", password: temporaryPassword })).status).toBe(401);
      const again = await signIn(ctx.app, "cashier1", newPassword);
      expect(again.body.user.mustChangePassword).toBe(false);
    });

    it("rejects an incorrect current password, a weak password, and reuse", async () => {
      const { temporaryPassword } = await provision(ctx.db, "owner1", "OWNER");
      const s = await signIn(ctx.app, "owner1", temporaryPassword);
      const change = (body: object) =>
        request(ctx.app).post("/api/auth/password").set("Cookie", s.cookie).set("X-CSRF-Token", s.csrfToken).send(body);

      expect((await change({ currentPassword: "wrong-password", newPassword: randomPassword() })).body.error.code).toBe("INVALID_CURRENT_PASSWORD");
      expect((await change({ currentPassword: temporaryPassword, newPassword: "short" })).body.error.code).toBe("WEAK_PASSWORD");
      expect((await change({ currentPassword: temporaryPassword, newPassword: temporaryPassword })).body.error.code).toBe("SAME_PASSWORD");
      const still = await request(ctx.app).get("/api/modules").set("Cookie", s.cookie);
      expect(still.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    });
  });

  describe("module entry", () => {
    it("lets both activated roles open Calendar, with role-based access from the server", async () => {
      const owner = await activatedAccount(ctx, "owner1", "OWNER");
      const cashier = await activatedAccount(ctx, "cashier1", "CASHIER");

      const ownerModules = await request(ctx.app).get("/api/modules").set("Cookie", owner.cookie);
      const cashierModules = await request(ctx.app).get("/api/modules").set("Cookie", cashier.cookie);
      const byKey = (body: any) => Object.fromEntries(body.modules.map((m: any) => [m.key, m]));

      expect(byKey(ownerModules.body).calendar).toMatchObject({ state: "open", path: "/calendar" });
      expect(byKey(cashierModules.body).calendar).toMatchObject({ state: "read-only", path: "/calendar" });
      expect(byKey(ownerModules.body).inventory).toMatchObject({ state: "open", path: "/inventory" });
      expect(byKey(cashierModules.body).inventory).toMatchObject({ state: "read-only", path: "/inventory" });
      expect(byKey(ownerModules.body).dashboard).toMatchObject({ state: "open", path: "/dashboard" });
      expect(byKey(cashierModules.body).dashboard.state).toBe("locked");
      expect(byKey(cashierModules.body).dashboard.path).toBeUndefined();
      expect(Object.keys(byKey(ownerModules.body))).toEqual(["pos", "dashboard", "calendar", "inventory"]);
      // Station status appears only once the business-day feature exists.
      expect(ownerModules.body.stationStatus).toBeNull();

      const ownerAccess = await request(ctx.app).get("/api/calendar/access").set("Cookie", owner.cookie);
      const cashierAccess = await request(ctx.app).get("/api/calendar/access").set("Cookie", cashier.cookie);
      expect(ownerAccess.body).toEqual({ canView: true, canManage: true });
      expect(cashierAccess.body).toEqual({ canView: true, canManage: false });

      const ownerInvAccess = await request(ctx.app).get("/api/inventory/access").set("Cookie", owner.cookie);
      const cashierInvAccess = await request(ctx.app).get("/api/inventory/access").set("Cookie", cashier.cookie);
      expect(ownerInvAccess.body).toEqual({
        canView: true,
        canInitializeOpeningStock: true,
        canCreateProduct: true,
      });
      expect(cashierInvAccess.body).toEqual({
        canView: true,
        canInitializeOpeningStock: false,
        canCreateProduct: false,
      });
    });

    it("rejects module requests without a session", async () => {
      for (const url of [
        "/api/modules",
        "/api/dashboard/sales",
        "/api/calendar/access",
        "/api/inventory/items",
        "/api/auth/session",
      ]) {
        const res = await request(ctx.app).get(url);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe("UNAUTHENTICATED");
      }
    });

    it("takes the role from the server account, not from the request", async () => {
      const cashier = await activatedAccount(ctx, "cashier1", "CASHIER");
      const res = await request(ctx.app)
        .get("/api/calendar/access")
        .set("Cookie", cashier.cookie)
        .set("X-Role", "OWNER")
        .query({ role: "OWNER" });
      expect(res.body.canManage).toBe(false);
    });
  });

  describe("sessions", () => {
    it("sets an HttpOnly, SameSite=Strict session cookie and never returns the token in the body", async () => {
      const { temporaryPassword } = await provision(ctx.db, "owner1", "OWNER");
      const res = await request(ctx.app).post("/api/auth/login").send({ username: "owner1", password: temporaryPassword });
      const raw = (res.headers["set-cookie"] as unknown as string[])[0]!;
      expect(raw).toMatch(/HttpOnly/);
      expect(raw).toMatch(/SameSite=Strict/);
      expect(raw).toMatch(/Path=\//);
      const token = sessionCookie(res).split("=")[1]!;
      expect(JSON.stringify(res.body)).not.toContain(token);
      const { rows } = await ctx.db.query<{ token_hash: string }>("SELECT token_hash FROM auth_sessions");
      expect(rows[0]!.token_hash).not.toBe(token);
    });

    it("uses Secure __Host- cookies when HTTPS cookies are enabled", async () => {
      const secure = await createTestContext({ secureCookies: true });
      try {
        const { temporaryPassword } = await provision(secure.db, "owner1", "OWNER");
        const res = await request(secure.app).post("/api/auth/login").send({ username: "owner1", password: temporaryPassword });
        const raw = (res.headers["set-cookie"] as unknown as string[])[0]!;
        expect(raw.startsWith("__Host-hd_session=")).toBe(true);
        expect(raw).toMatch(/Secure/);
      } finally {
        await secure.close();
      }
    });

    it("invalidates the session on logout", async () => {
      const owner = await activatedAccount(ctx, "owner1", "OWNER");
      const out = await request(ctx.app).post("/api/auth/logout").set("Cookie", owner.cookie).set("X-CSRF-Token", owner.csrfToken);
      expect(out.status).toBe(204);
      const after = await request(ctx.app).get("/api/modules").set("Cookie", owner.cookie);
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("keeps a session across an application restart", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "hydrop-restart-"));
      const clock = new ManualClock(START);
      try {
        const first = await createTestContext({ dataDir: dir, clock });
        const owner = await activatedAccount(first, "owner1", "OWNER");
        await first.close();

        clock.advance(2 * MINUTE);
        const second = await createTestContext({ dataDir: dir, clock });
        try {
          const res = await request(second.app).get("/api/modules").set("Cookie", owner.cookie);
          expect(res.status).toBe(200);
        } finally {
          await second.close();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("ends the session at 15 minutes idle; automatic refreshes do not count as use", async () => {
      const owner = await activatedAccount(ctx, "owner1", "OWNER");
      const background = () =>
        request(ctx.app).get("/api/modules").set("Cookie", owner.cookie).set("X-Hydrop-Background", "1");

      ctx.clock.advance(10 * MINUTE);
      expect((await background()).status).toBe(200);
      ctx.clock.advance(5 * MINUTE - 1000); // 14:59 since last active use
      const before = await request(ctx.app).get("/api/auth/session").set("Cookie", owner.cookie);
      expect(before.status).toBe(200);
      expect(before.body.session.idleExpiresAt).toBe(new Date(Date.parse(START) + 15 * MINUTE).toISOString());

      ctx.clock.advance(1000); // exactly 15:00
      const expired = await background();
      expect(expired.status).toBe(401);
      expect(expired.body.error.code).toBe("SESSION_EXPIRED");
      // Expiry is final: the session does not come back.
      expect((await request(ctx.app).get("/api/modules").set("Cookie", owner.cookie)).status).toBe(401);
    });

    it("resets the idle timer on active use and Continue Working", async () => {
      const owner = await activatedAccount(ctx, "owner1", "OWNER");
      ctx.clock.advance(14 * MINUTE);
      const cont = await request(ctx.app).post("/api/auth/activity").set("Cookie", owner.cookie).set("X-CSRF-Token", owner.csrfToken);
      expect(cont.status).toBe(200);
      expect(cont.body.session.idleExpiresAt).toBe(new Date(Date.parse(START) + 29 * MINUTE).toISOString());

      ctx.clock.advance(14 * MINUTE);
      const used = await request(ctx.app).get("/api/modules").set("Cookie", owner.cookie);
      expect(used.status).toBe(200);
      expect(used.headers["x-session-idle-expires-at"]).toBe(new Date(Date.parse(START) + 43 * MINUTE).toISOString());

      ctx.clock.advance(15 * MINUTE);
      expect((await request(ctx.app).get("/api/modules").set("Cookie", owner.cookie)).status).toBe(401);
    });

    it("ends the session at eight hours even with continuous use", async () => {
      const owner = await activatedAccount(ctx, "owner1", "OWNER");
      for (let elapsed = 10; elapsed < 8 * 60; elapsed += 10) {
        ctx.clock.set(new Date(Date.parse(START) + elapsed * MINUTE));
        const res = await request(ctx.app).post("/api/auth/activity").set("Cookie", owner.cookie).set("X-CSRF-Token", owner.csrfToken);
        expect(res.status).toBe(200);
      }
      ctx.clock.set(new Date(Date.parse(START) + 8 * HOUR - 1000));
      const last = await request(ctx.app).get("/api/modules").set("Cookie", owner.cookie);
      expect(last.status).toBe(200);
      expect(last.headers["x-session-idle-expires-at"]).toBe(new Date(Date.parse(START) + 8 * HOUR).toISOString());

      ctx.clock.set(new Date(Date.parse(START) + 8 * HOUR));
      const ended = await request(ctx.app).get("/api/modules").set("Cookie", owner.cookie);
      expect(ended.status).toBe(401);
      expect(ended.body.error.code).toBe("SESSION_EXPIRED");
    });
  });

  describe("request protection", () => {
    it("rejects cookie-authenticated writes without the session's CSRF token", async () => {
      const owner = await activatedAccount(ctx, "owner1", "OWNER");
      const missing = await request(ctx.app).post("/api/auth/logout").set("Cookie", owner.cookie);
      const wrong = await request(ctx.app).post("/api/auth/logout").set("Cookie", owner.cookie).set("X-CSRF-Token", "forged");
      expect(missing.status).toBe(403);
      expect(missing.body.error.code).toBe("CSRF_INVALID");
      expect(wrong.status).toBe(403);
      expect((await request(ctx.app).get("/api/modules").set("Cookie", owner.cookie)).status).toBe(200);
    });

    it("rejects sign-in from another site", async () => {
      const { temporaryPassword } = await provision(ctx.db, "owner1", "OWNER");
      const res = await request(ctx.app)
        .post("/api/auth/login")
        .set("Origin", "https://attacker.example")
        .send({ username: "owner1", password: temporaryPassword });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ORIGIN_REJECTED");
    });

    it("locks an account name for 15 minutes after five failed attempts", async () => {
      const { temporaryPassword } = await provision(ctx.db, "owner1", "OWNER");
      for (let i = 0; i < 5; i++) {
        const res = await request(ctx.app).post("/api/auth/login").send({ username: "owner1", password: `wrong-${i}` });
        expect(res.status).toBe(401);
      }
      const locked = await request(ctx.app).post("/api/auth/login").send({ username: "OWNER1", password: temporaryPassword });
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe("LOGIN_LOCKED");
      expect(Number(locked.headers["retry-after"])).toBe(15 * 60);

      ctx.clock.advance(15 * MINUTE);
      expect((await request(ctx.app).post("/api/auth/login").send({ username: "owner1", password: temporaryPassword })).status).toBe(200);
    });

    it("clears the account counter after a successful sign-in", async () => {
      const { temporaryPassword } = await provision(ctx.db, "owner1", "OWNER");
      const fail = () => request(ctx.app).post("/api/auth/login").send({ username: "owner1", password: "wrong-pass" });
      for (let i = 0; i < 4; i++) expect((await fail()).status).toBe(401);
      await signIn(ctx.app, "owner1", temporaryPassword);
      for (let i = 0; i < 4; i++) expect((await fail()).status).toBe(401);
      expect((await request(ctx.app).post("/api/auth/login").send({ username: "owner1", password: temporaryPassword })).status).toBe(200);
    });

    it("shared role guard denies a role outside the allowed list", async () => {
      const app = express();
      app.use((req, _res, next) => {
        const role = req.get("x-test-role") as "OWNER" | "CASHIER";
        req.auth = { sessionId: "s", csrfToken: "c", user: { id: "u", username: "u", role, mustChangePassword: false }, timing: {} as any };
        next();
      });
      app.post("/owner-only", requireRole("OWNER"), (_req, res) => res.json({ ok: true }));
      expect((await request(app).post("/owner-only").set("x-test-role", "CASHIER")).status).toBe(403);
      expect((await request(app).post("/owner-only").set("x-test-role", "OWNER")).status).toBe(200);
    });
  });

  it("applies migrations once", async () => {
    expect(await runMigrations(ctx.db)).toEqual([]);
  });
});
