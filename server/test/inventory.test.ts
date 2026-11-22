import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../src/shared/clock.js";
import {
  activatedAccount,
  createTestContext,
  provision,
  signIn,
  type SignedIn,
  type TestContext,
} from "./helpers.js";

const BASE_MANILA = "2026-11-22T09:00:00+08:00";

type Activated = SignedIn & { password: string };

async function postOpeningStock(
  ctx: TestContext,
  actor: SignedIn,
  shape: string,
  payload: unknown,
) {
  return request(ctx.app)
    .post(`/api/inventory/items/${encodeURIComponent(shape)}/opening-stock`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload as Record<string, unknown>);
}

describe("Inventory Round and Slim opening stock (DEC-065)", () => {
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

  it("enforces authentication, CSRF protection, and temporary-password replacement", async () => {
    const anonGet = await request(ctx.app).get("/api/inventory/items");
    expect(anonGet.status).toBe(401);
    expect(anonGet.body.error.code).toBe("UNAUTHENTICATED");

    const anonPost = await request(ctx.app)
      .post("/api/inventory/items/ROUND/opening-stock")
      .send({ quantity: 5 });
    expect(anonPost.status).toBe(401);
    expect(anonPost.body.error.code).toBe("UNAUTHENTICATED");

    const missingCsrf = await request(ctx.app)
      .post("/api/inventory/items/ROUND/opening-stock")
      .set("Cookie", owner.cookie)
      .send({ quantity: 5 });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error.code).toBe("CSRF_INVALID");

    const tempCreds = await provision(ctx.db, "owner.temp", "OWNER");
    const tempSession = await signIn(ctx.app, "owner.temp", tempCreds.temporaryPassword);
    const unactivatedGet = await request(ctx.app)
      .get("/api/inventory/items")
      .set("Cookie", tempSession.cookie);
    expect(unactivatedGet.status).toBe(403);
    expect(unactivatedGet.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("starts both Round and Slim as Not Set for both roles and blocks Cashier writes", async () => {
    const ownerRes = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body.permissions).toEqual({ canView: true, canInitializeOpeningStock: true });
    expect(ownerRes.body.items).toEqual([
      {
        code: "ROUND",
        name: "Round Container",
        category: "CONTAINER",
        shape: "ROUND",
        unit: "containers",
        status: "NOT_SET",
        currentQuantity: null,
        openingStock: null,
      },
      {
        code: "SLIM",
        name: "Slim Container",
        category: "CONTAINER",
        shape: "SLIM",
        unit: "containers",
        status: "NOT_SET",
        currentQuantity: null,
        openingStock: null,
      },
    ]);

    const cashierRes = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
    expect(cashierRes.status).toBe(200);
    expect(cashierRes.body.permissions).toEqual({ canView: true, canInitializeOpeningStock: false });
    expect(cashierRes.body.items).toEqual(ownerRes.body.items);

    const deniedRound = await request(ctx.app)
      .post("/api/inventory/items/ROUND/opening-stock")
      .set("Cookie", cashier.cookie)
      .set("X-CSRF-Token", cashier.csrfToken)
      .set("X-Role", "OWNER")
      .send({ quantity: 10 });
    expect(deniedRound.status).toBe(403);
    expect(deniedRound.body.error.code).toBe("FORBIDDEN");

    const deniedSlim = await postOpeningStock(ctx, cashier, "SLIM", { quantity: 0 });
    expect(deniedSlim.status).toBe(403);
    expect(deniedSlim.body.error.code).toBe("FORBIDDEN");

    const after = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
    expect(after.body.items.every((item: any) => item.status === "NOT_SET" && item.currentQuantity === null)).toBe(
      true,
    );
  });

  it("rejects invalid shapes and invalid quantities on the server", async () => {
    const invalidShape = await postOpeningStock(ctx, owner, "GALLON", { quantity: 5 });
    expect(invalidShape.status).toBe(400);
    expect(invalidShape.body.error.code).toBe("VALIDATION_FAILED");

    const invalidBodies = [
      { quantity: -1 },
      { quantity: 1.5 },
      { quantity: "10" },
      { quantity: true },
      { quantity: null },
      {},
      { quantity: 1_000_001 },
      { quantity: 5, unit: "boxes" },
    ];
    for (const payload of invalidBodies) {
      const res = await postOpeningStock(ctx, owner, "ROUND", payload);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }

    const after = await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie);
    expect(after.body.items[0].status).toBe("NOT_SET");
    expect(after.body.items[0].currentQuantity).toBeNull();
  });

  it("records explicit zero and positive counts independently and preserves opening audit details", async () => {
    const roundRes = await postOpeningStock(ctx, owner, "ROUND", { quantity: 0 });
    expect(roundRes.status).toBe(201);
    expect(roundRes.body.item).toEqual({
      code: "ROUND",
      name: "Round Container",
      category: "CONTAINER",
      shape: "ROUND",
      unit: "containers",
      status: "INITIALIZED",
      currentQuantity: 0,
      openingStock: {
        quantity: 0,
        unit: "containers",
        recordedBy: "owner1",
        recordedAt: "2026-11-22T09:00:00+08:00",
      },
    });

    // Slim remains Not Set until independently initialized.
    const midView = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
    expect(midView.body.items[0].status).toBe("INITIALIZED");
    expect(midView.body.items[0].currentQuantity).toBe(0);
    expect(midView.body.items[1]).toMatchObject({
      shape: "SLIM",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    });

    ctx.clock.advance(5 * 60_000);
    const slimRes = await postOpeningStock(ctx, owner, "slim", { quantity: 18 });
    expect(slimRes.status).toBe(201);
    expect(slimRes.body.item).toEqual({
      code: "SLIM",
      name: "Slim Container",
      category: "CONTAINER",
      shape: "SLIM",
      unit: "containers",
      status: "INITIALIZED",
      currentQuantity: 18,
      openingStock: {
        quantity: 18,
        unit: "containers",
        recordedBy: "owner1",
        recordedAt: "2026-11-22T09:05:00+08:00",
      },
    });

    const finalView = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
    expect(finalView.body.items[0].currentQuantity).toBe(0);
    expect(finalView.body.items[1].currentQuantity).toBe(18);
  });

  it("blocks duplicate opening counts and handles simultaneous concurrent requests cleanly", async () => {
    const first = await postOpeningStock(ctx, owner, "ROUND", { quantity: 12 });
    expect(first.status).toBe(201);

    const owner2 = await activatedAccount(ctx, "owner2", "OWNER");
    ctx.clock.advance(5 * 60_000);

    const duplicate = await postOpeningStock(ctx, owner2, "ROUND", { quantity: 99 });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("OPENING_STOCK_ALREADY_SET");
    expect(duplicate.body.item).toEqual(first.body.item);

    // Concurrent initialization attempts on Slim: exactly one succeeds, one gets 409.
    const [r1, r2] = await Promise.all([
      postOpeningStock(ctx, owner, "SLIM", { quantity: 24 }),
      postOpeningStock(ctx, owner2, "SLIM", { quantity: 30 }),
    ]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const winner = r1.status === 201 ? r1.body.item : r2.body.item;
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe("OPENING_STOCK_ALREADY_SET");
    expect(loser.body.item).toEqual(winner);

    const { rows: countRows } = await ctx.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM inventory_opening_counts`,
    );
    expect(Number(countRows[0]?.count)).toBe(2);
  });

  it("persists opening counts across database reload", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "hydrop-inv-persist-"));
    try {
      const ctx1 = await createTestContext({ dataDir, clock: new ManualClock(BASE_MANILA) });
      const owner1 = await activatedAccount(ctx1, "owner1", "OWNER");
      const savedRound = await postOpeningStock(ctx1, owner1, "ROUND", { quantity: 0 });
      expect(savedRound.status).toBe(201);
      const savedSlim = await postOpeningStock(ctx1, owner1, "SLIM", { quantity: 15 });
      expect(savedSlim.status).toBe(201);
      await ctx1.close();

      const ctx2 = await createTestContext({ dataDir, clock: new ManualClock("2026-11-23T08:00:00+08:00") });
      const reloadedOwner = await signIn(ctx2.app, "owner1", owner1.password);
      const viewRes = await request(ctx2.app).get("/api/inventory/items").set("Cookie", reloadedOwner.cookie);
      expect(viewRes.status).toBe(200);
      expect(viewRes.body.items).toEqual([savedRound.body.item, savedSlim.body.item]);
      await ctx2.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("carries opening counts across POS Start Day, refill checkout, and End Day", async () => {
    const roundRes = await postOpeningStock(ctx, owner, "ROUND", { quantity: 14 });
    expect(roundRes.status).toBe(201);

    const startRes = await request(ctx.app)
      .post("/api/pos/day/start")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ requestKey: "inv-day-start" });
    expect(startRes.status).toBe(201);

    const prepRes = await request(ctx.app)
      .post("/api/pos/checkouts")
      .set("Cookie", cashier.cookie)
      .set("X-CSRF-Token", cashier.csrfToken)
      .send({
        requestKey: "inv-pos-prep",
        items: [{ kind: "STANDARD", waterType: "PURIFIED", quantity: 2 }],
      });
    expect(prepRes.status).toBe(201);
    const ref = prepRes.body.checkout.reference as string;

    const beginRes = await request(ctx.app)
      .post(`/api/pos/checkouts/${ref}/begin-payment`)
      .set("Cookie", cashier.cookie)
      .set("X-CSRF-Token", cashier.csrfToken)
      .send({});
    expect(beginRes.status).toBe(200);

    const confirmRes = await request(ctx.app)
      .post(`/api/pos/checkouts/${ref}/confirm`)
      .set("Cookie", cashier.cookie)
      .set("X-CSRF-Token", cashier.csrfToken)
      .send({ cashReceivedCentavos: 10000 });
    expect(confirmRes.status).toBe(201);

    const endRes = await request(ctx.app)
      .post("/api/pos/day/end")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ requestKey: "inv-day-end", expectedBusinessDate: "2026-11-22" });
    expect(endRes.status).toBe(200);

    const after = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
    expect(after.status).toBe(200);
    expect(after.body.items[0]).toEqual(roundRes.body.item);
    expect(after.body.items[1]).toMatchObject({
      shape: "SLIM",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    });
  });

  it("enables PostgreSQL row-level security on Inventory tables while Express retains access (DEC-067)", async () => {
    const { rows } = await ctx.db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('inventory_items', 'inventory_opening_counts')
        ORDER BY relname ASC`,
    );
    expect(rows).toEqual([
      { relname: "inventory_items", relrowsecurity: true, relforcerowsecurity: false },
      { relname: "inventory_opening_counts", relrowsecurity: true, relforcerowsecurity: false },
    ]);
  });
});
