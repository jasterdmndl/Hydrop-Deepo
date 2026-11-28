import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPgliteDatabase, type Database } from "../src/db/database.js";
import { MIGRATIONS_DIR, runMigrations } from "../src/db/migrate.js";
import { rollbackEmployeeRoleMigration } from "../src/db/rollbackEmployeeRole.js";
import { cookieSettings, moduleAccess, requestClock, requireRole } from "../src/modules/auth/guards.js";
import { ROLES, type Role } from "../src/modules/auth/policy.js";
import { AuthService } from "../src/modules/auth/service.js";
import { ManualClock } from "../src/shared/clock.js";
import {
  activatedAccount,
  createTestContext,
  provision,
  signIn,
  START,
  type TestContext,
} from "./helpers.js";

describe("DEC-114 Employee role rename and migration 0017", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("provisions EMPLOYEE on a fresh database and rejects legacy CASHIER at the database constraint", async () => {
    const ctx = await createTestContext();
    cleanups.push(() => ctx.close());

    expect(ROLES).toEqual(["OWNER", "EMPLOYEE"]);

    const emp = await activatedAccount(ctx, "emp1", "EMPLOYEE");
    expect(emp.body.user).toEqual({
      username: "emp1",
      role: "EMPLOYEE",
      mustChangePassword: false,
    });

    const sessionRes = await request(ctx.app).get("/api/auth/session").set("Cookie", emp.cookie);
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.user.role).toBe("EMPLOYEE");

    await expect(
      ctx.db.query(
        `INSERT INTO app_users (username, username_key, role, password_hash)
         VALUES ('legacy', 'legacy', 'CASHIER', '$argon2id$dummy')`,
      ),
    ).rejects.toThrow(/check constraint|app_users_role_check/i);

    // Provision helper also rejects unsupported role codes at compile/runtime boundary.
    await expect(provision(ctx.db, "legacy2", "CASHIER" as unknown as Role)).rejects.toThrow(
      /check constraint|app_users_role_check/i,
    );
  });

  it("migrates an upgraded database from CASHIER to EMPLOYEE while preserving identity, linked records, and permissions", async () => {
    const upgradeDb = await createPgliteDatabase();
    cleanups.push(() => upgradeDb.close());

    await upgradeDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const pre0017Files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.startsWith("0017_"))
      .sort();
    for (const file of pre0017Files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await upgradeDb.exec(sql);
      await upgradeDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    }

    const clock = new ManualClock(START); // 2026-11-18T09:00:00+08:00
    const app = createApp({ db: upgradeDb, clock });
    const preCtx: TestContext = {
      db: upgradeDb,
      clock,
      app,
      close: () => upgradeDb.close(),
    };

    const ownerPre = await activatedAccount(preCtx, "owner1", "OWNER");
    const cashierPre = await activatedAccount(preCtx, "cashier1", "CASHIER" as unknown as Role);

    const { rows: beforeUsers } = await upgradeDb.query<{
      id: string;
      username: string;
      username_key: string;
      role: string;
      password_hash: string;
    }>("SELECT id, username, username_key, role, password_hash FROM app_users ORDER BY username_key");
    const beforeCashier = beforeUsers.find((u) => u.username_key === "cashier1")!;
    expect(beforeCashier.role).toBe("CASHIER");

    // Seed pre-migration linked records across Calendar, Inventory, and POS.
    const calCreate = await request(app)
      .post("/api/calendar/activities")
      .set("Cookie", ownerPre.cookie)
      .set("X-CSRF-Token", ownerPre.csrfToken)
      .send({
        requestKey: "pre-0017-cal-1",
        name: "Tank flushing",
        scheduledDate: "2026-11-20",
        scheduledTime: "10:00",
      });
    expect(calCreate.status).toBe(201);
    const activityRef = calCreate.body.activity.reference as string;

    const invOpening = await request(app)
      .post("/api/inventory/items/ROUND/opening-stock")
      .set("Cookie", ownerPre.cookie)
      .set("X-CSRF-Token", ownerPre.csrfToken)
      .send({ quantity: 10 });
    expect(invOpening.status).toBe(201);

    const startDay = await request(app)
      .post("/api/pos/day/start")
      .set("Cookie", ownerPre.cookie)
      .set("X-CSRF-Token", ownerPre.csrfToken)
      .send({ requestKey: "pre-0017-start-day" });
    expect(startDay.status).toBe(201);

    const prepSaved = await request(app)
      .post("/api/pos/checkouts")
      .set("Cookie", ownerPre.cookie)
      .set("X-CSRF-Token", ownerPre.csrfToken)
      .send({
        prepareKey: "pre-0017-sale-1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
    expect(prepSaved.status).toBe(201);
    const savedRef = prepSaved.body.checkout.reference as string;

    const confirmSaved = await request(app)
      .post(`/api/pos/checkouts/${savedRef}/confirm`)
      .set("Cookie", ownerPre.cookie)
      .set("X-CSRF-Token", ownerPre.csrfToken)
      .send({ cashReceivedCentavos: 10_000 });
    expect(confirmSaved.status).toBe(201);

    const prepPending = await request(app)
      .post("/api/pos/checkouts")
      .set("Cookie", ownerPre.cookie)
      .set("X-CSRF-Token", ownerPre.csrfToken)
      .send({
        prepareKey: "pre-0017-pending-1",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
    expect(prepPending.status).toBe(201);
    const pendingRef = prepPending.body.checkout.reference as string;

    const beginPending = await request(app)
      .post(`/api/pos/checkouts/${pendingRef}/begin-payment`)
      .set("Cookie", ownerPre.cookie)
      .set("X-CSRF-Token", ownerPre.csrfToken)
      .send({});
    expect(beginPending.status).toBe(200);

    // Assign pre-migration POS records to the legacy CASHIER account (as left by the pre-0017 server).
    await upgradeDb.query(`UPDATE pos_business_days SET started_by_user_id = $1`, [beforeCashier.id]);
    await upgradeDb.query(`UPDATE pos_checkouts SET created_by_user_id = $1`, [beforeCashier.id]);
    await upgradeDb.query(`UPDATE pos_sales SET created_by_user_id = $1`, [beforeCashier.id]);

    // Apply migration 0017 on the upgraded database.
    const newlyApplied = await runMigrations(upgradeDb);
    expect(newlyApplied).toEqual(["0017_employee_role_rename.sql"]);

    // Existing identity and credentials remain intact while role becomes EMPLOYEE.
    const { rows: afterUsers } = await upgradeDb.query<{
      id: string;
      username: string;
      username_key: string;
      role: string;
      password_hash: string;
    }>("SELECT id, username, username_key, role, password_hash FROM app_users ORDER BY username_key");
    const afterCashier = afterUsers.find((u) => u.username_key === "cashier1")!;
    const afterOwner = afterUsers.find((u) => u.username_key === "owner1")!;
    expect(afterCashier).toEqual({
      id: beforeCashier.id,
      username: "cashier1",
      username_key: "cashier1",
      role: "EMPLOYEE",
      password_hash: beforeCashier.password_hash,
    });
    expect(afterOwner.role).toBe("OWNER");

    // Migrated constraint rejects legacy CASHIER values.
    await expect(
      upgradeDb.query(
        `INSERT INTO app_users (username, username_key, role, password_hash)
         VALUES ('cashier2', 'cashier2', 'CASHIER', '$argon2id$dummy')`,
      ),
    ).rejects.toThrow(/check constraint|app_users_role_check/i);
    await expect(
      upgradeDb.query(`UPDATE app_users SET role = 'CASHIER' WHERE id = $1`, [afterCashier.id]),
    ).rejects.toThrow(/check constraint|app_users_role_check/i);

    // Existing employee signs in with preserved username/password and receives EMPLOYEE role.
    const employee = await signIn(app, "cashier1", cashierPre.password);
    expect(employee.body.user).toEqual({
      username: "cashier1",
      role: "EMPLOYEE",
      mustChangePassword: false,
    });

    const empModules = await request(app).get("/api/modules").set("Cookie", employee.cookie);
    expect(empModules.status).toBe(200);
    const byKey = Object.fromEntries(empModules.body.modules.map((m: any) => [m.key, m]));
    expect(byKey.pos).toMatchObject({ state: "open", path: "/pos" });
    expect(byKey.calendar).toMatchObject({ state: "read-only", path: "/calendar" });
    expect(byKey.inventory).toMatchObject({ state: "read-only", path: "/inventory" });
    expect(byKey.dashboard.state).toBe("locked");
    expect(byKey.dashboard.path).toBeUndefined();

    // Retained POS history and same-account checkout recovery work; Owner-only resolution is denied.
    const savedSaleRes = await request(app).get(`/api/pos/sales/${savedRef}`).set("Cookie", employee.cookie);
    expect(savedSaleRes.status).toBe(200);
    expect(savedSaleRes.body).toMatchObject({
      reference: savedRef,
      createdBy: "cashier1",
      totalCentavos: 5000,
    });

    const recoveryLookup = await request(app)
      .get(`/api/pos/checkouts/${pendingRef}`)
      .set("Cookie", employee.cookie);
    expect(recoveryLookup.status).toBe(200);
    expect(recoveryLookup.body).toMatchObject({
      recoveryState: "SAFE_TO_RETRY",
      ownedByCurrentUser: true,
      canRetry: true,
      canSettlePriorDay: false,
      canResolveFullRefund: false,
    });

    const empResolveDenied = await request(app)
      .post(`/api/pos/checkouts/${pendingRef}/resolve`)
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({ outcome: "FULL_REFUND", reason: "Employee attempt" });
    expect(empResolveDenied.status).toBe(403);
    expect(empResolveDenied.body.error.code).toBe("FORBIDDEN");

    // Same-account employee can complete their pending checkout.
    const empConfirmPending = await request(app)
      .post(`/api/pos/checkouts/${pendingRef}/confirm`)
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({ cashReceivedCentavos: 4000 });
    expect(empConfirmPending.status).toBe(201);

    // Calendar: Employee can read retained activities and cannot write.
    const calRead = await request(app).get("/api/calendar/activities?month=2026-11").set("Cookie", employee.cookie);
    expect(calRead.status).toBe(200);
    expect(calRead.body.scheduledActivities.some((a: any) => a.reference === activityRef)).toBe(true);

    const calWriteDenied = await request(app)
      .post("/api/calendar/activities")
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({
        requestKey: "post-0017-emp-cal",
        name: "Filter check",
        scheduledDate: "2026-11-21",
        scheduledTime: "10:00",
      });
    expect(calWriteDenied.status).toBe(403);
    expect(calWriteDenied.body.error.code).toBe("FORBIDDEN");

    // Inventory: Employee can view retained opening stock and cannot perform Owner writes.
    const invRead = await request(app).get("/api/inventory/items").set("Cookie", employee.cookie);
    expect(invRead.status).toBe(200);
    expect(invRead.body.items.find((i: any) => i.code === "ROUND")).toMatchObject({
      status: "INITIALIZED",
      currentQuantity: 10,
    });

    const invWriteDenied = await request(app)
      .post("/api/inventory/products")
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({
        name: "Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 5000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      });
    expect(invWriteDenied.status).toBe(403);
    expect(invWriteDenied.body.error.code).toBe("FORBIDDEN");

    // Dashboard: locked for Employee (403).
    const dashDenied = await request(app).get("/api/dashboard/sales").set("Cookie", employee.cookie);
    expect(dashDenied.status).toBe(403);
    expect(dashDenied.body.error.code).toBe("FORBIDDEN");

    // Owner account keeps full access after migration 0017.
    const owner = await signIn(app, "owner1", ownerPre.password);
    expect(owner.body.user.role).toBe("OWNER");
    expect((await request(app).get("/api/dashboard/sales").set("Cookie", owner.cookie)).status).toBe(200);
    expect(
      (
        await request(app)
          .post("/api/inventory/products")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({
            name: "Push Faucet",
            unit: "pcs",
            unitConfirmed: true,
            unitPriceCentavos: 5000,
            showInPos: true,
            posSection: "CHANGE_OF_GRIPO",
            faucetReportingType: "PUSH_TYPE",
          })
      ).status,
    ).toBe(201);

    // DEC-114 / Task 4: Migrated EMPLOYEE keeps operating-supply usage + OWN_USAGE history
    // and remains blocked from Owner-only Inventory writes and Dashboard Stock Trend.
    const supplyCreate = await request(app)
      .post("/api/inventory/products")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        category: "OPERATING_SUPPLY",
        name: "Backwash Salt",
        unit: "kg",
        allowDecimalQuantity: true,
        unitConfirmed: true,
      });
    expect(supplyCreate.status).toBe(201);
    const supplyId = supplyCreate.body.item.id as string;

    const supplyOpen = await request(app)
      .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/opening-stock`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ quantity: 5 });
    expect(supplyOpen.status).toBe(201);

    const empUsage = await request(app)
      .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/usage`)
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({
        quantity: 1,
        purpose: "Brine recharge",
        expectedRevision: supplyOpen.body.item.stockRevision,
        expectedCurrentQuantity: 5,
        requestKey: "post-0017-emp-usage",
      });
    expect(empUsage.status).toBe(201);
    expect(empUsage.body.item.currentQuantity).toBe(4);
    const empUsageMovId = empUsage.body.movement.id as string;

    const empHistory = await request(app)
      .get(`/api/inventory/items/${encodeURIComponent(supplyId)}/history`)
      .set("Cookie", employee.cookie);
    expect(empHistory.status).toBe(200);
    expect(empHistory.body.scope).toBe("OWN_USAGE");
    expect(empHistory.body.openingStock).toBeNull();
    expect(empHistory.body.item.openingStock).toBeNull();
    expect(empHistory.body.reconciliations).toEqual([]);
    expect(empHistory.body.movements).toHaveLength(1);
    expect(empHistory.body.movements[0]).toMatchObject({
      id: empUsageMovId,
      recordedBy: "cashier1",
    });

    expect(
      (
        await request(app)
          .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/receiving`)
          .set("Cookie", employee.cookie)
          .set("X-CSRF-Token", employee.csrfToken)
          .send({
            quantity: 2,
            expectedRevision: empUsage.body.item.stockRevision,
            expectedCurrentQuantity: 4,
            requestKey: "post-0017-emp-recv-denied",
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/reconciliations`)
          .set("Cookie", employee.cookie)
          .set("X-CSRF-Token", employee.csrfToken)
          .send({
            physicalCount: 4,
            reason: "Unauthorized recount",
            expectedRevision: empUsage.body.item.stockRevision,
            expectedCurrentQuantity: 4,
            requestKey: "post-0017-emp-rec-denied",
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/inventory/pending-reviews")
          .set("Cookie", employee.cookie)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/inventory/pending-corrections")
          .set("Cookie", employee.cookie)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/inventory/movements/${encodeURIComponent(empUsageMovId)}/correct-quantity`)
          .set("Cookie", employee.cookie)
          .set("X-CSRF-Token", employee.csrfToken)
          .send({
            newQuantity: 2,
            reason: "Unauthorized edit",
            coverageMode: "NONE",
            expectedCorrectionVersion: 0,
            expectedRevision: empUsage.body.item.stockRevision,
            expectedCurrentQuantity: 4,
            expectedLatestReconciliationId: null,
            expectedOpeningCountCoversDate: false,
            requestKey: "post-0017-emp-corr-denied",
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/dashboard/stocks/ROUND/trend")
          .set("Cookie", employee.cookie)
      ).status,
    ).toBe(403);
  });

  it("supports cutover, transactional rollback to CASHIER, and re-cutover without losing identity or history", async () => {
    const db = await createPgliteDatabase();
    cleanups.push(() => db.close());

    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const pre0017Files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.startsWith("0017_"))
      .sort();
    for (const file of pre0017Files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await db.exec(sql);
      await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    }

    const clock = new ManualClock(START);
    const dec114App = createApp({ db, clock });
    const authService = new AuthService(db);
    const cookies = cookieSettings(false);

    const preDec114PosApp = express();
    preDec114PosApp.use(cookieParser());
    preDec114PosApp.use(requestClock(clock));
    preDec114PosApp.get(
      "/api/pos/day",
      ...moduleAccess(authService, cookies),
      requireRole("OWNER", "CASHIER" as unknown as Role),
      (req, res) => {
        res.json({ ok: true, role: req.auth!.user.role });
      },
    );

    const compatPosApp = express();
    compatPosApp.use(cookieParser());
    compatPosApp.use(requestClock(clock));
    compatPosApp.get(
      "/api/pos/day",
      ...moduleAccess(authService, cookies),
      requireRole("OWNER", "CASHIER" as unknown as Role, "EMPLOYEE"),
      (req, res) => {
        res.json({ ok: true, role: req.auth!.user.role });
      },
    );

    const preCtx: TestContext = { db, clock, app: dec114App, close: () => db.close() };
    const ownerPre = await activatedAccount(preCtx, "owner1", "OWNER");
    const cashierPre = await activatedAccount(preCtx, "cashier1", "CASHIER" as unknown as Role);

    const { rows: beforeRows } = await db.query<{
      id: string;
      username: string;
      username_key: string;
      role: string;
      password_hash: string;
    }>("SELECT id, username, username_key, role, password_hash FROM app_users WHERE username_key = 'cashier1'");
    const beforeCashier = beforeRows[0]!;
    expect(beforeCashier.role).toBe("CASHIER");

    // Seed a retained sale owned by cashier1 before cutover.
    await request(dec114App)
      .post("/api/pos/day/start")
      .set("Cookie", ownerPre.cookie)
      .set("X-CSRF-Token", ownerPre.csrfToken)
      .send({ requestKey: "cutover-start-day" });
    const prep = await request(dec114App)
      .post("/api/pos/checkouts")
      .set("Cookie", ownerPre.cookie)
      .set("X-CSRF-Token", ownerPre.csrfToken)
      .send({ prepareKey: "cutover-sale", items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }] });
    const savedRef = prep.body.checkout.reference as string;
    await request(dec114App)
      .post(`/api/pos/checkouts/${savedRef}/confirm`)
      .set("Cookie", ownerPre.cookie)
      .set("X-CSRF-Token", ownerPre.csrfToken)
      .send({ cashReceivedCentavos: 5000 });
    await db.query("UPDATE pos_business_days SET started_by_user_id = $1", [beforeCashier.id]);
    await db.query("UPDATE pos_checkouts SET created_by_user_id = $1", [beforeCashier.id]);
    await db.query("UPDATE pos_sales SET created_by_user_id = $1", [beforeCashier.id]);

    // Pre-cutover (0016): old POS guard and compat guard allow CASHIER; DEC-114 guard rejects CASHIER.
    const preOld = await request(preDec114PosApp).get("/api/pos/day").set("Cookie", cashierPre.cookie);
    expect(preOld.status).toBe(200);
    expect(preOld.body).toEqual({ ok: true, role: "CASHIER" });
    const preCompat = await request(compatPosApp).get("/api/pos/day").set("Cookie", cashierPre.cookie);
    expect(preCompat.status).toBe(200);
    expect(preCompat.body).toEqual({ ok: true, role: "CASHIER" });
    expect((await request(dec114App).get("/api/pos/day").set("Cookie", cashierPre.cookie)).status).toBe(403);

    // 1. Cutover: apply migration 0017 while compat is live; compat and DEC-114 accept EMPLOYEE, old rejects it.
    expect(await runMigrations(db)).toEqual(["0017_employee_role_rename.sql"]);
    expect((await request(preDec114PosApp).get("/api/pos/day").set("Cookie", cashierPre.cookie)).status).toBe(403);
    const cutoverCompat = await request(compatPosApp).get("/api/pos/day").set("Cookie", cashierPre.cookie);
    expect(cutoverCompat.status).toBe(200);
    expect(cutoverCompat.body).toEqual({ ok: true, role: "EMPLOYEE" });
    expect((await request(dec114App).get("/api/pos/day").set("Cookie", cashierPre.cookie)).status).toBe(200);

    // 2. Rollback: restore CASHIER role while compat is live; compat accepts both sides, old resumes cleanly.
    const rollbackRes = await rollbackEmployeeRoleMigration(db);
    expect(rollbackRes).toEqual({ rolledBack: true, convertedUsers: 1 });
    expect(await rollbackEmployeeRoleMigration(db)).toEqual({ rolledBack: false, convertedUsers: 0 });

    const { rows: migRowsAfterRollback } = await db.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name = '0017_employee_role_rename.sql'",
    );
    expect(migRowsAfterRollback).toHaveLength(0);

    const { rows: rolledBackRows } = await db.query<{
      id: string;
      username: string;
      username_key: string;
      role: string;
      password_hash: string;
    }>("SELECT id, username, username_key, role, password_hash FROM app_users WHERE username_key = 'cashier1'");
    expect(rolledBackRows[0]).toEqual(beforeCashier);

    await expect(
      db.query(
        `INSERT INTO app_users (username, username_key, role, password_hash)
         VALUES ('emp_rejected', 'emp_rejected', 'EMPLOYEE', '$argon2id$dummy')`,
      ),
    ).rejects.toThrow(/check constraint|app_users_role_check/i);

    const rollbackCompat = await request(compatPosApp).get("/api/pos/day").set("Cookie", cashierPre.cookie);
    expect(rollbackCompat.status).toBe(200);
    expect(rollbackCompat.body).toEqual({ ok: true, role: "CASHIER" });
    const afterRollbackOld = await request(preDec114PosApp).get("/api/pos/day").set("Cookie", cashierPre.cookie);
    expect(afterRollbackOld.status).toBe(200);
    expect(afterRollbackOld.body).toEqual({ ok: true, role: "CASHIER" });
    expect((await request(dec114App).get("/api/pos/day").set("Cookie", cashierPre.cookie)).status).toBe(403);

    // 3. Re-cutover: runMigrations re-applies 0017 cleanly and restores EMPLOYEE access and retained history.
    expect(await runMigrations(db)).toEqual(["0017_employee_role_rename.sql"]);
    const employeeAfter = await signIn(dec114App, "cashier1", cashierPre.password);
    expect(employeeAfter.body.user).toEqual({
      username: "cashier1",
      role: "EMPLOYEE",
      mustChangePassword: false,
    });
    expect((await request(compatPosApp).get("/api/pos/day").set("Cookie", employeeAfter.cookie)).status).toBe(200);
    expect((await request(dec114App).get("/api/pos/day").set("Cookie", employeeAfter.cookie)).status).toBe(200);
    const saleRes = await request(dec114App).get(`/api/pos/sales/${savedRef}`).set("Cookie", employeeAfter.cookie);
    expect(saleRes.status).toBe(200);
    expect(saleRes.body).toMatchObject({ reference: savedRef, createdBy: "cashier1" });
    expect((await request(dec114App).get("/api/dashboard/sales").set("Cookie", employeeAfter.cookie)).status).toBe(403);
  });
});
