import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Database } from "../src/db/database.js";
import { classifyStandaloneMerchandiseFaucet } from "../src/modules/dashboard/salesReport.js";
import { ManualClock } from "../src/shared/clock.js";
import {
  activatedAccount,
  createTestContext,
  provision,
  signIn,
  type SignedIn,
  type TestContext,
} from "./helpers.js";

// 2026-11-15 23:59:59+08:00 (Sunday night in Manila, 15:59:59Z UTC)
const SUNDAY_BEFORE_MIDNIGHT_MANILA = "2026-11-15T15:59:59.000Z";

type Activated = SignedIn & { password: string };

async function reauth(ctx: TestContext, username: string, actor: Activated): Promise<Activated> {
  const fresh = await signIn(ctx.app, username, actor.password);
  return { ...fresh, password: actor.password };
}

async function startDay(ctx: TestContext, actor: SignedIn, requestKey: string) {
  return request(ctx.app)
    .post("/api/pos/day/start")
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send({ requestKey });
}

async function endDay(ctx: TestContext, actor: SignedIn, requestKey: string) {
  return request(ctx.app)
    .post("/api/pos/day/end")
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send({ requestKey });
}

async function sellCart(
  ctx: TestContext,
  actor: SignedIn,
  items: unknown[],
  cashReceivedCentavos: number,
  prepareKey: string,
) {
  const prep = await request(ctx.app)
    .post("/api/pos/checkouts")
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send({ prepareKey, items });
  expect(prep.status).toBe(201);
  const reference = prep.body.checkout.reference as string;

  const confirm = await request(ctx.app)
    .post(`/api/pos/checkouts/${encodeURIComponent(reference)}/confirm`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send({ cashReceivedCentavos, items });
  expect(confirm.status).toBe(201);
  return confirm.body.sale as { reference: string; totalCentavos: number };
}

describe("Dashboard sales report and authorization (DEC-076)", () => {
  let ctx: TestContext;
  let owner: Activated;
  let cashier: Activated;

  beforeEach(async () => {
    ctx = await createTestContext({ clock: new ManualClock(SUNDAY_BEFORE_MIDNIGHT_MANILA) });
    owner = await activatedAccount(ctx, "owner1", "OWNER");
    cashier = await activatedAccount(ctx, "cashier1", "CASHIER");
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("enforces authentication, password activation, and Owner-only role access on GET /api/dashboard/sales", async () => {
    const anon = await request(ctx.app).get("/api/dashboard/sales");
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe("UNAUTHENTICATED");

    const { temporaryPassword } = await provision(ctx.db, "owner_temp", "OWNER");
    const unactivated = await signIn(ctx.app, "owner_temp", temporaryPassword);
    const blocked = await request(ctx.app).get("/api/dashboard/sales").set("Cookie", unactivated.cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");

    const cashierRes = await request(ctx.app)
      .get("/api/dashboard/sales")
      .set("Cookie", cashier.cookie)
      .set("X-Role", "OWNER")
      .query({ role: "OWNER" });
    expect(cashierRes.status).toBe(403);
    expect(cashierRes.body.error.code).toBe("FORBIDDEN");

    const ownerRes = await request(ctx.app).get("/api/dashboard/sales").set("Cookie", owner.cookie);
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body.range.period).toBe("week");
  });

  it("resolves Today, Monday-to-today This Week, Month-to-date, and inclusive Custom across Manila midnight and honors request cutoff", async () => {
    // At 2026-11-15T15:59:59Z -> Sunday 2026-11-15 23:59:59+08:00
    const sunWeek = await request(ctx.app).get("/api/dashboard/sales").set("Cookie", owner.cookie);
    expect(sunWeek.status).toBe(200);
    expect(sunWeek.body.range).toMatchObject({
      period: "week",
      from: "2026-11-09",
      to: "2026-11-15",
      todayDate: "2026-11-15",
      cutoffAt: "2026-11-15T23:59:59+08:00",
    });

    const sunToday = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(sunToday.status).toBe(200);
    expect(sunToday.body.range).toMatchObject({
      period: "today",
      from: "2026-11-15",
      to: "2026-11-15",
      todayDate: "2026-11-15",
    });

    const sunMonth = await request(ctx.app)
      .get("/api/dashboard/sales?period=month")
      .set("Cookie", owner.cookie);
    expect(sunMonth.status).toBe(200);
    expect(sunMonth.body.range).toMatchObject({
      period: "month",
      from: "2026-11-01",
      to: "2026-11-15",
      todayDate: "2026-11-15",
    });

    const sunCustom = await request(ctx.app)
      .get("/api/dashboard/sales?period=custom&from=2026-11-10&to=2026-11-15")
      .set("Cookie", owner.cookie);
    expect(sunCustom.status).toBe(200);
    expect(sunCustom.body.range).toMatchObject({
      period: "custom",
      from: "2026-11-10",
      to: "2026-11-15",
    });
    expect(sunCustom.body.trend).toHaveLength(6);

    // Cross Manila midnight by 1 second: 2026-11-15T16:00:00Z -> Monday 2026-11-16 00:00:00+08:00
    ctx.clock.set("2026-11-15T16:00:00.000Z");
    const monWeek = await request(ctx.app).get("/api/dashboard/sales").set("Cookie", owner.cookie);
    expect(monWeek.status).toBe(200);
    expect(monWeek.body.range).toMatchObject({
      period: "week",
      from: "2026-11-16",
      to: "2026-11-16",
      todayDate: "2026-11-16",
      cutoffAt: "2026-11-16T00:00:00+08:00",
    });

    const monToday = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(monToday.status).toBe(200);
    expect(monToday.body.range).toMatchObject({
      period: "today",
      from: "2026-11-16",
      to: "2026-11-16",
    });

    // Reject reversed, invalid, future, incomplete, or unknown period queries with 400
    const invalidQueries = [
      "/api/dashboard/sales?period=year",
      "/api/dashboard/sales?period=custom",
      "/api/dashboard/sales?period=custom&from=2026-11-10",
      "/api/dashboard/sales?period=custom&to=2026-11-15",
      "/api/dashboard/sales?period=custom&from=2026-11-15&to=2026-11-10",
      "/api/dashboard/sales?period=custom&from=2026-02-30&to=2026-11-15",
      "/api/dashboard/sales?period=custom&from=2026-11-16&to=2026-11-17",
      "/api/dashboard/sales?period=custom&from=2026-11-17&to=2026-11-18",
      "/api/dashboard/sales?period=custom&from=2025-10-01&to=2026-11-16",
    ];
    for (const url of invalidQueries) {
      const bad = await request(ctx.app).get(url).set("Cookie", owner.cookie);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("VALIDATION_FAILED");
    }

    // Single request cutoff: sale recorded at 08:10 Manila is excluded if queried at 08:05 Manila
    ctx.clock.set("2026-11-16T08:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "cutoff-day")).status).toBe(201);

    ctx.clock.set("2026-11-16T08:10:00+08:00");
    await sellCart(ctx, owner, [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }], 5000, "later-sale");

    ctx.clock.set("2026-11-16T08:05:00+08:00");
    const earlierCutoff = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(earlierCutoff.status).toBe(200);
    expect(earlierCutoff.body.totals).toEqual({
      salesCentavos: 0,
      containersRefilled: 0,
      waterVolumeMl: 0,
      transactions: 0,
    });

    ctx.clock.set("2026-11-16T08:12:00+08:00");
    const laterCutoff = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(laterCutoff.status).toBe(200);
    expect(laterCutoff.body.totals).toEqual({
      salesCentavos: 2500,
      containersRefilled: 1,
      waterVolumeMl: 25000,
      transactions: 1,
    });
  });

  it("reconciles mixed carts, merchandise-only receipts, multi-quantity refills, voided sales, and archived/repriced product snapshots", async () => {
    ctx.clock.set("2026-11-16T09:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    cashier = await reauth(ctx, "cashier1", cashier);

    // Initialize Slim container opening stock & publish Slim to POS
    expect(
      (
        await request(ctx.app)
          .post("/api/inventory/items/SLIM/opening-stock")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ quantity: 5 })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(ctx.app)
          .patch("/api/inventory/containers/SLIM")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ showInPos: true })
      ).status,
    ).toBe(200);

    // Initialize Round container opening stock & publish Round to POS
    expect(
      (
        await request(ctx.app)
          .post("/api/inventory/items/ROUND/opening-stock")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ quantity: 5 })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(ctx.app)
          .patch("/api/inventory/containers/ROUND")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ showInPos: true })
      ).status,
    ).toBe(200);

    // Create standalone merchandise product (Big Cap PHP 20) & set opening stock 10
    const capRes = await request(ctx.app)
      .post("/api/inventory/products")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        name: "Big Cap",
        description: "Large cap",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 2000,
        showInPos: true,
        posSection: "TAKIP_ACCESSORIES",
      });
    expect(capRes.status).toBe(201);
    const capId = capRes.body.item.id as string;
    expect(
      (
        await request(ctx.app)
          .post(`/api/inventory/items/${encodeURIComponent(capId)}/opening-stock`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ quantity: 10 })
      ).status,
    ).toBe(201);

    expect((await startDay(ctx, owner, "agg-day")).status).toBe(201);

    // 1) Mixed cart: 1 x 8 L Custom Purified (PHP 15) + 1 x 25 L filled Slim (PHP 200)
    await sellCart(
      ctx,
      cashier,
      [
        {
          kind: "CUSTOM",
          waterType: "PURIFIED",
          unitVolumeLiters: 8,
          unitPriceCentavos: 1500,
          quantity: 1,
        },
        {
          kind: "CONTAINER_PACKAGE",
          packageCode: "SLIM_PURIFIED",
          includedGripo: "TWIST_TYPE",
          quantity: 1,
        },
      ],
      25000,
      "mixed-cart-1",
    );

    const afterMixed = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(afterMixed.status).toBe(200);
    expect(afterMixed.body.totals).toEqual({
      salesCentavos: 21500,
      containersRefilled: 1,
      waterVolumeMl: 33000,
      transactions: 1,
    });
    expect(afterMixed.body.service).toEqual([
      {
        waterType: "PURIFIED",
        containers: 1,
        waterVolumeMl: 8000,
        salesCentavos: 1500,
        sharePercent: 100,
      },
      {
        waterType: "ALKALINE",
        containers: 0,
        waterVolumeMl: 0,
        salesCentavos: 0,
        sharePercent: 0,
      },
    ]);

    // 2) Merchandise-only receipt: 2 x Big Cap (PHP 40) + 1 x Empty Round (PHP 175) = PHP 215
    await sellCart(
      ctx,
      cashier,
      [
        { kind: "MERCHANDISE", productId: capId, quantity: 2 },
        {
          kind: "CONTAINER_PACKAGE",
          packageCode: "ROUND_EMPTY",
          includedGripo: "PUSH_TYPE",
          quantity: 1,
        },
      ],
      25000,
      "merch-only-1",
    );

    // 3) Multi-quantity Standard & Custom refills:
    //    2 x Standard Purified (5000 centavos, 50000 mL)
    //    3 x Standard Alkaline (10500 centavos, 75000 mL)
    //    2 x Custom Alkaline 11 L @ PHP 20 (4000 centavos, 22000 mL)
    await sellCart(
      ctx,
      owner,
      [
        { kind: "STANDARD", waterType: "PURIFIED", quantity: 2 },
        { kind: "STANDARD", waterType: "ALKALINE", quantity: 3 },
        {
          kind: "CUSTOM",
          waterType: "ALKALINE",
          unitVolumeLiters: 11,
          unitPriceCentavos: 2000,
          quantity: 2,
        },
      ],
      25000,
      "multi-refills-1",
    );

    // 4) A sale that is later marked VOIDED must be excluded completely
    const voidedSale = await sellCart(
      ctx,
      owner,
      [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 4 }],
      10000,
      "will-be-voided",
    );
    await ctx.db.query(`UPDATE pos_sales SET status = 'VOIDED' WHERE reference = $1`, [
      voidedSale.reference,
    ]);

    // 5) Reprice and archive Big Cap afterwards: saved sale snapshot must stay unchanged
    expect(
      (
        await request(ctx.app)
          .patch(`/api/inventory/products/${encodeURIComponent(capId)}`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ unitPriceCentavos: 9900 })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app)
          .post(`/api/inventory/products/${encodeURIComponent(capId)}/archive`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({})
      ).status,
    ).toBe(200);

    const finalRes = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(finalRes.status).toBe(200);

    // Totals:
    //   Tx 1 (mixed): 21500 centavos, 1 standalone refill, 33000 mL
    //   Tx 2 (merch): 21500 centavos, 0 standalone refills, 0 mL
    //   Tx 3 (multi): 5000 + 10500 + 4000 = 19500 centavos, 7 standalone refills, 147000 mL
    //   Sum = 62500 centavos, 8 standalone refills, 180000 mL, 3 transactions
    expect(finalRes.body.totals).toEqual({
      salesCentavos: 62500,
      containersRefilled: 8,
      waterVolumeMl: 180000,
      transactions: 3,
    });

    // Purified standalone: 1 + 2 = 3 (3/8 = 37.5%), 1500 + 5000 = 6500 centavos, 8000 + 50000 = 58000 mL
    // Alkaline standalone: 3 + 2 = 5 (5/8 = 62.5%), 10500 + 4000 = 14500 centavos, 75000 + 22000 = 97000 mL
    expect(finalRes.body.service).toEqual([
      {
        waterType: "PURIFIED",
        containers: 3,
        waterVolumeMl: 58000,
        salesCentavos: 6500,
        sharePercent: 37.5,
      },
      {
        waterType: "ALKALINE",
        containers: 5,
        waterVolumeMl: 97000,
        salesCentavos: 14500,
        sharePercent: 62.5,
      },
    ]);

    const trendSum = (finalRes.body.trend as Array<{ salesCentavos: number | null }>).reduce(
      (sum, point) => sum + (point.salesCentavos ?? 0),
      0,
    );
    expect(trendSum).toBe(finalRes.body.totals.salesCentavos);
  });

  it("keeps prior-day settlements separate on their settlement date and distinguishes zero-sale days from unrecorded days", async () => {
    // Day 1 (Nov 10): open, 1 voided sale + 1 unsettled PAYMENT_PENDING checkout; close after settling next day
    ctx.clock.set("2026-11-10T09:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "day1-start")).status).toBe(201);

    const voidSale = await sellCart(
      ctx,
      owner,
      [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      5000,
      "day1-voided",
    );
    await ctx.db.query(`UPDATE pos_sales SET status = 'VOIDED' WHERE reference = $1`, [
      voidSale.reference,
    ]);

    const pendingPrep = await request(ctx.app)
      .post("/api/pos/checkouts")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        prepareKey: "day1-pending-1",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 2 }],
      });
    expect(pendingPrep.status).toBe(201);
    const pendingRef = pendingPrep.body.checkout.reference as string;
    const beginPending = await request(ctx.app)
      .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/begin-payment`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({});
    expect(beginPending.status).toBe(200);

    // Skip Day 2 (Nov 11): NO business day recorded
    // Advance to Day 3 (Nov 12): settle Day 1 pending checkout, close Day 1, open Day 3 with 1 sale
    ctx.clock.set("2026-11-12T09:30:00+08:00");
    owner = await reauth(ctx, "owner1", owner);

    const settled = await request(ctx.app)
      .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/settle`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        paymentKeptConfirmed: true,
        refillDeliveredConfirmed: true,
        cashReceivedCentavos: 10000,
        note: "Collected cash before power blink",
      });
    expect(settled.status).toBe(201);

    expect((await endDay(ctx, owner, "day1-close")).status).toBe(200);
    expect((await startDay(ctx, owner, "day3-start")).status).toBe(201);

    await sellCart(
      ctx,
      owner,
      [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      5000,
      "day3-sale-1",
    );

    // Day 1 custom query: Day 1 has known zero active sales, and NO prior-day settlements (settled on Nov 12)
    const day1Report = await request(ctx.app)
      .get("/api/dashboard/sales?period=custom&from=2026-11-10&to=2026-11-10")
      .set("Cookie", owner.cookie);
    expect(day1Report.status).toBe(200);
    expect(day1Report.body.totals).toEqual({
      salesCentavos: 0,
      containersRefilled: 0,
      waterVolumeMl: 0,
      transactions: 0,
    });
    expect(day1Report.body.trend).toEqual([
      {
        businessDate: "2026-11-10",
        hasBusinessDay: true,
        dayStatus: "CLOSED",
        salesCentavos: 0,
        transactions: 0,
      },
    ]);
    expect(day1Report.body.priorDaySettlements).toEqual([]);

    // Range Nov 10..12: Nov 10 CLOSED 0, Nov 11 NO_RECORD null, Nov 12 OPEN 2500 + settlement on Nov 12 only
    const rangeReport = await request(ctx.app)
      .get("/api/dashboard/sales?period=custom&from=2026-11-10&to=2026-11-12")
      .set("Cookie", owner.cookie);
    expect(rangeReport.status).toBe(200);
    expect(rangeReport.body.range).toMatchObject({
      recordedDayCount: 2,
      missingDayCount: 1,
    });
    expect(rangeReport.body.totals).toEqual({
      salesCentavos: 2500,
      containersRefilled: 1,
      waterVolumeMl: 25000,
      transactions: 1,
    });
    expect(rangeReport.body.trend).toEqual([
      {
        businessDate: "2026-11-10",
        hasBusinessDay: true,
        dayStatus: "CLOSED",
        salesCentavos: 0,
        transactions: 0,
      },
      {
        businessDate: "2026-11-11",
        hasBusinessDay: false,
        dayStatus: "NO_RECORD",
        salesCentavos: null,
        transactions: null,
      },
      {
        businessDate: "2026-11-12",
        hasBusinessDay: true,
        dayStatus: "OPEN",
        salesCentavos: 2500,
        transactions: 1,
      },
    ]);
    expect(rangeReport.body.priorDaySettlements).toEqual([
      {
        checkoutReference: pendingRef,
        originalBusinessDate: "2026-11-10",
        settlementDate: "2026-11-12",
        netAmountKeptCentavos: 7000,
        settledBy: "owner1",
        settledAt: "2026-11-12T09:30:00+08:00",
        note: "Collected cash before power blink",
      },
    ]);

    // Purely historical empty range (Nov 1..3) with no recorded business days
    const emptyHistory = await request(ctx.app)
      .get("/api/dashboard/sales?period=custom&from=2026-11-01&to=2026-11-03")
      .set("Cookie", owner.cookie);
    expect(emptyHistory.status).toBe(200);
    expect(emptyHistory.body.range).toMatchObject({
      recordedDayCount: 0,
      missingDayCount: 3,
    });
    expect(emptyHistory.body.totals).toEqual({
      salesCentavos: 0,
      containersRefilled: 0,
      waterVolumeMl: 0,
      transactions: 0,
    });
    expect(emptyHistory.body.trend).toEqual([
      {
        businessDate: "2026-11-01",
        hasBusinessDay: false,
        dayStatus: "NO_RECORD",
        salesCentavos: null,
        transactions: null,
      },
      {
        businessDate: "2026-11-02",
        hasBusinessDay: false,
        dayStatus: "NO_RECORD",
        salesCentavos: null,
        transactions: null,
      },
      {
        businessDate: "2026-11-03",
        hasBusinessDay: false,
        dayStatus: "NO_RECORD",
        salesCentavos: null,
        transactions: null,
      },
    ]);
    expect(emptyHistory.body.service).toEqual([
      {
        waterType: "PURIFIED",
        containers: 0,
        waterVolumeMl: 0,
        salesCentavos: 0,
        sharePercent: null,
      },
      {
        waterType: "ALKALINE",
        containers: 0,
        waterVolumeMl: 0,
        salesCentavos: 0,
        sharePercent: null,
      },
    ]);
    expect(emptyHistory.body.priorDaySettlements).toEqual([]);
  });

  it("derives all sales metrics from one database snapshot during concurrent POS checkout confirmation (Finding 1)", async () => {
    ctx.clock.set("2026-11-16T09:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    cashier = await reauth(ctx, "cashier1", cashier);
    expect((await startDay(ctx, owner, "concurrent-day")).status).toBe(201);

    const items = [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }];
    const prep = await request(ctx.app)
      .post("/api/pos/checkouts")
      .set("Cookie", cashier.cookie)
      .set("X-CSRF-Token", cashier.csrfToken)
      .send({ prepareKey: "concurrent-prep-1", items });
    expect(prep.status).toBe(201);
    const ref = prep.body.checkout.reference as string;

    const begin = await request(ctx.app)
      .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/begin-payment`)
      .set("Cookie", cashier.cookie)
      .set("X-CSRF-Token", cashier.csrfToken)
      .send({});
    expect(begin.status).toBe(200);

    let reportQueryCount = 0;
    const spiedDb: Database = {
      query(sql, params) {
        if (sql.includes("pos_sale_items") && sql.includes("pos_prior_day_settlements")) {
          reportQueryCount += 1;
        }
        return ctx.db.query(sql, params);
      },
      exec(sql) {
        return ctx.db.exec(sql);
      },
      transaction(fn) {
        return ctx.db.transaction(fn);
      },
      close() {
        return ctx.db.close();
      },
    };
    const spiedApp = createApp({ db: spiedDb, clock: ctx.clock });

    const [confirmRes, reportRes] = await Promise.all([
      request(spiedApp)
        .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/confirm`)
        .set("Cookie", cashier.cookie)
        .set("X-CSRF-Token", cashier.csrfToken)
        .send({ cashReceivedCentavos: 5000, items }),
      request(spiedApp)
        .get("/api/dashboard/sales?period=today")
        .set("Cookie", owner.cookie),
    ]);

    expect(confirmRes.status).toBe(201);
    expect(reportRes.status).toBe(200);
    expect(reportQueryCount).toBe(1);

    const report = reportRes.body;
    const trendSum = (report.trend as Array<{ salesCentavos: number | null }>).reduce(
      (sum, point) => sum + (point.salesCentavos ?? 0),
      0,
    );
    expect(trendSum).toBe(report.totals.salesCentavos);

    const purified = (report.service as Array<{ waterType: string }>).find(
      (s) => s.waterType === "PURIFIED",
    );
    if (report.totals.transactions === 0) {
      expect(report.totals).toEqual({
        salesCentavos: 0,
        containersRefilled: 0,
        waterVolumeMl: 0,
        transactions: 0,
      });
      expect(purified).toEqual({
        waterType: "PURIFIED",
        containers: 0,
        waterVolumeMl: 0,
        salesCentavos: 0,
        sharePercent: null,
      });
    } else {
      expect(report.totals).toEqual({
        salesCentavos: 2500,
        containersRefilled: 1,
        waterVolumeMl: 25000,
        transactions: 1,
      });
      expect(purified).toEqual({
        waterType: "PURIFIED",
        containers: 1,
        waterVolumeMl: 25000,
        salesCentavos: 2500,
        sharePercent: 100,
      });
    }

    // Follow-up read after confirm commits reflects the complete sale across all metrics.
    const afterRes = await request(spiedApp)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(afterRes.status).toBe(200);
    expect(afterRes.body.totals).toEqual({
      salesCentavos: 2500,
      containersRefilled: 1,
      waterVolumeMl: 25000,
      transactions: 1,
    });
    expect(afterRes.body.service[0]).toEqual({
      waterType: "PURIFIED",
      containers: 1,
      waterVolumeMl: 25000,
      salesCentavos: 2500,
      sharePercent: 100,
    });
  });
});

