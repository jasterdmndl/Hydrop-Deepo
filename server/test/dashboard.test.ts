import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Database } from "../src/db/database.js";
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
