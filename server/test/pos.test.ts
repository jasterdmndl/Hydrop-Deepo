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

      // Next business day: mixed refill + merchandise checkout crossing midnight remains pending (DEC-075 covers merchandise-only only).
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
      expect(priorLookup.body.canSettlePriorDay).toBe(false);

      const settleMixed = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, itemsHandedOverConfirmed: true });
      expect(settleMixed.status).toBe(409);
      expect(settleMixed.body.error.code).toBe("CHECKOUT_NOT_SETTLABLE");
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
});