describe("Final Dashboard Sales comparison, breakdowns, and recommendations (DEC-086..088, DEC-091..093)", () => {
  let ctx: TestContext;
  let owner: Activated;
  let cashier: Activated;

  beforeEach(async () => {
    ctx = await createTestContext({ clock: new ManualClock("2026-11-04T08:00:00+08:00") });
    owner = await activatedAccount(ctx, "owner1", "OWNER");
    cashier = await activatedAccount(ctx, "cashier1", "CASHIER");
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("enforces matched Manila comparison windows, partial-day cutoffs, full day-record coverage, short months, verified zero, and exact 10% decline", async () => {
    // Open & run previous week Mon Nov 2, Tue Nov 3, Wed Nov 4
    ctx.clock.set("2026-11-02T08:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "w1-mon")).status).toBe(201);
    await sellCart(ctx, owner, [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }], 5000, "w1-mon-s1"); // 5000
    expect((await endDay(ctx, owner, "w1-mon-end")).status).toBe(200);

    ctx.clock.set("2026-11-03T08:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "w1-tue")).status).toBe(201);
    // Zero valid sales on Tue Nov 3 (verified ₱0)
    expect((await endDay(ctx, owner, "w1-tue-end")).status).toBe(200);

    // Wed Nov 4 starts at 15:00 (after 14:00 cutoff) initially to test coverage rejection, plus a sale at 15:10
    ctx.clock.set("2026-11-04T15:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "w1-wed")).status).toBe(201);
    ctx.clock.set("2026-11-04T15:10:00+08:00");
    await sellCart(ctx, owner, [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }], 5000, "w1-wed-late"); // 5000
    expect((await endDay(ctx, owner, "w1-wed-end")).status).toBe(200);

    // Current week Mon Nov 9, Tue Nov 10, Wed Nov 11
    ctx.clock.set("2026-11-09T08:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "w2-mon")).status).toBe(201);
    await sellCart(ctx, owner, [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }], 5000, "w2-mon-s1"); // 5000
    expect((await endDay(ctx, owner, "w2-mon-end")).status).toBe(200);

    ctx.clock.set("2026-11-10T08:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "w2-tue")).status).toBe(201);
    await sellCart(ctx, owner, [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }], 5000, "w2-tue-s1"); // 2500
    expect((await endDay(ctx, owner, "w2-tue-end")).status).toBe(200);

    ctx.clock.set("2026-11-11T08:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "w2-wed")).status).toBe(201);

    // Query This Week at Wed Nov 11 14:00 -> prev Wed Nov 4 started at 15:00, so prev Wed lacks coverage by 14:00 cutoff!
    ctx.clock.set("2026-11-11T14:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const missingCutoffWeek = await request(ctx.app)
      .get("/api/dashboard/sales?period=week")
      .set("Cookie", owner.cookie);
    expect(missingCutoffWeek.status).toBe(200);
    expect(missingCutoffWeek.body.totals.salesCentavos).toBe(7500);
    expect(missingCutoffWeek.body.comparison).toMatchObject({
      available: false,
      unavailableReason: "MISSING_STATION_DAY",
      currentRange: { from: "2026-11-09", to: "2026-11-11" },
      previousRange: { from: "2026-11-02", to: "2026-11-04" },
      amountChangeCentavos: null,
      percentChange: null,
    });

    // Update Wed Nov 4 started_at to 08:00 so coverage exists, while its 15:10 sale remains after 14:00 cutoff
    await ctx.db.query(
      `UPDATE pos_business_days SET started_at = '2026-11-04T08:00:00+08:00' WHERE business_date = '2026-11-04'`,
    );
    const coveredAt1400 = await request(ctx.app)
      .get("/api/dashboard/sales?period=week")
      .set("Cookie", owner.cookie);
    expect(coveredAt1400.status).toBe(200);
    expect(coveredAt1400.body.comparison).toMatchObject({
      available: true,
      currentTotalSalesCentavos: 7500,
      previousTotalSalesCentavos: 5000, // 15:10 sale on Nov 4 is excluded by 14:00 cutoff
      amountChangeCentavos: 2500,
      percentChange: 50,
    });

    // At 15:30 on Wed Nov 11, the 15:10 receipt on Nov 4 is now included (5000 + 5000 = 10000) -> 7500 vs 10000 = -25%
    ctx.clock.set("2026-11-11T15:30:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const coveredAt1530 = await request(ctx.app)
      .get("/api/dashboard/sales?period=week")
      .set("Cookie", owner.cookie);
    expect(coveredAt1530.status).toBe(200);
    expect(coveredAt1530.body.comparison).toMatchObject({
      available: true,
      currentTotalSalesCentavos: 7500,
      previousTotalSalesCentavos: 10000,
      amountChangeCentavos: -2500,
      percentChange: -25,
    });

    // Today comparison at 15:30 on Nov 11 (0) vs Nov 10 through 15:30 (2500) -> -2500 (-100%)
    const todayComp = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(todayComp.status).toBe(200);
    expect(todayComp.body.comparison).toMatchObject({
      available: true,
      currentTotalSalesCentavos: 0,
      previousTotalSalesCentavos: 2500,
      amountChangeCentavos: -2500,
      percentChange: -100,
    });

    // Verified ₱0 previous period: Custom Nov 4 (whole day) vs Nov 3 (whole day) uses selected end date, not refresh clock
    const zeroPrevCustom = await request(ctx.app)
      .get("/api/dashboard/sales?period=custom&from=2026-11-04&to=2026-11-04")
      .set("Cookie", owner.cookie);
    expect(zeroPrevCustom.status).toBe(200);
    expect(zeroPrevCustom.body.comparison).toMatchObject({
      available: true,
      currentRange: {
        from: "2026-11-04",
        to: "2026-11-04",
        isPartialEndDay: false,
        cutoffAt: "2026-11-04T23:59:59+08:00",
      },
      previousRange: {
        from: "2026-11-03",
        to: "2026-11-03",
        isPartialEndDay: false,
        cutoffAt: "2026-11-03T23:59:59+08:00",
      },
      currentTotalSalesCentavos: 5000,
      previousTotalSalesCentavos: 0,
      amountChangeCentavos: 5000,
      percentChange: null,
    });

    // Custom partial end day ending today (Nov 10-11 vs Nov 8-9): missing Nov 8 -> Comparison Unavailable
    const missingCurrentOrPrevCustom = await request(ctx.app)
      .get("/api/dashboard/sales?period=custom&from=2026-11-10&to=2026-11-11")
      .set("Cookie", owner.cookie);
    expect(missingCurrentOrPrevCustom.status).toBe(200);
    expect(missingCurrentOrPrevCustom.body.comparison).toMatchObject({
      available: false,
      unavailableReason: "MISSING_STATION_DAY",
      previousRange: { from: "2026-11-08", to: "2026-11-09" },
    });

    // Exact 10% decline vs 9.9% decline on Custom Nov 10 (curr) vs Nov 9 (prev)
    // Set Nov 9 = 10000 and Nov 10 = 9000 -> -10% (triggers SALES_DECLINE).
    await ctx.db.query(
      `UPDATE pos_sales
          SET total_centavos = 10000,
              cash_received_centavos = 15000,
              change_centavos = 5000
        WHERE business_date = '2026-11-09' AND status = 'ACTIVE'`,
    );
    await ctx.db.query(
      `UPDATE pos_sales
          SET total_centavos = 9000,
              cash_received_centavos = 15000,
              change_centavos = 6000
        WHERE business_date = '2026-11-10' AND status = 'ACTIVE'`,
    );
    const exact10 = await request(ctx.app)
      .get("/api/dashboard/sales?period=custom&from=2026-11-10&to=2026-11-10")
      .set("Cookie", owner.cookie);
    expect(exact10.status).toBe(200);
    expect(exact10.body.comparison).toMatchObject({
      available: true,
      currentTotalSalesCentavos: 9000,
      previousTotalSalesCentavos: 10000,
      amountChangeCentavos: -1000,
      percentChange: -10,
    });
    expect(exact10.body.recommendations.some((r: { type: string }) => r.type === "SALES_DECLINE")).toBe(
      true,
    );

    await ctx.db.query(
      `UPDATE pos_sales
          SET total_centavos = 9010,
              cash_received_centavos = 15000,
              change_centavos = 5990
        WHERE business_date = '2026-11-10' AND status = 'ACTIVE'`,
    );
    const below10 = await request(ctx.app)
      .get("/api/dashboard/sales?period=custom&from=2026-11-10&to=2026-11-10")
      .set("Cookie", owner.cookie);
    expect(below10.status).toBe(200);
    expect(below10.body.comparison).toMatchObject({
      available: true,
      currentTotalSalesCentavos: 9010,
      previousTotalSalesCentavos: 10000,
      amountChangeCentavos: -990,
      percentChange: -9.9,
    });
    expect(below10.body.recommendations.some((r: { type: string }) => r.type === "SALES_DECLINE")).toBe(
      false,
    );

    // Short prior month (Mar 31 -> Feb has no 31st)
    ctx.clock.set("2026-03-31T10:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const marMonth = await request(ctx.app)
      .get("/api/dashboard/sales?period=month")
      .set("Cookie", owner.cookie);
    expect(marMonth.status).toBe(200);
    expect(marMonth.body.comparison).toMatchObject({
      available: false,
      unavailableReason: "NO_EQUIVALENT_PREVIOUS_MONTH_DATE",
      previousRange: null,
    });
  });

  it("reconciles Container Sales (₱925 example), Faucet Sales (explicit, legacy, untyped NONE, ties), and excludes included gripo", async () => {
    ctx.clock.set("2026-11-16T09:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    cashier = await reauth(ctx, "cashier1", cashier);

    // Setup Round & Slim containers
    for (const shape of ["ROUND", "SLIM"]) {
      expect(
        (
          await request(ctx.app)
            .post(`/api/inventory/items/${shape}/opening-stock`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ quantity: 20 })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(ctx.app)
            .patch(`/api/inventory/containers/${shape}`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ showInPos: true })
        ).status,
      ).toBe(200);
    }

    // Create standalone Push faucet, Twist faucet, and deliberately untyped accessory
    const createProd = async (payload: Record<string, unknown>) => {
      const res = await request(ctx.app)
        .post("/api/inventory/products")
        .set("Cookie", owner.cookie)
        .set("X-CSRF-Token", owner.csrfToken)
        .send(payload);
      expect(res.status).toBe(201);
      const id = res.body.item.id as string;
      expect(
        (
          await request(ctx.app)
            .post(`/api/inventory/items/${encodeURIComponent(id)}/opening-stock`)
            .set("Cookie", owner.cookie)
            .set("X-CSRF-Token", owner.csrfToken)
            .send({ quantity: 20 })
        ).status,
      ).toBe(201);
      return id;
    };

    const pushId = await createProd({
      name: "Push Faucet",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 4000,
      showInPos: true,
      posSection: "CHANGE_OF_GRIPO",
      faucetReportingType: "PUSH_TYPE",
    });
    const twistId = await createProd({
      name: "Twist Faucet",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 5000,
      showInPos: true,
      posSection: "CHANGE_OF_GRIPO",
      faucetReportingType: "TWIST_TYPE",
    });
    const capId = await createProd({
      name: "Blue Cap",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 1500,
      showInPos: true,
      posSection: "TAKIP_ACCESSORIES",
      faucetReportingType: null,
    });

    expect((await startDay(ctx, owner, "breakdowns-day")).status).toBe(201);

    // 1) Design ₱925 Container Sales example:
    //    3 Empty Round @ ₱175 (52500) + 2 Purified-filled Slim @ ₱200 (40000) with TWIST_TYPE included gripo
    await sellCart(
      ctx,
      cashier,
      [
        {
          kind: "CONTAINER_PACKAGE",
          packageCode: "ROUND_EMPTY",
          includedGripo: "PUSH_TYPE",
          quantity: 3,
        },
        {
          kind: "CONTAINER_PACKAGE",
          packageCode: "SLIM_PURIFIED",
          includedGripo: "TWIST_TYPE",
          quantity: 2,
        },
      ],
      100000,
      "pkg-925-example",
    );

    const pkgReport = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(pkgReport.status).toBe(200);
    expect(pkgReport.body.totals).toEqual({
      salesCentavos: 92500,
      containersRefilled: 0,
      waterVolumeMl: 50000,
      transactions: 1,
    });
    expect(pkgReport.body.containerSales).toEqual({
      totalUnits: 5,
      totalSalesCentavos: 92500,
      items: [
        {
          packageCode: "ROUND_EMPTY",
          shape: "ROUND",
          fillType: "EMPTY",
          label: "Empty Round",
          units: 3,
          salesCentavos: 52500,
          waterVolumeMl: 0,
        },
        {
          packageCode: "ROUND_PURIFIED",
          shape: "ROUND",
          fillType: "PURIFIED",
          label: "Purified Round",
          units: 0,
          salesCentavos: 0,
          waterVolumeMl: 0,
        },
        {
          packageCode: "ROUND_ALKALINE",
          shape: "ROUND",
          fillType: "ALKALINE",
          label: "Alkaline Round",
          units: 0,
          salesCentavos: 0,
          waterVolumeMl: 0,
        },
        {
          packageCode: "SLIM_EMPTY",
          shape: "SLIM",
          fillType: "EMPTY",
          label: "Empty Slim",
          units: 0,
          salesCentavos: 0,
          waterVolumeMl: 0,
        },
        {
          packageCode: "SLIM_PURIFIED",
          shape: "SLIM",
          fillType: "PURIFIED",
          label: "Purified Slim",
          units: 2,
          salesCentavos: 40000,
          waterVolumeMl: 50000,
        },
        {
          packageCode: "SLIM_ALKALINE",
          shape: "SLIM",
          fillType: "ALKALINE",
          label: "Alkaline Slim",
          units: 0,
          salesCentavos: 0,
          waterVolumeMl: 0,
        },
      ],
    });
    // Included gripo on container packages must NOT appear in standalone Faucet Sales
    expect(pkgReport.body.faucetSales).toEqual({
      totalUnits: 0,
      totalSalesCentavos: 0,
      leader: null,
      unclassifiedUnits: 0,
      unclassifiedSalesCentavos: 0,
      items: [
        { type: "PUSH_TYPE", label: "Push-Type Faucet", units: 0, salesCentavos: 0, sharePercent: null },
        { type: "TWIST_TYPE", label: "Twist-Type Faucet", units: 0, salesCentavos: 0, sharePercent: null },
      ],
    });

    // 2) Sell 2 Push Faucets, 2 Twist Faucets (a tie!), and 1 deliberately untyped Blue Cap (NONE)
    await sellCart(
      ctx,
      cashier,
      [
        { kind: "MERCHANDISE", productId: pushId, quantity: 2 },
        { kind: "MERCHANDISE", productId: twistId, quantity: 2 },
        { kind: "MERCHANDISE", productId: capId, quantity: 1 },
      ],
      25000,
      "faucets-tie-and-cap",
    );

    // Edit & archive Push Faucet afterward: saved sale must retain Push-Type classification
    expect(
      (
        await request(ctx.app)
          .patch(`/api/inventory/products/${encodeURIComponent(pushId)}`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ name: "Renamed", faucetReportingType: "TWIST_TYPE" })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app)
          .post(`/api/inventory/products/${encodeURIComponent(pushId)}/archive`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({})
      ).status,
    ).toBe(200);

    const tiedReport = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(tiedReport.status).toBe(200);
    expect(tiedReport.body.faucetSales).toEqual({
      totalUnits: 4,
      totalSalesCentavos: 18000,
      leader: "TIE",
      unclassifiedUnits: 0,
      unclassifiedSalesCentavos: 0,
      items: [
        { type: "PUSH_TYPE", label: "Push-Type Faucet", units: 2, salesCentavos: 8000, sharePercent: 50 },
        { type: "TWIST_TYPE", label: "Twist-Type Faucet", units: 2, salesCentavos: 10000, sharePercent: 50 },
      ],
    });

    // 3) Legacy lines (faucet_reporting_type IS NULL):
    //    - Clear legacy label "Push-Type Gripo" -> recognized as PUSH_TYPE (breaks tie -> 3 vs 2, 60% vs 40%)
    //    - Ambiguous legacy label "Gripo Special" in CHANGE_OF_GRIPO -> flagged in unclassifiedUnits
    await ctx.db.query(
      `UPDATE pos_sale_items
          SET faucet_reporting_type = NULL,
              display_label = 'Push-Type Gripo'
        WHERE inventory_item_id = $1`,
      [pushId],
    );
    const legacySale = await sellCart(
      ctx,
      cashier,
      [{ kind: "MERCHANDISE", productId: capId, quantity: 1 }],
      5000,
      "legacy-unclear-faucet",
    );
    await ctx.db.query(
      `UPDATE pos_sale_items psi
          SET faucet_reporting_type = NULL,
              pos_section = 'CHANGE_OF_GRIPO',
              display_label = 'Special Replacement Valve'
         FROM pos_sales ps
        WHERE ps.id = psi.sale_id AND ps.reference = $1`,
      [legacySale.reference],
    );

    const legacyCheck = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(legacyCheck.status).toBe(200);
    expect(legacyCheck.body.faucetSales).toMatchObject({
      totalUnits: 4,
      leader: "TIE",
      unclassifiedUnits: 1,
      unclassifiedSalesCentavos: 1500,
    });

    // Finding 1 regressions:
    // A) New standalone "Push-Type Faucet" sold BEFORE Owner sets its type (saved as NONE)
    //    stays out of typed PUSH_TYPE, enters unclassifiedUnits coverage, and stays in Total Sales.
    // B) Accessory "Faucet Seal for Push-Type" (legacy NULL or NONE) is excluded from BOTH
    //    typed PUSH_TYPE and unclassifiedUnits while remaining in Total Sales.
    const untypedPushFaucetId = await createProd({
      name: "Push-Type Faucet",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 4000,
      showInPos: true,
      posSection: "CHANGE_OF_GRIPO",
      faucetReportingType: null,
    });
    const sealId = await createProd({
      name: "Faucet Seal for Push-Type",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 1000,
      showInPos: true,
      posSection: "TAKIP_ACCESSORIES",
      faucetReportingType: null,
    });
    const regressionSale = await sellCart(
      ctx,
      cashier,
      [
        { kind: "MERCHANDISE", productId: untypedPushFaucetId, quantity: 1 }, // 4000 (NONE, faucet)
        { kind: "MERCHANDISE", productId: sealId, quantity: 2 }, // 2000 (NONE, non-faucet seal)
      ],
      10000,
      "faucet-finding1-reg",
    );
    const legacySealSale = await sellCart(
      ctx,
      cashier,
      [{ kind: "MERCHANDISE", productId: sealId, quantity: 1 }], // 1000 (legacy NULL, non-faucet seal)
      2000,
      "faucet-finding1-legacy-seal",
    );
    await ctx.db.query(
      `UPDATE pos_sale_items psi
          SET faucet_reporting_type = NULL
         FROM pos_sales ps
        WHERE ps.id = psi.sale_id AND ps.reference = $1`,
      [legacySealSale.reference],
    );

    const finding1Report = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(finding1Report.status).toBe(200);
    // Total Sales includes everything:
    // 92500 + 19500 + 1500 (legacy valve) + 6000 (untyped faucet + 2 seals) + 1000 (legacy seal) = 120500
    expect(finding1Report.body.totals.salesCentavos).toBe(120500);
    expect(finding1Report.body.faucetSales).toMatchObject({
      totalUnits: 4,
      totalSalesCentavos: 18000,
      leader: "TIE",
      unclassifiedUnits: 2, // 1 legacy Special Replacement Valve (1500) + 1 untyped Push-Type Faucet (4000)
      unclassifiedSalesCentavos: 5500,
    });
    expect(regressionSale.totalCentavos).toBe(6000);

    // Retest follow-up regressions:
    // C) Legacy NULL "Push-Type Faucet for Slim Container" (4000) -> recognized as PUSH_TYPE
    // D) Legacy NULL "Push-Type Faucet Wrench" in CHANGE_OF_GRIPO (3500) -> NOT_FAUCET, preserved in Total Sales
    const legacyFitFaucetId = await createProd({
      name: "Push-Type Faucet for Slim Container",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 4000,
      showInPos: true,
      posSection: "CHANGE_OF_GRIPO",
      faucetReportingType: null,
    });
    const legacyWrenchId = await createProd({
      name: "Push-Type Faucet Wrench",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 3500,
      showInPos: true,
      posSection: "CHANGE_OF_GRIPO",
      faucetReportingType: null,
    });
    const retestSale = await sellCart(
      ctx,
      cashier,
      [
        { kind: "MERCHANDISE", productId: legacyFitFaucetId, quantity: 1 }, // 4000
        { kind: "MERCHANDISE", productId: legacyWrenchId, quantity: 1 }, // 3500
      ],
      10000,
      "faucet-finding1-retest-reg",
    );
    await ctx.db.query(
      `UPDATE pos_sale_items psi
          SET faucet_reporting_type = NULL
         FROM pos_sales ps
        WHERE ps.id = psi.sale_id AND ps.reference = $1`,
      [retestSale.reference],
    );

    const finding1RetestReport = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(finding1RetestReport.status).toBe(200);
    // 120500 + 4000 + 3500 = 128000
    expect(finding1RetestReport.body.totals.salesCentavos).toBe(128000);
    expect(finding1RetestReport.body.faucetSales).toMatchObject({
      totalUnits: 5,
      totalSalesCentavos: 22000,
      leader: "PUSH_TYPE",
      unclassifiedUnits: 2,
      unclassifiedSalesCentavos: 5500,
      items: [
        { type: "PUSH_TYPE", units: 3, salesCentavos: 12000 },
        { type: "TWIST_TYPE", units: 2, salesCentavos: 10000 },
      ],
    });
  });

  it("classifies standalone faucets vs parts/tools and respects fit descriptions and explicit types", () => {
    expect(
      classifyStandaloneMerchandiseFaucet({
        itemKind: "MERCHANDISE",
        faucetReportingType: null,
        posSection: "CHANGE_OF_GRIPO",
        displayLabel: "Push-Type Faucet for Slim Container",
      }),
    ).toEqual({ kind: "TYPED", type: "PUSH_TYPE" });

    expect(
      classifyStandaloneMerchandiseFaucet({
        itemKind: "MERCHANDISE",
        faucetReportingType: null,
        posSection: "CHANGE_OF_GRIPO",
        displayLabel: "Twist-Type Gripo for Round Gallon",
      }),
    ).toEqual({ kind: "TYPED", type: "TWIST_TYPE" });

    expect(
      classifyStandaloneMerchandiseFaucet({
        itemKind: "MERCHANDISE",
        faucetReportingType: null,
        posSection: "CHANGE_OF_GRIPO",
        displayLabel: "Faucet for Slim Container",
      }),
    ).toEqual({ kind: "UNCLASSIFIED_FAUCET" });

    expect(
      classifyStandaloneMerchandiseFaucet({
        itemKind: "MERCHANDISE",
        faucetReportingType: null,
        posSection: "CHANGE_OF_GRIPO",
        displayLabel: "Faucet for Push-Type Dispenser",
      }),
    ).toEqual({ kind: "UNCLASSIFIED_FAUCET" });

    for (const faucetReportingType of [null, "NONE"] as const) {
      for (const posSection of ["TAKIP_ACCESSORIES", "CHANGE_OF_GRIPO"] as const) {
        expect(
          classifyStandaloneMerchandiseFaucet({
            itemKind: "MERCHANDISE",
            faucetReportingType,
            posSection,
            displayLabel: "Push-Type Faucet Wrench",
          }),
        ).toEqual({ kind: "NOT_FAUCET" });

        expect(
          classifyStandaloneMerchandiseFaucet({
            itemKind: "MERCHANDISE",
            faucetReportingType,
            posSection,
            displayLabel: "Faucet Seal for Push-Type",
          }),
        ).toEqual({ kind: "NOT_FAUCET" });
      }
    }

    expect(
      classifyStandaloneMerchandiseFaucet({
        itemKind: "MERCHANDISE",
        faucetReportingType: null,
        posSection: "CHANGE_OF_GRIPO",
        displayLabel: "Slim Container with Push-Type Faucet",
      }),
    ).toEqual({ kind: "NOT_FAUCET" });

    expect(
      classifyStandaloneMerchandiseFaucet({
        itemKind: "MERCHANDISE",
        faucetReportingType: "NONE",
        posSection: "CHANGE_OF_GRIPO",
        displayLabel: "Push-Type Faucet for Slim Container",
      }),
    ).toEqual({ kind: "UNCLASSIFIED_FAUCET" });

    expect(
      classifyStandaloneMerchandiseFaucet({
        itemKind: "MERCHANDISE",
        faucetReportingType: "TWIST_TYPE",
        posSection: "TAKIP_ACCESSORIES",
        displayLabel: "Push-Type Faucet Wrench",
      }),
    ).toEqual({ kind: "TYPED", type: "TWIST_TYPE" });
  });

  it("orders recommendations by Overdue, Sales Decline, Refill Leader, Faucet Leader (max 3) and isolates Calendar failures", async () => {
    // Day 1 (Nov 15): 10000 centavos
    ctx.clock.set("2026-11-15T09:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "rec-day1")).status).toBe(201);
    await sellCart(ctx, owner, [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 4 }], 10000, "rec-d1-s1");
    expect((await endDay(ctx, owner, "rec-day1-end")).status).toBe(200);

    // Day 2 (Nov 16): Purified refill leader + Push faucet leader, total 6500 (35% decline vs 10000)
    ctx.clock.set("2026-11-16T09:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const pushRes = await request(ctx.app)
      .post("/api/inventory/products")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        name: "Push Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
        faucetReportingType: "PUSH_TYPE",
      });
    const pushId = pushRes.body.item.id as string;
    await request(ctx.app)
      .post(`/api/inventory/items/${encodeURIComponent(pushId)}/opening-stock`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ quantity: 10 });

    // Schedule an activity at 08:00 (already overdue at 09:00)
    const sched = await request(ctx.app)
      .post("/api/calendar/activities")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        name: "Backwash Filter",
        scheduledDate: "2026-11-16",
        scheduledTime: "08:00",
        requestKey: "rec-overdue-1",
      });
    expect(sched.status).toBe(201);

    expect((await startDay(ctx, owner, "rec-day2")).status).toBe(201);
    await sellCart(
      ctx,
      owner,
      [
        { kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }, // 2500
        { kind: "MERCHANDISE", productId: pushId, quantity: 1 }, // 4000
      ],
      10000,
      "rec-d2-s1",
    );

    const fourQualifying = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(fourQualifying.status).toBe(200);
    expect(fourQualifying.body.recommendations).toHaveLength(3);
    expect(fourQualifying.body.recommendations.map((r: { type: string }) => r.type)).toEqual([
      "OVERDUE_ACTIVITIES",
      "SALES_DECLINE",
      "REFILL_LEADER",
    ]);

    // Calendar source failure leaves sales recommendations intact (decline, refill leader, faucet leader)
    const failingCalendarDb: Database = {
      query(sql, params) {
        if (sql.includes("calendar_occurrences")) {
          return Promise.reject(new Error("calendar read unavailable"));
        }
        return ctx.db.query(sql, params);
      },
      exec(sql) {
        return ctx.db.exec(sql);
      },
      transaction(fn) {
        return ctx.db.transaction(fn);
      },
      close() {
        return ctx.db.close();
      },
    };
    const isolatedApp = createApp({ db: failingCalendarDb, clock: ctx.clock });
    const isolatedRes = await request(isolatedApp)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(isolatedRes.status).toBe(200);
    expect(isolatedRes.body.recommendations.map((r: { type: string }) => r.type)).toEqual([
      "SALES_DECLINE",
      "REFILL_LEADER",
      "FAUCET_LEADER",
    ]);
  });

  it("enforces Owner-only stock trend access and builds verified history for opening counts, sales, settlements, reconciliations, same-time ties, and gaps (DEC-089)", async () => {
    ctx.clock.set("2026-11-16T08:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    cashier = await reauth(ctx, "cashier1", cashier);

    // Auth & validation guards
    expect((await request(ctx.app).get("/api/dashboard/stocks/ROUND/trend")).status).toBe(401);
    expect(
      (await request(ctx.app).get("/api/dashboard/stocks/ROUND/trend").set("Cookie", cashier.cookie))
        .status,
    ).toBe(403);
    expect(
      (await request(ctx.app).get("/api/dashboard/stocks/bad-key/trend").set("Cookie", owner.cookie))
        .status,
    ).toBe(400);
    expect(
      (
        await request(ctx.app)
          .get("/api/dashboard/stocks/00000000-0000-4000-8000-000000000000/trend")
          .set("Cookie", owner.cookie)
      ).status,
    ).toBe(404);

    // Uninitialized item -> NOT_SET
    const notSetTrend = await request(ctx.app)
      .get("/api/dashboard/stocks/ROUND/trend")
      .set("Cookie", owner.cookie);
    expect(notSetTrend.status).toBe(200);
    expect(notSetTrend.body).toMatchObject({
      item: { code: "ROUND", unit: "containers", status: "NOT_SET", currentQuantity: null },
      historyState: "NOT_SET",
      points: [],
    });

    // Zero opening count on SLIM -> COMPLETE with 1 opening point at 0
    expect(
      (
        await request(ctx.app)
          .post("/api/inventory/items/SLIM/opening-stock")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ quantity: 0 })
      ).status,
    ).toBe(201);
    const slimZeroTrend = await request(ctx.app)
      .get("/api/dashboard/stocks/SLIM/trend")
      .set("Cookie", owner.cookie);
    expect(slimZeroTrend.status).toBe(200);
    expect(slimZeroTrend.body.historyState).toBe("COMPLETE");
    expect(slimZeroTrend.body.points).toHaveLength(1);
    expect(slimZeroTrend.body.points[0]).toMatchObject({
      pointKind: "OPENING",
      balanceAfter: 0,
      unit: "containers",
    });

    // ROUND opening count 10, publish, sell 3 -> 10 then 7; reconcile to 9 -> 10, 7, 9
    expect(
      (
        await request(ctx.app)
          .post("/api/inventory/items/ROUND/opening-stock")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ quantity: 10 })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(ctx.app)
          .patch("/api/inventory/containers/ROUND")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ showInPos: true })
      ).status,
    ).toBe(200);

    // Hidden active merchandise product (showInPos: false) still loads by UUID
    const hiddenProd = await request(ctx.app)
      .post("/api/inventory/products")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        name: "Hidden Salt",
        unit: "sacks",
        unitConfirmed: true,
        unitPriceCentavos: 30000,
        showInPos: false,
      });
    const hiddenId = hiddenProd.body.item.id as string;
    expect(
      (
        await request(ctx.app)
          .post(`/api/inventory/items/${encodeURIComponent(hiddenId)}/opening-stock`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ quantity: 4 })
      ).status,
    ).toBe(201);
    const hiddenTrend = await request(ctx.app)
      .get(`/api/dashboard/stocks/${encodeURIComponent(hiddenId)}/trend`)
      .set("Cookie", owner.cookie);
    expect(hiddenTrend.status).toBe(200);
    expect(hiddenTrend.body.item).toMatchObject({
      id: hiddenId,
      unit: "sacks",
      showInPos: false,
      currentQuantity: 4,
    });

    // Archived product returns 404 from active trend picker endpoint
    expect(
      (
        await request(ctx.app)
          .post(`/api/inventory/products/${encodeURIComponent(hiddenId)}/archive`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({})
      ).status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app)
          .get(`/api/dashboard/stocks/${encodeURIComponent(hiddenId)}/trend`)
          .set("Cookie", owner.cookie)
      ).status,
    ).toBe(404);

    // Day 1: sell 3 Round (10 -> 7) and prepare a PAYMENT_PENDING checkout for 2 Round
    ctx.clock.set("2026-11-16T09:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "trend-d1")).status).toBe(201);
    await sellCart(
      ctx,
      owner,
      [
        {
          kind: "CONTAINER_PACKAGE",
          packageCode: "ROUND_EMPTY",
          includedGripo: "PUSH_TYPE",
          quantity: 3,
        },
      ],
      60000,
      "trend-sale-3",
    );

    const pendingPkg = await request(ctx.app)
      .post("/api/pos/checkouts")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        prepareKey: "trend-prior-pending",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_EMPTY",
            includedGripo: "TWIST_TYPE",
            quantity: 2,
          },
        ],
      });
    const pendingRef = pendingPkg.body.checkout.reference as string;
    await request(ctx.app)
      .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/begin-payment`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({});

    // Next day: settle prior-day merchandise checkout (7 -> 5 at 2026-11-17T10:00:00+08:00)
    // and then reconcile physical count to 9 (5 -> 9 at 2026-11-17T11:00:00+08:00)
    ctx.clock.set("2026-11-17T10:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const settleRes = await request(ctx.app)
      .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/settle`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        paymentKeptConfirmed: true,
        itemsHandedOverConfirmed: true,
        cashReceivedCentavos: 40000,
      });
    expect(settleRes.status).toBe(201);

    ctx.clock.set("2026-11-17T11:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const roundRow = (
      await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie)
    ).body.items.find((i: { shape: string }) => i.shape === "ROUND");
    expect(
      (
        await request(ctx.app)
          .post("/api/inventory/items/ROUND/reconciliations")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({
            physicalCount: 9,
            reason: "Found 4 extra containers",
            expectedRevision: roundRow.stockRevision,
            expectedCurrentQuantity: 5,
            requestKey: "trend-rec-9",
          })
      ).status,
    ).toBe(201);

    const roundTrend = await request(ctx.app)
      .get("/api/dashboard/stocks/ROUND/trend")
      .set("Cookie", owner.cookie);
    expect(roundTrend.status).toBe(200);
    expect(roundTrend.body.historyState).toBe("COMPLETE");
    expect(
      roundTrend.body.points.map(
        (p: { movementType: string; balanceAfter: number; recordedAt: string }) => ({
          movementType: p.movementType,
          balanceAfter: p.balanceAfter,
          recordedAt: p.recordedAt,
        }),
      ),
    ).toEqual([
      { movementType: "OPENING_COUNT", balanceAfter: 10, recordedAt: "2026-11-16T08:00:00+08:00" },
      { movementType: "POS_SALE", balanceAfter: 7, recordedAt: "2026-11-16T09:00:00+08:00" },
      {
        movementType: "PRIOR_DAY_SETTLEMENT",
        balanceAfter: 5,
        recordedAt: "2026-11-17T10:00:00+08:00",
      },
      {
        movementType: "PHYSICAL_COUNT_RECONCILIATION",
        balanceAfter: 9,
        recordedAt: "2026-11-17T11:00:00+08:00",
      },
    ]);

    // Resolvable same-timestamp movements: force settlement & reconciliation to share timestamp 10:00:00
    await ctx.db.query(
      `UPDATE inventory_stock_movements
          SET recorded_at = '2026-11-17T10:00:00+08:00'
        WHERE item_id = $1 AND movement_type IN ('PRIOR_DAY_SETTLEMENT', 'PHYSICAL_COUNT_RECONCILIATION')`,
      [roundRow.id],
    );
    const resolvableTie = await request(ctx.app)
      .get("/api/dashboard/stocks/ROUND/trend")
      .set("Cookie", owner.cookie);
    expect(resolvableTie.status).toBe(200);
    expect(resolvableTie.body.historyState).toBe("COMPLETE");
    expect(
      resolvableTie.body.points.map((p: { balanceAfter: number }) => p.balanceAfter),
    ).toEqual([10, 7, 5, 9]);

    // Ambiguous same-timestamp cycle (5 -> 9, 9 -> 5, 5 -> 9 all at 10:00:00) -> INCOMPLETE
    await ctx.db.query(
      `INSERT INTO inventory_stock_movements (
         item_id, movement_type, quantity_delta, balance_before, balance_after,
         unit, actor_user_id, recorded_at
       )
       VALUES
         ($1, 'PHYSICAL_COUNT_RECONCILIATION', -4, 9, 5, 'containers',
          (SELECT id FROM app_users WHERE username = 'owner1'), '2026-11-17T10:00:00+08:00'),
         ($1, 'PHYSICAL_COUNT_RECONCILIATION', 4, 5, 9, 'containers',
          (SELECT id FROM app_users WHERE username = 'owner1'), '2026-11-17T10:00:00+08:00')`,
      [roundRow.id],
    );
    const ambiguousTie = await request(ctx.app)
      .get("/api/dashboard/stocks/ROUND/trend")
      .set("Cookie", owner.cookie);
    expect(ambiguousTie.status).toBe(200);
    expect(ambiguousTie.body.historyState).toBe("INCOMPLETE");
    expect(ambiguousTie.body.points).toEqual([]);
    expect(ambiguousTie.body.item.currentQuantity).toBe(9);

    // Balance gap where current_quantity disagrees with last movement -> INCOMPLETE
    await ctx.db.query(`UPDATE inventory_items SET current_quantity = 99 WHERE id = $1`, [
      roundRow.id,
    ]);
    const gapTrend = await request(ctx.app)
      .get("/api/dashboard/stocks/ROUND/trend")
      .set("Cookie", owner.cookie);
    expect(gapTrend.status).toBe(200);
    expect(gapTrend.body.historyState).toBe("INCOMPLETE");
    expect(gapTrend.body.points).toEqual([]);

    // Finding 3 regression: four distinct sub-second movements within a single second
    // (10 -> 9 -> 10 -> 8 -> 10) reconcile into COMPLETE trend rather than collapsing to 1 tie.
    const capRes = await request(ctx.app)
      .post("/api/inventory/products")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        name: "Subsecond Cap",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 1500,
        showInPos: false,
      });
    expect(capRes.status).toBe(201);
    const subId = capRes.body.item.id as string;
    expect(
      (
        await request(ctx.app)
          .post(`/api/inventory/items/${encodeURIComponent(subId)}/opening-stock`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ quantity: 10 })
      ).status,
    ).toBe(201);

    await ctx.db.query(
      `INSERT INTO inventory_stock_movements (
         item_id, movement_type, quantity_delta, balance_before, balance_after,
         unit, actor_user_id, recorded_at
       )
       VALUES
         ($1, 'PHYSICAL_COUNT_RECONCILIATION', -1, 10, 9, 'pcs',
          (SELECT id FROM app_users WHERE username = 'owner1'), '2026-11-17T12:00:00.100+08:00'),
         ($1, 'PHYSICAL_COUNT_RECONCILIATION', 1, 9, 10, 'pcs',
          (SELECT id FROM app_users WHERE username = 'owner1'), '2026-11-17T12:00:00.200+08:00'),
         ($1, 'PHYSICAL_COUNT_RECONCILIATION', -2, 10, 8, 'pcs',
          (SELECT id FROM app_users WHERE username = 'owner1'), '2026-11-17T12:00:00.300+08:00'),
         ($1, 'PHYSICAL_COUNT_RECONCILIATION', 2, 8, 10, 'pcs',
          (SELECT id FROM app_users WHERE username = 'owner1'), '2026-11-17T12:00:00.400+08:00')`,
      [subId],
    );
    await ctx.db.query(`UPDATE inventory_items SET current_quantity = 10 WHERE id = $1`, [subId]);

    const subsecondTrend = await request(ctx.app)
      .get(`/api/dashboard/stocks/${encodeURIComponent(subId)}/trend`)
      .set("Cookie", owner.cookie);
    expect(subsecondTrend.status).toBe(200);
    expect(subsecondTrend.body.historyState).toBe("COMPLETE");
    expect(
      subsecondTrend.body.points.map((p: { balanceAfter: number; recordedAt: string }) => ({
        balanceAfter: p.balanceAfter,
        recordedAt: p.recordedAt,
      })),
    ).toEqual([
      { balanceAfter: 10, recordedAt: "2026-11-17T11:00:00+08:00" },
      { balanceAfter: 9, recordedAt: "2026-11-17T12:00:00.100+08:00" },
      { balanceAfter: 10, recordedAt: "2026-11-17T12:00:00.200+08:00" },
      { balanceAfter: 8, recordedAt: "2026-11-17T12:00:00.300+08:00" },
      { balanceAfter: 10, recordedAt: "2026-11-17T12:00:00.400+08:00" },
    ]);
  });

  it("places Active corrected replacements in matched partial-day comparisons by original purchase time (Task 4 Finding 1)", async () => {
    ctx.clock.set("2026-11-18T08:50:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "f1-day1-start")).status).toBe(201);

    // Pre-cutoff Day 1 sales (09:01, 09:05, 09:10 Manila)
    ctx.clock.set("2026-11-18T09:01:00+08:00");
    const saleA = await sellCart(
      ctx,
      owner,
      [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      2500,
      "f1-sale-a",
    ); // ₱25

    ctx.clock.set("2026-11-18T09:05:00+08:00");
    const saleB = await sellCart(
      ctx,
      owner,
      [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      2500,
      "f1-sale-b",
    ); // ₱25

    ctx.clock.set("2026-11-18T09:10:00+08:00");
    const saleVoid = await sellCart(
      ctx,
      owner,
      [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      2500,
      "f1-sale-void",
    ); // ₱25

    // Post-cutoff Day 1 sale (14:00 Manila, after 10:05 comparison cutoff)
    ctx.clock.set("2026-11-18T14:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const saleLate = await sellCart(
      ctx,
      owner,
      [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      3500,
      "f1-sale-late",
    ); // ₱35

    // Unresolved PAYMENT_PENDING checkout on Day 1 for separate Day 2 settlement check
    ctx.clock.set("2026-11-18T14:30:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const prepPending = await request(ctx.app)
      .post("/api/pos/checkouts")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        prepareKey: "f1-pending-prior",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      });
    expect(prepPending.status).toBe(201);
    const pendingRef = prepPending.body.checkout.reference as string;
    expect(
      (
        await request(ctx.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/begin-payment`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({})
      ).status,
    ).toBe(200);

    // Same-day late correction on 09:01 saleA at 15:00 (₱25 -> ₱50), then chained at 16:00 (₱50 -> ₱75)
    ctx.clock.set("2026-11-18T15:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const prepA1 = await request(ctx.app)
      .post(`/api/pos/sales/${encodeURIComponent(saleA.reference)}/actions`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        actionType: "CORRECT",
        reason: "First correction after cutoff",
        prepareKey: "f1-corr-a1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
    expect(prepA1.status).toBe(201);
    const confA1 = await request(ctx.app)
      .post(`/api/pos/sale-actions/${encodeURIComponent(prepA1.body.action.reference)}/confirm`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ cashConfirmed: true, cashTenderedCentavos: 2500 });
    expect(confA1.status).toBe(201);
    const saleA1Ref = confA1.body.replacementSale.reference as string;

    // Same-day late correction on 14:00 post-cutoff saleLate at 15:30 (₱35 -> ₱70)
    ctx.clock.set("2026-11-18T15:30:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const prepLate = await request(ctx.app)
      .post(`/api/pos/sales/${encodeURIComponent(saleLate.reference)}/actions`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        actionType: "CORRECT",
        reason: "Correction on post-cutoff purchase",
        prepareKey: "f1-corr-late",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 2 }],
      });
    expect(prepLate.status).toBe(201);
    expect(
      (
        await request(ctx.app)
          .post(`/api/pos/sale-actions/${encodeURIComponent(prepLate.body.action.reference)}/confirm`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ cashConfirmed: true, cashTenderedCentavos: 3500 })
      ).status,
    ).toBe(201);

    // Void the 09:10 sale at 15:45 (must remain ₱0)
    ctx.clock.set("2026-11-18T15:45:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const prepVoid = await request(ctx.app)
      .post(`/api/pos/sales/${encodeURIComponent(saleVoid.reference)}/actions`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        actionType: "VOID",
        reason: "Void after cutoff",
        prepareKey: "f1-void",
      });
    expect(prepVoid.status).toBe(201);
    expect(
      (
        await request(ctx.app)
          .post(`/api/pos/sale-actions/${encodeURIComponent(prepVoid.body.action.reference)}/confirm`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ cashConfirmed: true })
      ).status,
    ).toBe(201);

    // Chained second correction on saleA1 at 16:00 (₱50 -> ₱75)
    ctx.clock.set("2026-11-18T16:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const prepA2 = await request(ctx.app)
      .post(`/api/pos/sales/${encodeURIComponent(saleA1Ref)}/actions`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        actionType: "CORRECT",
        reason: "Chained correction after cutoff",
        prepareKey: "f1-corr-a2",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 3 }],
      });
    expect(prepA2.status).toBe(201);
    expect(
      (
        await request(ctx.app)
          .post(`/api/pos/sale-actions/${encodeURIComponent(prepA2.body.action.reference)}/confirm`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ cashConfirmed: true, cashTenderedCentavos: 2500 })
      ).status,
    ).toBe(201);

    // Prepare cross-midnight correction on 09:05 saleB before midnight (₱25 -> ₱50)
    ctx.clock.set("2026-11-18T23:55:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const prepB1 = await request(ctx.app)
      .post(`/api/pos/sales/${encodeURIComponent(saleB.reference)}/actions`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        actionType: "CORRECT",
        reason: "Prepared before midnight",
        prepareKey: "f1-corr-b1",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
    expect(prepB1.status).toBe(201);

    // Complete cross-midnight correction on 2026-11-19 at 10:00 Manila, settle pending checkout, close Day 1, start Day 2
    ctx.clock.set("2026-11-19T10:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const confB1 = await request(ctx.app)
      .post(`/api/pos/sale-actions/${encodeURIComponent(prepB1.body.action.reference)}/confirm`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ cashConfirmed: true, cashTenderedCentavos: 2500 });
    expect(confB1.status).toBe(201);
    const saleB1Ref = confB1.body.replacementSale.reference as string;
    expect(confB1.body.replacementSale.createdAt).toBe("2026-11-19T10:00:00+08:00");

    expect(
      (
        await request(ctx.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(pendingRef)}/settle`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({
            paymentKeptConfirmed: true,
            refillDeliveredConfirmed: true,
          })
      ).status,
    ).toBe(201);

    expect((await endDay(ctx, owner, "f1-day1-end")).status).toBe(200);
    expect((await startDay(ctx, owner, "f1-day2-start")).status).toBe(201);

    // Day 2 pre-cutoff purchase at 10:02 (₱35)
    ctx.clock.set("2026-11-19T10:02:00+08:00");
    const day2PreSale = await sellCart(
      ctx,
      owner,
      [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 1 }],
      5000,
      "f1-day2-pre",
    ); // ₱35

    // Query Today at 2026-11-19 10:05 Manila -> matched comparison vs 2026-11-18 through 10:05
    // Must include chained saleA2 (₱75, origin 09:01) + cross-midnight saleB1 (₱50, origin 09:05) = ₱125,
    // while excluding 14:00 saleLate correction (₱70), voided 09:10 saleVoid (₱0), and separate prior-day settlement (₱25).
    ctx.clock.set("2026-11-19T10:05:00+08:00");
    const day2Today = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(day2Today.status).toBe(200);
    expect(day2Today.body.totals.salesCentavos).toBe(3500);
    expect(day2Today.body.comparison).toMatchObject({
      available: true,
      currentTotalSalesCentavos: 3500,
      previousTotalSalesCentavos: 12500,
      amountChangeCentavos: -9000,
      previousRange: {
        from: "2026-11-18",
        to: "2026-11-18",
      },
    });
    expect(day2Today.body.priorDaySettlements).toHaveLength(1);
    expect(day2Today.body.priorDaySettlements[0].netAmountKeptCentavos).toBe(2500);

    // Full-day 2026-11-18 report still includes all three Active sales (₱75 + ₱50 + ₱70 = ₱195)
    const day1Full = await request(ctx.app)
      .get("/api/dashboard/sales?period=custom&from=2026-11-18&to=2026-11-18")
      .set("Cookie", owner.cookie);
    expect(day1Full.status).toBe(200);
    expect(day1Full.body.totals).toEqual({
      salesCentavos: 19500,
      containersRefilled: 7,
      waterVolumeMl: 175000,
      transactions: 3,
    });

    // Audit timestamp on replacement saleB1 stays its actual completion time (2026-11-19T10:00:00+08:00)
    const day1History = await request(ctx.app)
      .get("/api/pos/sales?date=2026-11-18")
      .set("Cookie", owner.cookie);
    expect(day1History.status).toBe(200);
    const histB1 = day1History.body.sales.find((s: { reference: string }) => s.reference === saleB1Ref);
    expect(histB1).toBeDefined();
    expect(histB1.createdAt).toBe("2026-11-19T10:00:00+08:00");

    // Current-day late correction on Day 2 (10:02 corrected at 14:00 -> ₱70) + post-cutoff purchase at 14:30 (₱25)
    // stays placed at 10:02 when Day 3 (2026-11-20 10:05) compares against Day 2 through 10:05.
    ctx.clock.set("2026-11-19T14:00:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    const prepDay2Late = await request(ctx.app)
      .post(`/api/pos/sales/${encodeURIComponent(day2PreSale.reference)}/actions`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        actionType: "CORRECT",
        reason: "Current-day correction after morning hour",
        prepareKey: "f1-day2-corr",
        items: [{ kind: "STANDARD", waterType: "ALKALINE", quantity: 2 }],
      });
    expect(prepDay2Late.status).toBe(201);
    expect(
      (
        await request(ctx.app)
          .post(`/api/pos/sale-actions/${encodeURIComponent(prepDay2Late.body.action.reference)}/confirm`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ cashConfirmed: true, cashTenderedCentavos: 3500 })
      ).status,
    ).toBe(201);

    ctx.clock.set("2026-11-19T14:30:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    await sellCart(
      ctx,
      owner,
      [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 1 }],
      2500,
      "f1-day2-post",
    ); // ₱25 (must stay outside 10:05 cutoff)

    expect((await endDay(ctx, owner, "f1-day2-end")).status).toBe(200);
    ctx.clock.set("2026-11-20T10:05:00+08:00");
    owner = await reauth(ctx, "owner1", owner);
    expect((await startDay(ctx, owner, "f1-day3-start")).status).toBe(201);

    const day3Today = await request(ctx.app)
      .get("/api/dashboard/sales?period=today")
      .set("Cookie", owner.cookie);
    expect(day3Today.status).toBe(200);
    expect(day3Today.body.totals.salesCentavos).toBe(0);
    expect(day3Today.body.comparison).toMatchObject({
      available: true,
      currentTotalSalesCentavos: 0,
      previousTotalSalesCentavos: 7000,
      amountChangeCentavos: -7000,
      previousRange: {
        from: "2026-11-19",
        to: "2026-11-19",
      },
    });
  });
});
