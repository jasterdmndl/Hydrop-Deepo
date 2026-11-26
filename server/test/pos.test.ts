import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPgliteDatabase, type Database, type Queryable } from "../src/db/database.js";
import { MIGRATIONS_DIR, runMigrations } from "../src/db/migrate.js";
import { ManualClock } from "../src/shared/clock.js";
import {
  activatedAccount,
  createTestContext,
  provision,
  signIn,
  type SignedIn,
  type TestContext,
} from "./helpers.js";

// 2026-11-09 09:00 Asia/Manila (01:00 UTC)
const BASE_MANILA = "2026-11-09T09:00:00+08:00";

type Activated = SignedIn & { password: string };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function reauth(ctx: TestContext, username: string, actor: Activated): Promise<Activated> {
  const fresh = await signIn(ctx.app, username, actor.password);
  return { ...fresh, password: actor.password };
}

async function startDay(ctx: TestContext, actor: SignedIn, payload: Record<string, unknown> = {}) {
  return request(ctx.app)
    .post("/api/pos/day/start")
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload);
}

async function endDay(ctx: TestContext, actor: SignedIn, payload: Record<string, unknown> = {}) {
  return request(ctx.app)
    .post("/api/pos/day/end")
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload);
}

async function prepareCheckout(ctx: TestContext, actor: SignedIn, payload: Record<string, unknown>) {
  return request(ctx.app)
    .post("/api/pos/checkouts")
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload);
}

async function confirmCheckout(
  app: TestContext["app"],
  actor: SignedIn,
  reference: string,
  payload: Record<string, unknown>,
) {
  return request(app)
    .post(`/api/pos/checkouts/${encodeURIComponent(reference)}/confirm`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload);
}

async function cancelCheckout(
  ctx: TestContext,
  actor: SignedIn,
  reference: string,
  payload: Record<string, unknown> = {},
) {
  return request(ctx.app)
    .post(`/api/pos/checkouts/${encodeURIComponent(reference)}/cancel`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload);
}

