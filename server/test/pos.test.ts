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

      // Missing either confirmation keeps the checkout pending.
      const missingDelivery = await request(ctx.app)
        .post(`/api/pos/checkouts/${encodeURIComponent(priorRef)}/settle`)
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send({ paymentKeptConfirmed: true, refillDeliveredConfirmed: false });
      expect(missingDelivery.status).toBe(400);
      expect(missingDelivery.body.error.code).toBe("VALIDATION_FAILED");

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
      expect(lookupAfterMidnight.body.checkout).toMatchObject({
        status: "CANCELLED_DRAFT",
        resolutionReason: "CLEARED_ON_END_DAY",
      });
      expect(lookupAfterMidnight.body.canSettlePriorDay).toBe(false);

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

      // Delayed confirm on explicitRef AFTER day close STILL preserves CANCELLED_DRAFT & its reason
      const confirmAfterClose = await confirmCheckout(ctx.app, cashier, explicitRef, {
        cashReceivedCentavos: 10000,
      });
      expect(confirmAfterClose.status).toBe(409);
      expect(confirmAfterClose.body.error.code).toBe("CHECKOUT_CANCELLED");

      const lookupAfterClose = await request(ctx.app)
        .get(`/api/pos/checkouts/${explicitRef}`)
        .set("Cookie", owner.cookie);
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
});