describe("POS station day and refill sales", () => {
  let ctx: TestContext;
  let owner: Activated;
  let cashier: Activated;

  beforeEach(async () => {
    ctx = await createTestContext({ clock: new ManualClock(BASE_MANILA) });
    owner = await activatedAccount(ctx, "owner1", "OWNER");
    cashier = await activatedAccount(ctx, "cashier1", "CASHIER");
  });

  afterEach(async () => {
    await ctx.close();
  });

  describe("authentication, CSRF, and role access", () => {
    it("rejects unauthenticated, expired, unactivated, and missing-CSRF requests and allows both activated roles", async () => {
      const anonDay = await request(ctx.app).get("/api/pos/day");
      expect(anonDay.status).toBe(401);
      expect(anonDay.body.error.code).toBe("UNAUTHENTICATED");

      const { temporaryPassword } = await provision(ctx.db, "tempcashier", "CASHIER");
      const unactivated = await signIn(ctx.app, "tempcashier", temporaryPassword);
      const blockedDay = await request(ctx.app).get("/api/pos/day").set("Cookie", unactivated.cookie);
      expect(blockedDay.status).toBe(403);
      expect(blockedDay.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");

      const noCsrf = await request(ctx.app)
        .post("/api/pos/day/start")
        .set("Cookie", cashier.cookie)
        .send({ requestKey: "no-csrf-1" });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body.error.code).toBe("CSRF_INVALID");

      const badCsrf = await request(ctx.app)
        .post("/api/pos/day/start")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", "wrong-token")
        .send({ requestKey: "bad-csrf-1" });
      expect(badCsrf.status).toBe(403);
      expect(badCsrf.body.error.code).toBe("CSRF_INVALID");

      const ownerDay = await request(ctx.app).get("/api/pos/day").set("Cookie", owner.cookie);
      const cashierDay = await request(ctx.app).get("/api/pos/day").set("Cookie", cashier.cookie);
      expect(ownerDay.status).toBe(200);
      expect(cashierDay.status).toBe(200);

      // Expire Cashier session after 15 minutes idle
      ctx.clock.advance(15 * 60_000);
      const expired = await request(ctx.app).get("/api/pos/day").set("Cookie", cashier.cookie);
      expect(expired.status).toBe(401);
      expect(expired.body.error.code).toBe("SESSION_EXPIRED");
    });
  });

  describe("station day lifecycle (DAY-001, DAY-002)", () => {
    it("starts NOT_STARTED, opens on Start Day, ignores login/logout, closes permanently, and replays idempotently", async () => {
      const initial = await request(ctx.app).get("/api/pos/day").set("Cookie", cashier.cookie);
      expect(initial.status).toBe(200);
      expect(initial.body).toMatchObject({
        state: "NOT_STARTED",
        todayDate: "2026-11-09",
        canStartDay: true,
        canSell: false,
        canEndDay: false,
        day: null,
        unresolvedCheckouts: [],
        unpaidDrafts: [],
      });

      const endBeforeStart = await endDay(ctx, owner, { requestKey: "end-before-start" });
      expect(endBeforeStart.status).toBe(409);
      expect(endBeforeStart.body.error.code).toBe("DAY_NOT_OPEN");

      // Cannot prepare checkout before Start Day
      const blockedSale = await prepareCheckout(ctx, cashier, {
        prepareKey: "before-start-1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      expect(blockedSale.status).toBe(409);
      expect(blockedSale.body.error.code).toBe("DAY_NOT_OPEN");

      // Cashier can Start Day
      const started = await startDay(ctx, cashier, { requestKey: "start-nov-09" });
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({
        state: "OPEN",
        todayDate: "2026-11-09",
        canStartDay: false,
        canSell: true,
        canEndDay: true,
        replayed: false,
      });
      expect(started.body.day).toMatchObject({
        businessDate: "2026-11-09",
        startedBy: "cashier1",
        startedAt: "2026-11-09T09:00:00+08:00",
        closedBy: null,
        closedAt: null,
      });

      // Idempotent replay with same requestKey returns 200
      const startReplay = await startDay(ctx, owner, { requestKey: "start-nov-09" });
      expect(startReplay.status).toBe(200);
      expect(startReplay.body.replayed).toBe(true);
      expect(startReplay.body.day.businessDate).toBe("2026-11-09");

      // Duplicate Start Day without matching key is rejected
      const duplicateStart = await startDay(ctx, owner, { requestKey: "start-nov-09-second" });
      expect(duplicateStart.status).toBe(409);
      expect(duplicateStart.body.error.code).toBe("DAY_ALREADY_OPEN");

      // Logout and re-login / account switch never close or reopen the station day
      const out = await request(ctx.app)
        .post("/api/auth/logout")
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken);
      expect(out.status).toBe(204);
      cashier = await reauth(ctx, "cashier1", cashier);
      const afterRelogin = await request(ctx.app).get("/api/pos/day").set("Cookie", owner.cookie);
      expect(afterRelogin.status).toBe(200);
      expect(afterRelogin.body.state).toBe("OPEN");
      expect(afterRelogin.body.day.businessDate).toBe("2026-11-09");

      // expectedBusinessDate validation
      const badExpected = await endDay(ctx, owner, { expectedBusinessDate: "2026-02-30" });
      expect(badExpected.status).toBe(400);
      expect(badExpected.body.error.code).toBe("VALIDATION_FAILED");

      const wrongExpected = await endDay(ctx, owner, { expectedBusinessDate: "2026-11-08" });
      expect(wrongExpected.status).toBe(409);
      expect(wrongExpected.body.error.code).toBe("DAY_MISMATCH");

      // Close the day
      ctx.clock.set("2026-11-09T18:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      const ended = await endDay(ctx, owner, {
        requestKey: "end-nov-09",
        expectedBusinessDate: "2026-11-09",
      });
      expect(ended.status).toBe(200);
      expect(ended.body).toMatchObject({
        state: "CLOSED",
        replayed: false,
      });
      expect(ended.body.day).toMatchObject({
        businessDate: "2026-11-09",
        startedBy: "cashier1",
        closedBy: "owner1",
        closedAt: "2026-11-09T18:00:00+08:00",
      });
      expect(ended.body.summary).toMatchObject({
        businessDate: "2026-11-09",
        totalSalesCentavos: 0,
        validTransactionCount: 0,
        purifiedQuantity: 0,
        alkalineQuantity: 0,
        purifiedVolumeMl: 0,
        alkalineVolumeMl: 0,
        totalVolumeMl: 0,
        totalVolumeLiters: 0,
        voidedCount: 0,
        voidedTotalCentavos: 0,
      });

      // Replay End Day returns original closure without error
      const endReplay = await endDay(ctx, owner, { requestKey: "end-nov-09" });
      expect(endReplay.status).toBe(200);
      expect(endReplay.body.replayed).toBe(true);
      expect(endReplay.body.day.closedAt).toBe("2026-11-09T18:00:00+08:00");

      // Cannot end again with new key, reopen closed day, or start sales after close
      const secondEnd = await endDay(ctx, owner, { requestKey: "end-nov-09-second" });
      expect(secondEnd.status).toBe(409);
      expect(secondEnd.body.error.code).toBe("DAY_ALREADY_CLOSED");

      const reopenAttempt = await startDay(ctx, owner, { requestKey: "reopen-nov-09" });
      expect(reopenAttempt.status).toBe(409);
      expect(reopenAttempt.body.error.code).toBe("DAY_ALREADY_CLOSED");

      const postCloseSale = await prepareCheckout(ctx, owner, {
        prepareKey: "after-close-1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      expect(postCloseSale.status).toBe(409);
      expect(postCloseSale.body.error.code).toBe("DAY_ALREADY_CLOSED");
    });

    it("detects PREVIOUS_DAY_OPEN across Manila midnight even before UTC midnight, preserves original date on late close, then allows starting today", async () => {
      // Open on 2026-11-18 Manila time (22:00+08:00 = 14:00Z)
      ctx.clock.set("2026-11-18T22:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      const opened = await startDay(ctx, owner, { requestKey: "start-nov-18" });
      expect(opened.status).toBe(201);
      expect(opened.body.day.businessDate).toBe("2026-11-18");

      // Advance to 2026-11-18T16:30:00Z, which is 2026-11-19 00:30+08:00 in Asia/Manila
      ctx.clock.set("2026-11-18T16:30:00.000Z");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      const statusNextDay = await request(ctx.app).get("/api/pos/day").set("Cookie", cashier.cookie);
      expect(statusNextDay.status).toBe(200);
      expect(statusNextDay.body).toMatchObject({
        state: "PREVIOUS_DAY_OPEN",
        todayDate: "2026-11-19",
        canStartDay: false,
        canSell: false,
        canEndDay: true,
      });
      expect(statusNextDay.body.day.businessDate).toBe("2026-11-18");

      // Starting today or preparing a new sale is blocked until previous day is closed
      const startBlocked = await startDay(ctx, cashier, { requestKey: "start-nov-19-too-soon" });
      expect(startBlocked.status).toBe(409);
      expect(startBlocked.body.error.code).toBe("PREVIOUS_DAY_OPEN");

      const sellBlocked = await prepareCheckout(ctx, cashier, {
        prepareKey: "sell-during-prev-open",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      expect(sellBlocked.status).toBe(409);
      expect(sellBlocked.body.error.code).toBe("PREVIOUS_DAY_OPEN");

      // Late close retains businessDate = 2026-11-18 and records actual closedAt in Manila time
      const lateClose = await endDay(ctx, cashier, { requestKey: "late-close-nov-18" });
      expect(lateClose.status).toBe(200);
      expect(lateClose.body.state).toBe("CLOSED");
      expect(lateClose.body.day).toMatchObject({
        businessDate: "2026-11-18",
        closedBy: "cashier1",
        closedAt: "2026-11-19T00:30:00+08:00",
      });

      // Old start requestKey cannot be reused for a new date
      const keyReuse = await startDay(ctx, owner, { requestKey: "start-nov-18" });
      expect(keyReuse.status).toBe(409);
      expect(keyReuse.body.error.code).toBe("REQUEST_KEY_CONFLICT");

      // Now today (2026-11-19) is NOT_STARTED and can be started
      const afterLateClose = await request(ctx.app).get("/api/pos/day").set("Cookie", owner.cookie);
      expect(afterLateClose.status).toBe(200);
      expect(afterLateClose.body).toMatchObject({
        state: "NOT_STARTED",
        todayDate: "2026-11-19",
        canStartDay: true,
        canSell: false,
        canEndDay: false,
      });

      const startedToday = await startDay(ctx, owner, { requestKey: "start-nov-19" });
      expect(startedToday.status).toBe(201);
      expect(startedToday.body.state).toBe("OPEN");
      expect(startedToday.body.day.businessDate).toBe("2026-11-19");
    });
  });

  describe("refill catalog, pricing, validation, snapshots, and history (POS-002, POS-003, POS-006..008)", () => {
    it("serves server catalog, computes two 25 L Purified refills at PHP 25 with PHP 100 tender, and leaves zero stock artifacts", async () => {
      const catRes = await request(ctx.app).get("/api/pos/catalog").set("Cookie", cashier.cookie);
      expect(catRes.status).toBe(200);
      expect(catRes.body.items).toEqual([
        {
          code: "PURIFIED_25L",
          waterType: "PURIFIED",
          displayName: "Purified refill · 25 L",
          unitVolumeMl: 25000,
          unitVolumeLiters: 25,
          unitPriceCentavos: 2500,
        },
        {
          code: "ALKALINE_25L",
          waterType: "ALKALINE",
          displayName: "Alkaline refill · 25 L",
          unitVolumeMl: 25000,
          unitVolumeLiters: 25,
          unitPriceCentavos: 3500,
        },
      ]);

      await startDay(ctx, cashier, { requestKey: "day-fixture" });

      const prepared = await prepareCheckout(ctx, cashier, {
        prepareKey: "prep-fixture-1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      expect(prepared.status).toBe(201);
      const ref = prepared.body.checkout.reference as string;
      expect(ref).toBe("HD-1109-001");
      expect(prepared.body.checkout).toMatchObject({
        reference: "HD-1109-001",
        status: "DRAFT",
        totalCentavos: 5000,
        totalContainers: 2,
        totalVolumeMl: 50000,
        totalVolumeLiters: 50,
        cashReceivedCentavos: null,
        changeCentavos: null,
      });

      // Insufficient cash rejected before saving any sale
      const underpaid = await confirmCheckout(ctx.app, cashier, ref, {
        cashReceivedCentavos: 4999,
      });
      expect(underpaid.status).toBe(400);
      expect(underpaid.body.error.code).toBe("INSUFFICIENT_CASH");
      const { rows: zeroSales } = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM pos_sales");
      expect(Number(zeroSales[0]!.count)).toBe(0);

      // Confirm with PHP 100 (10000 centavos)
      const confirmed = await confirmCheckout(ctx.app, cashier, ref, {
        cashReceivedCentavos: 10000,
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
        expectedTotalCentavos: 5000,
      });
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.replayed).toBe(false);
      expect(confirmed.body.sale).toMatchObject({
        reference: "HD-1109-001",
        checkoutReference: "HD-1109-001",
        businessDate: "2026-11-09",
        status: "ACTIVE",
        totalCentavos: 5000,
        cashReceivedCentavos: 10000,
        changeCentavos: 5000,
        totalContainers: 2,
        totalVolumeMl: 50000,
        totalVolumeLiters: 50,
        createdBy: "cashier1",
        createdAt: "2026-11-09T09:00:00+08:00",
      });
      expect(confirmed.body.sale.items).toEqual([
        {
          lineIndex: 0,
          kind: "STANDARD",
          catalogCode: "PURIFIED_25L",
          waterType: "PURIFIED",
          displayLabel: "Purified refill · 25 L",
          unitVolumeMl: 25000,
          unitVolumeLiters: 25,
          unitPriceCentavos: 2500,
          quantity: 2,
          lineTotalCentavos: 5000,
          lineVolumeMl: 50000,
          lineVolumeLiters: 50,
        },
      ]);
      expect(confirmed.body.sale.actionHistory).toEqual([
        {
          action: "SALE_SAVED",
          actor: "cashier1",
          note: null,
          recordedAt: "2026-11-09T09:00:00+08:00",
        },
      ]);

      // Completing a customer-owned refill leaves container opening counts unset and untouched.
      const { rows: openingRows } = await ctx.db.query<{ id: string }>(
        `SELECT id FROM inventory_opening_counts`,
      );
      expect(openingRows).toEqual([]);
      const { rows: itemRows } = await ctx.db.query<{ code: string; current_quantity: number | null }>(
        `SELECT code, current_quantity FROM inventory_items ORDER BY code ASC`,
      );
      expect(itemRows).toEqual([
        { code: "ROUND", current_quantity: null },
        { code: "SLIM", current_quantity: null },
      ]);
    });

    it("supports mixed standard and custom per-container pricing, keeps distinct custom lines, checks PHP 500 minus PHP 325 = PHP 175, and rejects forged inputs", async () => {
      await startDay(ctx, owner, { requestKey: "day-custom" });

      // Invalid payloads rejected cleanly
      const invalidPayloads = [
        // Forged price/volume on standard refill
        { items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1, unitPriceCentavos: 100 }] },
        // Empty cart
        { items: [] },
        // Unsupported merchandise product kind
        { items: [{ kind: "CONTAINER", shape: "ROUND", quantity: 1 }] },
        // Non-integer quantity
        { items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1.5 }] },
        // Zero quantity
        { items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 0 }] },
        // Zero liters
        { items: [{ kind: "CUSTOM", waterType: "PURIFIED", unitVolumeLiters: 0, unitPriceCentavos: 1500, quantity: 1 }] },
        // More than 2 decimal places on liters
        { items: [{ kind: "CUSTOM", waterType: "PURIFIED", unitVolumeLiters: 11.125, unitPriceCentavos: 1500, quantity: 1 }] },
        // Non-integer centavos
        { items: [{ kind: "CUSTOM", waterType: "ALKALINE", unitVolumeLiters: 11, unitPriceCentavos: 2000.5, quantity: 1 }] },
        // Zero price
        { items: [{ kind: "CUSTOM", waterType: "ALKALINE", unitVolumeLiters: 11, unitPriceCentavos: 0, quantity: 1 }] },
      ];

      for (const payload of invalidPayloads) {
        const res = await prepareCheckout(ctx, cashier, payload);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_FAILED");
      }

      // Mixed standard + custom cart matching DEC-043's PHP 325 total & PHP 500 cash -> PHP 175 change:
      // 2 x 25 L Purified (5000) + 1 x 25 L Alkaline (3500) + 2 x Custom 11 L Purified @ PHP 120 (24000) = 32500
      const mixed = await prepareCheckout(ctx, cashier, {
        prepareKey: "prep-mixed-325",
        items: [
          { kind: "STANDARD", waterType: "PURIFIED", quantity: 2 },
          { kind: "STANDARD", waterType: "ALKALINE", quantity: 1 },
          { kind: "CUSTOM", waterType: "PURIFIED", unitVolumeLiters: 11, unitPriceCentavos: 12000, quantity: 2 },
        ],
      });
      expect(mixed.status).toBe(201);
      const ref1 = mixed.body.checkout.reference as string;

      const confirmed1 = await confirmCheckout(ctx.app, cashier, ref1, {
        cashReceivedCentavos: 50000,
      });
      expect(confirmed1.status).toBe(201);
      expect(confirmed1.body.sale).toMatchObject({
        totalCentavos: 32500,
        cashReceivedCentavos: 50000,
        changeCentavos: 17500,
        totalContainers: 5,
        totalVolumeMl: 97000,
        totalVolumeLiters: 97,
      });

      // Separate custom lines with same liters but different prices and decimal liters (18.5 L) stay distinct
      const customLines = await prepareCheckout(ctx, owner, {
        prepareKey: "prep-custom-lines",
        items: [
          { kind: "CUSTOM", waterType: "PURIFIED", unitVolumeLiters: 11, unitPriceCentavos: 2000, quantity: 2 },
          { kind: "CUSTOM", waterType: "PURIFIED", unitVolumeLiters: 11, unitPriceCentavos: 2200, quantity: 1 },
          { kind: "CUSTOM", waterType: "ALKALINE", unitVolumeLiters: 18.5, unitPriceCentavos: 2800, quantity: 2 },
        ],
      });
      expect(customLines.status).toBe(201);
      const ref2 = customLines.body.checkout.reference as string;
      const confirmed2 = await confirmCheckout(ctx.app, owner, ref2, {
        cashReceivedCentavos: 11800,
      });
      expect(confirmed2.status).toBe(201);
      expect(confirmed2.body.sale.items).toHaveLength(3);
      expect(confirmed2.body.sale).toMatchObject({
        totalCentavos: 11800,
        cashReceivedCentavos: 11800,
        changeCentavos: 0,
        totalContainers: 5,
        totalVolumeMl: 70000,
        totalVolumeLiters: 70,
      });

      // Mutate catalog price after sale; saved historical snapshot remains immutable
      await ctx.db.query(
        `UPDATE pos_refill_catalog SET unit_price_centavos = 3000 WHERE code = 'PURIFIED_25L'`,
      );

      // End Day summary accumulates both active sales accurately
      const ended = await endDay(ctx, owner, { requestKey: "end-custom-day" });
      expect(ended.status).toBe(200);
      expect(ended.body.summary).toMatchObject({
        businessDate: "2026-11-09",
        totalSalesCentavos: 44300,
        validTransactionCount: 2,
        purifiedQuantity: 7,
        alkalineQuantity: 3,
        purifiedVolumeMl: 105000,
        alkalineVolumeMl: 62000,
        totalVolumeMl: 167000,
        totalVolumeLiters: 167,
        voidedCount: 0,
        voidedTotalCentavos: 0,
      });

      // Old sale detail still retains PHP 25.00 unit price
      const detail = await request(ctx.app).get(`/api/pos/sales/${ref1}`).set("Cookie", owner.cookie);
      expect(detail.status).toBe(200);
      expect(detail.body.items[0].unitPriceCentavos).toBe(2500);
      expect(detail.body.sale.items[0].unitPriceCentavos).toBe(2500);
    });

    it("supports Transaction History filtering by Today, previous date, Active/Voided status, reference search, and detail view for both roles", async () => {
      // Day 1: 2026-11-09
      await startDay(ctx, owner, { requestKey: "hist-d1" });
      const p1 = await prepareCheckout(ctx, cashier, {
        prepareKey: "hist-p1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      const refNov09Active = p1.body.checkout.reference as string;
      await confirmCheckout(ctx.app, cashier, refNov09Active, { cashReceivedCentavos: 5000 });

      const p2 = await prepareCheckout(ctx, owner, {
        prepareKey: "hist-p2",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 2 }],
      });
      const refNov09Voided = p2.body.checkout.reference as string;
      await confirmCheckout(ctx.app, owner, refNov09Voided, { cashReceivedCentavos: 10000 });
      // Mark second sale VOIDED directly in DB to verify Active/Voided history filtering & End Day exclusion
      await ctx.db.query(`UPDATE pos_sales SET status = 'VOIDED' WHERE reference = $1`, [refNov09Voided]);

      const endedNov09 = await endDay(ctx, owner, { requestKey: "end-hist-d1" });
      expect(endedNov09.status).toBe(200);
      expect(endedNov09.body.summary).toMatchObject({
        totalSalesCentavos: 2500,
        validTransactionCount: 1,
        voidedCount: 1,
        voidedTotalCentavos: 7000,
      });

      // Day 2: 2026-11-10
      ctx.clock.set("2026-11-10T10:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);
      await startDay(ctx, cashier, { requestKey: "hist-d2" });

      const p3 = await prepareCheckout(ctx, cashier, {
        prepareKey: "hist-p3",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
      const refNov10 = p3.body.checkout.reference as string;
      await confirmCheckout(ctx.app, cashier, refNov10, { cashReceivedCentavos: 5000 });

      // Default /api/pos/sales returns Today (2026-11-10)
      const todayList = await request(ctx.app).get("/api/pos/sales").set("Cookie", cashier.cookie);
      expect(todayList.status).toBe(200);
      expect(todayList.body.businessDate).toBe("2026-11-10");
      expect(todayList.body.sales.map((s: any) => s.reference)).toEqual([refNov10]);

      // Previous date filter + ALL / ACTIVE / VOIDED filters
      const prevAll = await request(ctx.app)
        .get("/api/pos/sales?date=2026-11-09&status=ALL")
        .set("Cookie", owner.cookie);
      expect(prevAll.status).toBe(200);
      expect(prevAll.body.sales.map((s: any) => s.reference)).toEqual([refNov09Voided, refNov09Active]);

      const prevActive = await request(ctx.app)
        .get("/api/pos/sales?date=2026-11-09&status=ACTIVE")
        .set("Cookie", cashier.cookie);
      expect(prevActive.body.sales.map((s: any) => s.reference)).toEqual([refNov09Active]);

      const prevVoided = await request(ctx.app)
        .get("/api/pos/sales?date=2026-11-09&status=VOIDED")
        .set("Cookie", cashier.cookie);
      expect(prevVoided.body.sales.map((s: any) => s.reference)).toEqual([refNov09Voided]);

      // Reference search (case-insensitive) and wildcard escaping ('%' should not match everything)
      const searchMatch = await request(ctx.app)
        .get("/api/pos/sales?date=2026-11-09&q=hd-1109-001")
        .set("Cookie", cashier.cookie);
      expect(searchMatch.body.sales.map((s: any) => s.reference)).toEqual([refNov09Active]);

      const wildcardSearch = await request(ctx.app)
        .get("/api/pos/sales?date=2026-11-09&q=%25")
        .set("Cookie", cashier.cookie);
      expect(wildcardSearch.status).toBe(200);
      expect(wildcardSearch.body.sales).toEqual([]);

      // Invalid date or status rejected
      const badDate = await request(ctx.app).get("/api/pos/sales?date=2026-02-30").set("Cookie", owner.cookie);
      expect(badDate.status).toBe(400);
      expect(badDate.body.error.code).toBe("VALIDATION_FAILED");

      const badStatus = await request(ctx.app).get("/api/pos/sales?status=PENDING").set("Cookie", owner.cookie);
      expect(badStatus.status).toBe(400);
      expect(badStatus.body.error.code).toBe("VALIDATION_FAILED");

      // Both roles can fetch single sale detail
      const detail = await request(ctx.app).get(`/api/pos/sales/${refNov09Active}`).set("Cookie", cashier.cookie);
      expect(detail.status).toBe(200);
      expect(detail.body.reference).toBe(refNov09Active);
      expect(detail.body.sale.reference).toBe(refNov09Active);
    });
  });

  describe("checkout recovery, rollback, concurrency, and date boundary", () => {
    it("handles lost response after commit, identical replay, and rejects mismatched retry payloads", async () => {
      await startDay(ctx, cashier, { requestKey: "rec-day-1" });

      const prepPayload = {
        prepareKey: "prep-loss-1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      };
      const prep1 = await prepareCheckout(ctx, cashier, prepPayload);
      expect(prep1.status).toBe(201);
      const ref = prep1.body.checkout.reference as string;

      // Idempotent prepare replay returns 200, changed cart under same prepareKey returns 409
      const prepReplay = await prepareCheckout(ctx, cashier, prepPayload);
      expect(prepReplay.status).toBe(200);
      expect(prepReplay.body.replayed).toBe(true);
      expect(prepReplay.body.checkout.reference).toBe(ref);

      const prepConflict = await prepareCheckout(ctx, cashier, {
        prepareKey: "prep-loss-1",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
      expect(prepConflict.status).toBe(409);
      expect(prepConflict.body.error.code).toBe("REQUEST_KEY_CONFLICT");

      // Initial confirm commits, simulate response lost before client reads it
      const firstConfirm = await confirmCheckout(ctx.app, cashier, ref, {
        cashReceivedCentavos: 10000,
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      expect(firstConfirm.status).toBe(201);

      // Lookup returns SAVED with full sale and cash/change
      const lookup = await request(ctx.app).get(`/api/pos/checkouts/${ref}`).set("Cookie", cashier.cookie);
      expect(lookup.status).toBe(200);
      expect(lookup.body).toMatchObject({
        recoveryState: "SAVED",
        reason: null,
        canRetry: false,
        ownedByCurrentUser: true,
      });
      expect(lookup.body.sale).toMatchObject({
        reference: ref,
        totalCentavos: 5000,
        cashReceivedCentavos: 10000,
        changeCentavos: 5000,
      });

      // Identical replay returns 200 with original sale and no duplicate
      const replay = await confirmCheckout(ctx.app, cashier, ref, {
        cashReceivedCentavos: 10000,
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.sale.reference).toBe(ref);

      // Changed cash, changed items, or changed total under same reference are rejected
      const changedCash = await confirmCheckout(ctx.app, cashier, ref, { cashReceivedCentavos: 20000 });
      expect(changedCash.status).toBe(409);
      expect(changedCash.body.error.code).toBe("PAYLOAD_MISMATCH");

      const changedItems = await confirmCheckout(ctx.app, cashier, ref, {
        cashReceivedCentavos: 10000,
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 3 }],
      });
      expect(changedItems.status).toBe(409);
      expect(changedItems.body.error.code).toBe("PAYLOAD_MISMATCH");

      const changedTotal = await confirmCheckout(ctx.app, cashier, ref, {
        cashReceivedCentavos: 10000,
        expectedTotalCentavos: 7500,
      });
      expect(changedTotal.status).toBe(409);
      expect(changedTotal.body.error.code).toBe("PAYLOAD_MISMATCH");

      const { rows } = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM pos_sales");
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it("recovers safely via reauthentication after request never reached Express and session expired", async () => {
      await startDay(ctx, cashier, { requestKey: "rec-day-2" });
      const prep = await prepareCheckout(ctx, cashier, {
        prepareKey: "prep-never-reached",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 2 }],
      });
      const ref = prep.body.checkout.reference as string;

      // Session expires before confirm reaches server
      ctx.clock.advance(15 * 60_000);
      const expiredConfirm = await confirmCheckout(ctx.app, cashier, ref, {
        cashReceivedCentavos: 10000,
      });
      expect(expiredConfirm.status).toBe(401);
      expect(expiredConfirm.body.error.code).toBe("SESSION_EXPIRED");

      // Same operator signs back in, checks status -> SAFE_TO_RETRY -> retries with original reference & cash
      cashier = await reauth(ctx, "cashier1", cashier);
      const lookup = await request(ctx.app).get(`/api/pos/checkouts/${ref}`).set("Cookie", cashier.cookie);
      expect(lookup.status).toBe(200);
      expect(lookup.body).toMatchObject({
        recoveryState: "SAFE_TO_RETRY",
        reason: "NOT_SAVED",
        canRetry: true,
        ownedByCurrentUser: true,
        sale: null,
      });

      const retry = await confirmCheckout(ctx.app, cashier, ref, {
        cashReceivedCentavos: 10000,
      });
      expect(retry.status).toBe(201);
      expect(retry.body.sale).toMatchObject({
        reference: ref,
        totalCentavos: 7000,
        cashReceivedCentavos: 10000,
        changeCentavos: 3000,
      });
    });

    it("marks an in-flight confirmation as UNRESOLVED on lookup and blocks End Day and cancel until it finishes", async () => {
      const enteredTx = deferred<void>();
      const releaseTx = deferred<void>();
      let pauseNextTx = true;

      const wrappedDb: Database = {
        query: (sql, params) => ctx.db.query(sql, params),
        exec: (sql) => ctx.db.exec(sql),
        close: () => ctx.db.close(),
        async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
          if (pauseNextTx) {
            pauseNextTx = false;
            enteredTx.resolve();
            await releaseTx.promise;
          }
          return ctx.db.transaction(fn);
        },
      };
      const pausedApp = createApp({ db: wrappedDb, clock: ctx.clock, secureCookies: false });

      // Start day and prepare checkout on normal app
      await startDay(ctx, cashier, { requestKey: "inflight-day" });
      const prep = await prepareCheckout(ctx, cashier, {
        prepareKey: "prep-inflight",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const ref = prep.body.checkout.reference as string;

      // Launch confirm on pausedApp and wait until it enters inFlight + pauses right before db.transaction
      const confirmPromise = confirmCheckout(pausedApp, cashier, ref, {
        cashReceivedCentavos: 10000,
      });
      await enteredTx.promise;

      // Lookup must NOT say SAFE_TO_RETRY while save is in flight
      const inFlightLookup = await request(pausedApp)
        .get(`/api/pos/checkouts/${ref}`)
        .set("Cookie", cashier.cookie);
      expect(inFlightLookup.status).toBe(200);
      expect(inFlightLookup.body).toMatchObject({
        recoveryState: "UNRESOLVED",
        reason: "SAVE_IN_PROGRESS",
        canRetry: false,
        ownedByCurrentUser: true,
        sale: null,
      });
      expect(inFlightLookup.body.checkout).toMatchObject({
        reference: ref,
        cashReceivedCentavos: 10000,
        changeCentavos: 5000,
      });

      // End Day is blocked even when clearUnpaidDrafts is true
      const endBlocked = await request(pausedApp)
        .post("/api/pos/day/end")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ requestKey: "end-while-inflight", clearUnpaidDrafts: true });
      expect(endBlocked.status).toBe(409);
      expect(endBlocked.body.error.code).toBe("UNRESOLVED_CHECKOUTS");
      expect(endBlocked.body.blockingCheckouts.map((c: any) => c.reference)).toEqual([ref]);

      // Cancel is blocked while in flight
      const cancelBlocked = await request(pausedApp)
        .post(`/api/pos/checkouts/${ref}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(cancelBlocked.status).toBe(409);
      expect(cancelBlocked.body.error.code).toBe("CHECKOUT_NOT_CANCELLABLE");

      // Release confirm -> completes -> lookup is SAVED -> End Day succeeds
      releaseTx.resolve();
      const finished = await confirmPromise;
      expect(finished.status).toBe(201);

      const afterLookup = await request(pausedApp)
        .get(`/api/pos/checkouts/${ref}`)
        .set("Cookie", cashier.cookie);
      expect(afterLookup.status).toBe(200);
      expect(afterLookup.body.recoveryState).toBe("SAVED");

      const endOk = await request(pausedApp)
        .post("/api/pos/day/end")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ requestKey: "end-after-inflight" });
      expect(endOk.status).toBe(200);
      expect(endOk.body.summary.validTransactionCount).toBe(1);
    });

    it("rolls back atomically on DB error after pos_sales insert, leaves SAFE_TO_RETRY, and succeeds on retry", async () => {
      let failNextItemsInsert = true;
      const failingDb: Database = {
        query: (sql, params) => ctx.db.query(sql, params),
        exec: (sql) => ctx.db.exec(sql),
        close: () => ctx.db.close(),
        async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
          return ctx.db.transaction((tx) =>
            fn({
              query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
                if (failNextItemsInsert && sql.includes("INSERT INTO pos_sale_items")) {
                  failNextItemsInsert = false;
                  throw new Error("Simulated failure inserting pos_sale_items");
                }
                return tx.query<R>(sql, params);
              },
              exec: (sql) => tx.exec(sql),
            }),
          );
        },
      };
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const flakyApp = createApp({ db: failingDb, clock: ctx.clock, secureCookies: false });

        await startDay(ctx, cashier, { requestKey: "rollback-day" });
        const prep = await prepareCheckout(ctx, cashier, {
          prepareKey: "prep-rollback",
          items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
        });
        const ref = prep.body.checkout.reference as string;

        const failedConfirm = await confirmCheckout(flakyApp, cashier, ref, {
          cashReceivedCentavos: 10000,
        });
        expect(failedConfirm.status).toBe(500);
        expect(failedConfirm.body.error.code).toBe("INTERNAL_ERROR");

        // Entire transaction rolled back: 0 sales, checkout still DRAFT, inFlight cleared
        const { rows: salesAfterFail } = await ctx.db.query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM pos_sales",
        );
        expect(Number(salesAfterFail[0]!.count)).toBe(0);

        const lookup = await request(flakyApp)
          .get(`/api/pos/checkouts/${ref}`)
          .set("Cookie", cashier.cookie);
        expect(lookup.status).toBe(200);
        expect(lookup.body).toMatchObject({
          recoveryState: "SAFE_TO_RETRY",
          reason: "NOT_SAVED",
          canRetry: true,
        });

        const retry = await confirmCheckout(flakyApp, cashier, ref, {
          cashReceivedCentavos: 10000,
        });
        expect(retry.status).toBe(201);
        const { rows: salesAfterRetry } = await ctx.db.query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM pos_sales",
        );
        expect(Number(salesAfterRetry[0]!.count)).toBe(1);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("creates exactly one sale for concurrent same-reference confirm submissions", async () => {
      await startDay(ctx, cashier, { requestKey: "conc-day" });
      const prep = await prepareCheckout(ctx, cashier, {
        prepareKey: "prep-conc",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const ref = prep.body.checkout.reference as string;

      const [r1, r2] = await Promise.all([
        confirmCheckout(ctx.app, cashier, ref, { cashReceivedCentavos: 10000 }),
        confirmCheckout(ctx.app, cashier, ref, { cashReceivedCentavos: 10000 }),
      ]);

      expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([200, 201]);
      expect([r1.body.replayed, r2.body.replayed].sort()).toEqual([false, true]);
      expect(r1.body.sale.reference).toBe(ref);
      expect(r2.body.sale.reference).toBe(ref);

      const { rows } = await ctx.db.query<{ count: string }>("SELECT COUNT(*) AS count FROM pos_sales");
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it("blocks wrong account from confirming or cancelling a pending checkout and unlocks SAVED details after original operator confirms", async () => {
      await startDay(ctx, cashier, { requestKey: "switch-day" });
      const prep = await prepareCheckout(ctx, cashier, {
        prepareKey: "prep-switch",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const ref = prep.body.checkout.reference as string;

      // Owner checks Cashier's unfinished checkout
      const ownerLookup = await request(ctx.app)
        .get(`/api/pos/checkouts/${ref}`)
        .set("Cookie", owner.cookie);
      expect(ownerLookup.status).toBe(200);
      expect(ownerLookup.body).toMatchObject({
        recoveryState: "UNRESOLVED",
        reason: "OWNED_BY_OTHER_ACCOUNT",
        canRetry: false,
        ownedByCurrentUser: false,
        sale: null,
      });

      // Owner cannot confirm or cancel Cashier's checkout
      const ownerConfirm = await confirmCheckout(ctx.app, owner, ref, {
        cashReceivedCentavos: 10000,
      });
      expect(ownerConfirm.status).toBe(403);
      expect(ownerConfirm.body.error.code).toBe("FORBIDDEN");

      const ownerCancel = await cancelCheckout(ctx, owner, ref, {});
      expect(ownerCancel.status).toBe(403);
      expect(ownerCancel.body.error.code).toBe("FORBIDDEN");

      // Cashier returns and confirms -> now both roles can read SAVED checkout & sale
      const cashierConfirm = await confirmCheckout(ctx.app, cashier, ref, {
        cashReceivedCentavos: 10000,
      });
      expect(cashierConfirm.status).toBe(201);

      const ownerLookupAfter = await request(ctx.app)
        .get(`/api/pos/checkouts/${ref}`)
        .set("Cookie", owner.cookie);
      expect(ownerLookupAfter.status).toBe(200);
      expect(ownerLookupAfter.body).toMatchObject({
        recoveryState: "SAVED",
        canRetry: false,
        ownedByCurrentUser: false,
      });
      expect(ownerLookupAfter.body.sale.reference).toBe(ref);
    });

    it("enforces End Day draft safeguards, marks post-close confirm as REVIEW_REQUIRED without creating a sale, and stays consistent under concurrent End Day", async () => {
      await startDay(ctx, owner, { requestKey: "end-safe-day" });

      // Draft 1: explicitly cancelled
      const d1 = await prepareCheckout(ctx, cashier, {
        prepareKey: "draft-1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      const ref1 = d1.body.checkout.reference as string;

      // Unpaid draft blocks End Day until cancelled or cleared
      const blockedEnd = await endDay(ctx, owner, { requestKey: "end-blocked-1" });
      expect(blockedEnd.status).toBe(409);
      expect(blockedEnd.body.error.code).toBe("UNPAID_DRAFTS_PRESENT");
      expect(blockedEnd.body.unpaidDrafts.map((c: any) => c.reference)).toEqual([ref1]);

      const cancelled = await cancelCheckout(ctx, cashier, ref1, { reason: "Customer left" });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.checkout.status).toBe("CANCELLED_DRAFT");

      // Confirming an explicitly cancelled draft on same open day is rejected
      const confirmCancelled = await confirmCheckout(ctx.app, cashier, ref1, {
        cashReceivedCentavos: 5000,
      });
      expect(confirmCancelled.status).toBe(409);
      expect(confirmCancelled.body.error.code).toBe("CHECKOUT_CANCELLED");

      // Draft 2: cleared via End Day clearUnpaidDrafts: true
      const d2 = await prepareCheckout(ctx, cashier, {
        prepareKey: "draft-2",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
      const ref2 = d2.body.checkout.reference as string;

      const clearedEnd = await endDay(ctx, owner, {
        requestKey: "end-clear-drafts",
        clearUnpaidDrafts: true,
      });
      expect(clearedEnd.status).toBe(200);
      expect(clearedEnd.body.clearedDraftReferences).toEqual([ref2]);

      // A late confirm arriving for ref2 after End Day marks it REVIEW_REQUIRED with cash snapshot and 0 sales
      const postCloseConfirm = await confirmCheckout(ctx.app, cashier, ref2, {
        cashReceivedCentavos: 5000,
      });
      expect(postCloseConfirm.status).toBe(409);
      expect(postCloseConfirm.body.error.code).toBe("CHECKOUT_REVIEW_REQUIRED");
      expect(postCloseConfirm.body.checkout).toMatchObject({
        reference: ref2,
        status: "REVIEW_REQUIRED",
        resolutionReason: "DAY_CLOSED",
        cashReceivedCentavos: 5000,
        changeCentavos: 1500,
      });

      const lookupAfterClose = await request(ctx.app)
        .get(`/api/pos/checkouts/${ref2}`)
        .set("Cookie", owner.cookie);
      expect(lookupAfterClose.status).toBe(200);
      expect(lookupAfterClose.body).toMatchObject({
        recoveryState: "REVIEW_REQUIRED",
        reason: "DAY_CLOSED",
        canRetry: false,
        sale: null,
      });

      // Concurrent confirm vs End Day(clearUnpaidDrafts: true) on a fresh day stays strictly consistent
      ctx.clock.set("2026-11-10T09:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);
      await startDay(ctx, owner, { requestKey: "conc-end-day" });

      const d3 = await prepareCheckout(ctx, cashier, {
        prepareKey: "draft-3",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const ref3 = d3.body.checkout.reference as string;

      const [confirmRes, endRes] = await Promise.all([
        confirmCheckout(ctx.app, cashier, ref3, { cashReceivedCentavos: 10000 }),
        endDay(ctx, owner, { requestKey: "end-race", clearUnpaidDrafts: true }),
      ]);

      const { rows: finalSales } = await ctx.db.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM pos_sales WHERE business_date = '2026-11-10'",
      );
      const salesCount = Number(finalSales[0]!.count);

      if (endRes.status === 200) {
        expect(endRes.body.summary.validTransactionCount).toBe(salesCount);
        if (salesCount === 1) {
          expect(confirmRes.status).toBe(201);
          expect(endRes.body.clearedDraftReferences).toEqual([]);
        } else {
          expect(confirmRes.status).toBe(409);
          expect(confirmRes.body.error.code).toBe("CHECKOUT_REVIEW_REQUIRED");
          expect(endRes.body.clearedDraftReferences).toEqual([ref3]);
        }
      } else {
        expect(endRes.status).toBe(409);
        expect(endRes.body.error.code).toBe("UNRESOLVED_CHECKOUTS");
        expect(confirmRes.status).toBe(201);
        expect(salesCount).toBe(1);
        const retryEnd = await endDay(ctx, owner, { requestKey: "end-race-after" });
        expect(retryEnd.status).toBe(200);
        expect(retryEnd.body.summary.validTransactionCount).toBe(1);
      }
    });

    it("prevents backdated sales across Manila midnight, flags late confirmation as REVIEW_REQUIRED blocking End Day, clears unpaid drafts on late close, and keeps earlier saved sales readable", async () => {
      ctx.clock.set("2026-11-18T23:50:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);
      await startDay(ctx, cashier, { requestKey: "midnight-day" });

      // Sale 1: saved before midnight
      const savedPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "before-midnight-saved",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const savedRef = savedPrep.body.checkout.reference as string;
      const savedConfirm = await confirmCheckout(ctx.app, cashier, savedRef, {
        cashReceivedCentavos: 10000,
      });
      expect(savedConfirm.status).toBe(201);

      // Draft A: confirm attempted after midnight (review required -> blocks End Day)
      const draftAPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "before-midnight-draft-a",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
      const refA = draftAPrep.body.checkout.reference as string;

      // Draft B: unpaid draft never submitted -> lookup shows BUSINESS_DATE_CROSSED, clearable on late End Day
      const draftBPrep = await prepareCheckout(ctx, owner, {
        prepareKey: "before-midnight-draft-b",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      const refB = draftBPrep.body.checkout.reference as string;

      // Cross Manila midnight (2026-11-19 00:05+08:00)
      ctx.clock.set("2026-11-19T00:05:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      // Draft B lookup shows REVIEW_REQUIRED / BUSINESS_DATE_CROSSED without auto-saving
      const lookupB = await request(ctx.app).get(`/api/pos/checkouts/${refB}`).set("Cookie", owner.cookie);
      expect(lookupB.status).toBe(200);
      expect(lookupB.body).toMatchObject({
        recoveryState: "REVIEW_REQUIRED",
        reason: "BUSINESS_DATE_CROSSED",
        canRetry: false,
      });

      // Confirm on Draft A after midnight is rejected with CHECKOUT_REVIEW_REQUIRED and creates NO backdated sale
      const confirmA = await confirmCheckout(ctx.app, cashier, refA, {
        cashReceivedCentavos: 5000,
      });
      expect(confirmA.status).toBe(409);
      expect(confirmA.body.error.code).toBe("CHECKOUT_REVIEW_REQUIRED");
      expect(confirmA.body.checkout).toMatchObject({
        reference: refA,
        businessDate: "2026-11-18",
        status: "REVIEW_REQUIRED",
        resolutionReason: "BUSINESS_DATE_CROSSED",
        cashReceivedCentavos: 5000,
        changeCentavos: 1500,
      });

      const { rows: nov18Sales } = await ctx.db.query<{ reference: string }>(
        "SELECT reference FROM pos_sales WHERE business_date = '2026-11-18'",
      );
      expect(nov18Sales.map((r) => r.reference)).toEqual([savedRef]);

      // Review-required Draft A blocks End Day even with clearUnpaidDrafts: true
      const endBlockedByReview = await endDay(ctx, owner, {
        requestKey: "end-nov18-blocked",
        clearUnpaidDrafts: true,
      });
      expect(endBlockedByReview.status).toBe(409);
      expect(endBlockedByReview.body.error.code).toBe("UNRESOLVED_CHECKOUTS");
      expect(endBlockedByReview.body.blockingCheckouts.map((c: any) => c.reference)).toEqual([refA]);

      // Saved sale from Nov 18 remains readable after midnight and even on a fresh day!
      // Verify Draft B alone on a separate day can be cleared on late End Day
      // First clear the review-required checkout? Let's test Draft B clearable in a clean separate test case,
      // and here verify savedRef lookup & sale detail remain readable after midnight.
      const savedLookupAfterMidnight = await request(ctx.app)
        .get(`/api/pos/checkouts/${savedRef}`)
        .set("Cookie", owner.cookie);
      expect(savedLookupAfterMidnight.status).toBe(200);
      expect(savedLookupAfterMidnight.body.recoveryState).toBe("SAVED");
      expect(savedLookupAfterMidnight.body.sale.reference).toBe(savedRef);

      const savedSaleDetail = await request(ctx.app)
        .get(`/api/pos/sales/${savedRef}`)
        .set("Cookie", cashier.cookie);
      expect(savedSaleDetail.status).toBe(200);
      expect(savedSaleDetail.body.businessDate).toBe("2026-11-18");
    });

    it("clears an unpaid cross-midnight draft on late End Day and keeps earlier saved sales readable after closing and starting the next day", async () => {
      ctx.clock.set("2026-11-18T23:50:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);
      await startDay(ctx, cashier, { requestKey: "late-clear-day" });

      const savedPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "late-saved",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      const savedRef = savedPrep.body.checkout.reference as string;
      await confirmCheckout(ctx.app, cashier, savedRef, { cashReceivedCentavos: 5000 });

      const unpaidPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "late-unpaid",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
      const unpaidRef = unpaidPrep.body.checkout.reference as string;

      // Cross midnight
      ctx.clock.set("2026-11-19T00:10:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      const lateEnd = await endDay(ctx, owner, {
        requestKey: "late-end-clear-unpaid",
        clearUnpaidDrafts: true,
      });
      expect(lateEnd.status).toBe(200);
      expect(lateEnd.body.day.businessDate).toBe("2026-11-18");
      expect(lateEnd.body.clearedDraftReferences).toEqual([unpaidRef]);
      expect(lateEnd.body.summary.validTransactionCount).toBe(1);

      // Start new day 2026-11-19
      const startedNew = await startDay(ctx, cashier, { requestKey: "start-nov19-after-late" });
      expect(startedNew.status).toBe(201);
      expect(startedNew.body.day.businessDate).toBe("2026-11-19");

      // Saved Nov 18 checkout & sale remain readable after late close and new day start
      const savedLookup = await request(ctx.app)
        .get(`/api/pos/checkouts/${savedRef}`)
        .set("Cookie", cashier.cookie);
      expect(savedLookup.status).toBe(200);
      expect(savedLookup.body.recoveryState).toBe("SAVED");
      expect(savedLookup.body.sale.reference).toBe(savedRef);

      const prevHistory = await request(ctx.app)
        .get("/api/pos/sales?date=2026-11-18")
        .set("Cookie", owner.cookie);
      expect(prevHistory.status).toBe(200);
      expect(prevHistory.body.sales.map((s: any) => s.reference)).toEqual([savedRef]);
    });

    it("persists station day, checkouts, and sales across an application restart", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "hydrop-pos-restart-"));
      const clock = new ManualClock("2026-11-09T09:00:00+08:00");
      try {
        const first = await createTestContext({ dataDir: dir, clock });
        const o1 = await activatedAccount(first, "owner1", "OWNER");
        const c1 = await activatedAccount(first, "cashier1", "CASHIER");

        await startDay(first, c1, { requestKey: "restart-day" });
        const prep = await prepareCheckout(first, c1, {
          prepareKey: "restart-prep",
          items: [{ kind: "CUSTOM", waterType: "PURIFIED", unitVolumeLiters: 11, unitPriceCentavos: 2000, quantity: 2 }],
        });
        const ref = prep.body.checkout.reference as string;
        const confirmed = await confirmCheckout(first.app, c1, ref, { cashReceivedCentavos: 5000 });
        expect(confirmed.status).toBe(201);
        await first.close();

        clock.advance(5 * 60_000);
        const second = await createTestContext({ dataDir: dir, clock });
        try {
          const o2 = await signIn(second.app, "owner1", o1.password);
          const dayRes = await request(second.app).get("/api/pos/day").set("Cookie", o2.cookie);
          expect(dayRes.status).toBe(200);
          expect(dayRes.body.state).toBe("OPEN");
          expect(dayRes.body.day.summary).toMatchObject({
            totalSalesCentavos: 4000,
            validTransactionCount: 1,
            purifiedQuantity: 2,
            purifiedVolumeMl: 22000,
          });

          const saleRes = await request(second.app).get(`/api/pos/sales/${ref}`).set("Cookie", o2.cookie);
          expect(saleRes.status).toBe(200);
          expect(saleRes.body).toMatchObject({
            reference: ref,
            totalCentavos: 4000,
            cashReceivedCentavos: 5000,
            changeCentavos: 1000,
            totalVolumeLiters: 22,
          });
        } finally {
          await second.close();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("protects PAYMENT_PENDING checkouts from End Day clearing across missing confirmation and server restart while still clearing explicitly unpaid drafts", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "hydrop-pos-protected-restart-"));
      const clock = new ManualClock("2026-11-09T09:00:00+08:00");
      try {
        const first = await createTestContext({ dataDir: dir, clock });
        const o1 = await activatedAccount(first, "owner1", "OWNER");
        const c1 = await activatedAccount(first, "cashier1", "CASHIER");

        await startDay(first, o1, { requestKey: "prot-day" });

        const prepProtected = await prepareCheckout(first, c1, {
          prepareKey: "prot-checkout",
          items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
        });
        expect(prepProtected.status).toBe(201);
        const refProtected = prepProtected.body.checkout.reference as string;

        const prepDraft = await prepareCheckout(first, c1, {
          prepareKey: "unpaid-draft",
          items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
        });
        expect(prepDraft.status).toBe(201);
        const refDraft = prepDraft.body.checkout.reference as string;

        // Wrong operator cannot mark another operator's draft as PAYMENT_PENDING.
        const wrongBegin = await request(first.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(refProtected)}/begin-payment`)
          .set("Cookie", o1.cookie)
          .set("X-CSRF-Token", o1.csrfToken)
          .send({});
        expect(wrongBegin.status).toBe(403);
        expect(wrongBegin.body.error.code).toBe("FORBIDDEN");

        // Initiating cashier marks checkout PAYMENT_PENDING BEFORE being instructed to take cash.
        const begun = await request(first.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(refProtected)}/begin-payment`)
          .set("Cookie", c1.cookie)
          .set("X-CSRF-Token", c1.csrfToken)
          .send({});
        expect(begun.status).toBe(200);
        expect(begun.body.replayed).toBe(false);
        expect(begun.body.checkout).toMatchObject({
          reference: refProtected,
          status: "PAYMENT_PENDING",
          paymentStartedAt: "2026-11-09T09:00:00+08:00",
        });

        // Replaying begin-payment is idempotent.
        const begunReplay = await request(first.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(refProtected)}/begin-payment`)
          .set("Cookie", c1.cookie)
          .set("X-CSRF-Token", c1.csrfToken)
          .send({});
        expect(begunReplay.status).toBe(200);
        expect(begunReplay.body.replayed).toBe(true);

        // Day status places refProtected under unresolvedCheckouts (not unpaidDrafts).
        const dayBeforeRestart = await request(first.app).get("/api/pos/day").set("Cookie", o1.cookie);
        expect(dayBeforeRestart.status).toBe(200);
        expect(dayBeforeRestart.body.unresolvedCheckouts.map((c: any) => c.reference)).toEqual([
          refProtected,
        ]);
        expect(dayBeforeRestart.body.unpaidDrafts.map((c: any) => c.reference)).toEqual([refDraft]);

        // Even with NO confirm ever sent, Owner End Day(clearUnpaidDrafts: true) MUST reject.
        const endBlockedBeforeRestart = await endDay(first, o1, {
          requestKey: "end-before-restart",
          clearUnpaidDrafts: true,
        });
        expect(endBlockedBeforeRestart.status).toBe(409);
        expect(endBlockedBeforeRestart.body.error.code).toBe("UNRESOLVED_CHECKOUTS");
        expect(endBlockedBeforeRestart.body.blockingCheckouts.map((c: any) => c.reference)).toEqual([
          refProtected,
        ]);

        // Plain cancel without confirmNoCashTaken is rejected once payment has started.
        const plainCancel = await cancelCheckout(first, c1, refProtected, {
          reason: "Accidental click",
        });
        expect(plainCancel.status).toBe(409);
        expect(plainCancel.body.error.code).toBe("CHECKOUT_NOT_CANCELLABLE");

        await first.close();

        // Full server restart wipes all in-memory state (inFlight); durable DB protection must hold!
        clock.advance(2 * 60_000);
        const second = await createTestContext({ dataDir: dir, clock });
        try {
          const o2 = await signIn(second.app, "owner1", o1.password);
          const c2 = await signIn(second.app, "cashier1", c1.password);

          const dayAfterRestart = await request(second.app).get("/api/pos/day").set("Cookie", o2.cookie);
          expect(dayAfterRestart.status).toBe(200);
          expect(dayAfterRestart.body.unresolvedCheckouts.map((c: any) => c.reference)).toEqual([
            refProtected,
          ]);
          expect(dayAfterRestart.body.unpaidDrafts.map((c: any) => c.reference)).toEqual([refDraft]);

          // End Day with clearUnpaidDrafts: true still refuses to clear refProtected!
          const endBlockedAfterRestart = await endDay(second, o2, {
            requestKey: "end-after-restart",
            clearUnpaidDrafts: true,
          });
          expect(endBlockedAfterRestart.status).toBe(409);
          expect(endBlockedAfterRestart.body.error.code).toBe("UNRESOLVED_CHECKOUTS");
          expect(
            endBlockedAfterRestart.body.blockingCheckouts.map((c: any) => c.reference),
          ).toEqual([refProtected]);

          // Owner cannot hijack retry; Cashier can inspect SAFE_TO_RETRY and finish the sale.
          const ownerLookup = await request(second.app)
            .get(`/api/pos/checkouts/${refProtected}`)
            .set("Cookie", o2.cookie);
          expect(ownerLookup.status).toBe(200);
          expect(ownerLookup.body).toMatchObject({
            recoveryState: "UNRESOLVED",
            reason: "OWNED_BY_OTHER_ACCOUNT",
            canRetry: false,
          });

          const cashierLookup = await request(second.app)
            .get(`/api/pos/checkouts/${refProtected}`)
            .set("Cookie", c2.cookie);
          expect(cashierLookup.status).toBe(200);
          expect(cashierLookup.body).toMatchObject({
            recoveryState: "SAFE_TO_RETRY",
            reason: "NOT_SAVED",
            canRetry: true,
            ownedByCurrentUser: true,
          });

          const retried = await confirmCheckout(second.app, c2, refProtected, {
            cashReceivedCentavos: 10000,
          });
          expect(retried.status).toBe(201);
          expect(retried.body.sale).toMatchObject({
            reference: refProtected,
            totalCentavos: 5000,
            cashReceivedCentavos: 10000,
            changeCentavos: 5000,
          });

          // begin-payment after SAVED rejects cleanly with CHECKOUT_ALREADY_SAVED.
          const beginAfterSaved = await request(second.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(refProtected)}/begin-payment`)
            .set("Cookie", c2.cookie)
            .set("X-CSRF-Token", c2.csrfToken)
            .send({});
          expect(beginAfterSaved.status).toBe(409);
          expect(beginAfterSaved.body.error.code).toBe("CHECKOUT_ALREADY_SAVED");

          // End Day now clears only the genuinely unpaid DRAFT and closes the day cleanly.
          const endCleared = await endDay(second, o2, {
            requestKey: "end-after-recovery",
            clearUnpaidDrafts: true,
          });
          expect(endCleared.status).toBe(200);
          expect(endCleared.body.clearedDraftReferences).toEqual([refDraft]);
          expect(endCleared.body.summary).toMatchObject({
            totalSalesCentavos: 5000,
            validTransactionCount: 1,
          });
        } finally {
          await second.close();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("supports explicit same-day no-cash cancellation of PAYMENT_PENDING and keeps concurrent begin-payment vs End Day strictly consistent", async () => {
      await startDay(ctx, owner, { requestKey: "cancel-pp-day" });

      const prepNoCash = await prepareCheckout(ctx, cashier, {
        prepareKey: "pp-no-cash",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      const refNoCash = prepNoCash.body.checkout.reference as string;

      await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refNoCash)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});

      // Wrong operator still rejected even with confirmNoCashTaken: true
      const ownerCancel = await cancelCheckout(ctx, owner, refNoCash, {
        confirmNoCashTaken: true,
      });
      expect(ownerCancel.status).toBe(403);
      expect(ownerCancel.body.error.code).toBe("FORBIDDEN");

      // Initiating cashier confirms no cash was taken -> cancelled
      const cashierCancel = await cancelCheckout(ctx, cashier, refNoCash, {
        confirmNoCashTaken: true,
        reason: "Customer changed mind before paying",
      });
      expect(cashierCancel.status).toBe(200);
      expect(cashierCancel.body.replayed).toBe(false);
      expect(cashierCancel.body.checkout).toMatchObject({
        reference: refNoCash,
        status: "CANCELLED_DRAFT",
        resolutionReason: "Customer changed mind before paying",
      });

      const cancelReplay = await cancelCheckout(ctx, cashier, refNoCash, {
        confirmNoCashTaken: true,
      });
      expect(cancelReplay.status).toBe(200);
      expect(cancelReplay.body.replayed).toBe(true);

      // Concurrent begin-payment vs End Day(clearUnpaidDrafts: true)
      const prepRace = await prepareCheckout(ctx, cashier, {
        prepareKey: "pp-race",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
      const refRace = prepRace.body.checkout.reference as string;

      const [beginRes, endRes] = await Promise.all([
        request(ctx.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(refRace)}/begin-payment`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({}),
        endDay(ctx, owner, { requestKey: "race-end", clearUnpaidDrafts: true }),
      ]);

      if (endRes.status === 200) {
        expect(endRes.body.clearedDraftReferences).toEqual([refRace]);
        expect(beginRes.status).toBe(409);
      } else {
        expect(beginRes.status).toBe(200);
        expect(endRes.status).toBe(409);
        expect(endRes.body.error.code).toBe("UNRESOLVED_CHECKOUTS");
        expect(endRes.body.blockingCheckouts.map((c: any) => c.reference)).toEqual([refRace]);
      }
    });

    it("keeps cross-midnight PAYMENT_PENDING un-cancellable and blocking End Day without backdating or auto-clearing", async () => {
      ctx.clock.set("2026-11-18T23:55:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);
      await startDay(ctx, cashier, { requestKey: "midnight-pp-day" });

      const prep = await prepareCheckout(ctx, cashier, {
        prepareKey: "midnight-pp-checkout",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const ref = prep.body.checkout.reference as string;

      const begun = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(begun.status).toBe(200);

      // Cross Manila midnight without confirming
      ctx.clock.set("2026-11-19T00:05:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      const lookup = await request(ctx.app).get(`/api/pos/checkouts/${ref}`).set("Cookie", owner.cookie);
      expect(lookup.status).toBe(200);
      expect(lookup.body).toMatchObject({
        recoveryState: "REVIEW_REQUIRED",
        reason: "BUSINESS_DATE_CROSSED",
        canRetry: false,
      });

      // Even confirmNoCashTaken cannot cancel a prior-day PAYMENT_PENDING checkout
      const cancelPrior = await cancelCheckout(ctx, cashier, ref, {
        confirmNoCashTaken: true,
      });
      expect(cancelPrior.status).toBe(409);
      expect(cancelPrior.body.error.code).toBe("CHECKOUT_NOT_CANCELLABLE");

      // End Day with clearUnpaidDrafts cannot silently drop it (prior-day settlement awaits business decision)
      const endBlocked = await endDay(ctx, owner, {
        requestKey: "midnight-pp-end",
        clearUnpaidDrafts: true,
      });
      expect(endBlocked.status).toBe(409);
      expect(endBlocked.body.error.code).toBe("UNRESOLVED_CHECKOUTS");
      expect(endBlocked.body.blockingCheckouts.map((c: any) => c.reference)).toEqual([ref]);
    });
  });

  describe("DEC-048 prior-day paid-and-delivered refill settlement", () => {
    it("settles a PHP 50 paid-and-delivered prior-day refill once for Owner before today opens, denies Cashier, handles concurrent retries, blocks repeat confirm, and keeps history separate", async () => {
      ctx.clock.set("2026-11-18T23:50:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);
      await startDay(ctx, cashier, { requestKey: "dec048-day-nov18" });

      // Saved sale from yesterday (1 x 25L Alkaline = PHP 35) to verify closed summary stays unchanged.
      const savedPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "dec048-saved-nov18",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
      const savedRef = savedPrep.body.checkout.reference as string;
      const savedRes = await confirmCheckout(ctx.app, cashier, savedRef, {
        cashReceivedCentavos: 5000,
      });
      expect(savedRes.status).toBe(201);

      // PHP 50 refill (2 x 25L Purified) started payment before midnight, confirm arrives after midnight.
      const priorPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "dec048-prior-50",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const priorRef = priorPrep.body.checkout.reference as string;
      const begun = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(begun.status).toBe(200);

      // Cross Manila midnight to 2026-11-19
      ctx.clock.set("2026-11-19T08:15:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      const lateConfirm = await confirmCheckout(ctx.app, cashier, priorRef, {
        cashReceivedCentavos: 10000,
      });
      expect(lateConfirm.status).toBe(409);
      expect(lateConfirm.body.error.code).toBe("CHECKOUT_REVIEW_REQUIRED");

      // Day state is PREVIOUS_DAY_OPEN (today's business day 2026-11-19 has not started yet).
      const dayBeforeSettle = await request(ctx.app).get("/api/pos/day").set("Cookie", owner.cookie);
      expect(dayBeforeSettle.status).toBe(200);
      expect(dayBeforeSettle.body.state).toBe("PREVIOUS_DAY_OPEN");

      // Cashier lookup does NOT expose Owner settlement authority; Cashier POST /settle is forbidden.
      const cashierLookup = await request(ctx.app)
        .get(`/api/pos/checkouts/${priorRef}`)
        .set("Cookie", cashier.cookie);
      expect(cashierLookup.status).toBe(200);
      expect(cashierLookup.body.canSettlePriorDay).toBe(false);

      const cashierSettle = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/settle`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: true });
      expect(cashierSettle.status).toBe(403);
      expect(cashierSettle.body.error.code).toBe("FORBIDDEN");

      // Owner lookup shows prior-day settle eligibility.
      const ownerLookupBefore = await request(ctx.app)
        .get(`/api/pos/checkouts/${priorRef}`)
        .set("Cookie", owner.cookie);
      expect(ownerLookupBefore.status).toBe(200);
      expect(ownerLookupBefore.body.canSettlePriorDay).toBe(true);

      // Missing or wrong confirmation keeps the checkout pending.
      const missingDelivery = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: false });
      expect(missingDelivery.status).toBe(400);
      expect(missingDelivery.body.error.code).toBe("VALIDATION_FAILED");

      const wrongFlagDelivery = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, itemsHandedOverConfirmed: true });
      expect(wrongFlagDelivery.status).toBe(400);
      expect(wrongFlagDelivery.body.error.code).toBe("VALIDATION_FAILED");

      const stillBlocked = await endDay(ctx, owner, { requestKey: "dec048-still-blocked" });
      expect(stillBlocked.status).toBe(409);
      expect(stillBlocked.body.error.code).toBe("UNRESOLVED_CHECKOUTS");

      // Owner confirms both payment kept and refill delivered before today's business day opens.
      // Run two concurrent settle calls to verify atomic single-settlement recording.
      const [s1, s2] = await Promise.all([
        request(ctx.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/settle`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({
            paymentKeptConfirmed: true,
            refillDeliveredConfirmed: true,
            note: "Verified cash and handover",
          }),
        request(ctx.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/settle`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({
            paymentKeptConfirmed: true,
            refillDeliveredConfirmed: true,
            note: "Verified cash and handover",
          }),
      ]);

      const statuses = [s1.status, s2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 201]);
      const createdRes = s1.status === 201 ? s1 : s2;
      const replayedRes = s1.status === 200 ? s1 : s2;
      expect(createdRes.body.replayed).toBe(false);
      expect(replayedRes.body.replayed).toBe(true);
      expect(createdRes.body.outcome).toBe("SETTLED");
      expect(createdRes.body.settlement).toMatchObject({
        checkoutReference: priorRef,
        originalBusinessDate: "2026-11-18",
        settlementDate: "2026-11-19",
        outcome: "PAID_AND_DELIVERED",
        netAmountKeptCentavos: 5000,
        cashReceivedCentavos: 10000,
        changeCentavos: 5000,
        totalContainers: 2,
        totalVolumeMl: 50000,
        totalVolumeLiters: 50,
        originalActor: "cashier1",
        originalPaymentStartedAt: "2026-11-18T23:50:00+08:00",
        originalPaymentRecordedAt: "2026-11-19T08:15:00+08:00",
        paymentKeptConfirmed: true,
        refillDeliveredConfirmed: true,
        settledBy: "owner1",
        settledAt: "2026-11-19T08:15:00+08:00",
        note: "Verified cash and handover",
      });
      expect(replayedRes.body.settlement).toEqual(createdRes.body.settlement);

      // Verify exactly one settlement row exists in PostgreSQL.
      const { rows: dbCount } = await ctx.db.query<{ cnt: number | string }>(
        `SELECT COUNT(*) AS cnt FROM pos_prior_day_settlements WHERE checkout_reference = $1`,
        [priorRef],
      );
      expect(Number(dbCount[0]!.cnt)).toBe(1);

      // Repeat confirmation or begin-payment cannot collect or save again.
      const repeatConfirm = await confirmCheckout(ctx.app, cashier, priorRef, {
        cashReceivedCentavos: 10000,
      });
      expect(repeatConfirm.status).toBe(409);
      expect(repeatConfirm.body.error.code).toBe("CHECKOUT_ALREADY_SETTLED");

      const repeatBegin = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(repeatBegin.status).toBe(409);
      expect(repeatBegin.body.error.code).toBe("CHECKOUT_ALREADY_SETTLED");

      // Lookup reflects SETTLED_PRIOR_DAY.
      const lookupAfter = await request(ctx.app)
        .get(`/api/pos/checkouts/${priorRef}`)
        .set("Cookie", cashier.cookie);
      expect(lookupAfter.status).toBe(200);
      expect(lookupAfter.body).toMatchObject({
        recoveryState: "SETTLED_PRIOR_DAY",
        canRetry: false,
        canSettlePriorDay: false,
        sale: null,
      });
      expect(lookupAfter.body.settlement.checkoutReference).toBe(priorRef);

      // Already-saved sale returns ALREADY_SAVED and creates zero settlements.
      const settleSaved = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(savedRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: true });
      expect(settleSaved.status).toBe(200);
      expect(settleSaved.body).toMatchObject({
        outcome: "ALREADY_SAVED",
        replayed: true,
        settlement: null,
      });
      expect(settleSaved.body.sale.reference).toBe(savedRef);

      // Close yesterday: closed summary preserves ONLY the PHP 35 saved sale from 2026-11-18.
      const closedYesterday = await endDay(ctx, owner, { requestKey: "dec048-close-nov18" });
      expect(closedYesterday.status).toBe(200);
      expect(closedYesterday.body.day.businessDate).toBe("2026-11-18");
      expect(closedYesterday.body.summary).toMatchObject({
        totalSalesCentavos: 3500,
        validTransactionCount: 1,
        purifiedQuantity: 0,
        alkalineQuantity: 1,
      });

      // Start today (2026-11-19) and record a normal PHP 25 sale today.
      const startedToday = await startDay(ctx, cashier, { requestKey: "dec048-start-nov19" });
      expect(startedToday.status).toBe(201);
      expect(startedToday.body.day.businessDate).toBe("2026-11-19");

      const todayPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "dec048-today-sale",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      const todayRef = todayPrep.body.checkout.reference as string;
      const todaySaved = await confirmCheckout(ctx.app, cashier, todayRef, {
        cashReceivedCentavos: 5000,
      });
      expect(todaySaved.status).toBe(201);

      // Today's sales history keeps today's refill sales (PHP 25) strictly separate from prior-day settlement (PHP 50).
      const todayHistory = await request(ctx.app)
        .get("/api/pos/sales?date=2026-11-19")
        .set("Cookie", owner.cookie);
      expect(todayHistory.status).toBe(200);
      expect(todayHistory.body.sales.map((s: any) => s.reference)).toEqual([todayRef]);
      expect(todayHistory.body.priorDaySettlements).toHaveLength(1);
      expect(todayHistory.body.priorDaySettlements[0]).toMatchObject({
        checkoutReference: priorRef,
        originalBusinessDate: "2026-11-18",
        settlementDate: "2026-11-19",
        netAmountKeptCentavos: 5000,
      });

      // Yesterday's closed summary and sales history remain completely unchanged.
      const nov18History = await request(ctx.app)
        .get("/api/pos/sales?date=2026-11-18")
        .set("Cookie", owner.cookie);
      expect(nov18History.status).toBe(200);
      expect(nov18History.body.sales.map((s: any) => s.reference)).toEqual([savedRef]);
      expect(nov18History.body.priorDaySettlements).toEqual([]);

      const settlementDetail = await request(ctx.app)
        .get(`/api/pos/settlements/${encodeURIComponent(priorRef)}`)
        .set("Cookie", cashier.cookie);
      expect(settlementDetail.status).toBe(200);
      expect(settlementDetail.body.checkoutReference).toBe(priorRef);

      // Today's open day summary includes ONLY today's PHP 25 refill sale.
      const todayDay = await request(ctx.app).get("/api/pos/day").set("Cookie", owner.cookie);
      expect(todayDay.status).toBe(200);
      expect(todayDay.body.day.summary).toMatchObject({
        businessDate: "2026-11-19",
        totalSalesCentavos: 2500,
        validTransactionCount: 1,
      });
    });

    it("resolves only the settled checkout's End Day block, preserves closed summaries, and rejects same-day or unpaid drafts", async () => {
      ctx.clock.set("2026-11-18T23:50:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);
      await startDay(ctx, owner, { requestKey: "dec048-multi-day" });

      // Prepare two prior-day PAYMENT_PENDING checkouts and one unpaid DRAFT.
      const p1 = await prepareCheckout(ctx, cashier, {
        prepareKey: "multi-1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const ref1 = p1.body.checkout.reference as string;
      await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref1)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});

      const p2 = await prepareCheckout(ctx, cashier, {
        prepareKey: "multi-2",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
      const ref2 = p2.body.checkout.reference as string;
      await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref2)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});

      const pDraft = await prepareCheckout(ctx, cashier, {
        prepareKey: "multi-draft",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      const refDraft = pDraft.body.checkout.reference as string;

      // Cross midnight to 2026-11-19
      ctx.clock.set("2026-11-19T09:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      // Unpaid DRAFT cannot be settled as a paid-and-delivered prior-day refill.
      const draftSettle = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refDraft)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: true });
      expect(draftSettle.status).toBe(409);
      expect(draftSettle.body.error.code).toBe("CHECKOUT_NOT_SETTLABLE");

      // Settle ONLY ref1 -> ref2 must still block End Day!
      const settle1 = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref1)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          paymentKeptConfirmed: true,
          refillDeliveredConfirmed: true,
          cashReceivedCentavos: 5000,
        });
      expect(settle1.status).toBe(201);

      const endAfterOne = await endDay(ctx, owner, {
        requestKey: "multi-end-after-1",
        clearUnpaidDrafts: true,
      });
      expect(endAfterOne.status).toBe(409);
      expect(endAfterOne.body.error.code).toBe("UNRESOLVED_CHECKOUTS");
      expect(endAfterOne.body.blockingCheckouts.map((c: any) => c.reference)).toEqual([ref2]);

      // Settle ref2 -> End Day now clears only refDraft and closes 2026-11-18 with zero sales.
      const settle2 = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref2)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: true });
      expect(settle2.status).toBe(201);
      expect(settle2.body.settlement).toMatchObject({
        checkoutReference: ref2,
        cashReceivedCentavos: null,
        originalPaymentStartedAt: "2026-11-18T23:50:00+08:00",
        originalPaymentRecordedAt: null,
        settledAt: "2026-11-19T09:00:00+08:00",
      });

      const endAfterTwo = await endDay(ctx, owner, {
        requestKey: "multi-end-after-2",
        clearUnpaidDrafts: true,
      });
      expect(endAfterTwo.status).toBe(200);
      expect(endAfterTwo.body.clearedDraftReferences).toEqual([refDraft]);
      expect(endAfterTwo.body.summary).toMatchObject({
        businessDate: "2026-11-18",
        totalSalesCentavos: 0,
        validTransactionCount: 0,
      });

      // Start 2026-11-19 and confirm same-day PAYMENT_PENDING cannot be settled via prior-day settle.
      const startedNov19 = await startDay(ctx, owner, { requestKey: "multi-start-nov19" });
      expect(startedNov19.status).toBe(201);

      const sameDayPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "same-day-pp",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      const sameDayRef = sameDayPrep.body.checkout.reference as string;
      await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(sameDayRef)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});

      const sameDaySettle = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(sameDayRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: true });
      expect(sameDaySettle.status).toBe(409);
      expect(sameDaySettle.body.error.code).toBe("CHECKOUT_NOT_SETTLABLE");
    });

    it("leaves a previously closed day summary untouched when settling a prior-day DAY_CLOSED review-required checkout", async () => {
      ctx.clock.set("2026-11-18T10:00:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);
      await startDay(ctx, owner, { requestKey: "closed-day-start" });

      // Completed sale on Nov 18 (PHP 25)
      const pSaved = await prepareCheckout(ctx, cashier, {
        prepareKey: "closed-saved",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      await confirmCheckout(ctx.app, cashier, pSaved.body.checkout.reference, {
        cashReceivedCentavos: 2500,
      });

      // Another checkout prepared on Nov 18; Owner closes Nov 18 clearing unpaid drafts,
      // then confirm arrives late and marks it REVIEW_REQUIRED (DAY_CLOSED).
      const pLate = await prepareCheckout(ctx, cashier, {
        prepareKey: "closed-late",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const lateRef = pLate.body.checkout.reference as string;
      const closedNov18 = await endDay(ctx, owner, {
        requestKey: "closed-day-end",
        clearUnpaidDrafts: true,
      });
      expect(closedNov18.status).toBe(200);
      expect(closedNov18.body.summary.totalSalesCentavos).toBe(2500);

      const lateConfirm = await confirmCheckout(ctx.app, cashier, lateRef, {
        cashReceivedCentavos: 5000,
      });
      expect(lateConfirm.status).toBe(409);
      expect(lateConfirm.body.error.code).toBe("CHECKOUT_REVIEW_REQUIRED");

      // Advance to Nov 19 (NOT_STARTED) before today opens: GET /day surfaces closed prior-day reference outside unresolvedCheckouts.
      ctx.clock.set("2026-11-19T09:30:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      const dayBeforeSettle = await request(ctx.app).get("/api/pos/day").set("Cookie", owner.cookie);
      expect(dayBeforeSettle.status).toBe(200);
      expect(dayBeforeSettle.body.state).toBe("NOT_STARTED");
      expect(dayBeforeSettle.body.unresolvedCheckouts).toEqual([]);
      expect(dayBeforeSettle.body.priorDayReviewCheckouts.map((c: any) => c.reference)).toEqual([
        lateRef,
      ]);

      const settled = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(lateRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: true });
      expect(settled.status).toBe(201);

      const dayAfterSettle = await request(ctx.app).get("/api/pos/day").set("Cookie", owner.cookie);
      expect(dayAfterSettle.status).toBe(200);
      expect(dayAfterSettle.body.priorDayReviewCheckouts).toEqual([]);

      // Verify Nov 18's stored closed summary columns in pos_business_days were NOT modified.
      const { rows: dayRows } = await ctx.db.query<{
        closedTotalSalesCentavos: number | string;
        closedValidTxCount: number | string;
      }>(
        `SELECT closed_total_sales_centavos AS "closedTotalSalesCentavos",
                closed_valid_tx_count AS "closedValidTxCount"
           FROM pos_business_days
          WHERE business_date = '2026-11-18'`,
      );
      expect(Number(dayRows[0]!.closedTotalSalesCentavos)).toBe(2500);
      expect(Number(dayRows[0]!.closedValidTxCount)).toBe(1);
    });

    it("preserves explicit unpaid cancellations across date rollover and day closure without becoming settlable", async () => {
      ctx.clock.set("2026-11-18T23:50:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);
      await startDay(ctx, cashier, { requestKey: "cancel-preserve-day" });

      // Checkout A: explicit no-cash cancellation of PAYMENT_PENDING using reason colliding with internal label
      const prepExplicit = await prepareCheckout(ctx, cashier, {
        prepareKey: "explicit-cancel-pp",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const explicitRef = prepExplicit.body.checkout.reference as string;
      await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(explicitRef)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      const explicitCancel = await cancelCheckout(ctx, cashier, explicitRef, {
        confirmNoCashTaken: true,
        reason: "CLEARED_ON_END_DAY",
      });
      expect(explicitCancel.status).toBe(200);

      // Checkout B: unpaid DRAFT that will be automatically cleared on End Day
      const prepAutoCleared = await prepareCheckout(ctx, cashier, {
        prepareKey: "auto-clear-draft",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
      const autoClearedRef = prepAutoCleared.body.checkout.reference as string;

      // Cross midnight to 2026-11-19
      ctx.clock.set("2026-11-19T00:10:00+08:00");
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      // Delayed confirm after rollover MUST reject with CHECKOUT_CANCELLED and preserve reason (despite reason string collision)
      const confirmAfterMidnight = await confirmCheckout(ctx.app, cashier, explicitRef, {
        cashReceivedCentavos: 10000,
      });
      expect(confirmAfterMidnight.status).toBe(409);
      expect(confirmAfterMidnight.body.error.code).toBe("CHECKOUT_CANCELLED");

      const lookupAfterMidnight = await request(ctx.app)
        .get(`/api/pos/checkouts/${explicitRef}`)
        .set("Cookie", owner.cookie);
      expect(lookupAfterMidnight.status).toBe(200);
      expect(lookupAfterMidnight.body).toMatchObject({
        recoveryState: "CANCELLED",
        canRetry: false,
        canSettlePriorDay: false,
        canDismissCancelled: true,
      });
      expect(lookupAfterMidnight.body.checkout).toMatchObject({
        status: "CANCELLED_DRAFT",
        resolutionReason: "CLEARED_ON_END_DAY",
      });

      // Cashier also receives verified CANCELLED state for explicit unpaid cancellation
      const cashierLookupCancelled = await request(ctx.app)
        .get(`/api/pos/checkouts/${explicitRef}`)
        .set("Cookie", cashier.cookie);
      expect(cashierLookupCancelled.status).toBe(200);
      expect(cashierLookupCancelled.body).toMatchObject({
        recoveryState: "CANCELLED",
        canRetry: false,
        canSettlePriorDay: false,
        canDismissCancelled: true,
        ownedByCurrentUser: true,
      });

      const settleAfterMidnight = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(explicitRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: true });
      expect(settleAfterMidnight.status).toBe(409);
      expect(settleAfterMidnight.body.error.code).toBe("CHECKOUT_NOT_SETTLABLE");

      // Close Nov 18 (auto-clearing only the unpaid DRAFT B)
      const closedDay = await endDay(ctx, owner, {
        requestKey: "cancel-preserve-end",
        clearUnpaidDrafts: true,
      });
      expect(closedDay.status).toBe(200);
      expect(closedDay.body.clearedDraftReferences).toEqual([autoClearedRef]);

      // Automatic End Day clearance must remain REVIEW_REQUIRED with canDismissCancelled: false
      const lookupAutoCleared = await request(ctx.app)
        .get(`/api/pos/checkouts/${autoClearedRef}`)
        .set("Cookie", owner.cookie);
      expect(lookupAutoCleared.status).toBe(200);
      expect(lookupAutoCleared.body).toMatchObject({
        recoveryState: "REVIEW_REQUIRED",
        canRetry: false,
        canDismissCancelled: false,
      });

      // Legacy CANCELLED_DRAFT row with null cancellation_origin must NOT allow dismissal even with "No cash received" reason
      const legacyNullRef = "HD-1118-LEGACY";
      await ctx.db.query(
        `INSERT INTO pos_checkouts (
           reference, business_day_id, business_date, created_by_user_id, prepare_key, status,
           quote_snapshot, quote_hash, total_centavos, total_containers, total_volume_ml,
           resolution_reason, cancellation_origin, created_at, updated_at
         )
         SELECT $1, business_day_id, business_date, created_by_user_id, 'legacy-null-origin', 'CANCELLED_DRAFT',
                quote_snapshot, quote_hash, total_centavos, total_containers, total_volume_ml,
                'No cash received', NULL, created_at, updated_at
           FROM pos_checkouts
          WHERE reference = $2`,
        [legacyNullRef, explicitRef],
      );
      const lookupLegacyNull = await request(ctx.app)
        .get(`/api/pos/checkouts/${legacyNullRef}`)
        .set("Cookie", owner.cookie);
      expect(lookupLegacyNull.status).toBe(200);
      expect(lookupLegacyNull.body).toMatchObject({
        recoveryState: "REVIEW_REQUIRED",
        canRetry: false,
        canSettlePriorDay: false,
        canDismissCancelled: false,
      });

      // Delayed confirm on explicitRef AFTER day close STILL preserves CANCELLED_DRAFT & its reason
      const confirmAfterClose = await confirmCheckout(ctx.app, cashier, explicitRef, {
        cashReceivedCentavos: 10000,
      });
      expect(confirmAfterClose.status).toBe(409);
      expect(confirmAfterClose.body.error.code).toBe("CHECKOUT_CANCELLED");

      const lookupAfterClose = await request(ctx.app)
        .get(`/api/pos/checkouts/${explicitRef}`)
        .set("Cookie", owner.cookie);
      expect(lookupAfterClose.status).toBe(200);
      expect(lookupAfterClose.body).toMatchObject({
        recoveryState: "CANCELLED",
        canRetry: false,
        canSettlePriorDay: false,
        canDismissCancelled: true,
      });
      expect(lookupAfterClose.body.checkout).toMatchObject({
        status: "CANCELLED_DRAFT",
        resolutionReason: "CLEARED_ON_END_DAY",
      });

      // Contrast: delayed confirm on auto-cleared draft after End Day still flags DAY_CLOSED for Owner review
      const delayedAutoConfirm = await confirmCheckout(ctx.app, cashier, autoClearedRef, {
        cashReceivedCentavos: 5000,
      });
      expect(delayedAutoConfirm.status).toBe(409);
      expect(delayedAutoConfirm.body.error.code).toBe("CHECKOUT_REVIEW_REQUIRED");
      expect(delayedAutoConfirm.body.checkout).toMatchObject({
        status: "REVIEW_REQUIRED",
        resolutionReason: "DAY_CLOSED",
      });
    });

    it("upgrades a database already on first-revision 0005 with existing settlement rows via 0006 without losing history", async () => {
      const upgradeDb = await createPgliteDatabase();
      try {
        await upgradeDb.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          );
        `);
        const pre0006Files = (await readdir(MIGRATIONS_DIR))
          .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.startsWith("0006_"))
          .sort();
        for (const file of pre0006Files) {
          const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
          await upgradeDb.exec(sql);
          await upgradeDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        }

        // Insert pre-upgrade user accounts, day, checkouts, and settled row via SQL (as left by pre-0006 server)
        const clock = new ManualClock("2026-11-17T10:00:00+08:00");
        const preUpgradeApp = createApp({ db: upgradeDb, clock });
        const preUpgradeCtx: TestContext = {
          db: upgradeDb,
          clock,
          app: preUpgradeApp,
          close: () => upgradeDb.close(),
        };
        const upOwner = await activatedAccount(preUpgradeCtx, "upowner", "OWNER");
        const upCashier = await activatedAccount(preUpgradeCtx, "upcashier", "CASHIER");

        const { rows: uRows } = await upgradeDb.query<{ id: string; username: string }>(
          `SELECT id, username FROM app_users WHERE username IN ('upowner', 'upcashier')`,
        );
        const ownerId = uRows.find((r) => r.username === "upowner")!.id;
        const cashierId = uRows.find((r) => r.username === "upcashier")!.id;

        const { rows: dayInserted } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_business_days (business_date, started_by_user_id, started_at, next_reference_seq)
           VALUES ('2026-11-17', $1, '2026-11-17T09:00:00+08:00', 2)
           RETURNING id`,
          [ownerId],
        );
        const dayId = dayInserted[0]!.id;

        const oldRef = "HD-1117-001";
        const newRef = "HD-1117-002";
        const oldItems = [
          {
            lineIndex: 0,
            kind: "STANDARD",
            catalogCode: "PURIFIED_25L",
            waterType: "PURIFIED",
            displayLabel: "Purified refill · 25 L",
            unitVolumeMl: 25000,
            unitVolumeLiters: 25,
            unitPriceCentavos: 2500,
            quantity: 2,
            lineTotalCentavos: 5000,
            lineVolumeMl: 50000,
            lineVolumeLiters: 50,
          },
        ];
        const newItems = [
          {
            lineIndex: 0,
            kind: "STANDARD",
            catalogCode: "ALKALINE_25L",
            waterType: "ALKALINE",
            displayLabel: "Alkaline refill · 25 L",
            unitVolumeMl: 25000,
            unitVolumeLiters: 25,
            unitPriceCentavos: 3500,
            quantity: 1,
            lineTotalCentavos: 3500,
            lineVolumeMl: 25000,
            lineVolumeLiters: 25,
          },
        ];

        const { rows: cOldInserted } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_checkouts (
             reference, business_day_id, business_date, created_by_user_id,
             status, quote_snapshot, quote_hash, total_centavos, total_containers, total_volume_ml,
             cash_received_centavos, change_centavos, payment_started_at, payment_recorded_at,
             resolution_reason, created_at, updated_at
           )
           VALUES (
             $1, $2, '2026-11-17', $3,
             'SETTLED_PRIOR_DAY', $4::jsonb, 'hash-old', 5000, 2, 50000,
             10000, 5000, '2026-11-17T23:50:00+08:00', '2026-11-17T23:55:00+08:00',
             'SETTLED_PRIOR_DAY_PAID_AND_DELIVERED', '2026-11-17T23:49:00+08:00', '2026-11-18T08:00:00+08:00'
           )
           RETURNING id`,
          [oldRef, dayId, cashierId, JSON.stringify(oldItems)],
        );

        await upgradeDb.query(
          `INSERT INTO pos_checkouts (
             reference, business_day_id, business_date, created_by_user_id,
             status, quote_snapshot, quote_hash, total_centavos, total_containers, total_volume_ml,
             payment_started_at, created_at, updated_at
           )
           VALUES (
             $1, $2, '2026-11-17', $3,
             'PAYMENT_PENDING', $4::jsonb, 'hash-new', 3500, 1, 25000,
             '2026-11-17T10:00:00+08:00', '2026-11-17T09:59:00+08:00', '2026-11-17T10:00:00+08:00'
           )`,
          [newRef, dayId, cashierId, JSON.stringify(newItems)],
        );

        await upgradeDb.query(
          `INSERT INTO pos_prior_day_settlements (
             checkout_id, checkout_reference, original_business_day_id,
             original_business_date, settlement_date, outcome,
             net_amount_kept_centavos, cash_received_centavos, change_centavos,
             total_containers, total_volume_ml, items_snapshot,
             original_actor_user_id, original_payment_recorded_at,
             payment_kept_confirmed, refill_delivered_confirmed,
             settled_by_user_id, settled_at, note
           )
           VALUES (
             $1, $2, $3, '2026-11-17', '2026-11-18', 'PAID_AND_DELIVERED',
             5000, 10000, 5000, 2, 50000, $4::jsonb,
             $5, '2026-11-17T23:55:00+08:00', true, true, $6, '2026-11-18T08:00:00+08:00', 'Pre-0006 row'
           )`,
          [cOldInserted[0]!.id, oldRef, dayId, JSON.stringify(oldItems), cashierId, ownerId],
        );

        // Now run the migration runner to upgrade existing DB -> must apply 0006!
        const newlyApplied = await runMigrations(upgradeDb);
        expect(newlyApplied).toEqual(["0006_pos_settlement_audit_and_cancel_origin.sql"]);

        // Advance to 2026-11-18 and read pre-0006 settlement history + record a new settlement
        clock.set("2026-11-18T09:00:00+08:00");
        const ownerAfter = await signIn(preUpgradeApp, "upowner", upOwner.password);

        const salesAfterUpgrade = await request(preUpgradeApp)
          .get("/api/pos/sales?date=2026-11-18")
          .set("Cookie", ownerAfter.cookie);
        expect(salesAfterUpgrade.status).toBe(200);
        expect(salesAfterUpgrade.body.priorDaySettlements).toHaveLength(1);
        expect(salesAfterUpgrade.body.priorDaySettlements[0]).toMatchObject({
          checkoutReference: oldRef,
          originalPaymentStartedAt: null,
          note: "Pre-0006 row",
        });

        const newSettle = await request(preUpgradeApp)
          .post(`/api/pos/checkouts/${encodeURIComponent(newRef)}/settle`)
          .set("Cookie", ownerAfter.cookie)
          .set("X-CSRF-Token", ownerAfter.csrfToken)
          .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: true });
        expect(newSettle.status).toBe(201);
        expect(newSettle.body.settlement).toMatchObject({
          checkoutReference: newRef,
          originalPaymentStartedAt: "2026-11-17T10:00:00+08:00",
          originalPaymentRecordedAt: null,
        });
      } finally {
        await upgradeDb.close();
      }
    });
  });

  describe("Inventory merchandise in POS (DEC-068 through DEC-070)", () => {
    async function createProduct(
      payload: Record<string, unknown>,
      actor: SignedIn = owner,
    ) {
      return request(ctx.app)
        .post("/api/inventory/products")
        .set("Cookie", actor.cookie)
        .set("X-CSRF-Token", actor.csrfToken)
        .send(payload);
    }

    async function setOpeningStock(itemKey: string, quantity: number, actor: SignedIn = owner) {
      return request(ctx.app)
        .post(`/api/inventory/items/${encodeURIComponent(itemKey)}/opening-stock`)
        .set("Cookie", actor.cookie)
        .set("X-CSRF-Token", actor.csrfToken)
        .send({ quantity });
    }

    it("exposes visible merchandise in catalog, hides unchecked items, sells standalone and mixed orders, and leaves customer refills decoupled", async () => {
      const faucetRes = await createProduct({
        name: "Push-Type Faucet",
        description: "Press to dispense water",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      });
      expect(faucetRes.status).toBe(201);
      const faucetId = faucetRes.body.item.id as string;

      const dividerRes = await createProduct({
        name: "Divider",
        description: "A white transparent cover",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 1500,
        showInPos: false,
        posSection: "TAKIP_ACCESSORIES",
      });
      expect(dividerRes.status).toBe(201);
      const dividerId = dividerRes.body.item.id as string;

      // Catalog shows visible faucet (NOT_SET initially) and omits hidden divider.
      const cat1 = await request(ctx.app).get("/api/pos/catalog").set("Cookie", cashier.cookie);
      expect(cat1.status).toBe(200);
      expect(cat1.body.merchandise).toEqual([
        {
          id: faucetId,
          code: faucetRes.body.item.code,
          name: "Push-Type Faucet",
          description: "Press to dispense water",
          unit: "pcs",
          unitPriceCentavos: 4000,
          posSection: "CHANGE_OF_GRIPO",
          stockStatus: "NOT_SET",
          currentQuantity: null,
          availableQuantity: null,
        },
      ]);

      await startDay(ctx, owner, { requestKey: "merch-day-1" });

      // Submitting Not Set merchandise fails for both Cashier and Owner.
      for (const actor of [cashier, owner]) {
        const unsetPrep = await prepareCheckout(ctx, actor, {
          items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
        });
        expect(unsetPrep.status).toBe(409);
        expect(unsetPrep.body.error.code).toBe("INSUFFICIENT_STOCK");
      }

      // Submitting hidden product directly fails.
      const hiddenPrep = await prepareCheckout(ctx, cashier, {
        items: [{ kind: "MERCHANDISE", productId: dividerId, quantity: 1 }],
      });
      expect(hiddenPrep.status).toBe(400);
      expect(hiddenPrep.body.error.code).toBe("PRODUCT_UNAVAILABLE");

      // Forged price rejected on schema validation.
      const forgedPrep = await prepareCheckout(ctx, cashier, {
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1, unitPriceCentavos: 100 }],
      });
      expect(forgedPrep.status).toBe(400);
      expect(forgedPrep.body.error.code).toBe("VALIDATION_FAILED");

      // Record opening stock: 5 pcs for Push-Type Faucet.
      const opening = await setOpeningStock(faucetId, 5);
      expect(opening.status).toBe(201);

      // Summed demand across duplicate lines in one cart exceeding 5 is blocked.
      const summedOver = await prepareCheckout(ctx, cashier, {
        items: [
          { kind: "MERCHANDISE", productId: faucetId, quantity: 3 },
          { kind: "MERCHANDISE", productId: faucetId, quantity: 3 },
        ],
      });
      expect(summedOver.status).toBe(409);
      expect(summedOver.body.error.code).toBe("INSUFFICIENT_STOCK");

      // Two-faucet sale: ₱80 total, ₱100 tender, ₱20 change, 0 containers, 0 L water volume.
      const twoFaucetsPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "merch-two-faucets",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 2 }],
      });
      expect(twoFaucetsPrep.status).toBe(201);
      const ref1 = twoFaucetsPrep.body.checkout.reference as string;
      expect(twoFaucetsPrep.body.checkout).toMatchObject({
        totalCentavos: 8000,
        totalContainers: 0,
        totalVolumeMl: 0,
        totalVolumeLiters: 0,
      });

      const begin1 = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref1)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(begin1.status).toBe(200);

      const confirm1 = await confirmCheckout(ctx.app, cashier, ref1, { cashReceivedCentavos: 10000 });
      expect(confirm1.status).toBe(201);
      expect(confirm1.body.sale).toMatchObject({
        reference: ref1,
        totalCentavos: 8000,
        cashReceivedCentavos: 10000,
        changeCentavos: 2000,
        totalContainers: 0,
        totalVolumeMl: 0,
        totalVolumeLiters: 0,
      });
      expect(confirm1.body.sale.items).toEqual([
        {
          lineIndex: 0,
          kind: "MERCHANDISE",
          catalogCode: null,
          waterType: null,
          productId: faucetId,
          stockUnit: "pcs",
          posSection: "CHANGE_OF_GRIPO",
          displayLabel: "Push-Type Faucet",
          unitVolumeMl: 0,
          unitVolumeLiters: 0,
          unitPriceCentavos: 4000,
          quantity: 2,
          lineTotalCentavos: 8000,
          lineVolumeMl: 0,
          lineVolumeLiters: 0,
        },
      ]);

      // Lost-response retry on /confirm does NOT deduct stock again!
      const retry1 = await confirmCheckout(ctx.app, cashier, ref1, { cashReceivedCentavos: 10000 });
      expect(retry1.status).toBe(200);
      expect(retry1.body.replayed).toBe(true);

      const { rows: invAfter1 } = await ctx.db.query<{ current_quantity: number }>(
        `SELECT current_quantity FROM inventory_items WHERE id = $1`,
        [faucetId],
      );
      expect(Number(invAfter1[0]!.current_quantity)).toBe(3);

      const { rows: moveRows1 } = await ctx.db.query<{
        quantity_delta: number;
        balance_before: number;
        balance_after: number;
        pos_reference: string;
      }>(
        `SELECT quantity_delta, balance_before, balance_after, pos_reference
           FROM inventory_stock_movements
          WHERE item_id = $1`,
        [faucetId],
      );
      expect(moveRows1).toEqual([
        {
          quantity_delta: -2,
          balance_before: 5,
          balance_after: 3,
          pos_reference: ref1,
        },
      ]);

      // Mixed sale: 1 Purified 25 L refill (₱25) + 1 Push-Type Faucet (₱40) = ₱65
      const mixedPrep = await prepareCheckout(ctx, owner, {
        prepareKey: "merch-mixed-sale",
        items: [
          { kind: "STANDARD", waterType: "PURIFIED", quantity: 1 },
          { kind: "MERCHANDISE", productId: faucetId, quantity: 1 },
        ],
      });
      expect(mixedPrep.status).toBe(201);
      const ref2 = mixedPrep.body.checkout.reference as string;
      const mixedConfirm = await confirmCheckout(ctx.app, owner, ref2, { cashReceivedCentavos: 10000 });
      expect(mixedConfirm.status).toBe(201);
      expect(mixedConfirm.body.sale).toMatchObject({
        totalCentavos: 6500,
        cashReceivedCentavos: 10000,
        changeCentavos: 3500,
        totalContainers: 1,
        totalVolumeMl: 25000,
        totalVolumeLiters: 25,
      });

      // Customer-owned refill alone does not alter merchandise stock (stays at 2).
      const refillOnlyPrep = await prepareCheckout(ctx, cashier, {
        items: [{ kind: "CUSTOM", waterType: "ALKALINE", unitVolumeLiters: 10, unitPriceCentavos: 3000, quantity: 1 }],
      });
      expect(refillOnlyPrep.status).toBe(201);
      const refillOnlyConfirm = await confirmCheckout(ctx.app, cashier, refillOnlyPrep.body.checkout.reference, {
        cashReceivedCentavos: 3000,
      });
      expect(refillOnlyConfirm.status).toBe(201);

      const { rows: invAfter3 } = await ctx.db.query<{ current_quantity: number }>(
        `SELECT current_quantity FROM inventory_items WHERE id = $1`,
        [faucetId],
      );
      expect(Number(invAfter3[0]!.current_quantity)).toBe(2);

      // Day summary tracks refill volume + combined sales revenue accurately.
      const dayRes = await request(ctx.app).get("/api/pos/day").set("Cookie", owner.cookie);
      expect(dayRes.body.day.summary).toMatchObject({
        totalSalesCentavos: 8000 + 6500 + 3000,
        validTransactionCount: 3,
        purifiedQuantity: 1,
        alkalineQuantity: 1,
        totalVolumeMl: 35000,
        totalVolumeLiters: 35,
      });
    });

    it("prevents competing checkouts from committing the same last unit, releases on cancel, preserves snapshots on product edits, and blocks closed-day and prior-day settlement", async () => {
      const faucetRes = await createProduct({
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      });
      const faucetId = faucetRes.body.item.id as string;
      await setOpeningStock(faucetId, 1);

      await startDay(ctx, owner, { requestKey: "compete-day" });

      // Prepare two separate drafts for the last 1 faucet.
      const prepA = await prepareCheckout(ctx, cashier, {
        prepareKey: "compete-a",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      const prepB = await prepareCheckout(ctx, owner, {
        prepareKey: "compete-b",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      expect(prepA.status).toBe(201);
      expect(prepB.status).toBe(201);
      const refA = prepA.body.checkout.reference as string;
      const refB = prepB.body.checkout.reference as string;

      // Concurrent begin-payment: exactly one succeeds (200) and the other is blocked (409 INSUFFICIENT_STOCK).
      const [beginA, beginB] = await Promise.all([
        request(ctx.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(refA)}/begin-payment`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({}),
        request(ctx.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(refB)}/begin-payment`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({}),
      ]);
      const beginStatuses = [beginA.status, beginB.status].sort((a, b) => a - b);
      expect(beginStatuses).toEqual([200, 409]);

      const winnerRef = beginA.status === 200 ? refA : refB;
      const winnerActor = beginA.status === 200 ? cashier : owner;
      const loserRef = beginA.status === 409 ? refA : refB;
      const loserActor = beginA.status === 409 ? cashier : owner;

      // Catalog shows 0 available while winner holds active commitment.
      const catHeld = await request(ctx.app).get("/api/pos/catalog").set("Cookie", cashier.cookie);
      expect(catHeld.body.merchandise[0]).toMatchObject({
        stockStatus: "OUT_OF_STOCK",
        currentQuantity: 1,
        availableQuantity: 0,
      });

      // Cancelling winner with confirmNoCashTaken releases the commitment so loser can begin payment.
      const cancelWinner = await cancelCheckout(ctx, winnerActor, winnerRef, {
        confirmNoCashTaken: true,
        reason: "Customer changed mind",
      });
      expect(cancelWinner.status).toBe(200);

      const beginLoser = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(loserRef)}/begin-payment`)
        .set("Cookie", loserActor.cookie)
        .set("X-CSRF-Token", loserActor.csrfToken)
        .send({});
      expect(beginLoser.status).toBe(200);

      // Owner updates product price and hides it AFTER loser's checkout was quoted.
      const patchRes = await request(ctx.app)
        .patch(`/api/inventory/products/${encodeURIComponent(faucetId)}`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ name: "Updated Faucet", unitPriceCentavos: 5500, showInPos: false });
      expect(patchRes.status).toBe(200);

      // Quoted recovery / confirm still uses the ₱40 snapshot and saves cleanly!
      const lookupLoser = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(loserRef)}`)
        .set("Cookie", loserActor.cookie);
      expect(lookupLoser.status).toBe(200);
      expect(lookupLoser.body.checkout.totalCentavos).toBe(4000);
      expect(lookupLoser.body.checkout.items[0].displayLabel).toBe("Push-Type Faucet");

      const confirmLoser = await confirmCheckout(ctx.app, loserActor, loserRef, {
        cashReceivedCentavos: 5000,
      });
      expect(confirmLoser.status).toBe(201);
      expect(confirmLoser.body.sale.totalCentavos).toBe(4000);
      expect(confirmLoser.body.sale.items[0].displayLabel).toBe("Push-Type Faucet");

      // Re-publish updated faucet with 2 pcs, close today, and verify closed-day attempt is rejected.
      await request(ctx.app)
        .patch(`/api/inventory/products/${encodeURIComponent(faucetId)}`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ showInPos: true });
      await ctx.db.query(`UPDATE inventory_items SET current_quantity = 2 WHERE id = $1`, [faucetId]);

      const endToday = await endDay(ctx, owner, { requestKey: "end-today-merch" });
      expect(endToday.status).toBe(200);

      const closedPrep = await prepareCheckout(ctx, cashier, {
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      expect(closedPrep.status).toBe(409);
      expect(closedPrep.body.error.code).toBe("DAY_ALREADY_CLOSED");

      // Next business day: mixed refill + merchandise checkout crossing midnight can be settled once both confirmations are provided (DEC-095).
      ctx.clock.advance(24 * 60 * 60_000);
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      const startNext = await startDay(ctx, owner, { requestKey: "start-next-merch" });
      expect(startNext.status).toBe(201);

      const priorPrep = await prepareCheckout(ctx, cashier, {
        items: [
          { kind: "STANDARD", waterType: "PURIFIED", quantity: 1 },
          { kind: "MERCHANDISE", productId: faucetId, quantity: 1 },
        ],
      });
      expect(priorPrep.status).toBe(201);
      const priorRef = priorPrep.body.checkout.reference as string;
      const priorBegin = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(priorBegin.status).toBe(200);

      ctx.clock.advance(24 * 60 * 60_000);
      owner = await reauth(ctx, "owner1", owner);

      const priorLookup = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(priorRef)}`)
        .set("Cookie", owner.cookie);
      expect(priorLookup.status).toBe(200);
      expect(priorLookup.body.recoveryState).toBe("REVIEW_REQUIRED");
      expect(priorLookup.body.canSettlePriorDay).toBe(true);

      const missingRefillConfirm = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, itemsHandedOverConfirmed: true });
      expect(missingRefillConfirm.status).toBe(400);
      expect(missingRefillConfirm.body.error.code).toBe("VALIDATION_FAILED");

      const settleMixed = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          paymentKeptConfirmed: true,
          refillDeliveredConfirmed: true,
          itemsHandedOverConfirmed: true,
        });
      expect(settleMixed.status).toBe(201);
      expect(settleMixed.body.outcome).toBe("SETTLED");
      expect(settleMixed.body.settlement.itemsHandedOverConfirmed).toBe(true);
    });

    it("publishes Round/Slim container packages sharing one shape balance, enforces shared stock gates, exposes custom sections, and keeps started checkout recovery safe after archive (DEC-073, DEC-074)", async () => {
      // Publish Round container (Slim remains hidden initially)
      const pubRound = await request(ctx.app)
        .patch("/api/inventory/containers/ROUND")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ showInPos: true });
      expect(pubRound.status).toBe(200);

      const catBeforeStock = await request(ctx.app).get("/api/pos/catalog").set("Cookie", cashier.cookie);
      expect(catBeforeStock.status).toBe(200);
      expect(catBeforeStock.body.containerPackages.map((p: any) => p.packageCode)).toEqual([
        "ROUND_EMPTY",
        "ROUND_PURIFIED",
        "ROUND_ALKALINE",
      ]);
      expect(catBeforeStock.body.containerPackages[0]).toMatchObject({
        packageCode: "ROUND_EMPTY",
        unitPriceCentavos: 17500,
        unitVolumeLiters: 0,
        stockStatus: "NOT_SET",
      });

      await startDay(ctx, owner, { requestKey: "containers-pos-day" });

      // Not Set Round and hidden Slim are both blocked
      const roundUnsetPrep = await prepareCheckout(ctx, cashier, {
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(roundUnsetPrep.status).toBe(409);
      expect(roundUnsetPrep.body.error.code).toBe("INSUFFICIENT_STOCK");

      const slimHiddenPrep = await prepareCheckout(ctx, cashier, {
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "SLIM_EMPTY",
            includedGripo: "TWIST_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(slimHiddenPrep.status).toBe(400);
      expect(slimHiddenPrep.body.error.code).toBe("PRODUCT_UNAVAILABLE");

      // Record opening stock: Round = 5, Slim = 4; publish Slim (explicit check of ₱200 empty Slim)
      expect((await setOpeningStock("ROUND", 5)).status).toBe(201);
      expect((await setOpeningStock("SLIM", 4)).status).toBe(201);
      expect(
        (
          await request(ctx.app)
            .patch("/api/inventory/containers/SLIM")
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ showInPos: true })
        ).status,
      ).toBe(200);

      const catPublished = await request(ctx.app).get("/api/pos/catalog").set("Cookie", cashier.cookie);
      expect(catPublished.body.containerPackages).toHaveLength(6);
      expect(
        catPublished.body.containerPackages.find((p: any) => p.packageCode === "SLIM_EMPTY"),
      ).toMatchObject({
        unitPriceCentavos: 20000,
        unitVolumeMl: 0,
        availableQuantity: 4,
      });

      // Mixed options exceeding Round's 5 balance (3 Empty + 3 Purified = 6) are blocked for both roles
      for (const actor of [cashier, owner]) {
        const overMixed = await prepareCheckout(ctx, actor, {
          items: [
            {
              kind: "CONTAINER_PACKAGE",
              packageCode: "ROUND_EMPTY",
              includedGripo: "PUSH_TYPE",
              quantity: 3,
            },
            {
              kind: "CONTAINER_PACKAGE",
              packageCode: "ROUND_PURIFIED",
              includedGripo: "TWIST_TYPE",
              quantity: 3,
            },
          ],
        });
        expect(overMixed.status).toBe(409);
        expect(overMixed.body.error.code).toBe("INSUFFICIENT_STOCK");
      }

      // Valid mixed Round sale: 1 Empty Round (₱175) + 1 Purified Round (₱200, 25 L) = ₱375, 25 L, deducts 2 Round (5 -> 3), Slim stays 4
      const mixedRoundPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "mixed-round-1",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "TWIST_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(mixedRoundPrep.status).toBe(201);
      const mixedRef = mixedRoundPrep.body.checkout.reference as string;
      const mixedConfirm = await confirmCheckout(ctx.app, cashier, mixedRef, {
        cashReceivedCentavos: 50000,
      });
      expect(mixedConfirm.status).toBe(201);
      expect(mixedConfirm.body.sale).toMatchObject({
        totalCentavos: 37500,
        changeCentavos: 12500,
        totalContainers: 0,
        totalVolumeMl: 25000,
        totalVolumeLiters: 25,
      });

      const invAfterRound = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const roundRow = invAfterRound.body.items.find((i: any) => i.shape === "ROUND");
      const slimRow = invAfterRound.body.items.find((i: any) => i.shape === "SLIM");
      expect(roundRow.currentQuantity).toBe(3);
      expect(slimRow.currentQuantity).toBe(4);

      // Customer-owned refill leaves Round and Slim balances unchanged
      const refillPrep = await prepareCheckout(ctx, cashier, {
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 2 }],
      });
      expect(
        (
          await confirmCheckout(ctx.app, cashier, refillPrep.body.checkout.reference, {
            cashReceivedCentavos: 10000,
          })
        ).status,
      ).toBe(201);

      const invAfterRefill = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      expect(invAfterRefill.body.items.find((i: any) => i.shape === "ROUND").currentQuantity).toBe(3);
      expect(invAfterRefill.body.items.find((i: any) => i.shape === "SLIM").currentQuantity).toBe(4);

      // Custom section + edit + archive with in-progress checkout recovery
      const secRes = await request(ctx.app)
        .post("/api/inventory/pos-sections")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ name: "Cleaning Supplies" });
      expect(secRes.status).toBe(201);
      const customCode = secRes.body.section.code as string;

      const brushRes = await createProduct({
        name: "Gallon Brush",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 6500,
        showInPos: true,
        posSection: customCode,
      });
      const brushId = brushRes.body.item.id as string;
      await setOpeningStock(brushId, 6);

      const catCustom = await request(ctx.app).get("/api/pos/catalog").set("Cookie", cashier.cookie);
      expect(catCustom.body.posSections.some((s: any) => s.code === customCode && s.name === "Cleaning Supplies")).toBe(true);
      expect(catCustom.body.merchandise.find((m: any) => m.id === brushId)).toMatchObject({
        posSection: customCode,
        unitPriceCentavos: 6500,
      });

      // Start payment on Gallon Brush, then Owner archives Gallon Brush before confirmation
      const brushPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "brush-pending-archive",
        items: [{ kind: "MERCHANDISE", productId: brushId, quantity: 2 }],
      });
      expect(brushPrep.status).toBe(201);
      const brushRef = brushPrep.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(brushRef)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      const archiveBrush = await request(ctx.app)
        .post(`/api/inventory/products/${encodeURIComponent(brushId)}/archive`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({});
      expect(archiveBrush.status).toBe(200);

      // New checkout for archived product is rejected, while the already-started PAYMENT_PENDING checkout completes safely
      const newArchivedPrep = await prepareCheckout(ctx, cashier, {
        items: [{ kind: "MERCHANDISE", productId: brushId, quantity: 1 }],
      });
      expect(newArchivedPrep.status).toBe(400);
      expect(newArchivedPrep.body.error.code).toBe("PRODUCT_UNAVAILABLE");

      const confirmArchivedPending = await confirmCheckout(ctx.app, cashier, brushRef, {
        cashReceivedCentavos: 20000,
      });
      expect(confirmArchivedPending.status).toBe(201);
      expect(confirmArchivedPending.body.sale.items[0].displayLabel).toBe("Gallon Brush");

      // Preserved balance reflects 6 - 2 = 4 in includeArchived query
      const archivedLookup = await request(ctx.app)
        .get("/api/inventory/items?includeArchived=true")
        .set("Cookie", owner.cookie);
      expect(archivedLookup.body.items.find((i: any) => i.id === brushId).currentQuantity).toBe(4);
    });

    it("protects active PAYMENT_PENDING reservations from conflicting stock corrections in both orderings (Finding 2)", async () => {
      const faucetRes = await createProduct({
        name: "Protected Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      });
      const faucetId = faucetRes.body.item.id as string;
      const open1 = await setOpeningStock(faucetId, 1);
      expect(open1.status).toBe(201);
      const rev1 = open1.body.item.stockRevision as number;

      await startDay(ctx, owner, { requestKey: "finding2-day" });

      // Ordering A: Cashier reserves the 1 unit in begin-payment -> Owner reconciliation 1 -> 0 is blocked
      const prepA = await prepareCheckout(ctx, cashier, {
        prepareKey: "f2-order-a",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      const refA = prepA.body.checkout.reference as string;
      const beginA = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refA)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(beginA.status).toBe(200);

      const blockedRec = await request(ctx.app)
        .post(`/api/inventory/items/${encodeURIComponent(faucetId)}/reconciliations`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          physicalCount: 0,
          reason: "Conflicting count",
          expectedRevision: rev1,
          expectedCurrentQuantity: 1,
        });
      expect(blockedRec.status).toBe(409);
      expect(blockedRec.body.error.code).toBe("ACTIVE_PAYMENT_COMMITMENT");

      // Cashier can still confirm the ₱40 sale and deduct 1 -> 0 cleanly
      const confirmA = await confirmCheckout(ctx.app, cashier, refA, {
        cashReceivedCentavos: 5000,
      });
      expect(confirmA.status).toBe(201);

      // Re-stock to 5 pcs and verify non-conflicting reconciliation (5 -> 2 with 1 reserved succeeds)
      const invMid = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const itemMid = invMid.body.items.find((i: any) => i.id === faucetId);
      const recUp = await request(ctx.app)
        .post(`/api/inventory/items/${encodeURIComponent(faucetId)}/reconciliations`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          physicalCount: 5,
          reason: "Verified restock shelf count",
          expectedRevision: itemMid.stockRevision,
          expectedCurrentQuantity: 0,
        });
      expect(recUp.status).toBe(201);

      const prepB = await prepareCheckout(ctx, cashier, {
        prepareKey: "f2-order-b",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      const refB = prepB.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(refB)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // With 1 unit reserved, reconciling 5 -> 2 leaves enough for the active reservation (2 >= 1)
      const recNonConflicting = await request(ctx.app)
        .post(`/api/inventory/items/${encodeURIComponent(faucetId)}/reconciliations`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          physicalCount: 2,
          reason: "Shelf count still covers active payment",
          expectedRevision: recUp.body.item.stockRevision,
          expectedCurrentQuantity: 5,
        });
      expect(recNonConflicting.status).toBe(201);

      const confirmB = await confirmCheckout(ctx.app, cashier, refB, {
        cashReceivedCentavos: 5000,
      });
      expect(confirmB.status).toBe(201);

      // Ordering B: Draft prepared when 1 unit available -> Owner reconciles 1 -> 0 BEFORE begin-payment -> begin-payment blocked before cash is taken
      const draftBeforeRec = await prepareCheckout(ctx, cashier, {
        prepareKey: "f2-order-c",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      const refC = draftBeforeRec.body.checkout.reference as string;

      const invBeforeC = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const itemBeforeC = invBeforeC.body.items.find((i: any) => i.id === faucetId);
      expect(itemBeforeC.currentQuantity).toBe(1);

      const recToZero = await request(ctx.app)
        .post(`/api/inventory/items/${encodeURIComponent(faucetId)}/reconciliations`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          physicalCount: 0,
          reason: "Removed damaged last unit before payment",
          expectedRevision: itemBeforeC.stockRevision,
          expectedCurrentQuantity: 1,
        });
      expect(recToZero.status).toBe(201);

      const beginCAfterRec = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refC)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(beginCAfterRec.status).toBe(409);
      expect(beginCAfterRec.body.error.code).toBe("INSUFFICIENT_STOCK");
    });

    it("blocks unpaid drafts from entering payment or confirming after archival while keeping started payments completable (Finding 3)", async () => {
      const faucetRes = await createProduct({
        name: "Archive Guard Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      });
      const faucetId = faucetRes.body.item.id as string;
      await setOpeningStock(faucetId, 5);

      await startDay(ctx, owner, { requestKey: "finding3-day" });

      // Draft 1 & Draft 2 stay in DRAFT; Checkout 3 enters PAYMENT_PENDING before archive
      const draftForBegin = await prepareCheckout(ctx, cashier, {
        prepareKey: "f3-draft-begin",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      const refDraftBegin = draftForBegin.body.checkout.reference as string;

      const draftDirectConfirm = await prepareCheckout(ctx, cashier, {
        prepareKey: "f3-draft-direct",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      const refDraftDirect = draftDirectConfirm.body.checkout.reference as string;

      const startedBeforeArchive = await prepareCheckout(ctx, cashier, {
        prepareKey: "f3-started",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      const refStarted = startedBeforeArchive.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(refStarted)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Owner archives the product
      const arch = await request(ctx.app)
        .post(`/api/inventory/products/${encodeURIComponent(faucetId)}/archive`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({});
      expect(arch.status).toBe(200);

      // Both unpaid drafts are blocked at begin-payment and direct confirm
      const beginBlocked = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refDraftBegin)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(beginBlocked.status).toBe(409);
      expect(beginBlocked.body.error.code).toBe("PRODUCT_UNAVAILABLE");

      const directBlocked = await confirmCheckout(ctx.app, cashier, refDraftDirect, {
        cashReceivedCentavos: 5000,
      });
      expect(directBlocked.status).toBe(409);
      expect(directBlocked.body.error.code).toBe("PRODUCT_UNAVAILABLE");

      // Already-started PAYMENT_PENDING checkout completes safely
      const startedConfirm = await confirmCheckout(ctx.app, cashier, refStarted, {
        cashReceivedCentavos: 5000,
      });
      expect(startedConfirm.status).toBe(201);
      expect(startedConfirm.body.sale.totalCentavos).toBe(4000);
    });

    it("requires and saves customer Push-Type or Twist-Type gripo choices per container line at the same package price (Finding 4, POS-012)", async () => {
      await request(ctx.app)
        .patch("/api/inventory/containers/ROUND")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ showInPos: true });
      await setOpeningStock("ROUND", 5);

      await startDay(ctx, owner, { requestKey: "finding4-day" });

      // Missing includedGripo is rejected
      const missingGripo = await prepareCheckout(ctx, cashier, {
        items: [{ kind: "CONTAINER_PACKAGE", packageCode: "ROUND_EMPTY", quantity: 1 }],
      });
      expect(missingGripo.status).toBe(400);
      expect(missingGripo.body.error.code).toBe("VALIDATION_FAILED");

      // Mixed choices on the same package save as separate lines at ₱175 each with no extra charge
      const mixedGripoPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "f4-mixed-gripo",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "TWIST_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(mixedGripoPrep.status).toBe(201);
      expect(mixedGripoPrep.body.checkout.totalCentavos).toBe(35000);

      const ref = mixedGripoPrep.body.checkout.reference as string;
      const confirmed = await confirmCheckout(ctx.app, cashier, ref, {
        cashReceivedCentavos: 40000,
      });
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.sale.items).toEqual([
        expect.objectContaining({
          kind: "CONTAINER_PACKAGE",
          catalogCode: "ROUND_EMPTY",
          includedGripo: "PUSH_TYPE",
          displayLabel: "Empty Round Container · Push-Type gripo",
          unitPriceCentavos: 17500,
          quantity: 1,
          lineTotalCentavos: 17500,
        }),
        expect.objectContaining({
          kind: "CONTAINER_PACKAGE",
          catalogCode: "ROUND_EMPTY",
          includedGripo: "TWIST_TYPE",
          displayLabel: "Empty Round Container · Twist-Type gripo",
          unitPriceCentavos: 17500,
          quantity: 1,
          lineTotalCentavos: 17500,
        }),
      ]);

      const fetched = await request(ctx.app)
        .get(`/api/pos/sales/${encodeURIComponent(ref)}`)
        .set("Cookie", cashier.cookie);
      expect(fetched.status).toBe(200);
      expect(fetched.body.sale.items.map((i: any) => i.includedGripo)).toEqual([
        "PUSH_TYPE",
        "TWIST_TYPE",
      ]);

      const invAfter = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      expect(invAfter.body.items.find((i: any) => i.shape === "ROUND").currentQuantity).toBe(3);
    });

    it("upgrades databases from either revision of 0009 via migration 0010 without guessing historical faucet choices (Finding 5)", async () => {
      // Path A: Database that already applied the original 0009 (before included_gripo existed)
      const upgradeDb = await createPgliteDatabase();
      try {
        await upgradeDb.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          );
        `);
        const pre0009Files = (await readdir(MIGRATIONS_DIR))
          .filter((f) => /^000[1-8]_.+\.sql$/.test(f))
          .sort();
        for (const file of pre0009Files) {
          const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
          await upgradeDb.exec(sql);
          await upgradeDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        }

        // Apply exact original 0009 schema (without included_gripo column on pos_sale_items)
        const current0009 = await readFile(
          path.join(MIGRATIONS_DIR, "0009_inventory_management_and_containers.sql"),
          "utf8",
        );
        const original0009 = current0009
          .replace(
            /ALTER TABLE pos_sale_items\s+ADD COLUMN included_gripo text[\s\S]*?TWIST_TYPE'\)\);/m,
            "",
          )
          .replace(/\s+AND included_gripo IS NULL/g, "")
          .replace(/\s+AND included_gripo IN \('PUSH_TYPE', 'TWIST_TYPE'\)/g, "");
        expect(original0009).not.toContain("included_gripo");
        await upgradeDb.exec(original0009);
        await upgradeDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          "0009_inventory_management_and_containers.sql",
        ]);

        const clock = new ManualClock("2026-11-22T10:00:00+08:00");
        const upgradeApp = createApp({ db: upgradeDb, clock });
        const upCtx: TestContext = {
          db: upgradeDb,
          clock,
          app: upgradeApp,
          close: () => upgradeDb.close(),
        };
        const upOwner = await activatedAccount(upCtx, "upowner", "OWNER");
        const upCashier = await activatedAccount(upCtx, "upcashier", "CASHIER");

        const { rows: userRows } = await upgradeDb.query<{ id: string; username: string }>(
          `SELECT id, username FROM app_users WHERE username IN ('upowner', 'upcashier')`,
        );
        const ownerId = userRows.find((r) => r.username === "upowner")!.id;
        const cashierId = userRows.find((r) => r.username === "upcashier")!.id;

        const { rows: roundRows } = await upgradeDb.query<{ id: string }>(
          `UPDATE inventory_items
              SET show_in_pos = true,
                  pos_section = 'CONTAINERS',
                  current_quantity = 5,
                  stock_revision = 1
            WHERE category = 'CONTAINER' AND container_shape = 'ROUND'
            RETURNING id`,
        );
        const roundId = roundRows[0]!.id;
        await upgradeDb.query(
          `INSERT INTO inventory_opening_counts (item_id, quantity, unit, recorded_by_user_id, recorded_at)
           VALUES ($1, 5, 'containers', $2, '2026-11-22T09:00:00+08:00')`,
          [roundId, ownerId],
        );

        const { rows: dayRows } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_business_days (business_date, started_by_user_id, started_at, next_reference_seq)
           VALUES ('2026-11-22', $1, '2026-11-22T09:00:00+08:00', 2)
           RETURNING id`,
          [ownerId],
        );
        const dayId = dayRows[0]!.id;

        // Seed pre-0010 historical standard refill + historical container sale (no included_gripo column yet)
        const stdRef = "HD-1122-001";
        const pkgRef = "HD-1122-002";
        const { rows: c1 } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_checkouts (
             reference, business_day_id, business_date, created_by_user_id,
             status, quote_snapshot, quote_hash, total_centavos, total_containers, total_volume_ml,
             cash_received_centavos, change_centavos, payment_recorded_at, created_at, updated_at
           )
           VALUES (
             $1, $2, '2026-11-22', $3, 'SAVED', '[]'::jsonb, 'h1', 2500, 1, 25000,
             5000, 2500, '2026-11-22T09:10:00+08:00', '2026-11-22T09:09:00+08:00', '2026-11-22T09:10:00+08:00'
           )
           RETURNING id`,
          [stdRef, dayId, cashierId],
        );
        const { rows: s1 } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_sales (
             reference, checkout_id, business_day_id, business_date, status,
             total_centavos, cash_received_centavos, change_centavos,
             total_containers, total_volume_ml, created_by_user_id, created_at
           )
           VALUES ($1, $2, $3, '2026-11-22', 'ACTIVE', 2500, 5000, 2500, 1, 25000, $4, '2026-11-22T09:10:00+08:00')
           RETURNING id`,
          [stdRef, c1[0]!.id, dayId, cashierId],
        );
        await upgradeDb.query(
          `INSERT INTO pos_sale_items (
             sale_id, line_index, item_kind, catalog_code, water_type,
             inventory_item_id, stock_unit, pos_section, display_label,
             unit_volume_ml, unit_price_centavos, quantity, line_total_centavos, line_volume_ml
           )
           VALUES ($1, 0, 'STANDARD', 'PURIFIED_25L', 'PURIFIED', NULL, NULL, NULL, 'Purified refill · 25 L', 25000, 2500, 1, 2500, 25000)`,
          [s1[0]!.id],
        );

        const { rows: c2 } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_checkouts (
             reference, business_day_id, business_date, created_by_user_id,
             status, quote_snapshot, quote_hash, total_centavos, total_containers, total_volume_ml,
             cash_received_centavos, change_centavos, payment_recorded_at, created_at, updated_at
           )
           VALUES (
             $1, $2, '2026-11-22', $3, 'SAVED', '[]'::jsonb, 'h2', 17500, 0, 0,
             20000, 2500, '2026-11-22T09:20:00+08:00', '2026-11-22T09:19:00+08:00', '2026-11-22T09:20:00+08:00'
           )
           RETURNING id`,
          [pkgRef, dayId, cashierId],
        );
        const { rows: s2 } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_sales (
             reference, checkout_id, business_day_id, business_date, status,
             total_centavos, cash_received_centavos, change_centavos,
             total_containers, total_volume_ml, created_by_user_id, created_at
           )
           VALUES ($1, $2, $3, '2026-11-22', 'ACTIVE', 17500, 20000, 2500, 0, 0, $4, '2026-11-22T09:20:00+08:00')
           RETURNING id`,
          [pkgRef, c2[0]!.id, dayId, cashierId],
        );
        await upgradeDb.query(
          `INSERT INTO pos_sale_items (
             sale_id, line_index, item_kind, catalog_code, water_type,
             inventory_item_id, stock_unit, pos_section, display_label,
             unit_volume_ml, unit_price_centavos, quantity, line_total_centavos, line_volume_ml
           )
           VALUES ($1, 0, 'CONTAINER_PACKAGE', 'ROUND_EMPTY', NULL, $2, 'containers', 'CONTAINERS', 'Empty Round Container', 0, 17500, 1, 17500, 0)`,
          [s2[0]!.id, roundId],
        );

        // Run forward migrations 0010 and 0011 on the upgraded DB
        const newlyApplied = await runMigrations(upgradeDb);
        expect(newlyApplied).toEqual([
          "0010_pos_container_included_gripo.sql",
          "0011_pos_legacy_pending_container_gripo.sql",
          "0012_pos_prior_day_merchandise_settlement.sql",
          "0013_dashboard_final_settings.sql",
          "0014_pos_checkout_resolutions_and_holds.sql",
          "0015_pos_sale_actions.sql",
          "0016_pos_sale_action_stock_effects.sql",
        ]);

        const cashierAfter = await signIn(upgradeApp, "upcashier", upCashier.password);
        expect(upOwner.password.length).toBeGreaterThan(0);

        // Historical container sale stays readable with includedGripo = null (no guessed faucet choice)
        const historyRes = await request(upgradeApp)
          .get("/api/pos/sales?date=2026-11-22")
          .set("Cookie", cashierAfter.cookie);
        expect(historyRes.status).toBe(200);
        const oldPkgSale = historyRes.body.sales.find((s: any) => s.reference === pkgRef);
        expect(oldPkgSale.items[0]).toMatchObject({
          kind: "CONTAINER_PACKAGE",
          catalogCode: "ROUND_EMPTY",
          displayLabel: "Empty Round Container",
          includedGripo: null,
        });

        // Standard Purified refill prepares and confirms cleanly after upgrade
        const refillPrep = await request(upgradeApp)
          .post("/api/pos/checkouts")
          .set("Cookie", cashierAfter.cookie)
          .set("X-CSRF-Token", cashierAfter.csrfToken)
          .send({
            prepareKey: "up-refill-1",
            items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
          });
        expect(refillPrep.status).toBe(201);
        const refillRef = refillPrep.body.checkout.reference as string;
        const refillBegin = await request(upgradeApp)
          .post(`/api/pos/checkouts/${encodeURIComponent(refillRef)}/begin-payment`)
          .set("Cookie", cashierAfter.cookie)
          .set("X-CSRF-Token", cashierAfter.csrfToken)
          .send({});
        expect(refillBegin.status).toBe(200);
        const refillConfirm = await confirmCheckout(upgradeApp, cashierAfter, refillRef, {
          cashReceivedCentavos: 5000,
        });
        expect(refillConfirm.status).toBe(201);

        // New container sale saves includedGripo = TWIST_TYPE and returns it in history
        const newPkgPrep = await request(upgradeApp)
          .post("/api/pos/checkouts")
          .set("Cookie", cashierAfter.cookie)
          .set("X-CSRF-Token", cashierAfter.csrfToken)
          .send({
            prepareKey: "up-pkg-1",
            items: [
              {
                kind: "CONTAINER_PACKAGE",
                packageCode: "ROUND_EMPTY",
                includedGripo: "TWIST_TYPE",
                quantity: 1,
              },
            ],
          });
        expect(newPkgPrep.status).toBe(201);
        const newPkgRef = newPkgPrep.body.checkout.reference as string;
        const newPkgConfirm = await confirmCheckout(upgradeApp, cashierAfter, newPkgRef, {
          cashReceivedCentavos: 20000,
        });
        expect(newPkgConfirm.status).toBe(201);
        expect(newPkgConfirm.body.sale.items[0]).toMatchObject({
          kind: "CONTAINER_PACKAGE",
          catalogCode: "ROUND_EMPTY",
          includedGripo: "TWIST_TYPE",
          displayLabel: "Empty Round Container · Twist-Type gripo",
        });

        // New container package checkout without includedGripo is rejected by Express validation
        const missingGripoPrepare = await request(upgradeApp)
          .post("/api/pos/checkouts")
          .set("Cookie", cashierAfter.cookie)
          .set("X-CSRF-Token", cashierAfter.csrfToken)
          .send({
            items: [{ kind: "CONTAINER_PACKAGE", packageCode: "ROUND_EMPTY", quantity: 1 }],
          });
        expect(missingGripoPrepare.status).toBe(400);
        expect(missingGripoPrepare.body.error.code).toBe("VALIDATION_FAILED");
      } finally {
        await upgradeDb.close();
      }

      // Path B: Database that already applied the revised 0009 upgrades cleanly through 0010 and 0011 too
      const revisedDb = await createPgliteDatabase();
      try {
        await revisedDb.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          );
        `);
        const pre0010Files = (await readdir(MIGRATIONS_DIR))
          .filter((f) => /^000[1-9]_.+\.sql$/.test(f))
          .sort();
        for (const file of pre0010Files) {
          const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
          await revisedDb.exec(sql);
          await revisedDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        }
        const applied = await runMigrations(revisedDb);
        expect(applied).toEqual([
          "0010_pos_container_included_gripo.sql",
          "0011_pos_legacy_pending_container_gripo.sql",
          "0012_pos_prior_day_merchandise_settlement.sql",
          "0013_dashboard_final_settings.sql",
          "0014_pos_checkout_resolutions_and_holds.sql",
          "0015_pos_sale_actions.sql",
          "0016_pos_sale_action_stock_effects.sql",
        ]);
      } finally {
        await revisedDb.close();
      }
    });

    it("Finding 6: pre-0010 same-day PAYMENT_PENDING container checkout finishes after 0010/0011 without guessing gripo and unblocks End Day", async () => {
      const upgradeDb = await createPgliteDatabase();
      try {
        await upgradeDb.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          );
        `);
        const pre0009Files = (await readdir(MIGRATIONS_DIR))
          .filter((f) => /^000[1-8]_.+\.sql$/.test(f))
          .sort();
        for (const file of pre0009Files) {
          const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
          await upgradeDb.exec(sql);
          await upgradeDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        }

        const current0009 = await readFile(
          path.join(MIGRATIONS_DIR, "0009_inventory_management_and_containers.sql"),
          "utf8",
        );
        const original0009 = current0009
          .replace(
            /ALTER TABLE pos_sale_items\s+ADD COLUMN included_gripo text[\s\S]*?TWIST_TYPE'\)\);/m,
            "",
          )
          .replace(/\s+AND included_gripo IS NULL/g, "")
          .replace(/\s+AND included_gripo IN \('PUSH_TYPE', 'TWIST_TYPE'\)/g, "");
        await upgradeDb.exec(original0009);
        await upgradeDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          "0009_inventory_management_and_containers.sql",
        ]);

        const clock = new ManualClock("2026-11-22T11:00:00+08:00");
        const upgradeApp = createApp({ db: upgradeDb, clock });
        const upCtx: TestContext = {
          db: upgradeDb,
          clock,
          app: upgradeApp,
          close: () => upgradeDb.close(),
        };
        const upOwner = await activatedAccount(upCtx, "f6owner", "OWNER");
        const upCashier = await activatedAccount(upCtx, "f6cashier", "CASHIER");

        const { rows: userRows } = await upgradeDb.query<{ id: string; username: string }>(
          `SELECT id, username FROM app_users WHERE username IN ('f6owner', 'f6cashier')`,
        );
        const ownerId = userRows.find((r) => r.username === "f6owner")!.id;
        const cashierId = userRows.find((r) => r.username === "f6cashier")!.id;

        const { rows: roundRows } = await upgradeDb.query<{ id: string }>(
          `UPDATE inventory_items
              SET show_in_pos = true,
                  pos_section = 'CONTAINERS',
                  current_quantity = 5,
                  stock_revision = 1
            WHERE category = 'CONTAINER' AND container_shape = 'ROUND'
            RETURNING id`,
        );
        const roundId = roundRows[0]!.id;
        await upgradeDb.query(
          `INSERT INTO inventory_opening_counts (item_id, quantity, unit, recorded_by_user_id, recorded_at)
           VALUES ($1, 5, 'containers', $2, '2026-11-22T09:00:00+08:00')`,
          [roundId, ownerId],
        );

        const { rows: dayRows } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_business_days (business_date, started_by_user_id, started_at, next_reference_seq)
           VALUES ('2026-11-22', $1, '2026-11-22T09:00:00+08:00', 1)
           RETURNING id`,
          [ownerId],
        );
        const dayId = dayRows[0]!.id;

        // Seed an already-started same-day PAYMENT_PENDING container checkout from pre-0010 (no includedGripo in quote_snapshot)
        const pendingRef = "HD-1122-001";
        const legacyQuoteSnapshot = [
          {
            lineIndex: 0,
            kind: "CONTAINER_PACKAGE",
            catalogCode: "ROUND_EMPTY",
            waterType: null,
            productId: roundId,
            stockUnit: "containers",
            posSection: "CONTAINERS",
            displayLabel: "Empty Round Container",
            unitVolumeMl: 0,
            unitVolumeLiters: 0,
            unitPriceCentavos: 17500,
            quantity: 1,
            lineTotalCentavos: 17500,
            lineVolumeMl: 0,
            lineVolumeLiters: 0,
          },
        ];
        const { rows: pendingRows } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_checkouts (
             reference, business_day_id, business_date, created_by_user_id,
             status, quote_hash, quote_snapshot, total_centavos, total_containers, total_volume_ml,
             payment_started_at, created_at, updated_at
           )
           VALUES ($1, $2, '2026-11-22', $3, 'PAYMENT_PENDING', 'legacy-pre-0010-hash', $4::jsonb, 17500, 0, 0,
                   '2026-11-22T10:55:00+08:00', '2026-11-22T10:54:00+08:00', '2026-11-22T10:55:00+08:00')
           RETURNING id`,
          [pendingRef, dayId, cashierId, JSON.stringify(legacyQuoteSnapshot)],
        );
        await upgradeDb.query(
          `INSERT INTO pos_checkout_stock_commitments (checkout_id, item_id, quantity, status, created_at)
           VALUES ($1, $2, 1, 'ACTIVE', '2026-11-22T10:55:00+08:00')`,
          [pendingRows[0]!.id, roundId],
        );

        // Upgrade via 0010 + 0011
        const applied = await runMigrations(upgradeDb);
        expect(applied).toEqual([
          "0010_pos_container_included_gripo.sql",
          "0011_pos_legacy_pending_container_gripo.sql",
          "0012_pos_prior_day_merchandise_settlement.sql",
          "0013_dashboard_final_settings.sql",
          "0014_pos_checkout_resolutions_and_holds.sql",
          "0015_pos_sale_actions.sql",
          "0016_pos_sale_action_stock_effects.sql",
        ]);

        const cashier = await signIn(upgradeApp, "f6cashier", upCashier.password);
        const owner = await signIn(upgradeApp, "f6owner", upOwner.password);

        // Confirm the legacy PAYMENT_PENDING checkout (sending legacy payload without includedGripo)
        const confirmRes = await request(upgradeApp)
          .post(`/api/pos/checkouts/${pendingRef}/confirm`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({
            cashReceivedCentavos: 20000,
            items: [{ kind: "CONTAINER_PACKAGE", packageCode: "ROUND_EMPTY", quantity: 1 }],
            expectedTotalCentavos: 17500,
          });
        expect(confirmRes.status).toBe(201);
        expect(confirmRes.body.sale.items[0]).toMatchObject({
          kind: "CONTAINER_PACKAGE",
          catalogCode: "ROUND_EMPTY",
          includedGripo: null,
          displayLabel: "Empty Round Container",
        });

        // Duplicate confirm replays idempotently without double-deducting stock
        const replayRes = await request(upgradeApp)
          .post(`/api/pos/checkouts/${pendingRef}/confirm`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({
            cashReceivedCentavos: 20000,
            items: [{ kind: "CONTAINER_PACKAGE", packageCode: "ROUND_EMPTY", quantity: 1 }],
            expectedTotalCentavos: 17500,
          });
        expect(replayRes.status).toBe(200);
        expect(replayRes.body.replayed).toBe(true);

        // Stock was deducted exactly once (5 -> 4) and commitment was consumed
        const { rows: stockRows } = await upgradeDb.query<{ current_quantity: number }>(
          `SELECT current_quantity FROM inventory_items WHERE id = $1`,
          [roundId],
        );
        expect(Number(stockRows[0]!.current_quantity)).toBe(4);
        const { rows: commitRows } = await upgradeDb.query<{ status: string }>(
          `SELECT status FROM pos_checkout_stock_commitments WHERE checkout_id = $1`,
          [pendingRows[0]!.id],
        );
        expect(commitRows[0]!.status).toBe("CONSUMED");

        // New container sale still requires includedGripo and saves it when provided
        const newMissingRes = await request(upgradeApp)
          .post("/api/pos/checkouts")
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({
            items: [{ kind: "CONTAINER_PACKAGE", packageCode: "ROUND_EMPTY", quantity: 1 }],
          });
        expect(newMissingRes.status).toBe(400);
        expect(newMissingRes.body.error.code).toBe("VALIDATION_FAILED");

        const newValidRes = await request(upgradeApp)
          .post("/api/pos/checkouts")
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({
            items: [
              {
                kind: "CONTAINER_PACKAGE",
                packageCode: "ROUND_EMPTY",
                includedGripo: "PUSH_TYPE",
                quantity: 1,
              },
            ],
          });
        expect(newValidRes.status).toBe(201);
        const newConfirmRes = await request(upgradeApp)
          .post(`/api/pos/checkouts/${newValidRes.body.checkout.reference}/confirm`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({ cashReceivedCentavos: 20000 });
        expect(newConfirmRes.status).toBe(201);
        expect(newConfirmRes.body.sale.items[0].includedGripo).toBe("PUSH_TYPE");

        // End Day succeeds cleanly once the legacy PAYMENT_PENDING checkout is resolved
        const endDayRes = await request(upgradeApp)
          .post("/api/pos/day/end")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({});
        expect(endDayRes.status).toBe(200);
        expect(endDayRes.body.state).toBe("CLOSED");
      } finally {
        await upgradeDb.close();
      }
    });

    it("Finding 7: blocks pre-0010 unpaid DRAFT container checkouts missing gripo while preserving PAYMENT_PENDING recovery", async () => {
      const upgradeDb = await createPgliteDatabase();
      try {
        await upgradeDb.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          );
        `);
        const pre0009Files = (await readdir(MIGRATIONS_DIR))
          .filter((f) => /^000[1-8]_.+\.sql$/.test(f))
          .sort();
        for (const file of pre0009Files) {
          const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
          await upgradeDb.exec(sql);
          await upgradeDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        }

        const current0009 = await readFile(
          path.join(MIGRATIONS_DIR, "0009_inventory_management_and_containers.sql"),
          "utf8",
        );
        const original0009 = current0009
          .replace(
            /ALTER TABLE pos_sale_items\s+ADD COLUMN included_gripo text[\s\S]*?TWIST_TYPE'\)\);/m,
            "",
          )
          .replace(/\s+AND included_gripo IS NULL/g, "")
          .replace(/\s+AND included_gripo IN \('PUSH_TYPE', 'TWIST_TYPE'\)/g, "");
        await upgradeDb.exec(original0009);
        await upgradeDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          "0009_inventory_management_and_containers.sql",
        ]);

        const clock = new ManualClock("2026-11-22T11:30:00+08:00");
        const upgradeApp = createApp({ db: upgradeDb, clock });
        const upCtx: TestContext = {
          db: upgradeDb,
          clock,
          app: upgradeApp,
          close: () => upgradeDb.close(),
        };
        const upOwner = await activatedAccount(upCtx, "f7owner", "OWNER");
        const upCashier = await activatedAccount(upCtx, "f7cashier", "CASHIER");

        const { rows: userRows } = await upgradeDb.query<{ id: string; username: string }>(
          `SELECT id, username FROM app_users WHERE username IN ('f7owner', 'f7cashier')`,
        );
        const ownerId = userRows.find((r) => r.username === "f7owner")!.id;
        const cashierId = userRows.find((r) => r.username === "f7cashier")!.id;

        const { rows: roundRows } = await upgradeDb.query<{ id: string }>(
          `UPDATE inventory_items
              SET show_in_pos = true,
                  pos_section = 'CONTAINERS',
                  current_quantity = 5,
                  stock_revision = 1
            WHERE category = 'CONTAINER' AND container_shape = 'ROUND'
            RETURNING id`,
        );
        const roundId = roundRows[0]!.id;
        await upgradeDb.query(
          `INSERT INTO inventory_opening_counts (item_id, quantity, unit, recorded_by_user_id, recorded_at)
           VALUES ($1, 5, 'containers', $2, '2026-11-22T09:00:00+08:00')`,
          [roundId, ownerId],
        );

        const { rows: dayRows } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_business_days (business_date, started_by_user_id, started_at, next_reference_seq)
           VALUES ('2026-11-22', $1, '2026-11-22T09:00:00+08:00', 3)
           RETURNING id`,
          [ownerId],
        );
        const dayId = dayRows[0]!.id;

        const legacyQuoteSnapshot = [
          {
            lineIndex: 0,
            kind: "CONTAINER_PACKAGE",
            catalogCode: "ROUND_EMPTY",
            waterType: null,
            productId: roundId,
            stockUnit: "containers",
            posSection: "CONTAINERS",
            displayLabel: "Empty Round Container",
            unitVolumeMl: 0,
            unitVolumeLiters: 0,
            unitPriceCentavos: 17500,
            quantity: 1,
            lineTotalCentavos: 17500,
            lineVolumeMl: 0,
            lineVolumeLiters: 0,
          },
        ];
        const snapshotJson = JSON.stringify(legacyQuoteSnapshot);

        // Two legacy unpaid DRAFT checkouts (no includedGripo) and one legacy PAYMENT_PENDING checkout
        const draftBeginRef = "HD-1122-001";
        const draftDirectConfirmRef = "HD-1122-002";
        const pendingRef = "HD-1122-003";

        const { rows: d1Rows } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_checkouts (
             reference, business_day_id, business_date, created_by_user_id,
             status, quote_hash, quote_snapshot, total_centavos, total_containers, total_volume_ml,
             created_at, updated_at
           )
           VALUES ($1, $2, '2026-11-22', $3, 'DRAFT', 'legacy-draft-1', $4::jsonb, 17500, 0, 0,
                   '2026-11-22T11:10:00+08:00', '2026-11-22T11:10:00+08:00')
           RETURNING id`,
          [draftBeginRef, dayId, cashierId, snapshotJson],
        );
        const { rows: d2Rows } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_checkouts (
             reference, business_day_id, business_date, created_by_user_id,
             status, quote_hash, quote_snapshot, total_centavos, total_containers, total_volume_ml,
             created_at, updated_at
           )
           VALUES ($1, $2, '2026-11-22', $3, 'DRAFT', 'legacy-draft-2', $4::jsonb, 17500, 0, 0,
                   '2026-11-22T11:12:00+08:00', '2026-11-22T11:12:00+08:00')
           RETURNING id`,
          [draftDirectConfirmRef, dayId, cashierId, snapshotJson],
        );
        const { rows: pendingRows } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_checkouts (
             reference, business_day_id, business_date, created_by_user_id,
             status, quote_hash, quote_snapshot, total_centavos, total_containers, total_volume_ml,
             payment_started_at, created_at, updated_at
           )
           VALUES ($1, $2, '2026-11-22', $3, 'PAYMENT_PENDING', 'legacy-pending-3', $4::jsonb, 17500, 0, 0,
                   '2026-11-22T11:15:00+08:00', '2026-11-22T11:14:00+08:00', '2026-11-22T11:15:00+08:00')
           RETURNING id`,
          [pendingRef, dayId, cashierId, snapshotJson],
        );
        await upgradeDb.query(
          `INSERT INTO pos_checkout_stock_commitments (checkout_id, item_id, quantity, status, created_at)
           VALUES ($1, $2, 1, 'ACTIVE', '2026-11-22T11:15:00+08:00')`,
          [pendingRows[0]!.id, roundId],
        );

        const applied = await runMigrations(upgradeDb);
        expect(applied).toEqual([
          "0010_pos_container_included_gripo.sql",
          "0011_pos_legacy_pending_container_gripo.sql",
          "0012_pos_prior_day_merchandise_settlement.sql",
          "0013_dashboard_final_settings.sql",
          "0014_pos_checkout_resolutions_and_holds.sql",
          "0015_pos_sale_actions.sql",
          "0016_pos_sale_action_stock_effects.sql",
        ]);

        const cashier = await signIn(upgradeApp, "f7cashier", upCashier.password);
        const owner = await signIn(upgradeApp, "f7owner", upOwner.password);

        // 1. Legacy DRAFT cannot start cash payment without a faucet choice
        const beginRes = await request(upgradeApp)
          .post(`/api/pos/checkouts/${draftBeginRef}/begin-payment`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({});
        expect(beginRes.status).toBe(409);
        expect(beginRes.body.error.code).toBe("GRIPO_CHOICE_REQUIRED");

        const { rows: d1Commit } = await upgradeDb.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pos_checkout_stock_commitments WHERE checkout_id = $1`,
          [d1Rows[0]!.id],
        );
        expect(d1Commit[0]!.count).toBe("0");

        // 2. Legacy DRAFT cannot confirm directly either (with or without items)
        const directConfirmNoItems = await request(upgradeApp)
          .post(`/api/pos/checkouts/${draftDirectConfirmRef}/confirm`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({ cashReceivedCentavos: 20000 });
        expect(directConfirmNoItems.status).toBe(409);
        expect(directConfirmNoItems.body.error.code).toBe("GRIPO_CHOICE_REQUIRED");

        const directConfirmWithItems = await request(upgradeApp)
          .post(`/api/pos/checkouts/${draftDirectConfirmRef}/confirm`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({
            cashReceivedCentavos: 20000,
            items: [{ kind: "CONTAINER_PACKAGE", packageCode: "ROUND_EMPTY", quantity: 1 }],
            expectedTotalCentavos: 17500,
          });
        expect(directConfirmWithItems.status).toBe(409);
        expect(directConfirmWithItems.body.error.code).toBe("GRIPO_CHOICE_REQUIRED");

        const { rows: d2Sales } = await upgradeDb.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pos_sales WHERE checkout_id = $1`,
          [d2Rows[0]!.id],
        );
        expect(d2Sales[0]!.count).toBe("0");

        // 3. Staff can cancel both unpaid drafts, then prepare & confirm a replacement with TWIST_TYPE
        for (const ref of [draftBeginRef, draftDirectConfirmRef]) {
          const cancelRes = await request(upgradeApp)
            .post(`/api/pos/checkouts/${ref}/cancel`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({ reason: "Returned to refill selection" });
          expect(cancelRes.status).toBe(200);
          expect(cancelRes.body.checkout.status).toBe("CANCELLED_DRAFT");
        }

        const freshPrep = await request(upgradeApp)
          .post("/api/pos/checkouts")
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({
            items: [
              {
                kind: "CONTAINER_PACKAGE",
                packageCode: "ROUND_EMPTY",
                includedGripo: "TWIST_TYPE",
                quantity: 1,
              },
            ],
          });
        expect(freshPrep.status).toBe(201);
        const freshConfirm = await request(upgradeApp)
          .post(`/api/pos/checkouts/${freshPrep.body.checkout.reference}/confirm`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({ cashReceivedCentavos: 20000 });
        expect(freshConfirm.status).toBe(201);
        expect(freshConfirm.body.sale.items[0].includedGripo).toBe("TWIST_TYPE");

        // 4. Finding 6 preserved: already-started PAYMENT_PENDING checkout still confirms with null gripo
        const pendingConfirm = await request(upgradeApp)
          .post(`/api/pos/checkouts/${pendingRef}/confirm`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({
            cashReceivedCentavos: 20000,
            items: [{ kind: "CONTAINER_PACKAGE", packageCode: "ROUND_EMPTY", quantity: 1 }],
            expectedTotalCentavos: 17500,
          });
        expect(pendingConfirm.status).toBe(201);
        expect(pendingConfirm.body.sale.items[0].includedGripo).toBeNull();

        const pendingReplay = await request(upgradeApp)
          .post(`/api/pos/checkouts/${pendingRef}/confirm`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({ cashReceivedCentavos: 20000 });
        expect(pendingReplay.status).toBe(200);
        expect(pendingReplay.body.replayed).toBe(true);

        // Stock deducted twice total: 1 for fresh TWIST_TYPE sale + 1 for pendingRef recovery = 5 -> 3
        const { rows: stockRows } = await upgradeDb.query<{ current_quantity: number }>(
          `SELECT current_quantity FROM inventory_items WHERE id = $1`,
          [roundId],
        );
        expect(Number(stockRows[0]!.current_quantity)).toBe(3);

        // End Day closes cleanly
        const endDayRes = await request(upgradeApp)
          .post("/api/pos/day/end")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({});
        expect(endDayRes.status).toBe(200);
        expect(endDayRes.body.state).toBe("CLOSED");
      } finally {
        await upgradeDb.close();
      }
    });

    it("Finding 7 date boundary: confirm after midnight checks unpaid DRAFT missing gripo before date rules, records no cash/stock change, and lets End Day clear it", async () => {
      const upgradeDb = await createPgliteDatabase();
      try {
        await upgradeDb.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          );
        `);
        const pre0009Files = (await readdir(MIGRATIONS_DIR))
          .filter((f) => /^000[1-8]_.+\.sql$/.test(f))
          .sort();
        for (const file of pre0009Files) {
          const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
          await upgradeDb.exec(sql);
          await upgradeDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        }

        const current0009 = await readFile(
          path.join(MIGRATIONS_DIR, "0009_inventory_management_and_containers.sql"),
          "utf8",
        );
        const original0009 = current0009
          .replace(
            /ALTER TABLE pos_sale_items\s+ADD COLUMN included_gripo text[\s\S]*?TWIST_TYPE'\)\);/m,
            "",
          )
          .replace(/\s+AND included_gripo IS NULL/g, "")
          .replace(/\s+AND included_gripo IN \('PUSH_TYPE', 'TWIST_TYPE'\)/g, "");
        await upgradeDb.exec(original0009);
        await upgradeDb.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          "0009_inventory_management_and_containers.sql",
        ]);

        const clock = new ManualClock("2026-11-22T23:45:00+08:00");
        const upgradeApp = createApp({ db: upgradeDb, clock });
        const upCtx: TestContext = {
          db: upgradeDb,
          clock,
          app: upgradeApp,
          close: () => upgradeDb.close(),
        };
        const upOwner = await activatedAccount(upCtx, "f7bowner", "OWNER");
        const upCashier = await activatedAccount(upCtx, "f7bcashier", "CASHIER");

        const { rows: userRows } = await upgradeDb.query<{ id: string; username: string }>(
          `SELECT id, username FROM app_users WHERE username IN ('f7bowner', 'f7bcashier')`,
        );
        const ownerId = userRows.find((r) => r.username === "f7bowner")!.id;
        const cashierId = userRows.find((r) => r.username === "f7bcashier")!.id;

        const { rows: roundRows } = await upgradeDb.query<{ id: string }>(
          `UPDATE inventory_items
              SET show_in_pos = true,
                  pos_section = 'CONTAINERS',
                  current_quantity = 5,
                  stock_revision = 1
            WHERE category = 'CONTAINER' AND container_shape = 'ROUND'
            RETURNING id`,
        );
        const roundId = roundRows[0]!.id;
        await upgradeDb.query(
          `INSERT INTO inventory_opening_counts (item_id, quantity, unit, recorded_by_user_id, recorded_at)
           VALUES ($1, 5, 'containers', $2, '2026-11-22T09:00:00+08:00')`,
          [roundId, ownerId],
        );

        const { rows: dayRows } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_business_days (business_date, started_by_user_id, started_at, next_reference_seq)
           VALUES ('2026-11-22', $1, '2026-11-22T09:00:00+08:00', 1)
           RETURNING id`,
          [ownerId],
        );
        const dayId = dayRows[0]!.id;

        const draftRef = "HD-1122-001";
        const legacyQuoteSnapshot = [
          {
            lineIndex: 0,
            kind: "CONTAINER_PACKAGE",
            catalogCode: "ROUND_EMPTY",
            waterType: null,
            productId: roundId,
            stockUnit: "containers",
            posSection: "CONTAINERS",
            displayLabel: "Empty Round Container",
            unitVolumeMl: 0,
            unitVolumeLiters: 0,
            unitPriceCentavos: 17500,
            quantity: 1,
            lineTotalCentavos: 17500,
            lineVolumeMl: 0,
            lineVolumeLiters: 0,
          },
        ];
        const { rows: draftRows } = await upgradeDb.query<{ id: string }>(
          `INSERT INTO pos_checkouts (
             reference, business_day_id, business_date, created_by_user_id,
             status, quote_hash, quote_snapshot, total_centavos, total_containers, total_volume_ml,
             created_at, updated_at
           )
           VALUES ($1, $2, '2026-11-22', $3, 'DRAFT', 'legacy-midnight-draft', $4::jsonb, 17500, 0, 0,
                   '2026-11-22T23:40:00+08:00', '2026-11-22T23:40:00+08:00')
           RETURNING id`,
          [draftRef, dayId, cashierId, JSON.stringify(legacyQuoteSnapshot)],
        );

        const applied = await runMigrations(upgradeDb);
        expect(applied).toEqual([
          "0010_pos_container_included_gripo.sql",
          "0011_pos_legacy_pending_container_gripo.sql",
          "0012_pos_prior_day_merchandise_settlement.sql",
          "0013_dashboard_final_settings.sql",
          "0014_pos_checkout_resolutions_and_holds.sql",
          "0015_pos_sale_actions.sql",
          "0016_pos_sale_action_stock_effects.sql",
        ]);

        // Cross Asia/Manila midnight with cash collection never started on draftRef
        clock.set("2026-11-23T00:15:00+08:00");

        const cashier = await signIn(upgradeApp, "f7bcashier", upCashier.password);
        const owner = await signIn(upgradeApp, "f7bowner", upOwner.password);

        const lateDraftConfirm = await request(upgradeApp)
          .post(`/api/pos/checkouts/${draftRef}/confirm`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({ cashReceivedCentavos: 20000 });
        expect(lateDraftConfirm.status).toBe(409);
        expect(lateDraftConfirm.body.error.code).toBe("GRIPO_CHOICE_REQUIRED");

        // Draft remains unpaid with zero cash snapshot and no review-required status change
        const { rows: afterConfirmRows } = await upgradeDb.query<{
          status: string;
          cash_received_centavos: number | null;
          change_centavos: number | null;
          resolution_reason: string | null;
        }>(
          `SELECT status, cash_received_centavos, change_centavos, resolution_reason
             FROM pos_checkouts
            WHERE id = $1`,
          [draftRows[0]!.id],
        );
        expect(afterConfirmRows[0]).toEqual({
          status: "DRAFT",
          cash_received_centavos: null,
          change_centavos: null,
          resolution_reason: null,
        });

        // No sale, commitment, or stock movement recorded
        const { rows: saleCount } = await upgradeDb.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pos_sales`,
        );
        expect(saleCount[0]!.count).toBe("0");
        const { rows: commitCount } = await upgradeDb.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pos_checkout_stock_commitments`,
        );
        expect(commitCount[0]!.count).toBe("0");
        const { rows: moveCount } = await upgradeDb.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM inventory_stock_movements`,
        );
        expect(moveCount[0]!.count).toBe("0");
        const { rows: stockBeforeEnd } = await upgradeDb.query<{ current_quantity: number }>(
          `SELECT current_quantity FROM inventory_items WHERE id = $1`,
          [roundId],
        );
        expect(Number(stockBeforeEnd[0]!.current_quantity)).toBe(5);

        // Owner clears the unpaid draft on End Day and starts 2026-11-23 cleanly
        const endDayRes = await request(upgradeApp)
          .post("/api/pos/day/end")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({
            clearUnpaidDrafts: true,
            expectedBusinessDate: "2026-11-22",
          });
        expect(endDayRes.status).toBe(200);
        expect(endDayRes.body.clearedDraftReferences).toEqual([draftRef]);

        const { rows: clearedRows } = await upgradeDb.query<{ status: string }>(
          `SELECT status FROM pos_checkouts WHERE id = $1`,
          [draftRows[0]!.id],
        );
        expect(clearedRows[0]!.status).toBe("CANCELLED_DRAFT");

        const startNextDayRes = await request(upgradeApp)
          .post("/api/pos/day/start")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({});
        expect(startNextDayRes.status).toBe(201);
        expect(startNextDayRes.body.state).toBe("OPEN");
        expect(startNextDayRes.body.todayDate).toBe("2026-11-23");

        // Finding 8: retrying the same confirm after End Day leaves the cleared unpaid draft cancelled
        const postEndRetry = await request(upgradeApp)
          .post(`/api/pos/checkouts/${draftRef}/confirm`)
          .set("Cookie", cashier.cookie)
          .set("X-CSRF-Token", cashier.csrfToken)
          .send({ cashReceivedCentavos: 20000 });
        expect(postEndRetry.status).toBe(409);
        expect(postEndRetry.body.error.code).toBe("GRIPO_CHOICE_REQUIRED");

        const { rows: postEndCheckoutRows } = await upgradeDb.query<{
          status: string;
          cash_received_centavos: number | null;
          change_centavos: number | null;
          resolution_reason: string | null;
        }>(
          `SELECT status, cash_received_centavos, change_centavos, resolution_reason
             FROM pos_checkouts
            WHERE id = $1`,
          [draftRows[0]!.id],
        );
        expect(postEndCheckoutRows[0]).toEqual({
          status: "CANCELLED_DRAFT",
          cash_received_centavos: null,
          change_centavos: null,
          resolution_reason: "CLEARED_ON_END_DAY",
        });

        const { rows: postEndSaleCount } = await upgradeDb.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pos_sales`,
        );
        expect(postEndSaleCount[0]!.count).toBe("0");
        const { rows: postEndCommitCount } = await upgradeDb.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pos_checkout_stock_commitments`,
        );
        expect(postEndCommitCount[0]!.count).toBe("0");
        const { rows: postEndMoveCount } = await upgradeDb.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM inventory_stock_movements`,
        );
        expect(postEndMoveCount[0]!.count).toBe("0");
        const { rows: stockAfterRetry } = await upgradeDb.query<{ current_quantity: number }>(
          `SELECT current_quantity FROM inventory_items WHERE id = $1`,
          [roundId],
        );
        expect(Number(stockAfterRetry[0]!.current_quantity)).toBe(5);

        const dayAfterRetryRes = await request(upgradeApp)
          .get("/api/pos/day")
          .set("Cookie", owner.cookie);
        expect(dayAfterRetryRes.status).toBe(200);
        expect(dayAfterRetryRes.body.priorDayReviewCheckouts ?? []).toEqual([]);
        expect(dayAfterRetryRes.body.unresolvedCheckouts ?? []).toEqual([]);
      } finally {
        await upgradeDb.close();
      }
    });

    it("DEC-075: Owner settles prior-day paid-and-handed-over merchandise and container packages once, deducts stock once, preserves closed reports, and unblocks End Day then Start Day", async () => {
      const faucetRes = await createProduct({
        name: "Disposable Settlement Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      });
      expect(faucetRes.status).toBe(201);
      const faucetId = faucetRes.body.item.id as string;
      expect((await setOpeningStock(faucetId, 5)).status).toBe(201);

      const pubRound = await request(ctx.app)
        .patch("/api/inventory/containers/ROUND")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ showInPos: true });
      expect(pubRound.status).toBe(200);
      expect((await setOpeningStock("ROUND", 4)).status).toBe(201);

      const startDay1 = await startDay(ctx, owner, { requestKey: "dec075-start-day1" });
      expect(startDay1.status).toBe(201);
      const day1Date = startDay1.body.todayDate as string;

      // Saved prior-day merchandise sale (stock 5 -> 4); must stay ALREADY_SAVED if settle is hit
      const savedPrep = await prepareCheckout(ctx, cashier, {
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      expect(savedPrep.status).toBe(201);
      const savedRef = savedPrep.body.checkout.reference as string;
      const savedConfirm = await confirmCheckout(ctx.app, cashier, savedRef, {
        cashReceivedCentavos: 5000,
      });
      expect(savedConfirm.status).toBe(201);

      // Start cash collection (PAYMENT_PENDING) on standalone faucet & TWIST_TYPE container package
      const merchPrep = await prepareCheckout(ctx, cashier, {
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
      });
      expect(merchPrep.status).toBe(201);
      const merchRef = merchPrep.body.checkout.reference as string;
      const merchBegin = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(merchRef)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(merchBegin.status).toBe(200);

      const pkgPrep = await prepareCheckout(ctx, cashier, {
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "TWIST_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(pkgPrep.status).toBe(201);
      const pkgRef = pkgPrep.body.checkout.reference as string;
      const pkgBegin = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(pkgRef)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(pkgBegin.status).toBe(200);

      // Advance past Manila midnight
      ctx.clock.advance(24 * 60 * 60_000);
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      const dayAfterMidnight = await request(ctx.app)
        .get("/api/pos/day")
        .set("Cookie", owner.cookie);
      expect(dayAfterMidnight.status).toBe(200);
      expect(dayAfterMidnight.body.state).toBe("PREVIOUS_DAY_OPEN");
      const day2Date = dayAfterMidnight.body.todayDate as string;
      expect(day2Date > day1Date).toBe(true);

      // End Day is blocked until unresolved prior-day checkouts are settled
      const blockedEnd = await endDay(ctx, owner, { requestKey: "dec075-blocked-end" });
      expect(blockedEnd.status).toBe(409);
      expect(blockedEnd.body.error.code).toBe("UNRESOLVED_CHECKOUTS");

      // Cashier is forbidden from settling; Owner missing handover confirmation gets 400
      const cashierAttempt = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(merchRef)}/settle`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({ paymentKeptConfirmed: true, itemsHandedOverConfirmed: true });
      expect(cashierAttempt.status).toBe(403);

      const incompleteAttempt = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(merchRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, itemsHandedOverConfirmed: false });
      expect(incompleteAttempt.status).toBe(400);
      expect(incompleteAttempt.body.error.code).toBe("VALIDATION_FAILED");

      // Finding 9: refillDeliveredConfirmed cannot substitute for itemsHandedOverConfirmed on merchandise checkouts,
      // and missing handover flag also rejects without mutating checkout cash, settlement rows, stock, or reservations.
      const wrongFlagMerch = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(merchRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          paymentKeptConfirmed: true,
          refillDeliveredConfirmed: true,
          cashReceivedCentavos: 5000,
        });
      expect(wrongFlagMerch.status).toBe(400);
      expect(wrongFlagMerch.body.error.code).toBe("VALIDATION_FAILED");

      const omittedHandoverMerch = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(merchRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true });
      expect(omittedHandoverMerch.status).toBe(400);
      expect(omittedHandoverMerch.body.error.code).toBe("VALIDATION_FAILED");

      const { rows: unmutatedCheckout } = await ctx.db.query<{
        status: string;
        cash_received_centavos: number | null;
        change_centavos: number | null;
      }>(
        `SELECT status, cash_received_centavos, change_centavos
           FROM pos_checkouts
          WHERE reference = $1`,
        [merchRef],
      );
      expect(unmutatedCheckout[0]).toEqual({
        status: "PAYMENT_PENDING",
        cash_received_centavos: null,
        change_centavos: null,
      });

      const { rows: zeroSettlements } = await ctx.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pos_prior_day_settlements WHERE checkout_reference = $1`,
        [merchRef],
      );
      expect(zeroSettlements[0]!.count).toBe("0");

      const { rows: untouchedStock } = await ctx.db.query<{ current_quantity: number }>(
        `SELECT current_quantity FROM inventory_items WHERE id = $1`,
        [faucetId],
      );
      expect(Number(untouchedStock[0]!.current_quantity)).toBe(4);

      const { rows: zeroSettleMovements } = await ctx.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM inventory_stock_movements
          WHERE item_id = $1 AND movement_type = 'PRIOR_DAY_SETTLEMENT'`,
        [faucetId],
      );
      expect(zeroSettleMovements[0]!.count).toBe("0");

      const { rows: stillActiveCommit } = await ctx.db.query<{ status: string }>(
        `SELECT c.status
           FROM pos_checkout_stock_commitments c
           JOIN pos_checkouts pc ON pc.id = c.checkout_id
          WHERE pc.reference = $1`,
        [merchRef],
      );
      expect(stillActiveCommit[0]!.status).toBe("ACTIVE");

      // Lookup confirms Owner eligibility for prior-day merchandise checkout
      const merchLookup = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(merchRef)}`)
        .set("Cookie", owner.cookie);
      expect(merchLookup.status).toBe(200);
      expect(merchLookup.body.canSettlePriorDay).toBe(true);

      // Owner settles standalone faucet checkout once
      const settleMerch = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(merchRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          paymentKeptConfirmed: true,
          itemsHandedOverConfirmed: true,
          cashReceivedCentavos: 5000,
          note: "Cash kept and faucet handed over",
        });
      expect(settleMerch.status).toBe(201);
      expect(settleMerch.body).toMatchObject({
        outcome: "SETTLED",
        replayed: false,
        settlement: {
          checkoutReference: merchRef,
          originalBusinessDate: day1Date,
          settlementDate: day2Date,
          netAmountKeptCentavos: 4000,
          cashReceivedCentavos: 5000,
          changeCentavos: 1000,
          totalContainers: 0,
          totalVolumeLiters: 0,
          note: "Cash kept and faucet handed over",
        },
        checkout: {
          reference: merchRef,
          status: "SETTLED_PRIOR_DAY",
        },
      });

      // Retry settle -> idempotent replay (200) without duplicate stock deduction
      const replayMerch = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(merchRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          paymentKeptConfirmed: true,
          itemsHandedOverConfirmed: true,
          cashReceivedCentavos: 5000,
        });
      expect(replayMerch.status).toBe(200);
      expect(replayMerch.body.outcome).toBe("SETTLED");
      expect(replayMerch.body.replayed).toBe(true);

      // Already-saved sale remains protected if settle is called on it
      const settleSaved = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(savedRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, itemsHandedOverConfirmed: true });
      expect(settleSaved.status).toBe(200);
      expect(settleSaved.body.outcome).toBe("ALREADY_SAVED");
      expect(settleSaved.body.settlement).toBeNull();

      // Faucet stock is 5 - 1 (saved) - 1 (settled) = 3, with one PRIOR_DAY_SETTLEMENT movement and CONSUMED commitment
      const { rows: faucetStockRows } = await ctx.db.query<{ current_quantity: number }>(
        `SELECT current_quantity FROM inventory_items WHERE id = $1`,
        [faucetId],
      );
      expect(Number(faucetStockRows[0]!.current_quantity)).toBe(3);

      const { rows: faucetMovements } = await ctx.db.query<{
        movement_type: string;
        quantity_delta: number;
        pos_reference: string;
      }>(
        `SELECT movement_type, quantity_delta, pos_reference
           FROM inventory_stock_movements
          WHERE item_id = $1
          ORDER BY recorded_at ASC`,
        [faucetId],
      );
      expect(faucetMovements).toEqual([
        { movement_type: "POS_SALE", quantity_delta: -1, pos_reference: savedRef },
        { movement_type: "PRIOR_DAY_SETTLEMENT", quantity_delta: -1, pos_reference: merchRef },
      ]);

      const { rows: merchCommit } = await ctx.db.query<{ status: string }>(
        `SELECT c.status
           FROM pos_checkout_stock_commitments c
           JOIN pos_checkouts pc ON pc.id = c.checkout_id
          WHERE pc.reference = $1`,
        [merchRef],
      );
      expect(merchCommit[0]!.status).toBe("CONSUMED");

      // Owner settles container package checkout (ROUND_PURIFIED + TWIST_TYPE) and preserves package details
      const settlePkg = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(pkgRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          paymentKeptConfirmed: true,
          itemsHandedOverConfirmed: true,
          note: "Twist container handed over",
        });
      expect(settlePkg.status).toBe(201);
      expect(settlePkg.body.settlement).toMatchObject({
        checkoutReference: pkgRef,
        originalBusinessDate: day1Date,
        settlementDate: day2Date,
        totalContainers: 0,
        totalVolumeLiters: 25,
      });
      expect(settlePkg.body.settlement.items[0]).toMatchObject({
        kind: "CONTAINER_PACKAGE",
        catalogCode: "ROUND_PURIFIED",
        includedGripo: "TWIST_TYPE",
        displayLabel: "Round Container (Purified · 25 L) · Twist-Type gripo",
      });

      const { rows: roundStockRows } = await ctx.db.query<{ current_quantity: number }>(
        `SELECT current_quantity FROM inventory_items WHERE category = 'CONTAINER' AND container_shape = 'ROUND'`,
      );
      expect(Number(roundStockRows[0]!.current_quantity)).toBe(3);

      // Owner can now close yesterday (summary keeps only saved sales, excluding prior-day settlements) and open today
      const closeDay1 = await endDay(ctx, owner, { requestKey: "dec075-close-day1" });
      expect(closeDay1.status).toBe(200);
      expect(closeDay1.body.state).toBe("CLOSED");
      expect(closeDay1.body.summary).toMatchObject({
        businessDate: day1Date,
        totalSalesCentavos: 4000,
        validTransactionCount: 1,
      });

      const startDay2 = await startDay(ctx, owner, { requestKey: "dec075-start-day2" });
      expect(startDay2.status).toBe(201);
      expect(startDay2.body.state).toBe("OPEN");
      expect(startDay2.body.todayDate).toBe(day2Date);

      // History separates prior-day settlements onto settlementDate without altering closed day1 sales
      const day2History = await request(ctx.app)
        .get(`/api/pos/sales?date=${day2Date}`)
        .set("Cookie", owner.cookie);
      expect(day2History.status).toBe(200);
      expect(day2History.body.sales).toEqual([]);
      expect(
        day2History.body.priorDaySettlements.map((s: { checkoutReference: string }) => s.checkoutReference),
      ).toEqual([pkgRef, merchRef]);

      const day1History = await request(ctx.app)
        .get(`/api/pos/sales?date=${day1Date}`)
        .set("Cookie", owner.cookie);
      expect(day1History.status).toBe(200);
      expect(day1History.body.sales.map((s: { reference: string }) => s.reference)).toEqual([savedRef]);
      expect(day1History.body.priorDaySettlements).toEqual([]);
    });
  });

  describe("DEC-085 fresh-browser and session takeover recovery", () => {
    it("lets the same account check committed, server-pending, and other-account checkouts after device takeover without mutating checkouts or stock", async () => {
      const faucetRes = await request(ctx.app)
        .post("/api/inventory/products")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          name: "Takeover Faucet",
          unit: "pcs",
          unitConfirmed: true,
          unitPriceCentavos: 4000,
          showInPos: true,
          posSection: "CHANGE_OF_GRIPO",
        });
      expect(faucetRes.status).toBe(201);
      const faucetId = faucetRes.body.item.id as string;

      const openStock = await request(ctx.app)
        .post(`/api/inventory/items/${encodeURIComponent(faucetId)}/opening-stock`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ quantity: 5 });
      expect(openStock.status).toBe(201);

      expect((await startDay(ctx, owner, { requestKey: "dec085-start" })).status).toBe(201);

      // 1) Sale committed on Device A (cashier1), confirmation response lost -> Device B takes over session.
      const savedPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "dec085-saved-prep",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const savedRef = savedPrep.body.checkout.reference as string;
      const savedConfirm = await confirmCheckout(ctx.app, cashier, savedRef, {
        cashReceivedCentavos: 10000,
      });
      expect(savedConfirm.status).toBe(201);

      // 2) Server-known PAYMENT_PENDING checkout on Device A (cashier1) with reserved merchandise stock and no cash sent to server.
      const pendingPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "dec085-pending-prep",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 2 }],
      });
      const pendingRef = pendingPrep.body.checkout.reference as string;
      const beginPending = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/begin-payment`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({});
      expect(beginPending.status).toBe(200);

      // 3) Separate unpaid DRAFT on Device A (cashier1) — must remain in unpaidDrafts, not unresolvedCheckouts.
      const draftPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "dec085-draft-prep",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      });
      const draftRef = draftPrep.body.checkout.reference as string;

      // 4) Owner also has a PAYMENT_PENDING checkout for cross-account authorization checks.
      const ownerPrep = await prepareCheckout(ctx, owner, {
        prepareKey: "dec085-owner-prep",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      const ownerPendingRef = ownerPrep.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(ownerPendingRef)}/begin-payment`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Device B signs in as cashier1 (taking over cashier1's session; owner remains signed in).
      const cashierDeviceB = await reauth(ctx, "cashier1", cashier);
      expect((await request(ctx.app).get("/api/pos/day").set("Cookie", cashier.cookie)).status).toBe(401);
      expect((await request(ctx.app).get("/api/pos/day").set("Cookie", owner.cookie)).status).toBe(200);

      // Fresh Device B /day reports owned pending checkouts separately from unpaid drafts and other-account checkouts.
      const dayB = await request(ctx.app).get("/api/pos/day").set("Cookie", cashierDeviceB.cookie);
      expect(dayB.status).toBe(200);
      expect(dayB.body.unresolvedCheckouts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reference: pendingRef,
            status: "PAYMENT_PENDING",
            ownedByCurrentUser: true,
            cashReceivedCentavos: null,
          }),
          expect.objectContaining({
            reference: ownerPendingRef,
            status: "PAYMENT_PENDING",
            ownedByCurrentUser: false,
            cashReceivedCentavos: null,
          }),
        ]),
      );
      expect(dayB.body.unpaidDrafts.map((d: { reference: string }) => d.reference)).toEqual([draftRef]);

      // Lookup committed sale by original reference on Device B -> SAVED, matching receipt, no mutation.
      const savedLookup = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(savedRef)}`)
        .set("Cookie", cashierDeviceB.cookie);
      expect(savedLookup.status).toBe(200);
      expect(savedLookup.body).toMatchObject({
        recoveryState: "SAVED",
        canRetry: false,
        canCancelUnpaid: false,
        ownedByCurrentUser: true,
      });
      expect(savedLookup.body.sale).toMatchObject({
        reference: savedRef,
        cashReceivedCentavos: 10000,
        changeCentavos: 5000,
      });
      const historyRes = await request(ctx.app)
        .get(`/api/pos/sales?date=${dayB.body.todayDate}`)
        .set("Cookie", cashierDeviceB.cookie);
      expect(historyRes.status).toBe(200);
      expect(historyRes.body.sales.map((s: { reference: string }) => s.reference)).toContain(savedRef);

      // Lookup server-pending checkout on Device B -> SAFE_TO_RETRY, canCancelUnpaid true, cashReceivedCentavos stays null, stock commitment preserved.
      const pendingLookup = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}`)
        .set("Cookie", cashierDeviceB.cookie);
      expect(pendingLookup.status).toBe(200);
      expect(pendingLookup.body).toMatchObject({
        recoveryState: "SAFE_TO_RETRY",
        canRetry: true,
        canCancelUnpaid: true,
        ownedByCurrentUser: true,
      });
      expect(pendingLookup.body.checkout.cashReceivedCentavos).toBeNull();

      const { rows: activeCommits } = await ctx.db.query<{ quantity: number; status: string }>(
        `SELECT c.quantity, c.status
           FROM pos_checkout_stock_commitments c
           JOIN pos_checkouts pc ON pc.id = c.checkout_id
          WHERE pc.reference = $1`,
        [pendingRef],
      );
      expect(activeCommits).toEqual([{ quantity: 2, status: "ACTIVE" }]);

      // Cross-account lookup on Device B: cashier checks owner's pending checkout -> UNRESOLVED / OWNED_BY_OTHER_ACCOUNT.
      const otherLookup = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(ownerPendingRef)}`)
        .set("Cookie", cashierDeviceB.cookie);
      expect(otherLookup.status).toBe(200);
      expect(otherLookup.body).toMatchObject({
        recoveryState: "UNRESOLVED",
        reason: "OWNED_BY_OTHER_ACCOUNT",
        canRetry: false,
        canCancelUnpaid: false,
        canSettlePriorDay: false,
        ownedByCurrentUser: false,
      });

      // Ineligible cancellations fail cleanly: other account (403) and missing no-cash confirmation (409).
      const otherCancel = await cancelCheckout(ctx, cashierDeviceB, ownerPendingRef, {
        confirmNoCashTaken: true,
        reason: "No cash received",
      });
      expect(otherCancel.status).toBe(403);
      const unconfirmedCancel = await cancelCheckout(ctx, cashierDeviceB, pendingRef, {
        confirmNoCashTaken: false,
      });
      expect(unconfirmedCancel.status).toBe(409);

      // Initiating account (cashierDeviceB) explicitly cancels unpaid pendingRef -> releases merchandise reservation.
      const validCancel = await cancelCheckout(ctx, cashierDeviceB, pendingRef, {
        confirmNoCashTaken: true,
        reason: "No cash received",
      });
      expect(validCancel.status).toBe(200);
      expect(validCancel.body.checkout.status).toBe("CANCELLED_DRAFT");

      const { rows: releasedCommits } = await ctx.db.query<{ status: string }>(
        `SELECT c.status
           FROM pos_checkout_stock_commitments c
           JOIN pos_checkouts pc ON pc.id = c.checkout_id
          WHERE pc.reference = $1`,
        [pendingRef],
      );
      expect(releasedCommits).toEqual([{ status: "RELEASED" }]);

      // Owner also cancels ownerPendingRef after fresh-device check -> End Day (clearing unpaid draft) succeeds.
      const ownerLookup = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(ownerPendingRef)}`)
        .set("Cookie", owner.cookie);
      expect(ownerLookup.status).toBe(200);
      expect(ownerLookup.body.canCancelUnpaid).toBe(true);
      expect(
        (
          await cancelCheckout(ctx, owner, ownerPendingRef, {
            confirmNoCashTaken: true,
            reason: "No cash received",
          })
        ).status,
      ).toBe(200);

      const endAfterCancels = await endDay(ctx, owner, {
        requestKey: "dec085-end-after-cancels",
        clearUnpaidDrafts: true,
      });
      expect(endAfterCancels.status).toBe(200);
      expect(endAfterCancels.body.state).toBe("CLOSED");

      // Unknown reference lookup returns 404 without mutating anything.
      const missingLookup = await request(ctx.app)
        .get("/api/pos/checkouts/HD-9999-999")
        .set("Cookie", cashierDeviceB.cookie);
      expect(missingLookup.status).toBe(404);
    });

    it("keeps an in-flight confirmation single-commit across session takeover and reports SAVE_IN_PROGRESS then SAVED on Device B", async () => {
      const faucetRes = await request(ctx.app)
        .post("/api/inventory/products")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          name: "Inflight Takeover Faucet",
          unit: "pcs",
          unitConfirmed: true,
          unitPriceCentavos: 5000,
          showInPos: true,
          posSection: "CHANGE_OF_GRIPO",
        });
      expect(faucetRes.status).toBe(201);
      const faucetId = faucetRes.body.item.id as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/inventory/items/${encodeURIComponent(faucetId)}/opening-stock`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ quantity: 5 })
        ).status,
      ).toBe(201);

      const enteredTx = deferred<void>();
      const releaseTx = deferred<void>();
      let pauseNextConfirmTx = false;

      const wrappedDb: Database = {
        query: (sql, params) => ctx.db.query(sql, params),
        exec: (sql) => ctx.db.exec(sql),
        close: () => ctx.db.close(),
        async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
          if (pauseNextConfirmTx) {
            pauseNextConfirmTx = false;
            enteredTx.resolve();
            await releaseTx.promise;
          }
          return ctx.db.transaction(fn);
        },
      };
      const pausedApp = createApp({ db: wrappedDb, clock: ctx.clock, secureCookies: false });

      expect((await startDay(ctx, owner, { requestKey: "dec085-inflight-day" })).status).toBe(201);
      const prep = await prepareCheckout(ctx, cashier, {
        prepareKey: "dec085-inflight-prep",
        items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 2 }],
      });
      const ref = prep.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Device A starts confirm; pause right before its DB transaction.
      pauseNextConfirmTx = true;
      const confirmPromise = confirmCheckout(pausedApp, cashier, ref, {
        cashReceivedCentavos: 10000,
      });
      await enteredTx.promise;

      // Device B signs in as cashier1 while Device A's confirm is in flight.
      const cashierDeviceB = await signIn(pausedApp, "cashier1", cashier.password);

      // Device B checks status -> SAVE_IN_PROGRESS, canRetry: false.
      const duringLookup = await request(pausedApp)
        .get(`/api/pos/checkouts/${encodeURIComponent(ref)}`)
        .set("Cookie", cashierDeviceB.cookie);
      expect(duringLookup.status).toBe(200);
      expect(duringLookup.body).toMatchObject({
        recoveryState: "UNRESOLVED",
        reason: "SAVE_IN_PROGRESS",
        canRetry: false,
        ownedByCurrentUser: true,
      });

      // Already-accepted transaction completes once; Device B sees SAVED with one sale and one stock deduction.
      releaseTx.resolve();
      const confirmed = await confirmPromise;
      expect(confirmed.status).toBe(201);

      const afterLookup = await request(pausedApp)
        .get(`/api/pos/checkouts/${encodeURIComponent(ref)}`)
        .set("Cookie", cashierDeviceB.cookie);
      expect(afterLookup.status).toBe(200);
      expect(afterLookup.body).toMatchObject({
        recoveryState: "SAVED",
        canRetry: false,
        ownedByCurrentUser: true,
      });

      const { rows: saleCount } = await ctx.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pos_sales WHERE reference = $1`,
        [ref],
      );
      expect(saleCount[0]!.count).toBe("1");

      const { rows: stockRows } = await ctx.db.query<{ current_quantity: number }>(
        `SELECT current_quantity FROM inventory_items WHERE id = $1`,
        [faucetId],
      );
      expect(Number(stockRows[0]!.current_quantity)).toBe(3);

      // Device A's old session is now rejected on next request.
      const oldSessionRes = await request(pausedApp)
        .get("/api/pos/day")
        .set("Cookie", cashier.cookie);
      expect(oldSessionRes.status).toBe(401);
      expect(oldSessionRes.body.error.code).toBe("SESSION_REPLACED");
    });
  });

  describe("faucet reporting type snapshots and legacy quote compatibility (DEC-093)", () => {
    it("snapshots explicit typed and deliberately untyped merchandise choices while confirming legacy quotes and same-reference retries", async () => {
      // Create typed faucet and untyped accessory
      const typedRes = await request(ctx.app)
        .post("/api/inventory/products")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          name: "Push-Type Faucet",
          unit: "pcs",
          unitConfirmed: true,
          unitPriceCentavos: 4000,
          showInPos: true,
          posSection: "CHANGE_OF_GRIPO",
          faucetReportingType: "PUSH_TYPE",
        });
      expect(typedRes.status).toBe(201);
      const typedId = typedRes.body.item.id as string;

      const untypedRes = await request(ctx.app)
        .post("/api/inventory/products")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          name: "Blue Cap",
          unit: "pcs",
          unitConfirmed: true,
          unitPriceCentavos: 1500,
          showInPos: true,
          posSection: "TAKIP_ACCESSORIES",
          faucetReportingType: null,
        });
      expect(untypedRes.status).toBe(201);
      const untypedId = untypedRes.body.item.id as string;

      expect(
        (
          await request(ctx.app)
            .post(`/api/inventory/items/${encodeURIComponent(typedId)}/opening-stock`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ quantity: 10 })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(ctx.app)
            .post(`/api/inventory/items/${encodeURIComponent(untypedId)}/opening-stock`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ quantity: 10 })
        ).status,
      ).toBe(201);

      expect((await startDay(ctx, owner, { requestKey: "faucet-snap-day" })).status).toBe(201);

      // Prepare typed + deliberately untyped quote
      const prep = await prepareCheckout(ctx, cashier, {
        prepareKey: "faucet-snap-prep-1",
        items: [
          { kind: "MERCHANDISE", productId: typedId, quantity: 2 },
          { kind: "MERCHANDISE", productId: untypedId, quantity: 1 },
        ],
      });
      expect(prep.status).toBe(201);
      const ref1 = prep.body.checkout.reference as string;
      expect(prep.body.checkout.items[0].faucetReportingType).toBe("PUSH_TYPE");
      expect(prep.body.checkout.items[1].faucetReportingType).toBeNull();

      // Owner renames, reprices, re-tags to TWIST_TYPE, and moves section after quote preparation
      expect(
        (
          await request(ctx.app)
            .patch(`/api/inventory/products/${encodeURIComponent(typedId)}`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({
              name: "Renamed Twist Gripo",
              unitPriceCentavos: 9900,
              posSection: "TAKIP_ACCESSORIES",
              faucetReportingType: "TWIST_TYPE",
            })
        ).status,
      ).toBe(200);

      // Begin payment, then archive product; confirm original ref1 -> preserves PUSH_TYPE, Push-Type Faucet, ₱40.00, and NONE for untyped
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(ref1)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);
      expect(
        (
          await request(ctx.app)
            .post(`/api/inventory/products/${encodeURIComponent(typedId)}/archive`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({})
        ).status,
      ).toBe(200);
      const confirm1 = await confirmCheckout(ctx.app, cashier, ref1, {
        cashReceivedCentavos: 10000,
        items: [
          { kind: "MERCHANDISE", productId: typedId, quantity: 2 },
          { kind: "MERCHANDISE", productId: untypedId, quantity: 1 },
        ],
      });
      expect(confirm1.status).toBe(201);
      expect(confirm1.body.sale.items[0]).toMatchObject({
        displayLabel: "Push-Type Faucet",
        unitPriceCentavos: 4000,
        faucetReportingType: "PUSH_TYPE",
      });
      expect(confirm1.body.sale.items[1]).toMatchObject({
        displayLabel: "Blue Cap",
      });
      expect(confirm1.body.sale.items[1].faucetReportingType).toBeUndefined();

      const { rows: savedDbTypes } = await ctx.db.query<{
        line_index: number;
        faucet_reporting_type: string | null;
      }>(
        `SELECT psi.line_index, psi.faucet_reporting_type
           FROM pos_sale_items psi
           JOIN pos_sales ps ON ps.id = psi.sale_id
          WHERE ps.reference = $1
          ORDER BY psi.line_index ASC`,
        [ref1],
      );
      expect(savedDbTypes).toEqual([
        { line_index: 0, faucet_reporting_type: "PUSH_TYPE" },
        { line_index: 1, faucet_reporting_type: "NONE" },
      ]);

      // Same-reference retry replays cleanly without duplicate sale or stock deduction
      const retry1 = await confirmCheckout(ctx.app, cashier, ref1, {
        cashReceivedCentavos: 10000,
      });
      expect(retry1.status).toBe(200);
      expect(retry1.body.replayed).toBe(true);

      // Legacy quote snapshot (without faucetReportingType property) confirms with DB NULL
      const legacyPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "faucet-legacy-prep",
        items: [{ kind: "MERCHANDISE", productId: untypedId, quantity: 1 }],
      });
      expect(legacyPrep.status).toBe(201);
      const legacyRef = legacyPrep.body.checkout.reference as string;
      // Strip faucetReportingType from quote_snapshot to simulate a pre-0013 prepared quote
      await ctx.db.query(
        `UPDATE pos_checkouts
            SET quote_snapshot = (
              SELECT jsonb_agg(elem - 'faucetReportingType')
                FROM jsonb_array_elements(quote_snapshot) AS elem
            )
          WHERE reference = $1`,
        [legacyRef],
      );
      const legacyConfirm = await confirmCheckout(ctx.app, cashier, legacyRef, {
        cashReceivedCentavos: 2000,
        items: [{ kind: "MERCHANDISE", productId: untypedId, quantity: 1 }],
      });
      expect(legacyConfirm.status).toBe(201);
      expect("faucetReportingType" in legacyConfirm.body.sale.items[0]).toBe(false);

      const { rows: legacyDbTypes } = await ctx.db.query<{ faucet_reporting_type: string | null }>(
        `SELECT psi.faucet_reporting_type
           FROM pos_sale_items psi
           JOIN pos_sales ps ON ps.id = psi.sale_id
          WHERE ps.reference = $1`,
        [legacyRef],
      );
      expect(legacyDbTypes).toEqual([{ faucet_reporting_type: null }]);

      const legacyRetry = await confirmCheckout(ctx.app, cashier, legacyRef, {
        cashReceivedCentavos: 2000,
      });
      expect(legacyRetry.status).toBe(200);
      expect(legacyRetry.body.replayed).toBe(true);
    });
  });

  describe("Final POS Task 1 — verified checkout outcomes and pre-sale holds (DEC-095–098, DEC-103)", () => {
    async function setupRoundContainers(stockQuantity: number) {
      expect(
        (
          await request(ctx.app)
            .patch("/api/inventory/containers/ROUND")
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ showInPos: true })
        ).status,
      ).toBe(200);
      const opening = await request(ctx.app)
        .post("/api/inventory/items/ROUND/opening-stock")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ quantity: stockQuantity });
      expect(opening.status).toBe(201);
      return opening.body.item.id as string;
    }

    it("settles prior-day mixed refill + container package once with both delivery confirmations and leaves closed reports unchanged (DEC-095)", async () => {
      const roundId = await setupRoundContainers(4);
      expect((await startDay(ctx, owner, { requestKey: "t1-mixed-day1" })).status).toBe(201);

      const savedDay1 = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-mixed-day1-sale",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      expect(savedDay1.status).toBe(201);
      expect(
        (
          await confirmCheckout(ctx.app, cashier, savedDay1.body.checkout.reference as string, {
            cashReceivedCentavos: 2500,
          })
        ).status,
      ).toBe(201);

      // Mixed checkout: 1 customer-owned Purified refill (₱25) + 1 Empty Round package (₱175) = ₱200
      const mixedPrep = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-mixed-prior",
        items: [
          { kind: "STANDARD", waterType: "PURIFIED", quantity: 1 },
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(mixedPrep.status).toBe(201);
      const mixedRef = mixedPrep.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(mixedRef)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Day crosses midnight while payment is pending
      ctx.clock.advance(24 * 60 * 60_000);
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      const lookupBefore = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(mixedRef)}`)
        .set("Cookie", owner.cookie);
      expect(lookupBefore.status).toBe(200);
      expect(lookupBefore.body).toMatchObject({
        recoveryState: "REVIEW_REQUIRED",
        canSettlePriorDay: true,
        canResolveNoCashPriorDay: true,
        canResolveFullRefund: true,
      });

      // Missing either delivery confirmation keeps it pending (DEC-098)
      const missingItems = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(mixedRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: true });
      expect(missingItems.status).toBe(400);

      const missingRefill = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(mixedRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, itemsHandedOverConfirmed: true });
      expect(missingRefill.status).toBe(400);

      // Cashier is rejected
      const cashierAttempt = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(mixedRef)}/settle`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({
          paymentKeptConfirmed: true,
          refillDeliveredConfirmed: true,
          itemsHandedOverConfirmed: true,
        });
      expect(cashierAttempt.status).toBe(403);
      expect(cashierAttempt.body.error.code).toBe("FORBIDDEN");

      // Owner settles with both confirmations
      const settled = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(mixedRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          paymentKeptConfirmed: true,
          refillDeliveredConfirmed: true,
          itemsHandedOverConfirmed: true,
          cashReceivedCentavos: 25000,
          note: "Verified mixed handover",
        });
      expect(settled.status).toBe(201);
      expect(settled.body.outcome).toBe("SETTLED");
      expect(settled.body.settlement).toMatchObject({
        checkoutReference: mixedRef,
        originalBusinessDate: "2026-11-09",
        settlementDate: "2026-11-10",
        netAmountKeptCentavos: 20000,
        cashReceivedCentavos: 25000,
        changeCentavos: 5000,
        refillDeliveredConfirmed: true,
        itemsHandedOverConfirmed: true,
      });

      // Round stock deducted once (4 -> 3); customer-owned refill did not deduct another Round
      const invAfter = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const roundAfter = invAfter.body.items.find((i: any) => i.id === roundId);
      expect(roundAfter.currentQuantity).toBe(3);

      // Repeat settle replays cleanly without duplicate stock deduction
      const replaySettle = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(mixedRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          paymentKeptConfirmed: true,
          refillDeliveredConfirmed: true,
          itemsHandedOverConfirmed: true,
        });
      expect(replaySettle.status).toBe(200);
      expect(replaySettle.body.replayed).toBe(true);

      const { rows: movementRows } = await ctx.db.query<{ quantity_delta: number }>(
        `SELECT quantity_delta FROM inventory_stock_movements WHERE item_id = $1`,
        [roundId],
      );
      expect(movementRows).toHaveLength(1);
      expect(Number(movementRows[0]!.quantity_delta)).toBe(-1);

      // Previous day can now close and keeps only Day 1's ₱25 sale
      const closedDay1 = await endDay(ctx, owner, { requestKey: "t1-mixed-close-day1" });
      expect(closedDay1.status).toBe(200);
      expect(closedDay1.body.summary).toMatchObject({
        businessDate: "2026-11-09",
        totalSalesCentavos: 2500,
        validTransactionCount: 1,
      });
    });

    it("cancels a prior-day payment-pending checkout with no cash, releases reservations, and rejects contradictory resolutions (DEC-096)", async () => {
      const roundId = await setupRoundContainers(3);
      expect((await startDay(ctx, owner, { requestKey: "t1-nocash-day1" })).status).toBe(201);

      const prep = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-nocash-prep",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "TWIST_TYPE",
            quantity: 2,
          },
        ],
      });
      expect(prep.status).toBe(201);
      const ref = prep.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // 2 of 3 Rounds are reserved
      const catReserved = await request(ctx.app).get("/api/pos/catalog").set("Cookie", cashier.cookie);
      expect(catReserved.body.containerPackages[0].availableQuantity).toBe(1);

      ctx.clock.advance(24 * 60 * 60_000);
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      // Cashier cannot resolve
      const cashierForbidden = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/resolve`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({ outcome: "NO_CASH_CANCELLED", noCashReceivedConfirmed: true });
      expect(cashierForbidden.status).toBe(403);

      // Missing confirmation keeps checkout pending and End Day blocked
      const unconfirmed = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ outcome: "NO_CASH_CANCELLED", noCashReceivedConfirmed: false });
      expect(unconfirmed.status).toBe(400);

      const endBlocked = await endDay(ctx, owner, { requestKey: "t1-nocash-end-blocked" });
      expect(endBlocked.status).toBe(409);

      // Owner resolves NO_CASH_CANCELLED
      const resolved = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "NO_CASH_CANCELLED",
          noCashReceivedConfirmed: true,
          note: "Customer left without paying",
        });
      expect(resolved.status).toBe(201);
      expect(resolved.body.outcome).toBe("RESOLVED");
      expect(resolved.body.resolution).toMatchObject({
        checkoutReference: ref,
        originalBusinessDate: "2026-11-09",
        resolutionDate: "2026-11-10",
        outcome: "NO_CASH_CANCELLED",
        quoteTotalCentavos: 35000,
        cashReceivedCentavos: null,
        refundedAmountCentavos: null,
        heldItems: [],
      });

      // Reservation released (all 3 Rounds available again) and End Day succeeds
      const catReleased = await request(ctx.app).get("/api/pos/catalog").set("Cookie", owner.cookie);
      expect(catReleased.body.containerPackages.find((p: any) => p.productId === roundId).availableQuantity).toBe(3);
      expect((await endDay(ctx, owner, { requestKey: "t1-nocash-end-ok" })).status).toBe(200);

      // Lookup returns terminal CANCELLED_NO_CASH with all action flags false
      const lookupAfter = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(ref)}`)
        .set("Cookie", owner.cookie);
      expect(lookupAfter.status).toBe(200);
      expect(lookupAfter.body).toMatchObject({
        recoveryState: "CANCELLED_NO_CASH",
        canRetry: false,
        canCancelUnpaid: false,
        canSettlePriorDay: false,
        canResolveNoCashPriorDay: false,
        canResolveFullRefund: false,
        sale: null,
        settlement: null,
      });

      // Repeat NO_CASH_CANCELLED replays 200; contradictory FULL_REFUND or settle rejected 409
      const replayNoCash = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ outcome: "NO_CASH_CANCELLED", noCashReceivedConfirmed: true });
      expect(replayNoCash.status).toBe(200);
      expect(replayNoCash.body.replayed).toBe(true);

      const contradictRefund = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: true,
          cashReceivedCentavos: 35000,
          changeAlreadyGiven: false,
        });
      expect(contradictRefund.status).toBe(409);
      expect(contradictRefund.body.error.code).toBe("CHECKOUT_ALREADY_RESOLVED");

      const contradictSettle = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, itemsHandedOverConfirmed: true });
      expect(contradictSettle.status).toBe(409);
      expect(contradictSettle.body.error.code).toBe("CHECKOUT_ALREADY_RESOLVED");
    });

    it("records exact full refund for ₱175 quote with ₱250 tender (change given vs no change given) without creating a sale (DEC-097)", async () => {
      await setupRoundContainers(5);
      expect((await startDay(ctx, owner, { requestKey: "t1-refund-day1" })).status).toBe(201);

      // Checkout A: ₱175 quote, ₱250 tender, ₱75 change already given -> ₱175 refunded
      const prepA = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-refund-a",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
      });
      const refA = prepA.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(refA)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Checkout B: ₱175 quote, ₱250 tender, NO change given -> ₱250 refunded
      const prepB = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-refund-b",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "TWIST_TYPE",
            quantity: 1,
          },
        ],
      });
      const refB = prepB.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(refB)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Missing undelivered/refund confirmation stays pending
      const partialConfirm = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refA)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: false,
          cashReceivedCentavos: 25000,
          changeAlreadyGiven: true,
        });
      expect(partialConfirm.status).toBe(400);

      // Resolve A with changeAlreadyGiven: true
      const resA = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refA)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: true,
          cashReceivedCentavos: 25000,
          changeAlreadyGiven: true,
        });
      expect(resA.status).toBe(201);
      expect(resA.body.resolution).toMatchObject({
        checkoutReference: refA,
        outcome: "FULL_REFUND",
        quoteTotalCentavos: 17500,
        cashReceivedCentavos: 25000,
        changeAlreadyGiven: true,
        changeGivenCentavos: 7500,
        refundedAmountCentavos: 17500,
      });

      // Resolve B with changeAlreadyGiven: false
      const resB = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refB)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: true,
          cashReceivedCentavos: 25000,
          changeAlreadyGiven: false,
        });
      expect(resB.status).toBe(201);
      expect(resB.body.resolution).toMatchObject({
        checkoutReference: refB,
        outcome: "FULL_REFUND",
        quoteTotalCentavos: 17500,
        cashReceivedCentavos: 25000,
        changeAlreadyGiven: false,
        changeGivenCentavos: 0,
        refundedAmountCentavos: 25000,
      });

      const { rows: salesCount } = await ctx.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pos_sales`,
      );
      expect(salesCount[0]!.count).toBe("0");

      const lookupA = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(refA)}`)
        .set("Cookie", owner.cookie);
      expect(lookupA.status).toBe(200);
      expect(lookupA.body).toMatchObject({
        recoveryState: "REFUNDED_UNSAVED",
        canRetry: false,
        canResolveFullRefund: false,
        sale: null,
      });
    });

    it("holds a cancelled filled container once across retry, exposes it in POS and Inventory, and blocks competing checkouts (DEC-103, INV-015)", async () => {
      const roundId = await setupRoundContainers(3);
      expect((await startDay(ctx, owner, { requestKey: "t1-hold-day1" })).status).toBe(201);

      const prep = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-hold-filled",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(prep.status).toBe(201);
      const ref = prep.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Resolve with 1 held unit
      const holdReason = "Cancelled filled Round order held pending health guidance";
      const resHold = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: true,
          cashReceivedCentavos: 20000,
          changeAlreadyGiven: false,
          heldItems: [{ productId: roundId, quantity: 1, reason: holdReason }],
        });
      expect(resHold.status).toBe(201);
      expect(resHold.body.resolution.heldItems).toHaveLength(1);
      expect(resHold.body.resolution.heldItems[0]).toMatchObject({
        itemId: roundId,
        quantity: 1,
        reason: holdReason,
        posReference: ref,
      });

      // Retry replays 200 without creating a second hold
      const retryHold = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: true,
          cashReceivedCentavos: 20000,
          changeAlreadyGiven: false,
          heldItems: [{ productId: roundId, quantity: 1, reason: holdReason }],
        });
      expect(retryHold.status).toBe(200);
      expect(retryHold.body.replayed).toBe(true);

      const { rows: holdRows } = await ctx.db.query<{ quantity: number }>(
        `SELECT quantity FROM inventory_stock_holds WHERE item_id = $1 AND status = 'ACTIVE'`,
        [roundId],
      );
      expect(holdRows).toHaveLength(1);
      expect(Number(holdRows[0]!.quantity)).toBe(1);

      // POS catalog shows 2 available (3 physical - 1 held) and Inventory shows heldQuantity 1
      const posCat = await request(ctx.app).get("/api/pos/catalog").set("Cookie", cashier.cookie);
      expect(posCat.body.containerPackages.find((p: any) => p.productId === roundId).availableQuantity).toBe(2);

      const invItems = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
      const roundInv = invItems.body.items.find((i: any) => i.id === roundId);
      expect(roundInv).toMatchObject({
        currentQuantity: 3,
        heldQuantity: 1,
        availableQuantity: 2,
      });
      expect(roundInv.activeHolds).toHaveLength(1);
      expect(roundInv.activeHolds[0]).toMatchObject({
        quantity: 1,
        reason: holdReason,
        posReference: ref,
      });

      // Competing checkout trying to buy 3 Rounds is blocked; buying 2 Rounds succeeds
      const competingOver = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-hold-compete-over",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 3,
          },
        ],
      });
      expect(competingOver.status).toBe(409);
      expect(competingOver.body.error.code).toBe("INSUFFICIENT_STOCK");

      const competingOk = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-hold-compete-ok",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 2,
          },
        ],
      });
      expect(competingOk.status).toBe(201);

      // Same-account takeover + refresh lookup returns committed REFUNDED_UNSAVED with all action flags false
      const ownerDeviceB = await signIn(ctx.app, "owner1", owner.password);
      const takeoverLookup = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(ref)}`)
        .set("Cookie", ownerDeviceB.cookie);
      expect(takeoverLookup.status).toBe(200);
      expect(takeoverLookup.body).toMatchObject({
        recoveryState: "REFUNDED_UNSAVED",
        canRetry: false,
        canCancelUnpaid: false,
        canSettlePriorDay: false,
        canResolveNoCashPriorDay: false,
        canResolveFullRefund: false,
      });
      expect(takeoverLookup.body.resolution.heldItems).toHaveLength(1);
    });

    it("rejects resolve while confirm is in flight and returns committed sale after a lost confirm response", async () => {
      const enteredTx = deferred<void>();
      const releaseTx = deferred<void>();
      let pauseNextTx = false;

      const wrappedDb: Database = {
        query: (sql, params) => ctx.db.query(sql, params),
        exec: (sql) => ctx.db.exec(sql),
        close: () => ctx.db.close(),
        async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
          if (pauseNextTx) {
            pauseNextTx = false;
            enteredTx.resolve();
            await releaseTx.promise;
          }
          return ctx.db.transaction(fn);
        },
      };
      const pausedApp = createApp({ db: wrappedDb, clock: ctx.clock, secureCookies: false });

      expect((await startDay(ctx, owner, { requestKey: "t1-overlap-day" })).status).toBe(201);
      const prep = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-overlap-prep",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
      const ref = prep.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      pauseNextTx = true;
      const confirmPromise = confirmCheckout(pausedApp, cashier, ref, {
        cashReceivedCentavos: 10000,
      });
      await enteredTx.promise;

      // While confirm is in flight, resolve is rejected
      const resolveDuringInflight = await request(pausedApp)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: true,
          cashReceivedCentavos: 10000,
          changeAlreadyGiven: true,
        });
      expect(resolveDuringInflight.status).toBe(409);
      expect(resolveDuringInflight.body.error.code).toBe("CHECKOUT_NOT_RESOLVABLE");

      // Confirm finishes (lost response scenario); subsequent resolve returns CHECKOUT_ALREADY_SAVED + sale
      releaseTx.resolve();
      const confirmed = await confirmPromise;
      expect(confirmed.status).toBe(201);

      const resolveAfterSave = await request(pausedApp)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: true,
          cashReceivedCentavos: 10000,
          changeAlreadyGiven: true,
        });
      expect(resolveAfterSave.status).toBe(409);
      expect(resolveAfterSave.body.error.code).toBe("CHECKOUT_ALREADY_SAVED");
      expect(resolveAfterSave.body.sale.reference).toBe(ref);

      // Conversely, resolving an eligible checkout blocks subsequent confirm
      const prep2 = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-overlap-prep2",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      const ref2 = prep2.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(ref2)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(ref2)}/resolve`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({
              outcome: "FULL_REFUND",
              undeliveredConfirmed: true,
              fullRefundConfirmed: true,
              cashReceivedCentavos: 5000,
              changeAlreadyGiven: false,
            })
        ).status,
      ).toBe(201);

      const confirmAfterResolve = await confirmCheckout(ctx.app, cashier, ref2, {
        cashReceivedCentavos: 5000,
      });
      expect(confirmAfterResolve.status).toBe(409);
      expect(confirmAfterResolve.body.error.code).toBe("CHECKOUT_ALREADY_RESOLVED");
    });

    it("requires filled disposition on prior-day NO_CASH_CANCELLED, holds filled goods once across replay, blocks competing checkouts, and supports never-filled confirmation (Finding 1)", async () => {
      const roundId = await setupRoundContainers(3);
      expect((await startDay(ctx, owner, { requestKey: "t1-f1-nocash-day1" })).status).toBe(201);

      const prepHold = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-nocash-filled-1",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(prepHold.status).toBe(201);
      const refHold = prepHold.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(refHold)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      const prepNeverFilled = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-nocash-filled-2",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_ALKALINE",
            includedGripo: "TWIST_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(prepNeverFilled.status).toBe(201);
      const refNeverFilled = prepNeverFilled.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(refNeverFilled)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      ctx.clock.advance(24 * 60 * 60_000);
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      // Missing disposition on filled NO_CASH_CANCELLED is rejected
      const missingDisp = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refHold)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ outcome: "NO_CASH_CANCELLED", noCashReceivedConfirmed: true });
      expect(missingDisp.status).toBe(400);

      // Hold the 1 filled Round unit with NO_CASH_CANCELLED
      const reason = "Customer left unpaid after 1 Round was filled";
      const resolvedHold = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refHold)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "NO_CASH_CANCELLED",
          noCashReceivedConfirmed: true,
          heldItems: [{ productId: roundId, quantity: 1, reason }],
        });
      expect(resolvedHold.status).toBe(201);
      expect(resolvedHold.body.resolution.heldItems).toHaveLength(1);
      expect(resolvedHold.body.resolution.heldItems[0]).toMatchObject({
        itemId: roundId,
        quantity: 1,
        reason,
        posReference: refHold,
      });

      // Exact repeat replays 200 without duplicating hold; contradictory replay returns 409
      const replaySame = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refHold)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "NO_CASH_CANCELLED",
          noCashReceivedConfirmed: true,
          heldItems: [{ productId: roundId, quantity: 1, reason }],
        });
      expect(replaySame.status).toBe(200);
      expect(replaySame.body.replayed).toBe(true);

      const replayContradict = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refHold)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "NO_CASH_CANCELLED",
          noCashReceivedConfirmed: true,
          noFilledUnitsHeldConfirmed: true,
        });
      expect(replayContradict.status).toBe(409);
      expect(replayContradict.body.error.code).toBe("CHECKOUT_ALREADY_RESOLVED");

      // Second filled order explicitly confirmed as never actually filled creates no hold
      const resolvedNeverFilled = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refNeverFilled)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "NO_CASH_CANCELLED",
          noCashReceivedConfirmed: true,
          noFilledUnitsHeldConfirmed: true,
        });
      expect(resolvedNeverFilled.status).toBe(201);
      expect(resolvedNeverFilled.body.resolution.heldItems).toEqual([]);

      expect((await endDay(ctx, owner, { requestKey: "t1-f1-nocash-end1" })).status).toBe(200);
      expect((await startDay(ctx, owner, { requestKey: "t1-f1-nocash-day2" })).status).toBe(201);

      // Only 2 Rounds are available (3 physical - 1 CHECKOUT_CANCEL hold)
      const invAfter = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const invAfterRound = invAfter.body.items.find((i: any) => i.id === roundId);
      expect(invAfterRound).toMatchObject({
        currentQuantity: 3,
        heldQuantity: 1,
        availableQuantity: 2,
      });
      expect(invAfterRound.activeHolds[0]).toMatchObject({
        sourceKind: "CHECKOUT_CANCEL",
        quantity: 1,
        posReference: refHold,
      });

      const compete3 = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-nocash-compete3",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 3,
          },
        ],
      });
      expect(compete3.status).toBe(409);
      expect(compete3.body.error.code).toBe("INSUFFICIENT_STOCK");

      const compete2 = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-nocash-compete2",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 2,
          },
        ],
      });
      expect(compete2.status).toBe(201);
    });

    it("requires filled disposition on ordinary POST /cancel, preserves role/payment guards, holds filled goods once across replay, and blocks competing checkouts (Finding 1)", async () => {
      const roundId = await setupRoundContainers(3);
      expect((await startDay(ctx, owner, { requestKey: "t1-f1-cancel-day1" })).status).toBe(201);

      // Cashier prepares and enters PAYMENT_PENDING for 1 filled Round
      const prepPay = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-cancel-pay",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(prepPay.status).toBe(201);
      const refPay = prepPay.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(refPay)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Missing no-cash confirmation is still rejected
      const noCashMissing = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refPay)}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({ noFilledUnitsHeldConfirmed: true });
      expect(noCashMissing.status).toBe(409);
      expect(noCashMissing.body.error.code).toBe("CHECKOUT_NOT_CANCELLABLE");

      // Missing filled disposition on filled PAYMENT_PENDING cancel is rejected
      const dispMissing = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refPay)}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({ confirmNoCashTaken: true, reason: "Customer left" });
      expect(dispMissing.status).toBe(400);

      // Cancelling PAYMENT_PENDING with heldItems succeeds and records CHECKOUT_CANCEL hold
      const holdReason = "Cancelled unpaid filled Round at counter";
      const cancelHold = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refPay)}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({
          confirmNoCashTaken: true,
          reason: "No cash received",
          heldItems: [{ productId: roundId, quantity: 1, reason: holdReason }],
        });
      expect(cancelHold.status).toBe(200);
      expect(cancelHold.body.checkout.status).toBe("CANCELLED_DRAFT");
      expect(cancelHold.body.replayed).toBe(false);
      expect(cancelHold.body.heldItems).toHaveLength(1);
      expect(cancelHold.body.heldItems[0]).toMatchObject({
        itemId: roundId,
        quantity: 1,
        reason: holdReason,
        posReference: refPay,
      });

      // Exact repeat replays 200 without duplicating hold; contradictory repeat returns 409
      const cancelReplay = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refPay)}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({
          confirmNoCashTaken: true,
          reason: "No cash received",
          heldItems: [{ productId: roundId, quantity: 1, reason: holdReason }],
        });
      expect(cancelReplay.status).toBe(200);
      expect(cancelReplay.body.replayed).toBe(true);

      const cancelContradict = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refPay)}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({
          confirmNoCashTaken: true,
          reason: "No cash received",
          noFilledUnitsHeldConfirmed: true,
        });
      expect(cancelContradict.status).toBe(409);
      expect(cancelContradict.body.error.code).toBe("CHECKOUT_NOT_CANCELLABLE");

      const { rows: cancelHoldRows } = await ctx.db.query<{
        source_kind: string;
        resolution_id: string | null;
      }>(
        `SELECT source_kind, resolution_id FROM inventory_stock_holds WHERE checkout_id = (SELECT id FROM pos_checkouts WHERE reference = $1)`,
        [refPay],
      );
      expect(cancelHoldRows).toHaveLength(1);
      expect(cancelHoldRows[0]).toMatchObject({
        source_kind: "CHECKOUT_CANCEL",
        resolution_id: null,
      });

      // Competing checkout for 3 Rounds fails; 2 Rounds succeeds
      const competeOver = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-cancel-compete3",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 3,
          },
        ],
      });
      expect(competeOver.status).toBe(409);
      expect(competeOver.body.error.code).toBe("INSUFFICIENT_STOCK");

      // Cancelling a filled DRAFT order with noFilledUnitsHeldConfirmed leaves available stock at 2
      const prepDraft = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-cancel-draft",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "TWIST_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(prepDraft.status).toBe(201);
      const refDraft = prepDraft.body.checkout.reference as string;
      const cancelDraft = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refDraft)}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({ reason: "Returned to refill selection", noFilledUnitsHeldConfirmed: true });
      expect(cancelDraft.status).toBe(200);
      expect(cancelDraft.body.heldItems).toEqual([]);

      const invItems = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
      expect(invItems.body.items.find((i: any) => i.id === roundId)).toMatchObject({
        currentQuantity: 3,
        heldQuantity: 1,
        availableQuantity: 2,
      });
    });

    it("enforces filled disposition on FULL_REFUND and holds only the filled unit in a mixed same-shape empty/filled order (Findings 1 & 2)", async () => {
      const roundId = await setupRoundContainers(4);
      expect((await startDay(ctx, owner, { requestKey: "t1-f2-mixed-day1" })).status).toBe(201);

      // 1 Empty Round + 1 Purified Round (same roundId, total ordered 2, filled 1)
      const prepMixed = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f2-mixed-prep",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(prepMixed.status).toBe(201);
      const refMixed = prepMixed.body.checkout.reference as string;
      const totalCentavos = prepMixed.body.checkout.totalCentavos as number;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(refMixed)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Omitting both heldItems and noFilledUnitsHeldConfirmed on FULL_REFUND is rejected 400
      const omitDisp = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refMixed)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: true,
          cashReceivedCentavos: totalCentavos,
          changeAlreadyGiven: false,
        });
      expect(omitDisp.status).toBe(400);

      // Holding only the 1 filled Round unit satisfies the disposition requirement without holding the empty one
      const resolveMixed = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refMixed)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: true,
          cashReceivedCentavos: totalCentavos,
          changeAlreadyGiven: false,
          heldItems: [{ productId: roundId, quantity: 1, reason: "Only filled Round held" }],
        });
      expect(resolveMixed.status).toBe(201);
      expect(resolveMixed.body.resolution.heldItems).toHaveLength(1);
      expect(resolveMixed.body.resolution.heldItems[0].quantity).toBe(1);

      const invAfterMixed = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      expect(invAfterMixed.body.items.find((i: any) => i.id === roundId)).toMatchObject({
        currentQuantity: 4,
        heldQuantity: 1,
        availableQuantity: 3,
      });

      // A filled order never actually filled can be FULL_REFUND resolved with noFilledUnitsHeldConfirmed: true
      const prepUnfilled = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-refund-never-filled",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_ALKALINE",
            includedGripo: "TWIST_TYPE",
            quantity: 1,
          },
        ],
      });
      const refUnfilled = prepUnfilled.body.checkout.reference as string;
      const totalUnfilled = prepUnfilled.body.checkout.totalCentavos as number;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(refUnfilled)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);
      const resolveUnfilled = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(refUnfilled)}/resolve`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          outcome: "FULL_REFUND",
          undeliveredConfirmed: true,
          fullRefundConfirmed: true,
          cashReceivedCentavos: totalUnfilled,
          changeAlreadyGiven: false,
          noFilledUnitsHeldConfirmed: true,
        });
      expect(resolveUnfilled.status).toBe(201);
      expect(resolveUnfilled.body.resolution.heldItems).toEqual([]);
    });

    it("blocks End Day from bulk-cancelling filled drafts while clearing unaffected drafts, and supports partial subset holds on filled cancellations (Finding 1)", async () => {
      const roundId = await setupRoundContainers(5);
      expect((await startDay(ctx, owner, { requestKey: "t1-f1-draft-day1" })).status).toBe(201);

      // Prepare a 2-unit filled Round DRAFT and a 1-unit unaffected empty Round DRAFT
      const prepFilledDraft = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-draft-filled-2",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "PUSH_TYPE",
            quantity: 2,
          },
        ],
      });
      expect(prepFilledDraft.status).toBe(201);
      const filledRef = prepFilledDraft.body.checkout.reference as string;

      const prepEmptyDraft = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-draft-empty-1",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
      });
      expect(prepEmptyDraft.status).toBe(201);
      const emptyRef = prepEmptyDraft.body.checkout.reference as string;

      // Filled DRAFT is exposed in unresolvedCheckouts (not unpaidDrafts) and exposes canCancelUnpaid for its operator
      const dayCheck = await request(ctx.app).get("/api/pos/day").set("Cookie", cashier.cookie);
      expect(dayCheck.status).toBe(200);
      expect(dayCheck.body.unresolvedCheckouts.map((c: any) => c.reference)).toContain(filledRef);
      expect(dayCheck.body.unpaidDrafts.map((c: any) => c.reference)).toEqual([emptyRef]);

      const lookupFilled = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(filledRef)}`)
        .set("Cookie", cashier.cookie);
      expect(lookupFilled.status).toBe(200);
      expect(lookupFilled.body.canCancelUnpaid).toBe(true);

      // End Day with clearUnpaidDrafts: true refuses to bulk-cancel the filled draft
      const endBlocked = await endDay(ctx, owner, {
        requestKey: "t1-f1-draft-end-blocked",
        clearUnpaidDrafts: true,
      });
      expect(endBlocked.status).toBe(409);
      expect(endBlocked.body.error.code).toBe("UNRESOLVED_CHECKOUTS");
      expect(endBlocked.body.blockingCheckouts.map((c: any) => c.reference)).toContain(filledRef);

      // Partial subset hold (1 of 2 filled units) without noFilledUnitsHeldConfirmed is rejected 400
      const partialMissingConfirm = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(filledRef)}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({
          reason: "Returned to refill selection",
          heldItems: [{ productId: roundId, quantity: 1, reason: "Only 1 of 2 was filled" }],
        });
      expect(partialMissingConfirm.status).toBe(400);

      // Partial subset hold (1 of 2 filled units) with noFilledUnitsHeldConfirmed succeeds and holds only 1 unit
      const subsetReason = "Only 1 of 2 filled Rounds was filled before returning";
      const partialCancel = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(filledRef)}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({
          reason: "Returned to refill selection",
          heldItems: [{ productId: roundId, quantity: 1, reason: subsetReason }],
          noFilledUnitsHeldConfirmed: true,
        });
      expect(partialCancel.status).toBe(200);
      expect(partialCancel.body.heldItems).toHaveLength(1);
      expect(partialCancel.body.heldItems[0]).toMatchObject({
        itemId: roundId,
        quantity: 1,
        reason: subsetReason,
      });

      // Exact replay returns 200 without duplicating hold
      const partialReplay = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(filledRef)}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({
          reason: "Returned to refill selection",
          heldItems: [{ productId: roundId, quantity: 1, reason: subsetReason }],
          noFilledUnitsHeldConfirmed: true,
        });
      expect(partialReplay.status).toBe(200);
      expect(partialReplay.body.replayed).toBe(true);

      // Now only the unaffected empty draft remains, so End Day with clearUnpaidDrafts clears it cleanly
      const endOk = await endDay(ctx, owner, {
        requestKey: "t1-f1-draft-end-ok",
        clearUnpaidDrafts: true,
      });
      expect(endOk.status).toBe(200);
      expect(endOk.body.clearedDraftReferences).toEqual([emptyRef]);

      // Inventory retains the 1 CHECKOUT_CANCEL hold (available 4 out of 5)
      const invAfter = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      expect(invAfter.body.items.find((i: any) => i.id === roundId)).toMatchObject({
        currentQuantity: 5,
        heldQuantity: 1,
        availableQuantity: 4,
      });
    });

    it("lets the original operator cancel a recovered filled draft after midnight (open day) while protecting prior-day PAYMENT_PENDING and role boundaries (Finding 1)", async () => {
      const roundId = await setupRoundContainers(5);
      expect((await startDay(ctx, owner, { requestKey: "t1-f1-midnight-day1" })).status).toBe(201);

      // Cashier creates a 2-unit filled DRAFT and a 1-unit PAYMENT_PENDING before midnight
      const prepDraft = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-midnight-draft",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "PUSH_TYPE",
            quantity: 2,
          },
        ],
      });
      expect(prepDraft.status).toBe(201);
      const draftRef = prepDraft.body.checkout.reference as string;

      const prepPending = await prepareCheckout(ctx, cashier, {
        prepareKey: "t1-f1-midnight-pending",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
      expect(prepPending.status).toBe(201);
      const pendingRef = prepPending.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Advance past Manila midnight while previous day remains open
      ctx.clock.advance(24 * 60 * 60_000);
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      // Lookup of filled DRAFT across midnight lets original Cashier cancel it without allowing retry or prior-day PAYMENT_PENDING cancel
      const draftLookupCashier = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(draftRef)}`)
        .set("Cookie", cashier.cookie);
      expect(draftLookupCashier.status).toBe(200);
      expect(draftLookupCashier.body).toMatchObject({
        recoveryState: "REVIEW_REQUIRED",
        reason: "BUSINESS_DATE_CROSSED",
        canRetry: false,
        canCancelUnpaid: true,
        canSettlePriorDay: false,
        canResolveNoCashPriorDay: false,
        canResolveFullRefund: false,
      });

      // Another account (Owner) cannot cancel Cashier's draft directly
      const draftLookupOwner = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(draftRef)}`)
        .set("Cookie", owner.cookie);
      expect(draftLookupOwner.status).toBe(200);
      expect(draftLookupOwner.body.canCancelUnpaid).toBe(false);

      const ownerCancelDraft = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(draftRef)}/cancel`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ confirmNoCashTaken: true, noFilledUnitsHeldConfirmed: true });
      expect(ownerCancelDraft.status).toBe(403);

      // Prior-day PAYMENT_PENDING remains protected from Cashier /cancel across midnight
      const pendingLookupCashier = await request(ctx.app)
        .get(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}`)
        .set("Cookie", cashier.cookie);
      expect(pendingLookupCashier.status).toBe(200);
      expect(pendingLookupCashier.body.canCancelUnpaid).toBe(false);

      // Cashier cancels the prior-day filled draft holding 1 of 2 filled Rounds; End Day stays blocked only by the prior-day PAYMENT_PENDING until Owner resolves it
      const cashierCancelDraft = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(draftRef)}/cancel`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({
          confirmNoCashTaken: true,
          reason: "No cash received",
          heldItems: [{ productId: roundId, quantity: 1, reason: "1 of 2 Round filled before midnight" }],
          noFilledUnitsHeldConfirmed: true,
        });
      expect(cashierCancelDraft.status).toBe(200);
      expect(cashierCancelDraft.body.checkout.status).toBe("CANCELLED_DRAFT");
      expect(cashierCancelDraft.body.heldItems).toHaveLength(1);

      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/resolve`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ outcome: "NO_CASH_CANCELLED", noCashReceivedConfirmed: true })
        ).status,
      ).toBe(201);

      const endOk = await endDay(ctx, owner, {
        requestKey: "t1-f1-midnight-end-ok",
        clearUnpaidDrafts: true,
      });
      expect(endOk.status).toBe(200);

      const invAfter = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      expect(invAfter.body.items.find((i: any) => i.id === roundId)).toMatchObject({
        currentQuantity: 5,
        heldQuantity: 1,
        availableQuantity: 4,
      });
    });
  });

  describe("Final POS Task 2 — durable Owner sale actions (POS-004, POS-005, DEC-099, DEC-106)", () => {
    async function setupRoundContainers(stockQuantity: number) {
      expect(
        (
          await request(ctx.app)
            .patch("/api/inventory/containers/ROUND")
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ showInPos: true })
        ).status,
      ).toBe(200);
      const opening = await request(ctx.app)
        .post("/api/inventory/items/ROUND/opening-stock")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ quantity: stockQuantity });
      expect(opening.status).toBe(201);
      return opening.body.item.id as string;
    }

    async function saveRefillSale(
      actor: Parameters<typeof prepareCheckout>[1],
      input: {
        prepareKey: string;
        items: unknown[];
        cashReceivedCentavos: number;
      },
    ) {
      const prep = await prepareCheckout(ctx, actor, {
        prepareKey: input.prepareKey,
        items: input.items,
      });
      expect(prep.status).toBe(201);
      const reference = prep.body.checkout.reference as string;
      const confirm = await confirmCheckout(ctx.app, actor, reference, {
        cashReceivedCentavos: input.cashReceivedCentavos,
      });
      expect(confirm.status).toBe(201);
      return confirm.body.sale as {
        reference: string;
        totalCentavos: number;
        cashReceivedCentavos: number;
        changeCentavos: number;
        businessDate: string;
      };
    }

    it("supports Void Sale refunding sale total (₱175 vs ₱200 tender) and lower/higher/equal Correct Sale with Cashier, duplicate, replay, and stock gates", async () => {
      const roundId = await setupRoundContainers(4);
      expect((await startDay(ctx, owner, { requestKey: "t2-day1" })).status).toBe(201);

      // 1) Sale ₱175 with ₱200 tender (₱25 change) -> Void Sale must refund ₱175 (not ₱200)
      const saleVoid = await saveRefillSale(cashier, {
        prepareKey: "t2-sale-void",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 7 }],
        cashReceivedCentavos: 20000,
      });
      expect(saleVoid.totalCentavos).toBe(17500);
      expect(saleVoid.changeCentavos).toBe(2500);

      // Cashier is rejected on prepare/lookup/confirm/cancel
      const cashierPrep = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleVoid.reference)}/actions`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({ actionType: "VOID", reason: "Cashier cannot void" });
      expect(cashierPrep.status).toBe(403);

      const prepVoid = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleVoid.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Customer cancelled refill order",
          prepareKey: "t2-act-void-key",
        });
      expect(prepVoid.status).toBe(201);
      expect(prepVoid.body.replayed).toBe(false);
      expect(prepVoid.body.action).toMatchObject({
        originalSaleReference: saleVoid.reference,
        actionType: "VOID",
        status: "PENDING",
        originalTotalCentavos: 17500,
        originalCashReceivedCentavos: 20000,
        originalChangeCentavos: 2500,
        correctedTotalCentavos: 0,
        cashDifferenceCentavos: -17500,
        cashDirection: "REFUND",
      });
      const voidActionRef = prepVoid.body.action.reference as string;

      // Same prepareKey replays 200; duplicate second action on same sale returns 409 SALE_ACTION_ALREADY_PENDING
      const prepVoidReplay = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleVoid.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Customer cancelled refill order",
          prepareKey: "t2-act-void-key",
        });
      expect(prepVoidReplay.status).toBe(200);
      expect(prepVoidReplay.body.replayed).toBe(true);

      const competingAction = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleVoid.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ actionType: "VOID", reason: "Competing action" });
      expect(competingAction.status).toBe(409);
      expect(competingAction.body.error.code).toBe("SALE_ACTION_ALREADY_PENDING");

      // Cashier rejected on lookup/confirm/cancel
      expect(
        (
          await request(ctx.app)
            .get(`/api/pos/sale-actions/${encodeURIComponent(voidActionRef)}`)
            .set("Cookie", cashier.cookie)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(voidActionRef)}/confirm`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({ cashConfirmed: true })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(voidActionRef)}/cancel`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({ noCashExchangedConfirmed: true })
        ).status,
      ).toBe(403);

      // Missing cashConfirmed on refund rejected 400
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(voidActionRef)}/confirm`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({})
        ).status,
      ).toBe(400);

      // Confirm void -> refund is ₱175 (17500), original status becomes VOIDED, replay returns 200
      const confirmVoid = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(voidActionRef)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true });
      expect(confirmVoid.status).toBe(201);
      expect(confirmVoid.body).toMatchObject({
        outcome: "COMPLETED",
        replayed: false,
        replacementSale: null,
        originalSale: { reference: saleVoid.reference, status: "VOIDED" },
        action: {
          reference: voidActionRef,
          status: "COMPLETED",
          cashRefundedCentavos: 17500,
        },
      });

      const confirmVoidReplay = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(voidActionRef)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true });
      expect(confirmVoidReplay.status).toBe(200);
      expect(confirmVoidReplay.body.replayed).toBe(true);

      const contradictCancelAfterVoid = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(voidActionRef)}/cancel`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ noCashExchangedConfirmed: true });
      expect(contradictCancelAfterVoid.status).toBe(409);
      expect(contradictCancelAfterVoid.body.error.code).toBe("SALE_ACTION_ALREADY_COMPLETED");

      // 2) Lower correction: ₱350 -> ₱175 refunds ₱175 and voids original + activates replacement
      const saleLower = await saveRefillSale(cashier, {
        prepareKey: "t2-sale-lower",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 10 }],
        cashReceivedCentavos: 40000,
      });
      expect(saleLower.totalCentavos).toBe(35000);
      const prepLower = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleLower.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Recorded 10 Alkaline instead of 7 Purified",
          items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 7 }],
        });
      expect(prepLower.status).toBe(201);
      expect(prepLower.body.action).toMatchObject({
        correctedTotalCentavos: 17500,
        cashDifferenceCentavos: -17500,
        cashDirection: "REFUND",
      });
      const lowerConfirm = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(prepLower.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true });
      expect(lowerConfirm.status).toBe(201);
      expect(lowerConfirm.body.action.cashRefundedCentavos).toBe(17500);
      expect(lowerConfirm.body.originalSale.status).toBe("VOIDED");
      expect(lowerConfirm.body.replacementSale).toMatchObject({
        status: "ACTIVE",
        totalCentavos: 17500,
        correctedFromSaleReference: saleLower.reference,
      });

      // 3) Higher correction: ₱100 -> ₱175 collects ₱75 with ₱100 tender and ₱25 change
      const saleHigher = await saveRefillSale(cashier, {
        prepareKey: "t2-sale-higher",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 4 }],
        cashReceivedCentavos: 10000,
      });
      const prepHigher = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleHigher.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Added 3 more Purified refills",
          items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 7 }],
        });
      expect(prepHigher.status).toBe(201);
      expect(prepHigher.body.action).toMatchObject({
        cashDifferenceCentavos: 7500,
        cashDirection: "COLLECT",
      });
      const higherConfirm = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(prepHigher.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true, cashTenderedCentavos: 10000 });
      expect(higherConfirm.status).toBe(201);
      expect(higherConfirm.body.action).toMatchObject({
        cashTenderedCentavos: 10000,
        cashChangeCentavos: 2500,
      });
      expect(higherConfirm.body.replacementSale.totalCentavos).toBe(17500);

      // 4) Equal zero-cash correction: ₱25 Standard Purified -> ₱25 Custom Alkaline
      const saleEqual = await saveRefillSale(cashier, {
        prepareKey: "t2-sale-equal",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
        cashReceivedCentavos: 2500,
      });
      const prepEqual = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleEqual.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Water type switched at equal price",
          items: [
            {
              kind: "CUSTOM",
              waterType: "ALKALINE",
              unitVolumeLiters: 18.9,
              unitPriceCentavos: 2500,
              quantity: 1,
            },
          ],
        });
      expect(prepEqual.status).toBe(201);
      expect(prepEqual.body.action).toMatchObject({
        cashDifferenceCentavos: 0,
        cashDirection: "NONE",
      });
      const equalConfirm = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(prepEqual.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({});
      expect(equalConfirm.status).toBe(201);
      expect(equalConfirm.body.replacementSale).toMatchObject({
        status: "ACTIVE",
        totalCentavos: 2500,
      });

      // 5) Stock-changing sales (container/merchandise) are now preparable in Task 3 (test prepare + no-cash cancel leaves sale active)
      const saleMerch = await saveRefillSale(cashier, {
        prepareKey: "t2-sale-merch",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
        cashReceivedCentavos: 20000,
      });
      const stockPrepared = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleMerch.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Task 3 prepare & cancel check",
          stockDispositions: [{ productId: roundId, notReturnedQuantity: 1 }],
        });
      expect(stockPrepared.status).toBe(201);
      expect(stockPrepared.body.action.merchandisePlan.hasMerchandise).toBe(true);
      const cancelMerch = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(stockPrepared.body.action.reference)}/cancel`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ noCashExchangedConfirmed: true, reason: "Cancel after preview" });
      expect(cancelMerch.status).toBe(200);
      expect(cancelMerch.body.originalSale.status).toBe("ACTIVE");
      expect(roundId).toBeTruthy();

      // Verify live day summary reflects replacements & voids accurately
      const dayNow = await request(ctx.app).get("/api/pos/day").set("Cookie", owner.cookie);
      expect(dayNow.status).toBe(200);
      expect(dayNow.body.day.summary).toMatchObject({
        validTransactionCount: 4, // lower repl (17500) + higher repl (17500) + equal repl (2500) + merch (17500)
        totalSalesCentavos: 17500 + 17500 + 2500 + saleMerch.totalCentavos,
        voidedCount: 4, // saleVoid (17500) + saleLower (35000) + saleHigher (10000) + saleEqual (2500)
        voidedTotalCentavos: 17500 + 35000 + 10000 + 2500,
      });
    });

    it("recovers pending actions across Manila midnight on the original open day, blocks End Day, allows verified no-cash cancel, rejects new prior-day actions, and preserves saved zero-cash replacements", async () => {
      expect((await startDay(ctx, owner, { requestKey: "t2-mid-day1" })).status).toBe(201);

      // Sale A: prepared for lower correction before midnight, finished after midnight
      const saleA = await saveRefillSale(cashier, {
        prepareKey: "t2-mid-sale-a",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 4 }],
        cashReceivedCentavos: 10000,
      });
      // Sale B: prepared for void before midnight, cancelled no-cash after midnight
      const saleB = await saveRefillSale(cashier, {
        prepareKey: "t2-mid-sale-b",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 2 }],
        cashReceivedCentavos: 10000,
      });
      // Sale C: zero-cash replacement committed before midnight, read again after midnight
      const saleC = await saveRefillSale(cashier, {
        prepareKey: "t2-mid-sale-c",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
        cashReceivedCentavos: 2500,
      });
      // Sale D: untouched before midnight; starting a new action after midnight must be rejected
      const saleD = await saveRefillSale(cashier, {
        prepareKey: "t2-mid-sale-d",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
        cashReceivedCentavos: 5000,
      });

      const prepA = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleA.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Reduce to 2 Purified refills",
          items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
        });
      expect(prepA.status).toBe(201);
      const actARef = prepA.body.action.reference as string;

      const prepB = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleB.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ actionType: "VOID", reason: "Power blip during void" });
      expect(prepB.status).toBe(201);
      const actBRef = prepB.body.action.reference as string;

      const prepC = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleC.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Switch to zero-cash custom Purified",
          items: [
            {
              kind: "CUSTOM",
              waterType: "PURIFIED",
              unitVolumeLiters: 25,
              unitPriceCentavos: 2500,
              quantity: 1,
            },
          ],
        });
      expect(prepC.status).toBe(201);
      const actCRef = prepC.body.action.reference as string;
      const confirmC = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(actCRef)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({});
      expect(confirmC.status).toBe(201);
      const replCBeforeRef = confirmC.body.replacementSale.reference as string;

      // Cross Manila midnight while 2026-11-09 remains open
      ctx.clock.advance(24 * 60 * 60_000);
      owner = await reauth(ctx, "owner1", owner);
      cashier = await reauth(ctx, "cashier1", cashier);

      // Starting a new action on Sale D (previous business date) is rejected
      const newPriorDayAction = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleD.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ actionType: "VOID", reason: "Too late" });
      expect(newPriorDayAction.status).toBe(409);
      expect(newPriorDayAction.body.error.code).toBe("PRIOR_DAY_ACTION_BLOCKED");

      // Reading committed zero-cash replacement C after midnight leaves it untouched and blocks cancel
      const lookupC = await request(ctx.app)
        .get(`/api/pos/sale-actions/${encodeURIComponent(actCRef)}`)
        .set("Cookie", owner.cookie);
      expect(lookupC.status).toBe(200);
      expect(lookupC.body).toMatchObject({
        canConfirm: false,
        canCancelNoCash: false,
        action: { status: "COMPLETED", replacementSaleReference: replCBeforeRef },
        replacementSale: { reference: replCBeforeRef, status: "ACTIVE", businessDate: "2026-11-09" },
      });
      const replayConfirmC = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(actCRef)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({});
      expect(replayConfirmC.status).toBe(200);
      expect(replayConfirmC.body.replacementSale.reference).toBe(replCBeforeRef);
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(actCRef)}/cancel`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ noCashExchangedConfirmed: true })
        ).status,
      ).toBe(409);

      // Pending actions A and B block End Day
      const endBlocked1 = await endDay(ctx, owner, { requestKey: "t2-mid-end-blocked-1" });
      expect(endBlocked1.status).toBe(409);
      expect(endBlocked1.body.error.code).toBe("UNRESOLVED_SALE_ACTIONS");
      expect(endBlocked1.body.blockingSaleActions).toHaveLength(2);

      // Action A is recoverable after midnight and assigns replacement to original 2026-11-09 with 2026-11-10 completion timestamp
      const lookupA = await request(ctx.app)
        .get(`/api/pos/sale-actions/${encodeURIComponent(actARef)}`)
        .set("Cookie", owner.cookie);
      expect(lookupA.status).toBe(200);
      expect(lookupA.body).toMatchObject({ canConfirm: true, canCancelNoCash: true });

      const confirmA = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(actARef)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true });
      expect(confirmA.status).toBe(201);
      expect(confirmA.body.replacementSale).toMatchObject({
        status: "ACTIVE",
        businessDate: "2026-11-09",
        totalCentavos: 5000,
      });
      expect(confirmA.body.action.completedAt.startsWith("2026-11-10")).toBe(true);

      // Action B still blocks End Day until explicitly cancelled with noCashExchangedConfirmed: true
      const endBlocked2 = await endDay(ctx, owner, { requestKey: "t2-mid-end-blocked-2" });
      expect(endBlocked2.status).toBe(409);
      expect(endBlocked2.body.error.code).toBe("UNRESOLVED_SALE_ACTIONS");

      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(actBRef)}/cancel`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ noCashExchangedConfirmed: false })
        ).status,
      ).toBe(400);

      const cancelB = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(actBRef)}/cancel`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ noCashExchangedConfirmed: true, reason: "Verified no cash moved" });
      expect(cancelB.status).toBe(200);
      expect(cancelB.body.originalSale).toMatchObject({
        reference: saleB.reference,
        status: "ACTIVE",
      });

      // End Day now succeeds; pending actions cleared
      const endOk = await endDay(ctx, owner, { requestKey: "t2-mid-end-ok" });
      expect(endOk.status).toBe(200);

      // Closed day blocks any remaining recovery lookup from claiming canConfirm
      const lookupAfterClose = await request(ctx.app)
        .get(`/api/pos/sale-actions/${encodeURIComponent(actARef)}`)
        .set("Cookie", owner.cookie);
      expect(lookupAfterClose.status).toBe(200);
      expect(lookupAfterClose.body).toMatchObject({
        canConfirm: false,
        canCancelNoCash: false,
      });
    });

    it("replays identical CORRECT prepare requests, rejects modified payloads, exposes sourceAction cash truth on replacements, and blocks confirming unsaved zero-cash corrections after midnight (Findings 3, 4 & 5)", async () => {
      expect((await startDay(ctx, owner, { requestKey: "t2-f345-day1" })).status).toBe(201);

      // Original sale ₱100 paid with ₱120 tender (₱20 change) -> corrected to ₱175 taking ₱100 tender (₱25 change)
      const origSale = await saveRefillSale(cashier, {
        prepareKey: "t2-f345-sale1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 4 }],
        cashReceivedCentavos: 12000,
      });
      expect(origSale.changeCentavos).toBe(2000);

      const correctPayload = {
        actionType: "CORRECT" as const,
        reason: "Increased order to 7 Purified refills",
        prepareKey: "t2-f3-correct-replay",
        items: [{ kind: "STANDARD" as const, waterType: "PURIFIED" as const, quantity: 7 }],
      };
      const prep1 = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(origSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send(correctPayload);
      expect(prep1.status).toBe(201);
      expect(prep1.body.replayed).toBe(false);
      const actRef = prep1.body.action.reference as string;

      // Finding 3: Identical retry with same prepareKey replays 200 across JSONB round-trip
      const prepReplay = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(origSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send(correctPayload);
      expect(prepReplay.status).toBe(200);
      expect(prepReplay.body.replayed).toBe(true);
      expect(prepReplay.body.action.reference).toBe(actRef);

      // Finding 3: Changed correction items with same prepareKey reject 409 PAYLOAD_MISMATCH
      const prepChanged = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(origSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          ...correctPayload,
          items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 6 }],
        });
      expect(prepChanged.status).toBe(409);
      expect(prepChanged.body.error.code).toBe("PAYLOAD_MISMATCH");

      // Complete collection (₱100 tender for ₱75 increase -> ₱25 change) and check Finding 5 sourceAction
      const confirm1 = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(actRef)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true, cashTenderedCentavos: 10000 });
      expect(confirm1.status).toBe(201);
      const replRef = confirm1.body.replacementSale.reference as string;

      const replDetail = await request(ctx.app)
        .get(`/api/pos/sales/${encodeURIComponent(replRef)}`)
        .set("Cookie", cashier.cookie);
      expect(replDetail.status).toBe(200);
      expect(replDetail.body.totalCentavos).toBe(17500);
      expect(replDetail.body.sourceAction).toMatchObject({
        reference: actRef,
        originalSaleReference: origSale.reference,
        originalTotalCentavos: 10000,
        originalCashReceivedCentavos: 12000,
        originalChangeCentavos: 2000,
        cashDirection: "COLLECT",
        cashDifferenceCentavos: 7500,
        cashTenderedCentavos: 10000,
        cashChangeCentavos: 2500,
      });

      // Finding 4: Unsaved equal-total (zero-cash) correction prepared before midnight cannot be confirmed after midnight
      const saleZero = await saveRefillSale(cashier, {
        prepareKey: "t2-f4-zero-sale",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
        cashReceivedCentavos: 5000,
      });
      const prepZero = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleZero.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Equal swap before midnight",
          items: [
            {
              kind: "CUSTOM",
              waterType: "ALKALINE",
              unitVolumeLiters: 20,
              unitPriceCentavos: 2500,
              quantity: 1,
            },
          ],
        });
      expect(prepZero.status).toBe(201);
      const zeroActRef = prepZero.body.action.reference as string;

      ctx.clock.advance(24 * 60 * 60_000);
      owner = await reauth(ctx, "owner1", owner);

      const lookupZeroAfterMidnight = await request(ctx.app)
        .get(`/api/pos/sale-actions/${encodeURIComponent(zeroActRef)}`)
        .set("Cookie", owner.cookie);
      expect(lookupZeroAfterMidnight.status).toBe(200);
      expect(lookupZeroAfterMidnight.body).toMatchObject({
        canConfirm: false,
        canCancelNoCash: true,
        action: { status: "PENDING", cashDirection: "NONE" },
      });

      const confirmZeroAfterMidnight = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(zeroActRef)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({});
      expect(confirmZeroAfterMidnight.status).toBe(409);
      expect(confirmZeroAfterMidnight.body.error.code).toBe("PRIOR_DAY_ACTION_BLOCKED");

      // Owner cancels the unsaved zero-cash correction cleanly so original sale stays ACTIVE and End Day succeeds
      const cancelZeroAfterMidnight = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(zeroActRef)}/cancel`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ noCashExchangedConfirmed: true, reason: "Cleared zero-cash attempt after midnight" });
      expect(cancelZeroAfterMidnight.status).toBe(200);
      expect(cancelZeroAfterMidnight.body.originalSale.status).toBe("ACTIVE");
      expect((await endDay(ctx, owner, { requestKey: "t2-f345-end-ok" })).status).toBe(200);
    });

    it("distinguishes intermediate replacements from cash sales across chained Correct and Void actions and exposes linked cash events (Finding 5)", async () => {
      expect((await startDay(ctx, owner, { requestKey: "t2-f5-chain-day1" })).status).toBe(201);

      // Root cash sale: ₱100 total paid with ₱120 tender (₱20 change)
      const rootSale = await saveRefillSale(cashier, {
        prepareKey: "t2-f5-root-sale",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 4 }],
        cashReceivedCentavos: 12000,
      });

      // Correction 1: ₱100 -> ₱175 (collect ₱75 with ₱100 tender, ₱25 change) => Replacement 1
      const prep1 = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(rootSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Added 3 refills",
          items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 7 }],
        });
      expect(prep1.status).toBe(201);
      expect(prep1.body.action).toMatchObject({
        originalSaleIsReplacement: false,
        originalCashReceivedCentavos: 12000,
        originalChangeCentavos: 2000,
      });
      const act1Ref = prep1.body.action.reference as string;
      const conf1 = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(act1Ref)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true, cashTenderedCentavos: 10000 });
      expect(conf1.status).toBe(201);
      const repl1Ref = conf1.body.replacementSale.reference as string;

      // Correction 2 on Active Replacement 1: ₱175 -> ₱200 (collect ₱25 with ₱50 tender, ₱25 change) => Replacement 2
      const prep2 = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(repl1Ref)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Added 1 more refill to replacement",
          items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 8 }],
        });
      expect(prep2.status).toBe(201);
      expect(prep2.body.action).toMatchObject({
        originalSaleReference: repl1Ref,
        originalSaleIsReplacement: true,
        originalTotalCentavos: 17500,
        originalCashReceivedCentavos: null,
        originalChangeCentavos: null,
        correctedTotalCentavos: 20000,
        cashDifferenceCentavos: 2500,
        cashDirection: "COLLECT",
      });
      const act2Ref = prep2.body.action.reference as string;
      const conf2 = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(act2Ref)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true, cashTenderedCentavos: 5000 });
      expect(conf2.status).toBe(201);
      const repl2Ref = conf2.body.replacementSale.reference as string;

      // Lookup Action 2 still hides invented intermediate tender/change and Replacement 2 carries the full chain
      const lookupAct2 = await request(ctx.app)
        .get(`/api/pos/sale-actions/${encodeURIComponent(act2Ref)}`)
        .set("Cookie", owner.cookie);
      expect(lookupAct2.status).toBe(200);
      expect(lookupAct2.body.action).toMatchObject({
        originalSaleIsReplacement: true,
        originalCashReceivedCentavos: null,
        originalChangeCentavos: null,
      });

      const repl2Detail = await request(ctx.app)
        .get(`/api/pos/sales/${encodeURIComponent(repl2Ref)}`)
        .set("Cookie", cashier.cookie);
      expect(repl2Detail.status).toBe(200);
      expect(repl2Detail.body).toMatchObject({
        reference: repl2Ref,
        totalCentavos: 20000,
        correctedFromSaleReference: repl1Ref,
        sourceAction: {
          reference: act2Ref,
          originalSaleReference: repl1Ref,
          originalSaleIsReplacement: true,
          originalTotalCentavos: 17500,
          originalCashReceivedCentavos: null,
          originalChangeCentavos: null,
          cashTenderedCentavos: 5000,
          cashChangeCentavos: 2500,
        },
        cashEventChain: {
          rootCashSale: {
            reference: rootSale.reference,
            totalCentavos: 10000,
            cashReceivedCentavos: 12000,
            changeCentavos: 2000,
          },
          correctionEvents: [
            {
              actionReference: act1Ref,
              replacementSaleReference: repl1Ref,
              cashDifferenceCentavos: 7500,
              cashTenderedCentavos: 10000,
              cashChangeCentavos: 2500,
            },
            {
              actionReference: act2Ref,
              replacementSaleReference: repl2Ref,
              cashDifferenceCentavos: 2500,
              cashTenderedCentavos: 5000,
              cashChangeCentavos: 2500,
            },
          ],
        },
      });

      // Void Sale on Active Replacement 2 refunds ₱200 and preserves originalSaleIsReplacement: true
      const prepVoidRepl2 = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(repl2Ref)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ actionType: "VOID", reason: "Void final replacement" });
      expect(prepVoidRepl2.status).toBe(201);
      expect(prepVoidRepl2.body.action).toMatchObject({
        originalSaleReference: repl2Ref,
        originalSaleIsReplacement: true,
        originalTotalCentavos: 20000,
        originalCashReceivedCentavos: null,
        originalChangeCentavos: null,
        cashDirection: "REFUND",
        cashDifferenceCentavos: -20000,
      });
      const voidRepl2Ref = prepVoidRepl2.body.action.reference as string;
      const confVoidRepl2 = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(voidRepl2Ref)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true });
      expect(confVoidRepl2.status).toBe(201);
      expect(confVoidRepl2.body).toMatchObject({
        originalSale: { reference: repl2Ref, status: "VOIDED" },
        action: { cashRefundedCentavos: 20000 },
      });

      // End Day reporting retains accurate totals (0 active, 3 voided = 100 + 175 + 200 = 475)
      const endRes = await endDay(ctx, owner, { requestKey: "t2-f5-chain-end" });
      expect(endRes.status).toBe(200);
      expect(endRes.body.summary).toMatchObject({
        validTransactionCount: 0,
        totalSalesCentavos: 0,
        voidedCount: 3,
        voidedTotalCentavos: 47500,
      });
    });
  });

  describe("Final POS Task 3 — linked inventory stock effects, holds, reservations, and intervening count reviews", () => {
    async function initRoundContainer(stockQuantity: number) {
      expect(
        (
          await request(ctx.app)
            .patch("/api/inventory/containers/ROUND")
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ showInPos: true })
        ).status,
      ).toBe(200);
      const opening = await request(ctx.app)
        .post("/api/inventory/items/ROUND/opening-stock")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ quantity: stockQuantity });
      expect(opening.status).toBe(201);
      return opening.body.item.id as string;
    }

    async function createMerchProduct(input: {
      name: string;
      unitPriceCentavos: number;
      openingQuantity: number;
      showInPos?: boolean;
      faucetReportingType?: "PUSH_TYPE" | "TWIST_TYPE" | null;
    }) {
      const created = await request(ctx.app)
        .post("/api/inventory/products")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          name: input.name,
          unit: "pcs",
          unitConfirmed: true,
          unitPriceCentavos: input.unitPriceCentavos,
          showInPos: input.showInPos ?? true,
          posSection: "TAKIP_ACCESSORIES",
          faucetReportingType: input.faucetReportingType ?? null,
        });
      expect(created.status).toBe(201);
      const id = created.body.item.id as string;
      const opening = await request(ctx.app)
        .post(`/api/inventory/items/${id}/opening-stock`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ quantity: input.openingQuantity });
      expect(opening.status).toBe(201);
      return id;
    }

    async function saveSale(
      actor: Parameters<typeof prepareCheckout>[1],
      prepareKey: string,
      items: unknown[],
      cashReceivedCentavos: number,
    ) {
      const prep = await prepareCheckout(ctx, actor, { prepareKey, items });
      expect(prep.status).toBe(201);
      const confirm = await confirmCheckout(
        ctx.app,
        actor,
        prep.body.checkout.reference as string,
        { cashReceivedCentavos },
      );
      expect(confirm.status).toBe(201);
      return confirm.body.sale as {
        reference: string;
        totalCentavos: number;
      };
    }

    async function reconcileItem(
      itemKey: string,
      expectedItem: { stockRevision: number; currentQuantity: number },
      physicalCount: number,
      reason: string,
      requestKey: string,
    ) {
      return request(ctx.app)
        .post(`/api/inventory/items/${encodeURIComponent(itemKey)}/reconciliations`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          physicalCount,
          reason,
          expectedRevision: expectedItem.stockRevision,
          expectedCurrentQuantity: expectedItem.currentQuantity,
          requestKey,
        });
    }

    it("restores good returns, excludes damaged returns as reducesAvailability=false holds, and keeps Dashboard Stock Trend complete", async () => {
      const roundId = await initRoundContainer(4);
      ctx.clock.advance(5_000);
      const faucetId = await createMerchProduct({
        name: "Task3 Valve",
        unitPriceCentavos: 5000,
        openingQuantity: 4,
      });
      ctx.clock.advance(5_000);
      expect((await startDay(ctx, owner, { requestKey: "t3-day-1" })).status).toBe(201);
      ctx.clock.advance(5_000);

      const sale = await saveSale(
        cashier,
        "t3-sale-void-hold",
        [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 2,
          },
          { kind: "MERCHANDISE", productId: faucetId, quantity: 3 },
        ],
        50000,
      );
      expect(sale.totalCentavos).toBe(50000); // 2 * 17500 + 3 * 5000

      ctx.clock.advance(5_000);
      const prepVoid = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(sale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "One container cracked on return",
          prepareKey: "t3-void-prep-1",
          stockDispositions: [
            {
              productId: roundId,
              eligibleReturnedQuantity: 1,
              heldQuantity: 1,
              holdReason: "Cracked container neck",
            },
            {
              productId: faucetId,
              eligibleReturnedQuantity: 3,
            },
          ],
        });
      expect(prepVoid.status).toBe(201);
      expect(prepVoid.body.action.merchandisePlan.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            productId: roundId,
            returningFromSaleQuantity: 2,
            restoredQuantity: 1,
            heldQuantity: 1,
            holdReason: "Cracked container neck",
          }),
          expect.objectContaining({
            productId: faucetId,
            returningFromSaleQuantity: 3,
            restoredQuantity: 3,
            heldQuantity: 0,
          }),
        ]),
      );

      ctx.clock.advance(5_000);
      const confVoid = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(prepVoid.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true });
      expect(confVoid.status).toBe(201);

      // Round started at 4 -> sold 2 (=2) -> restored 1 (=3) + 1 reducesAvailability=false hold (available stays 3)
      const invRes = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      expect(invRes.status).toBe(200);
      const roundInv = invRes.body.items.find((i: { id: string }) => i.id === roundId);
      const faucetInv = invRes.body.items.find((i: { id: string }) => i.id === faucetId);
      expect(roundInv).toMatchObject({
        currentQuantity: 3,
        availableQuantity: 3,
        heldQuantity: 1,
      });
      expect(roundInv.activeHolds).toEqual([
        expect.objectContaining({
          sourceKind: "SALE_ACTION",
          reducesAvailability: false,
          quantity: 1,
          reason: "Cracked container neck",
          posReference: prepVoid.body.action.reference,
        }),
      ]);
      expect(faucetInv).toMatchObject({
        currentQuantity: 4,
        availableQuantity: 4,
      });

      // Dashboard Stock Trend stays COMPLETE with SALE_ACTION_RESTORATION
      const trendRes = await request(ctx.app)
        .get(`/api/dashboard/stocks/${roundId}/trend`)
        .set("Cookie", owner.cookie);
      expect(trendRes.status).toBe(200);
      expect(trendRes.body.historyState).toBe("COMPLETE");
      expect(trendRes.body.points.map((p: { movementType: string }) => p.movementType)).toEqual([
        "OPENING_COUNT",
        "POS_SALE",
        "SALE_ACTION_RESTORATION",
      ]);
    });

    it("keeps same-shape package edits at 0 container movement even at 0 stock, while physical exchanges check stock and deduct replacements", async () => {
      const roundId = await initRoundContainer(1);
      ctx.clock.advance(5_000);
      expect((await startDay(ctx, owner, { requestKey: "t3-day-2" })).status).toBe(201);
      ctx.clock.advance(5_000);

      // Sell the last remaining Round container (currentQuantity becomes 0)
      const sale = await saveSale(
        cashier,
        "t3-last-round",
        [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
        20000,
      );

      // Edit option ROUND_EMPTY -> ROUND_PURIFIED without physical exchange succeeds with 0 stock!
      ctx.clock.advance(5_000);
      const editOptPrep = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(sale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Customer actually got purified fill",
          prepareKey: "t3-edit-opt-prep",
          items: [
            {
              kind: "CONTAINER_PACKAGE",
              packageCode: "ROUND_PURIFIED",
              includedGripo: "TWIST_TYPE",
              quantity: 1,
            },
          ],
        });
      expect(editOptPrep.status).toBe(201);
      expect(editOptPrep.body.action.cashDirection).toBe("COLLECT");
      expect(editOptPrep.body.action.cashDifferenceCentavos).toBe(2500);
      expect(editOptPrep.body.action.merchandisePlan.items[0]).toMatchObject({
        productId: roundId,
        retainedQuantity: 1,
        exchangedQuantity: 0,
        addedQuantity: 0,
        restoredQuantity: 0,
        heldQuantity: 0,
      });

      const editOptConf = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(editOptPrep.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true, cashTenderedCentavos: 5000 });
      expect(editOptConf.status).toBe(201);
      const replRef = editOptConf.body.replacementSale.reference as string;

      // Exchange attempt when Round stock === 0 is blocked with 409 INSUFFICIENT_STOCK
      const blockedExchange = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(replRef)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Swap container",
          prepareKey: "t3-exch-blocked",
          items: [
            {
              kind: "CONTAINER_PACKAGE",
              packageCode: "ROUND_PURIFIED",
              includedGripo: "TWIST_TYPE",
              quantity: 1,
            },
          ],
          stockDispositions: [
            {
              productId: roundId,
              exchangedQuantity: 1,
              heldQuantity: 1,
              holdReason: "Leaking seam",
            },
          ],
        });
      expect(blockedExchange.status).toBe(409);
      expect(blockedExchange.body.error.code).toBe("INSUFFICIENT_STOCK");

      // Reconcile Round up to 1 available container, then complete same-shape physical exchange
      const invBefore = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const roundBefore = invBefore.body.items.find((i: { id: string }) => i.id === roundId);
      ctx.clock.advance(5_000);
      const recRes = await reconcileItem("ROUND", roundBefore, 1, "Found 1 spare", "t3-rec-spare");
      expect(recRes.status).toBe(201);

      ctx.clock.advance(5_000);
      const exchPrep = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(replRef)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Swapped leaking round container for spare",
          prepareKey: "t3-exch-ok",
          items: [
            {
              kind: "CONTAINER_PACKAGE",
              packageCode: "ROUND_PURIFIED",
              includedGripo: "TWIST_TYPE",
              quantity: 1,
            },
          ],
          stockDispositions: [
            {
              productId: roundId,
              exchangedQuantity: 1,
              heldQuantity: 1,
              holdReason: "Leaking seam swapped out",
            },
          ],
        });
      expect(exchPrep.status).toBe(201);
      expect(exchPrep.body.action.merchandisePlan.items[0]).toMatchObject({
        retainedQuantity: 0,
        exchangedQuantity: 1,
        addedQuantity: 1,
        restoredQuantity: 0,
        heldQuantity: 1,
      });

      const exchConf = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(exchPrep.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({});
      expect(exchConf.status).toBe(201);

      const invAfter = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const roundAfter = invAfter.body.items.find((i: { id: string }) => i.id === roundId);
      expect(roundAfter).toMatchObject({
        currentQuantity: 0,
        availableQuantity: 0,
        heldQuantity: 1,
      });
    });

    it("reserves added stock while pending, releases on no-cash cancel, and enforces retained vs archived/price-changed snapshots", async () => {
      const capId = await createMerchProduct({
        name: "Seal Cap",
        unitPriceCentavos: 2000,
        openingQuantity: 3,
      });
      const oldBagId = await createMerchProduct({
        name: "Old Carry Bag",
        unitPriceCentavos: 4000,
        openingQuantity: 3,
      });
      ctx.clock.advance(5_000);
      expect((await startDay(ctx, owner, { requestKey: "t3-day-3" })).status).toBe(201);
      ctx.clock.advance(5_000);

      // Sell 1x Seal Cap (2 left) + 2x Old Carry Bag (1 left)
      const capSale = await saveSale(
        cashier,
        "t3-cap-sale",
        [{ kind: "MERCHANDISE", productId: capId, quantity: 1 }],
        2000,
      );
      const bagSale = await saveSale(
        cashier,
        "t3-bag-sale",
        [{ kind: "MERCHANDISE", productId: oldBagId, quantity: 2 }],
        8000,
      );

      // Prepare pending CORRECT increasing Seal Cap 1 -> 3 (reserves remaining 2)
      ctx.clock.advance(5_000);
      const prepAdd = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(capSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Customer added 2 more caps",
          prepareKey: "t3-cap-add-prep",
          items: [{ kind: "MERCHANDISE", productId: capId, quantity: 3 }],
        });
      expect(prepAdd.status).toBe(201);

      // Pending reservation blocks another checkout for Seal Cap and blocks INV-009 reconcile below 2
      const competingCheckout = await prepareCheckout(ctx, cashier, {
        prepareKey: "t3-competing-cap",
        items: [{ kind: "MERCHANDISE", productId: capId, quantity: 1 }],
      });
      expect(competingCheckout.status).toBe(409);
      expect(competingCheckout.body.error.code).toBe("INSUFFICIENT_STOCK");

      const invBeforeRec = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const capBeforeRec = invBeforeRec.body.items.find((i: { id: string }) => i.id === capId);
      const blockedCapRec = await reconcileItem(capId, capBeforeRec, 1, "Below reserved", "t3-cap-rec-block");
      expect(blockedCapRec.status).toBe(409);
      expect(blockedCapRec.body.error.code).toBe("ACTIVE_PAYMENT_COMMITMENT");

      // Cancelling no-cash releases the reservation so competing checkout can proceed
      const cancelAdd = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(prepAdd.body.action.reference)}/cancel`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ noCashExchangedConfirmed: true, reason: "Customer declined extra caps" });
      expect(cancelAdd.status).toBe(200);

      // Raise Seal Cap price from ₱20 -> ₱30; archive Old Carry Bag
      expect(
        (
          await request(ctx.app)
            .patch(`/api/inventory/products/${capId}`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ unitPriceCentavos: 3000 })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(ctx.app)
            .post(`/api/inventory/products/${oldBagId}/archive`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Adding new qty on archived Old Carry Bag fails, while retaining original qty 2 preserves ₱40 snapshot!
      const blockedArchivedAdd = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(bagSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Try adding archived product",
          prepareKey: "t3-bag-add-fail",
          items: [{ kind: "MERCHANDISE", productId: oldBagId, quantity: 3 }],
        });
      expect(blockedArchivedAdd.status).toBe(409);
      expect(blockedArchivedAdd.body.error.code).toBe("PRODUCT_UNAVAILABLE");

      const retainArchivedOk = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(bagSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Add water refill while retaining archived bags",
          prepareKey: "t3-bag-retain-ok",
          items: [
            { kind: "MERCHANDISE", productId: oldBagId, quantity: 2 },
            { kind: "STANDARD", waterType: "PURIFIED", quantity: 1 },
          ],
        });
      expect(retainArchivedOk.status).toBe(201);
      expect(retainArchivedOk.body.action.correctedTotalCentavos).toBe(8000 + 2500);

      // Correcting Seal Cap 1 -> 2 after price raise retains 1 @ ₱20 + adds 1 @ ₱30 = ₱50 (+₱30 collect)
      const capPriceSplit = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(capSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Add 1 more cap at updated price",
          prepareKey: "t3-cap-split-ok",
          items: [{ kind: "MERCHANDISE", productId: capId, quantity: 2 }],
        });
      expect(capPriceSplit.status).toBe(201);
      expect(capPriceSplit.body.action.correctedTotalCentavos).toBe(2000 + 3000);
      expect(capPriceSplit.body.action.cashDifferenceCentavos).toBe(3000);
      const confCap = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(capPriceSplit.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true, cashTenderedCentavos: 3000 });
      expect(confCap.status).toBe(201);
    });

    it("protects pending items from counts, allows confirm re-review on same reference, and supports UNCOVERED and PARTIAL return coverage (Findings 2 & 4)", async () => {
      const nozzleId = await createMerchProduct({
        name: "Twist Nozzle",
        unitPriceCentavos: 6000,
        openingQuantity: 6,
      });
      ctx.clock.advance(5_000);
      expect((await startDay(ctx, owner, { requestKey: "t3-day-4" })).status).toBe(201);
      ctx.clock.advance(5_000);

      const sale1 = await saveSale(
        cashier,
        "t3-cnt-sale1",
        [{ kind: "MERCHANDISE", productId: nozzleId, quantity: 1 }],
        6000,
      );
      const sale2 = await saveSale(
        cashier,
        "t3-cnt-sale2",
        [{ kind: "MERCHANDISE", productId: nozzleId, quantity: 1 }],
        6000,
      );
      const sale3 = await saveSale(
        cashier,
        "t3-cnt-sale3",
        [{ kind: "MERCHANDISE", productId: nozzleId, quantity: 1 }],
        6000,
      );

      // Prepare Void on sale3 -> Inventory physical count on Twist Nozzle is blocked (409 UNRESOLVED_SALE_ACTIONS)
      ctx.clock.advance(5_000);
      const prepSale3 = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(sale3.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Prepare before count",
          prepareKey: "t3-stale-prep",
          stockDispositions: [{ productId: nozzleId, eligibleReturnedQuantity: 1 }],
        });
      expect(prepSale3.status).toBe(201);

      const invBeforePending = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const nozzleBeforePending = invBeforePending.body.items.find((i: { id: string }) => i.id === nozzleId);
      const blockedPendingRec = await reconcileItem(
        nozzleId,
        nozzleBeforePending,
        3,
        "Attempted count during pending void",
        "t3-cnt-blocked-pending",
      );
      expect(blockedPendingRec.status).toBe(409);
      expect(blockedPendingRec.body.error.code).toBe("UNRESOLVED_SALE_ACTIONS");

      // Simulate an intervening physical count arriving after prepare (e.g. direct/concurrent legacy count row)
      // and confirm on the SAME pending reference re-verifies coverage without stranding cash refund or End Day.
      ctx.clock.advance(5_000);
      await ctx.db.query(
        `INSERT INTO inventory_reconciliations (
           item_id, request_key, balance_before, physical_count, quantity_delta,
           balance_after, unit, reason, actor_user_id, recorded_at
         )
         VALUES ($1, 't3-cnt-rec1-direct', 3, 3, 0, 3, 'pcs', 'Midday count', $2, $3)`,
        [nozzleId, (await ctx.db.query<{ id: string }>(`SELECT id FROM app_users WHERE role = 'OWNER' LIMIT 1`)).rows[0]!.id, ctx.clock.now()],
      );

      const needReviewConfirm = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(prepSale3.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true });
      expect(needReviewConfirm.status).toBe(409);
      expect(needReviewConfirm.body.error.code).toBe("INTERVENING_COUNT_REVIEW_REQUIRED");
      expect(needReviewConfirm.body.staleStockCount).toBe(true);

      const recoveredConfirm = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(prepSale3.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          cashConfirmed: true,
          stockDispositions: [
            { productId: nozzleId, eligibleReturnedQuantity: 1, countCoverage: "COVERED_BY_COUNT" },
          ],
        });
      expect(recoveredConfirm.status).toBe(201);
      expect(recoveredConfirm.body.action.merchandisePlan.items[0]).toMatchObject({
        restoredQuantity: 0,
        countCoveredQuantity: 1,
      });

      // Voiding sale1 after rec1 without countCoverage returns 409 INTERVENING_COUNT_REVIEW_REQUIRED
      ctx.clock.advance(5_000);
      const promptReq = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(sale1.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Void after count",
          prepareKey: "t3-cnt-uncovered",
          stockDispositions: [{ productId: nozzleId, eligibleReturnedQuantity: 1 }],
        });
      expect(promptReq.status).toBe(409);
      expect(promptReq.body.error.code).toBe("INTERVENING_COUNT_REVIEW_REQUIRED");
      expect(promptReq.body.affectedItems[0]).toMatchObject({
        productId: nozzleId,
        returningQuantity: 1,
        physicalCount: 3,
      });

      // Retry with UNCOVERED (Finding 4) -> restores +1 once (stock moves 3 -> 4)
      const uncoveredPrep = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(sale1.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Void after count",
          prepareKey: "t3-cnt-uncovered",
          stockDispositions: [
            { productId: nozzleId, eligibleReturnedQuantity: 1, countCoverage: "UNCOVERED" },
          ],
        });
      expect(uncoveredPrep.status).toBe(201);
      expect(uncoveredPrep.body.action.merchandisePlan.items[0]).toMatchObject({
        restoredQuantity: 1,
        countCoveredQuantity: 0,
        unclearCoverageQuantity: 0,
      });
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(uncoveredPrep.body.action.reference)}/confirm`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ cashConfirmed: true })
        ).status,
      ).toBe(201);

      // Void sale2 with UNCLEAR -> requiresInventoryReview = true, exposed in Inventory, cleared by subsequent count
      ctx.clock.advance(5_000);
      const unclearPrep = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(sale2.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Unsure if counted",
          prepareKey: "t3-cnt-unclear",
          stockDispositions: [
            { productId: nozzleId, eligibleReturnedQuantity: 1, countCoverage: "UNCLEAR" },
          ],
        });
      expect(unclearPrep.status).toBe(201);
      expect(unclearPrep.body.action.merchandisePlan.requiresInventoryReview).toBe(true);
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(unclearPrep.body.action.reference)}/confirm`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ cashConfirmed: true })
        ).status,
      ).toBe(201);

      const invWithReview = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const nozzleReview = invWithReview.body.items.find((i: { id: string }) => i.id === nozzleId);
      expect(nozzleReview.currentQuantity).toBe(4);
      expect(nozzleReview.pendingStockReviews).toEqual([
        expect.objectContaining({
          saleActionReference: unclearPrep.body.action.reference,
          itemId: nozzleId,
          unclearQuantity: 1,
        }),
      ]);

      // Subsequent INV-009 reconciliation clears pendingStockReviews cleanly and End Day succeeds
      ctx.clock.advance(5_000);
      const rec2 = await reconcileItem(
        nozzleId,
        nozzleReview,
        5,
        "Confirmed returned nozzle on shelf",
        "t3-cnt-rec2",
      );
      expect(rec2.status).toBe(201);
      const invAfterClear = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const nozzleCleared = invAfterClear.body.items.find((i: { id: string }) => i.id === nozzleId);
      expect(nozzleCleared.currentQuantity).toBe(5);
      expect(nozzleCleared.pendingStockReviews).toEqual([]);

      const dayEnd = await endDay(ctx, owner, { requestKey: "t3-day-4-end" });
      expect(dayEnd.status).toBe(200);
    });

    it("requires explicit dispositions, enforces filled-package INV-014/015 exclusions without fake holds, and preserves multi-snapshot faucet types at equal price (Findings 1, 3 & 4)", async () => {
      const roundId = await initRoundContainer(6);
      ctx.clock.advance(5_000);
      const faucetId = await createMerchProduct({
        name: "Dual Faucet",
        unitPriceCentavos: 5000,
        openingQuantity: 6,
        faucetReportingType: "PUSH_TYPE",
      });
      ctx.clock.advance(5_000);
      expect((await startDay(ctx, owner, { requestKey: "t3-day-5" })).status).toBe(201);
      ctx.clock.advance(5_000);

      // Finding 1: Voiding a filled container package without disposition or with eligibleReturnedQuantity > 0 is blocked; notReturnedQuantity keeps 0 holds and 0 restoration
      const filledSale = await saveSale(
        cashier,
        "t3-f1-filled",
        [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
        ],
        20000,
      );

      const silentRejected = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(filledSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ actionType: "VOID", reason: "Refund filled bottle without confirm", prepareKey: "t3-f1-silent" });
      expect(silentRejected.status).toBe(400);

      const filledRestoreRejected = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(filledSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Try auto-restoring filled container",
          prepareKey: "t3-f1-bad-restore",
          stockDispositions: [{ productId: roundId, eligibleReturnedQuantity: 1 }],
        });
      expect(filledRestoreRejected.status).toBe(400);

      const notReturnedOk = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(filledSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Customer kept bottle / unreturned",
          prepareKey: "t3-f1-not-returned",
          stockDispositions: [{ productId: roundId, notReturnedQuantity: 1 }],
        });
      expect(notReturnedOk.status).toBe(201);
      expect(notReturnedOk.body.action.merchandisePlan.items[0]).toMatchObject({
        restoredQuantity: 0,
        heldQuantity: 0,
        notReturnedQuantity: 1,
        returningFilledQuantity: 1,
      });
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(notReturnedOk.body.action.reference)}/confirm`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ cashConfirmed: true })
        ).status,
      ).toBe(201);

      const invAfterF1 = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const roundAfterF1 = invAfterF1.body.items.find((i: { id: string }) => i.id === roundId);
      expect(roundAfterF1).toMatchObject({
        currentQuantity: 5,
        availableQuantity: 5,
        heldQuantity: 0,
      });

      // Finding 4: Partial return coverage after intervening count (2 empty Rounds -> 1 uncovered +1, 1 covered +0)
      const twoEmptySale = await saveSale(
        cashier,
        "t3-f4-partial-sale",
        [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "PUSH_TYPE",
            quantity: 2,
          },
        ],
        35000,
      );
      ctx.clock.advance(5_000);
      const invBeforePartial = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const roundBeforePartial = invBeforePartial.body.items.find((i: { id: string }) => i.id === roundId);
      expect(
        (await reconcileItem("ROUND", roundBeforePartial, 3, "Count after empty sale", "t3-f4-rec")).status,
      ).toBe(201);

      ctx.clock.advance(5_000);
      const partialPrep = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(twoEmptySale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Partial count overlap on 2 empty containers",
          prepareKey: "t3-f4-partial-void",
          stockDispositions: [
            {
              productId: roundId,
              eligibleReturnedQuantity: 2,
              countCoverage: "PARTIAL",
              uncoveredReturnedQuantity: 1,
              coveredByCountQuantity: 1,
              unclearCoverageQuantity: 0,
            },
          ],
        });
      expect(partialPrep.status).toBe(201);
      expect(partialPrep.body.action.merchandisePlan.items[0]).toMatchObject({
        restoredQuantity: 1,
        countCoveredQuantity: 1,
        unclearCoverageQuantity: 0,
      });
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(partialPrep.body.action.reference)}/confirm`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ cashConfirmed: true })
        ).status,
      ).toBe(201);
      const invAfterPartial = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
      const roundAfterPartial = invAfterPartial.body.items.find((i: { id: string }) => i.id === roundId);
      expect(roundAfterPartial.currentQuantity).toBe(4);

      // Finding 3: Equal-price faucetReportingType update preserves retained line type & repeated corrections retain mixed snapshots
      const faucetSale = await saveSale(
        cashier,
        "t3-f3-faucet1",
        [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }],
        5000,
      );
      expect(
        (
          await request(ctx.app)
            .patch(`/api/inventory/products/${faucetId}`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ faucetReportingType: "TWIST_TYPE" })
        ).status,
      ).toBe(200);

      const prepSplitSamePrice = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(faucetSale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Add second faucet after reporting type update",
          prepareKey: "t3-f3-corr1",
          items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 2 }],
        });
      expect(prepSplitSamePrice.status).toBe(201);
      expect(prepSplitSamePrice.body.action.correctedItems).toHaveLength(2);
      expect(prepSplitSamePrice.body.action.correctedItems[0]).toMatchObject({
        quantity: 1,
        unitPriceCentavos: 5000,
        faucetReportingType: "PUSH_TYPE",
      });
      expect(prepSplitSamePrice.body.action.correctedItems[1]).toMatchObject({
        quantity: 1,
        unitPriceCentavos: 5000,
        faucetReportingType: "TWIST_TYPE",
      });

      const confSplit1 = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(prepSplitSamePrice.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true, cashTenderedCentavos: 5000 });
      expect(confSplit1.status).toBe(201);
      const replFaucetRef = confSplit1.body.replacementSale.reference as string;

      // Second correction after a price raise preserves both earlier PUSH (₱50) and TWIST (₱50) lines, adding 1x @ ₱60
      expect(
        (
          await request(ctx.app)
            .patch(`/api/inventory/products/${faucetId}`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ unitPriceCentavos: 6000 })
        ).status,
      ).toBe(200);
      const prepSplitRepeat = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(replFaucetRef)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Add third faucet at new price",
          prepareKey: "t3-f3-corr2",
          items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 3 }],
        });
      expect(prepSplitRepeat.status).toBe(201);
      expect(prepSplitRepeat.body.action.correctedItems).toHaveLength(3);
      expect(prepSplitRepeat.body.action.correctedItems[0]).toMatchObject({
        quantity: 1,
        unitPriceCentavos: 5000,
        faucetReportingType: "PUSH_TYPE",
      });
      expect(prepSplitRepeat.body.action.correctedItems[1]).toMatchObject({
        quantity: 1,
        unitPriceCentavos: 5000,
        faucetReportingType: "TWIST_TYPE",
      });
      expect(prepSplitRepeat.body.action.correctedItems[2]).toMatchObject({
        quantity: 1,
        unitPriceCentavos: 6000,
        faucetReportingType: "TWIST_TYPE",
      });
      expect(prepSplitRepeat.body.action.correctedTotalCentavos).toBe(16000);

      // Cancel prepSplitRepeat so replFaucetRef stays clean, then test selected originalLineIndex removal
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(prepSplitRepeat.body.action.reference)}/cancel`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ noCashExchangedConfirmed: true })
        ).status,
      ).toBe(200);

      // Build a clean ₹120 replacement sale: Line 0 = 1x PUSH_TYPE @ ₱50, Line 1 = 1x TWIST_TYPE @ ₱70
      const faucet2Id = await createMerchProduct({
        name: "Mixed Price Faucet",
        unitPriceCentavos: 5000,
        openingQuantity: 4,
        faucetReportingType: "PUSH_TYPE",
      });
      const mixedOrig = await saveSale(
        cashier,
        "t3-f3-mixed-orig",
        [{ kind: "MERCHANDISE", productId: faucet2Id, quantity: 1 }],
        5000,
      );
      expect(
        (
          await request(ctx.app)
            .patch(`/api/inventory/products/${faucet2Id}`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ unitPriceCentavos: 7000, faucetReportingType: "TWIST_TYPE" })
        ).status,
      ).toBe(200);
      const mixedPrep1 = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(mixedOrig.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Add ₱70 twist faucet",
          prepareKey: "t3-f3-mixed-p1",
          items: [{ kind: "MERCHANDISE", productId: faucet2Id, quantity: 2 }],
        });
      expect(mixedPrep1.status).toBe(201);
      const mixedConf1 = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(mixedPrep1.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true, cashTenderedCentavos: 7000 });
      expect(mixedConf1.status).toBe(201);
      const mixedReplRef = mixedConf1.body.replacementSale.reference as string;
      expect(mixedConf1.body.replacementSale.totalCentavos).toBe(12000);

      // Invalid originalLineIndex -> 400 VALIDATION_FAILED
      const badIdx = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(mixedReplRef)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Invalid index check",
          prepareKey: "t3-f3-bad-idx",
          items: [{ kind: "MERCHANDISE", productId: faucet2Id, quantity: 1, originalLineIndex: 9 }],
          stockDispositions: [{ productId: faucet2Id, eligibleReturnedQuantity: 1 }],
        });
      expect(badIdx.status).toBe(400);

      // Removing ₱50 PUSH_TYPE line (keeping originalLineIndex: 1 = ₱70 TWIST_TYPE) refunds ₱50 and keeps ₱70 TWIST_TYPE
      const remove50Prep = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(mixedReplRef)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Remove ₱50 Push-Type unit, keep ₱70 Twist-Type unit",
          prepareKey: "t3-f3-rem-50",
          items: [{ kind: "MERCHANDISE", productId: faucet2Id, quantity: 1, originalLineIndex: 1 }],
          stockDispositions: [{ productId: faucet2Id, eligibleReturnedQuantity: 1 }],
        });
      expect(remove50Prep.status).toBe(201);
      expect(remove50Prep.body.action.correctedTotalCentavos).toBe(7000);
      expect(remove50Prep.body.action.cashDirection).toBe("REFUND");
      expect(remove50Prep.body.action.cashDifferenceCentavos).toBe(-5000);
      expect(remove50Prep.body.action.correctedItems).toEqual([
        expect.objectContaining({
          quantity: 1,
          unitPriceCentavos: 7000,
          faucetReportingType: "TWIST_TYPE",
        }),
      ]);

      // Reusing prepareKey with originalLineIndex: 0 (₱50 line instead of ₱70 line) is rejected with 409 PAYLOAD_MISMATCH
      const mismatchIdxReplay = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(mixedReplRef)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Remove ₱50 Push-Type unit, keep ₱70 Twist-Type unit",
          prepareKey: "t3-f3-rem-50",
          items: [{ kind: "MERCHANDISE", productId: faucet2Id, quantity: 1, originalLineIndex: 0 }],
          stockDispositions: [{ productId: faucet2Id, eligibleReturnedQuantity: 1 }],
        });
      expect(mismatchIdxReplay.status).toBe(409);
      expect(mismatchIdxReplay.body.error.code).toBe("PAYLOAD_MISMATCH");

      // Cancel no-cash, then remove ₱70 TWIST_TYPE line (keeping originalLineIndex: 0 = ₱50 PUSH_TYPE) -> refunds ₱70 and keeps ₱50 PUSH_TYPE
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(remove50Prep.body.action.reference)}/cancel`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ noCashExchangedConfirmed: true })
        ).status,
      ).toBe(200);

      const remove70Prep = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(mixedReplRef)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Remove ₱70 Twist-Type unit, keep ₱50 Push-Type unit",
          prepareKey: "t3-f3-rem-70",
          items: [{ kind: "MERCHANDISE", productId: faucet2Id, quantity: 1, originalLineIndex: 0 }],
          stockDispositions: [{ productId: faucet2Id, eligibleReturnedQuantity: 1 }],
        });
      expect(remove70Prep.status).toBe(201);
      expect(remove70Prep.body.action.correctedTotalCentavos).toBe(5000);
      expect(remove70Prep.body.action.cashDirection).toBe("REFUND");
      expect(remove70Prep.body.action.cashDifferenceCentavos).toBe(-7000);
      expect(remove70Prep.body.action.correctedItems).toEqual([
        expect.objectContaining({
          quantity: 1,
          unitPriceCentavos: 5000,
          faucetReportingType: "PUSH_TYPE",
        }),
      ]);
      const remove70Conf = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(remove70Prep.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true });
      expect(remove70Conf.status).toBe(201);
      expect(remove70Conf.body.action.cashRefundedCentavos).toBe(7000);
      expect(remove70Conf.body.replacementSale.items[0]).toMatchObject({
        unitPriceCentavos: 5000,
        faucetReportingType: "PUSH_TYPE",
      });

      // Exchange retry regression: sell ₱50 PUSH_TYPE, update to ₱70 TWIST_TYPE, exchange selected originalLineIndex: 0
      const exchFaucetId = await createMerchProduct({
        name: "Exchange Retry Faucet",
        unitPriceCentavos: 5000,
        openingQuantity: 3,
        faucetReportingType: "PUSH_TYPE",
      });
      const exchOrig = await saveSale(
        cashier,
        "t3-f3-exch-orig",
        [{ kind: "MERCHANDISE", productId: exchFaucetId, quantity: 1 }],
        5000,
      );
      expect(
        (
          await request(ctx.app)
            .patch(`/api/inventory/products/${exchFaucetId}`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ unitPriceCentavos: 7000, faucetReportingType: "TWIST_TYPE" })
        ).status,
      ).toBe(200);

      const exchPayload = {
        actionType: "CORRECT",
        reason: "Physical exchange for updated faucet",
        prepareKey: "t3-f3-exch-retry",
        items: [{ kind: "MERCHANDISE", productId: exchFaucetId, quantity: 1, originalLineIndex: 0 }],
        stockDispositions: [
          { productId: exchFaucetId, exchangedQuantity: 1, eligibleReturnedQuantity: 1 },
        ],
      };
      const firstExch = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(exchOrig.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send(exchPayload);
      expect(firstExch.status).toBe(201);
      expect(firstExch.body.action.correctedTotalCentavos).toBe(7000);
      expect(firstExch.body.action.cashDifferenceCentavos).toBe(2000);
      expect(firstExch.body.action.correctedItems).toEqual([
        expect.objectContaining({
          quantity: 1,
          unitPriceCentavos: 7000,
          faucetReportingType: "TWIST_TYPE",
        }),
      ]);

      // Identical retry with same prepareKey must replay cleanly and keep one reservation
      const identicalRetry = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(exchOrig.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send(exchPayload);
      expect(identicalRetry.status).toBe(200);
      expect(identicalRetry.body.replayed).toBe(true);
      expect(identicalRetry.body.action.reference).toBe(firstExch.body.action.reference);

      const { rows: commitCount } = await ctx.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM pos_sale_action_stock_commitments c
           JOIN pos_sale_action_requests r ON r.id = c.sale_action_id
          WHERE r.reference = $1 AND c.status = 'ACTIVE'`,
        [firstExch.body.action.reference],
      );
      expect(commitCount[0]!.count).toBe("1");

      // Changing disposition (exchangedQuantity: 0) or removing originalLineIndex under same key must still return 409 PAYLOAD_MISMATCH
      const changedDispositionRetry = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(exchOrig.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          ...exchPayload,
          stockDispositions: [],
        });
      expect(changedDispositionRetry.status).toBe(409);
      expect(changedDispositionRetry.body.error.code).toBe("PAYLOAD_MISMATCH");

      const changedIndexRetry = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(exchOrig.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          ...exchPayload,
          items: [{ kind: "MERCHANDISE", productId: exchFaucetId, quantity: 1 }],
        });
      expect(changedIndexRetry.status).toBe(409);
      expect(changedIndexRetry.body.error.code).toBe("PAYLOAD_MISMATCH");
    });
  });

  describe("Final POS Task 4 — End Day races & integrated reporting", () => {
    async function initRound(stockQuantity: number) {
      expect(
        (
          await request(ctx.app)
            .patch("/api/inventory/containers/ROUND")
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ showInPos: true })
        ).status,
      ).toBe(200);
      const opening = await request(ctx.app)
        .post("/api/inventory/items/ROUND/opening-stock")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ quantity: stockQuantity });
      expect(opening.status).toBe(201);
      return opening.body.item.id as string;
    }

    async function initProduct(input: {
      name: string;
      unitPriceCentavos: number;
      openingQuantity: number;
      faucetReportingType?: "PUSH_TYPE" | "TWIST_TYPE" | null;
    }) {
      const created = await request(ctx.app)
        .post("/api/inventory/products")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          name: input.name,
          unit: "pcs",
          unitConfirmed: true,
          unitPriceCentavos: input.unitPriceCentavos,
          showInPos: true,
          posSection: "TAKIP_ACCESSORIES",
          faucetReportingType: input.faucetReportingType ?? null,
        });
      expect(created.status).toBe(201);
      const id = created.body.item.id as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/inventory/items/${id}/opening-stock`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ quantity: input.openingQuantity })
        ).status,
      ).toBe(201);
      return id;
    }

    async function saveSale(
      actor: Parameters<typeof prepareCheckout>[1],
      prepareKey: string,
      items: unknown[],
      cashReceivedCentavos: number,
    ) {
      const prep = await prepareCheckout(ctx, actor, { prepareKey, items });
      expect(prep.status).toBe(201);
      const conf = await confirmCheckout(
        ctx.app,
        actor,
        prep.body.checkout.reference as string,
        { cashReceivedCentavos },
      );
      expect(conf.status).toBe(201);
      return conf.body.sale as {
        reference: string;
        totalCentavos: number;
      };
    }

    it("serializes concurrent End Day against sale-action preparation without allowing both to commit", async () => {
      expect((await startDay(ctx, owner, { requestKey: "t4-race1-day" })).status).toBe(201);
      const sale = await saveSale(
        cashier,
        "t4-race1-sale",
        [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
        5000,
      );

      const [endRes, prepRes] = await Promise.all([
        endDay(ctx, owner, { requestKey: "t4-race1-end" }),
        request(ctx.app)
          .post(`/api/pos/sales/${encodeURIComponent(sale.reference)}/actions`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({
            actionType: "VOID",
            reason: "Concurrent prepare vs End Day",
            prepareKey: "t4-race1-void",
          }),
      ]);

      if (endRes.status === 200) {
        expect(prepRes.status).toBe(409);
        expect(prepRes.body.error.code).toBe("DAY_CLOSED");
        expect(endRes.body.summary).toMatchObject({
          validTransactionCount: 1,
          totalSalesCentavos: 5000,
        });
      } else {
        expect(endRes.status).toBe(409);
        expect(endRes.body.error.code).toBe("UNRESOLVED_SALE_ACTIONS");
        expect(prepRes.status).toBe(201);
        expect(endRes.body.blockingSaleActions).toEqual([
          expect.objectContaining({
            reference: prepRes.body.action.reference,
            originalSaleReference: sale.reference,
          }),
        ]);
      }
    });

    it("serializes concurrent End Day against sale-action confirmation so active replacements count once", async () => {
      expect((await startDay(ctx, owner, { requestKey: "t4-race2-day" })).status).toBe(201);
      const sale = await saveSale(
        cashier,
        "t4-race2-sale",
        [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
        5000,
      );
      const prep = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(sale.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Upgrade to 2 refills",
          prepareKey: "t4-race2-corr",
          items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
        });
      expect(prep.status).toBe(201);
      const actionRef = prep.body.action.reference as string;

      const [endRes, confRes] = await Promise.all([
        endDay(ctx, owner, { requestKey: "t4-race2-end-1" }),
        request(ctx.app)
          .post(`/api/pos/sale-actions/${encodeURIComponent(actionRef)}/confirm`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ cashConfirmed: true, cashTenderedCentavos: 5000 }),
      ]);

      expect(confRes.status).toBe(201);
      if (endRes.status === 200) {
        expect(endRes.body.summary).toMatchObject({
          validTransactionCount: 1,
          totalSalesCentavos: 5000,
          voidedCount: 1,
          voidedTotalCentavos: 2500,
        });
      } else {
        expect(endRes.status).toBe(409);
        expect(endRes.body.error.code).toBe("UNRESOLVED_SALE_ACTIONS");
        const finalEnd = await endDay(ctx, owner, { requestKey: "t4-race2-end-2" });
        expect(finalEnd.status).toBe(200);
        expect(finalEnd.body.summary).toMatchObject({
          validTransactionCount: 1,
          totalSalesCentavos: 5000,
          voidedCount: 1,
          voidedTotalCentavos: 2500,
        });
      }
    });

    it("reconciles End Day, Dashboard Sales, Container/Faucet breakdowns, prior-day settlements, and Stock Trend across all movement types", async () => {
      const roundId = await initRound(5);
      ctx.clock.advance(5_000);
      const pushId = await initProduct({
        name: "Push Faucet Pro",
        unitPriceCentavos: 4000,
        openingQuantity: 5,
        faucetReportingType: "PUSH_TYPE",
      });
      ctx.clock.advance(5_000);
      const twistId = await initProduct({
        name: "Twist Faucet Pro",
        unitPriceCentavos: 6000,
        openingQuantity: 5,
        faucetReportingType: "TWIST_TYPE",
      });
      ctx.clock.advance(5_000);
      expect((await startDay(ctx, owner, { requestKey: "t4-int-day1" })).status).toBe(201);
      ctx.clock.advance(5_000);

      // Sale A: 1x ROUND_PURIFIED (25 L, ₱200, included Push gripo) + 1x standalone Push Faucet (₱40) = ₱240
      const saleA = await saveSale(
        cashier,
        "t4-int-sale-a",
        [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "PUSH_TYPE",
            quantity: 1,
          },
          { kind: "MERCHANDISE", productId: pushId, quantity: 1 },
        ],
        30000,
      );
      expect(saleA.totalCentavos).toBe(24000);

      // Correct Sale A -> 1x ROUND_ALKALINE (25 L, ₱210, retained same container) + 1x standalone Twist Faucet (₱60, returning Push Faucet) = ₱270
      ctx.clock.advance(5_000);
      const prepCorrA = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleA.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "CORRECT",
          reason: "Switch to Alkaline container package and Twist Faucet",
          prepareKey: "t4-int-corr-a",
          items: [
            {
              kind: "CONTAINER_PACKAGE",
              packageCode: "ROUND_ALKALINE",
              includedGripo: "PUSH_TYPE",
              quantity: 1,
            },
            { kind: "MERCHANDISE", productId: twistId, quantity: 1 },
          ],
          stockDispositions: [{ productId: pushId, eligibleReturnedQuantity: 1 }],
        });
      expect(prepCorrA.status).toBe(201);
      const confCorrA = await request(ctx.app)
        .post(`/api/pos/sale-actions/${encodeURIComponent(prepCorrA.body.action.reference)}/confirm`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ cashConfirmed: true, cashTenderedCentavos: 5000 });
      expect(confCorrA.status).toBe(201);

      // Sale B: 2x Standard Purified Refill (₱50), then Void Sale B
      ctx.clock.advance(5_000);
      const saleB = await saveSale(
        cashier,
        "t4-int-sale-b",
        [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
        5000,
      );
      ctx.clock.advance(5_000);
      const prepVoidB = await request(ctx.app)
        .post(`/api/pos/sales/${encodeURIComponent(saleB.reference)}/actions`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({
          actionType: "VOID",
          reason: "Cancelled refill",
          prepareKey: "t4-int-void-b",
        });
      expect(prepVoidB.status).toBe(201);
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/sale-actions/${encodeURIComponent(prepVoidB.body.action.reference)}/confirm`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ cashConfirmed: true })
        ).status,
      ).toBe(201);

      // Leave one Day 1 merchandise-only checkout PAYMENT_PENDING across Manila midnight
      ctx.clock.advance(5_000);
      const pendingMerch = await prepareCheckout(ctx, cashier, {
        prepareKey: "t4-int-prior-merch",
        items: [{ kind: "MERCHANDISE", productId: twistId, quantity: 1 }],
      });
      expect(pendingMerch.status).toBe(201);
      const pendingRef = pendingMerch.body.checkout.reference as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/begin-payment`)
            .set("Cookie", cashier.cookie)
            .set("X-CSRF-Token", cashier.csrfToken)
            .send({})
        ).status,
      ).toBe(200);

      // Advance past Manila midnight to Day 2 (2026-11-10) and re-authenticate expired session
      ctx.clock.set("2026-11-10T09:00:00+08:00");
      const ownerDay2 = await reauth(ctx, "owner1", owner);
      // Run INV-009 physical count reconciliation on Push Faucet (5 -> 4) before closing Day 1
      const invBeforeRec = await request(ctx.app).get("/api/inventory/items").set("Cookie", ownerDay2.cookie);
      expect(invBeforeRec.status).toBe(200);
      const pushInvBefore = invBeforeRec.body.items.find((i: { id: string }) => i.id === pushId);
      expect(
        (
          await request(ctx.app)
            .post(`/api/inventory/items/${pushId}/reconciliations`)
            .set("Cookie", ownerDay2.cookie)
            .set("X-CSRF-Token", ownerDay2.csrfToken)
            .send({
              physicalCount: 4,
              reason: "Sample physical count adjustment",
              expectedRevision: pushInvBefore.stockRevision,
              expectedCurrentQuantity: pushInvBefore.currentQuantity,
              requestKey: "t4-int-rec-push",
            })
        ).status,
      ).toBe(201);

      // Settle Day 1's merchandise-only prior-day checkout on Day 2 (2026-11-10) before closing Day 1
      ctx.clock.advance(5_000);
      const settlePrior = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/settle`)
        .set("Cookie", ownerDay2.cookie)
        .set("X-CSRF-Token", ownerDay2.csrfToken)
        .send({
          paymentKeptConfirmed: true,
          itemsHandedOverConfirmed: true,
        });
      expect(settlePrior.status).toBe(201);

      // End Day 1 late on Day 2: summary keeps only Day 1's Active replacement (₱270, 25 L Alkaline) + 2 voided originals (₱240 + ₱50)
      ctx.clock.advance(5_000);
      const closeDay1 = await endDay(ctx, ownerDay2, { requestKey: "t4-int-end-day1" });
      expect(closeDay1.status).toBe(200);
      expect(closeDay1.body.summary).toMatchObject({
        businessDate: "2026-11-09",
        totalSalesCentavos: 27000,
        validTransactionCount: 1,
        purifiedQuantity: 0,
        alkalineQuantity: 1,
        purifiedVolumeMl: 0,
        alkalineVolumeMl: 25000,
        voidedCount: 2,
        voidedTotalCentavos: 29000,
      });

      // Start Day 2 and re-verify Day 1's closed snapshot stays preserved and prior-day settlement appears separately on Day 2
      ctx.clock.advance(5_000);
      expect((await startDay(ctx, ownerDay2, { requestKey: "t4-int-start-day2" })).status).toBe(201);

      const dashDay1 = await request(ctx.app)
        .get("/api/dashboard/sales?period=custom&from=2026-11-09&to=2026-11-09")
        .set("Cookie", ownerDay2.cookie);
      expect(dashDay1.status).toBe(200);
      expect(dashDay1.body.totals).toEqual({
        salesCentavos: 27000,
        containersRefilled: 0,
        waterVolumeMl: 25000,
        transactions: 1,
      });
      expect(dashDay1.body.priorDaySettlements).toEqual([]);
      expect(dashDay1.body.containerSales).toMatchObject({
        totalUnits: 1,
        totalSalesCentavos: 21000,
      });
      expect(dashDay1.body.faucetSales).toMatchObject({
        totalUnits: 1,
        totalSalesCentavos: 6000,
        leader: "TWIST_TYPE",
      });

      const dashDay2 = await request(ctx.app)
        .get("/api/dashboard/sales?period=today")
        .set("Cookie", ownerDay2.cookie);
      expect(dashDay2.status).toBe(200);
      expect(dashDay2.body.totals).toEqual({
        salesCentavos: 0,
        containersRefilled: 0,
        waterVolumeMl: 0,
        transactions: 0,
      });
      expect(dashDay2.body.priorDaySettlements).toHaveLength(1);
      expect(dashDay2.body.priorDaySettlements[0].netAmountKeptCentavos).toBe(6000);

      // Verify COMPLETE Stock Trend chains across all movement types (OPENING_COUNT, POS_SALE, SALE_ACTION_RESTORATION, SALE_ACTION_DEDUCTION, PRIOR_DAY_SETTLEMENT, PHYSICAL_COUNT_RECONCILIATION)
      const [pushTrend, twistTrend, roundTrend] = await Promise.all([
        request(ctx.app).get(`/api/dashboard/stocks/${pushId}/trend`).set("Cookie", ownerDay2.cookie),
        request(ctx.app).get(`/api/dashboard/stocks/${twistId}/trend`).set("Cookie", ownerDay2.cookie),
        request(ctx.app).get(`/api/dashboard/stocks/${roundId}/trend`).set("Cookie", ownerDay2.cookie),
      ]);
      expect(pushTrend.status).toBe(200);
      expect(pushTrend.body.historyState).toBe("COMPLETE");
      expect(pushTrend.body.points.map((p: { movementType: string }) => p.movementType)).toEqual([
        "OPENING_COUNT",
        "POS_SALE",
        "SALE_ACTION_RESTORATION",
        "PHYSICAL_COUNT_RECONCILIATION",
      ]);

      expect(twistTrend.status).toBe(200);
      expect(twistTrend.body.historyState).toBe("COMPLETE");
      expect(twistTrend.body.points.map((p: { movementType: string }) => p.movementType)).toEqual([
        "OPENING_COUNT",
        "SALE_ACTION_DEDUCTION",
        "PRIOR_DAY_SETTLEMENT",
      ]);

      expect(roundTrend.status).toBe(200);
      expect(roundTrend.body.historyState).toBe("COMPLETE");
      expect(roundTrend.body.points.map((p: { movementType: string }) => p.movementType)).toEqual([
        "OPENING_COUNT",
        "POS_SALE",
      ]);
    });
  });
});
