import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const BASE_MANILA = "2026-11-22T09:00:00+08:00";

type Activated = SignedIn & { password: string };

async function postOpeningStock(
  ctx: TestContext,
  actor: SignedIn,
  itemKey: string,
  payload: unknown,
) {
  return request(ctx.app)
    .post(`/api/inventory/items/${encodeURIComponent(itemKey)}/opening-stock`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload as Record<string, unknown>);
}

async function postProduct(
  ctx: TestContext,
  actor: SignedIn,
  payload: unknown,
) {
  return request(ctx.app)
    .post("/api/inventory/products")
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload as Record<string, unknown>);
}

async function patchProduct(
  ctx: TestContext,
  actor: SignedIn,
  id: string,
  payload: unknown,
) {
  return request(ctx.app)
    .patch(`/api/inventory/products/${encodeURIComponent(id)}`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload as Record<string, unknown>);
}

async function patchContainer(
  ctx: TestContext,
  actor: SignedIn,
  shape: string,
  payload: unknown,
) {
  return request(ctx.app)
    .patch(`/api/inventory/containers/${encodeURIComponent(shape)}`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload as Record<string, unknown>);
}

async function postPosSection(
  ctx: TestContext,
  actor: SignedIn,
  payload: unknown,
) {
  return request(ctx.app)
    .post("/api/inventory/pos-sections")
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload as Record<string, unknown>);
}

async function archiveProduct(
  ctx: TestContext,
  actor: SignedIn,
  id: string,
) {
  return request(ctx.app)
    .post(`/api/inventory/products/${encodeURIComponent(id)}/archive`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send({});
}

async function postReconciliation(
  ctx: TestContext,
  actor: SignedIn,
  itemKey: string,
  payload: unknown,
) {
  return request(ctx.app)
    .post(`/api/inventory/items/${encodeURIComponent(itemKey)}/reconciliations`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload as Record<string, unknown>);
}

async function postReceiving(
  ctx: TestContext,
  actor: SignedIn,
  itemKey: string,
  payload: unknown,
) {
  return request(ctx.app)
    .post(`/api/inventory/items/${encodeURIComponent(itemKey)}/receiving`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload as Record<string, unknown>);
}

async function postUsage(
  ctx: TestContext,
  actor: SignedIn,
  itemKey: string,
  payload: unknown,
) {
  return request(ctx.app)
    .post(`/api/inventory/items/${encodeURIComponent(itemKey)}/usage`)
    .set("Cookie", actor.cookie)
    .set("X-CSRF-Token", actor.csrfToken)
    .send(payload as Record<string, unknown>);
}

describe("Inventory Round/Slim opening stock and merchandise products (DEC-065, DEC-068, DEC-069)", () => {
  let ctx: TestContext;
  let owner: Activated;
  let cashier: Activated;

  beforeEach(async () => {
    ctx = await createTestContext({ clock: new ManualClock(BASE_MANILA) });
    owner = await activatedAccount(ctx, "owner1", "OWNER");
    cashier = await activatedAccount(ctx, "cashier1", "EMPLOYEE");
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

    const anonCreate = await request(ctx.app)
      .post("/api/inventory/products")
      .send({
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      });
    expect(anonCreate.status).toBe(401);
    expect(anonCreate.body.error.code).toBe("UNAUTHENTICATED");

    const missingCsrf = await request(ctx.app)
      .post("/api/inventory/items/ROUND/opening-stock")
      .set("Cookie", owner.cookie)
      .send({ quantity: 5 });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error.code).toBe("CSRF_INVALID");

    const missingProductCsrf = await request(ctx.app)
      .post("/api/inventory/products")
      .set("Cookie", owner.cookie)
      .send({
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      });
    expect(missingProductCsrf.status).toBe(403);
    expect(missingProductCsrf.body.error.code).toBe("CSRF_INVALID");

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
    expect(ownerRes.body.permissions).toEqual({
      canView: true,
      canInitializeOpeningStock: true,
      canCreateProduct: true,
      canRecordReceiving: true,
      canRecordUsage: true,
      canReconcile: true,
    });
    expect(ownerRes.body.items).toHaveLength(2);
    expect(ownerRes.body.items[0]).toMatchObject({
      code: "ROUND",
      name: "Round Container",
      category: "CONTAINER",
      shape: "ROUND",
      unit: "containers",
      showInPos: false,
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    });
    expect(ownerRes.body.items[1]).toMatchObject({
      code: "SLIM",
      name: "Slim Container",
      category: "CONTAINER",
      shape: "SLIM",
      unit: "containers",
      showInPos: false,
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
    });

    const cashierRes = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
    expect(cashierRes.status).toBe(200);
    expect(cashierRes.body.permissions).toEqual({
      canView: true,
      canInitializeOpeningStock: false,
      canCreateProduct: false,
      canRecordReceiving: false,
      canRecordUsage: true,
      canReconcile: false,
    });
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

    const deniedCreate = await request(ctx.app)
      .post("/api/inventory/products")
      .set("Cookie", cashier.cookie)
      .set("X-CSRF-Token", cashier.csrfToken)
      .set("X-Role", "OWNER")
      .send({
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      });
    expect(deniedCreate.status).toBe(403);
    expect(deniedCreate.body.error.code).toBe("FORBIDDEN");

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
    expect(roundRes.body.item).toMatchObject({
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
    expect(slimRes.body.item).toMatchObject({
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

  it("allows Owner to create visible Push-Type Faucet (₱40) and hidden Divider (₱15), validate inputs, toggle visibility, and initialize merchandise opening counts", async () => {
    // Reject invalid merchandise product payloads
    const invalidPayloads = [
      {
        name: "   ",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      },
      {
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: false,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      },
      {
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 0,
        showInPos: false,
        posSection: "CHANGE_OF_GRIPO",
      },
      {
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: -100,
        showInPos: false,
      },
      {
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 40.5,
        showInPos: false,
      },
      {
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
      },
      {
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "INVALID_SECTION",
      },
      {
        name: "Push-Type Faucet",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: false,
        currentQuantity: 50,
      },
    ];
    for (const payload of invalidPayloads) {
      const bad = await postProduct(ctx, owner, payload);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("VALIDATION_FAILED");
    }

    // Create visible Push-Type Faucet @ ₱40.00
    const faucetRes = await postProduct(ctx, owner, {
      name: "Push-Type Faucet",
      description: "Press to dispense water",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 4000,
      showInPos: true,
      posSection: "CHANGE_OF_GRIPO",
    });
    expect(faucetRes.status).toBe(201);
    expect(faucetRes.body.item).toMatchObject({
      name: "Push-Type Faucet",
      category: "MERCHANDISE",
      shape: null,
      description: "Press to dispense water",
      unit: "pcs",
      unitPriceCentavos: 4000,
      showInPos: true,
      posSection: "CHANGE_OF_GRIPO",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
      createdBy: "owner1",
      createdAt: "2026-11-22T09:00:00+08:00",
    });

    // Create hidden Divider @ ₱15.00 (defaults showInPos to false if omitted)
    ctx.clock.advance(60_000);
    const dividerRes = await postProduct(ctx, owner, {
      name: "Divider",
      description: "A white transparent cover",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 1500,
      posSection: "TAKIP_ACCESSORIES",
    });
    expect(dividerRes.status).toBe(201);
    expect(dividerRes.body.item).toMatchObject({
      name: "Divider",
      category: "MERCHANDISE",
      unit: "pcs",
      unitPriceCentavos: 1500,
      showInPos: false,
      posSection: "TAKIP_ACCESSORIES",
      status: "NOT_SET",
      currentQuantity: null,
      openingStock: null,
      createdBy: "owner1",
    });

    // Reject duplicate product name (case-insensitive)
    const dupRes = await postProduct(ctx, owner, {
      name: "  push-type faucet ",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 4000,
      showInPos: false,
    });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error.code).toBe("PRODUCT_ALREADY_EXISTS");

    // Initialize explicit zero opening count on Divider and positive opening count on Faucet
    const dividerId = dividerRes.body.item.id as string;
    const faucetId = faucetRes.body.item.id as string;

    const divOpening = await postOpeningStock(ctx, owner, dividerId, { quantity: 0 });
    expect(divOpening.status).toBe(201);
    expect(divOpening.body.item).toMatchObject({
      id: dividerId,
      status: "INITIALIZED",
      currentQuantity: 0,
      openingStock: { quantity: 0, unit: "pcs", recordedBy: "owner1" },
    });

    const faucetOpening = await postOpeningStock(ctx, owner, faucetId, { quantity: 10 });
    expect(faucetOpening.status).toBe(201);
    expect(faucetOpening.body.item).toMatchObject({
      id: faucetId,
      status: "INITIALIZED",
      currentQuantity: 10,
      openingStock: { quantity: 10, unit: "pcs", recordedBy: "owner1" },
    });

    // Duplicate opening count for merchandise is blocked
    const dupOpening = await postOpeningStock(ctx, owner, faucetId, { quantity: 99 });
    expect(dupOpening.status).toBe(409);
    expect(dupOpening.body.error.code).toBe("OPENING_STOCK_ALREADY_SET");

    // Cashier cannot edit/toggle merchandise product
    const cashierPatch = await patchProduct(ctx, cashier, dividerId, { showInPos: true });
    expect(cashierPatch.status).toBe(403);
    expect(cashierPatch.body.error.code).toBe("FORBIDDEN");

    // Owner can publish Divider in POS while preserving its opening stock (0 pcs)
    const ownerPatch = await patchProduct(ctx, owner, dividerId, { showInPos: true });
    expect(ownerPatch.status).toBe(200);
    expect(ownerPatch.body.item).toMatchObject({
      id: dividerId,
      showInPos: true,
      status: "INITIALIZED",
      currentQuantity: 0,
    });
  });

  it("persists products and opening counts across database reload", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "hydrop-inv-persist-"));
    try {
      const ctx1 = await createTestContext({ dataDir, clock: new ManualClock(BASE_MANILA) });
      const owner1 = await activatedAccount(ctx1, "owner1", "OWNER");
      const savedRound = await postOpeningStock(ctx1, owner1, "ROUND", { quantity: 0 });
      expect(savedRound.status).toBe(201);
      const savedSlim = await postOpeningStock(ctx1, owner1, "SLIM", { quantity: 15 });
      expect(savedSlim.status).toBe(201);
      const savedFaucet = await postProduct(ctx1, owner1, {
        name: "Push-Type Faucet",
        description: "Press to dispense water",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 4000,
        showInPos: true,
        posSection: "CHANGE_OF_GRIPO",
      });
      expect(savedFaucet.status).toBe(201);
      const savedDivider = await postProduct(ctx1, owner1, {
        name: "Divider",
        unit: "pcs",
        unitConfirmed: true,
        unitPriceCentavos: 1500,
        showInPos: false,
        posSection: "TAKIP_ACCESSORIES",
      });
      expect(savedDivider.status).toBe(201);
      const faucetOpening = await postOpeningStock(ctx1, owner1, savedFaucet.body.item.id, { quantity: 8 });
      expect(faucetOpening.status).toBe(201);
      await ctx1.close();

      const ctx2 = await createTestContext({ dataDir, clock: new ManualClock("2026-11-23T08:00:00+08:00") });
      const reloadedOwner = await signIn(ctx2.app, "owner1", owner1.password);
      const viewRes = await request(ctx2.app).get("/api/inventory/items").set("Cookie", reloadedOwner.cookie);
      expect(viewRes.status).toBe(200);
      expect(viewRes.body.items).toEqual([
        savedRound.body.item,
        savedSlim.body.item,
        savedDivider.body.item,
        faucetOpening.body.item,
      ]);
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

  it("enables PostgreSQL row-level security on Inventory and POS stock tables while Express retains access (DEC-067)", async () => {
    const { rows } = await ctx.db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN (
            'inventory_items',
            'inventory_opening_counts',
            'inventory_stock_movements',
            'pos_checkout_stock_commitments'
          )
        ORDER BY relname ASC`,
    );
    expect(rows).toEqual([
      { relname: "inventory_items", relrowsecurity: true, relforcerowsecurity: false },
      { relname: "inventory_opening_counts", relrowsecurity: true, relforcerowsecurity: false },
      { relname: "inventory_stock_movements", relrowsecurity: true, relforcerowsecurity: false },
      { relname: "pos_checkout_stock_commitments", relrowsecurity: true, relforcerowsecurity: false },
    ]);

    const { rows: newRlsRows } = await ctx.db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('inventory_pos_sections', 'inventory_reconciliations')
        ORDER BY relname ASC`,
    );
    expect(newRlsRows).toEqual([
      { relname: "inventory_pos_sections", relrowsecurity: true, relforcerowsecurity: false },
      { relname: "inventory_reconciliations", relrowsecurity: true, relforcerowsecurity: false },
    ]);
  });

  it("lets Owner publish Round and Slim to POS and create reusable custom POS sections (DEC-073)", async () => {
    const deniedContainer = await patchContainer(ctx, cashier, "ROUND", { showInPos: true });
    expect(deniedContainer.status).toBe(403);
    expect(deniedContainer.body.error.code).toBe("FORBIDDEN");

    const roundPublished = await patchContainer(ctx, owner, "ROUND", { showInPos: true });
    expect(roundPublished.status).toBe(200);
    expect(roundPublished.body.item).toMatchObject({
      shape: "ROUND",
      showInPos: true,
      posSection: "CONTAINERS",
    });

    const slimPublished = await patchContainer(ctx, owner, "SLIM", { showInPos: true });
    expect(slimPublished.status).toBe(200);
    expect(slimPublished.body.item).toMatchObject({
      shape: "SLIM",
      showInPos: true,
      posSection: "CONTAINERS",
    });

    const roundHidden = await patchContainer(ctx, owner, "ROUND", { showInPos: false });
    expect(roundHidden.status).toBe(200);
    expect(roundHidden.body.item.showInPos).toBe(false);

    // Custom section creation: Owner-only, duplicate-protected, persisted across reload
    const deniedSection = await postPosSection(ctx, cashier, { name: "Cleaning Supplies" });
    expect(deniedSection.status).toBe(403);
    expect(deniedSection.body.error.code).toBe("FORBIDDEN");

    const sectionRes = await postPosSection(ctx, owner, { name: "  Cleaning   Supplies  " });
    expect(sectionRes.status).toBe(201);
    expect(sectionRes.body.section).toMatchObject({
      name: "Cleaning Supplies",
      isBuiltIn: false,
      createdBy: "owner1",
    });
    const customCode = sectionRes.body.section.code as string;

    const dupSection = await postPosSection(ctx, owner, { name: "cleaning supplies" });
    expect(dupSection.status).toBe(409);
    expect(dupSection.body.error.code).toBe("SECTION_ALREADY_EXISTS");

    // Built-in Containers section is reserved and rejected for standalone merchandise
    const reservedAttempt = await postProduct(ctx, owner, {
      name: "Sanitizer Bottle",
      unit: "bottles",
      unitConfirmed: true,
      unitPriceCentavos: 6000,
      showInPos: true,
      posSection: "CONTAINERS",
    });
    expect(reservedAttempt.status).toBe(400);
    expect(reservedAttempt.body.error.code).toBe("VALIDATION_FAILED");

    const customMerch = await postProduct(ctx, owner, {
      name: "Sanitizer Bottle",
      description: "500 ml bottle",
      unit: "bottles",
      unitConfirmed: true,
      unitPriceCentavos: 6000,
      showInPos: true,
      posSection: customCode,
    });
    expect(customMerch.status).toBe(201);
    expect(customMerch.body.item.posSection).toBe(customCode);

    const listRes = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
    expect(listRes.status).toBe(200);
    expect(listRes.body.posSections.map((s: any) => s.name)).toEqual([
      "Containers",
      "Takip Types / Accessories",
      "Change of Gripo",
      "Cleaning Supplies",
    ]);
  });

  it("lets Owner edit details, archive with stock/sales history, and reconcile physical counts under INV-009 (DEC-074)", async () => {
    const created = await postProduct(ctx, owner, {
      name: "Push-Type Faucet",
      description: "Press to dispense",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 4000,
      showInPos: true,
      posSection: "CHANGE_OF_GRIPO",
    });
    const faucetId = created.body.item.id as string;

    // Cannot reconcile before opening stock is set
    const unsetRec = await postReconciliation(ctx, owner, faucetId, {
      physicalCount: 5,
      reason: "Initial check",
      expectedRevision: 0,
      expectedCurrentQuantity: 0,
    });
    expect(unsetRec.status).toBe(409);
    expect(unsetRec.body.error.code).toBe("OPENING_STOCK_NOT_SET");

    const opened = await postOpeningStock(ctx, owner, faucetId, { quantity: 50 });
    expect(opened.status).toBe(201);
    const revAfterOpen = opened.body.item.stockRevision as number;

    // Cashier cannot reconcile stock
    const cashierRec = await postReconciliation(ctx, cashier, faucetId, {
      physicalCount: 5,
      reason: "Cashier check",
      expectedRevision: revAfterOpen,
      expectedCurrentQuantity: 50,
    });
    expect(cashierRec.status).toBe(403);
    expect(cashierRec.body.error.code).toBe("FORBIDDEN");

    // Invalid reconciliation inputs rejected
    const badReason = await postReconciliation(ctx, owner, faucetId, {
      physicalCount: 5,
      reason: "   ",
      expectedRevision: revAfterOpen,
      expectedCurrentQuantity: 50,
    });
    expect(badReason.status).toBe(400);

    const negCount = await postReconciliation(ctx, owner, faucetId, {
      physicalCount: -1,
      reason: "Negative test",
      expectedRevision: revAfterOpen,
      expectedCurrentQuantity: 50,
    });
    expect(negCount.status).toBe(400);

    // INV-009: current balance 50, physical count 5 -> delta -45, original opening count 50 preserved
    ctx.clock.advance(5 * 60_000);
    const reconciled = await postReconciliation(ctx, owner, faucetId, {
      physicalCount: 5,
      reason: "Actual shelf count was 5",
      expectedRevision: revAfterOpen,
      expectedCurrentQuantity: 50,
      requestKey: "rec-faucet-1",
    });
    expect(reconciled.status).toBe(201);
    expect(reconciled.body.reconciliation).toMatchObject({
      balanceBefore: 50,
      physicalCount: 5,
      quantityDelta: -45,
      balanceAfter: 5,
      unit: "pcs",
      reason: "Actual shelf count was 5",
      recordedBy: "owner1",
    });
    expect(reconciled.body.item).toMatchObject({
      id: faucetId,
      currentQuantity: 5,
      openingStock: {
        quantity: 50,
        unit: "pcs",
        recordedBy: "owner1",
      },
      latestReconciliation: {
        physicalCount: 5,
        quantityDelta: -45,
      },
    });

    // Idempotent replay with same requestKey returns 200 without re-applying
    const replayRec = await postReconciliation(ctx, owner, faucetId, {
      physicalCount: 5,
      reason: "Actual shelf count was 5",
      expectedRevision: revAfterOpen,
      expectedCurrentQuantity: 50,
      requestKey: "rec-faucet-1",
    });
    expect(replayRec.status).toBe(200);
    expect(replayRec.body.replayed).toBe(true);
    expect(replayRec.body.item.currentQuantity).toBe(5);

    // Stale count using old baseline (50) is rejected with STALE_STOCK_COUNT and current item state
    const staleRec = await postReconciliation(ctx, owner, faucetId, {
      physicalCount: 10,
      reason: "Stale recount",
      expectedRevision: revAfterOpen,
      expectedCurrentQuantity: 50,
      requestKey: "rec-faucet-stale",
    });
    expect(staleRec.status).toBe(409);
    expect(staleRec.body.error.code).toBe("STALE_STOCK_COUNT");
    expect(staleRec.body.item.currentQuantity).toBe(5);

    // Zero-delta verification at current balance 5 saves history without modifying stock
    const revAfterRec = reconciled.body.item.stockRevision as number;
    const verifyRec = await postReconciliation(ctx, owner, faucetId, {
      physicalCount: 5,
      reason: "Verified shelf count",
      expectedRevision: revAfterRec,
      expectedCurrentQuantity: 5,
    });
    expect(verifyRec.status).toBe(201);
    expect(verifyRec.body.reconciliation.quantityDelta).toBe(0);

    const recHistory = await request(ctx.app)
      .get(`/api/inventory/items/${encodeURIComponent(faucetId)}/reconciliations`)
      .set("Cookie", cashier.cookie);
    expect(recHistory.status).toBe(200);
    expect(recHistory.body.reconciliations).toHaveLength(2);

    // Edit details directly in Inventory (stock and opening count remain intact)
    const sectionRes = await postPosSection(ctx, owner, { name: "Spare Parts" });
    const spareCode = sectionRes.body.section.code as string;
    const edited = await patchProduct(ctx, owner, faucetId, {
      name: "Blue Push Faucet",
      description: "Updated blue lever",
      unitPriceCentavos: 4500,
      posSection: spareCode,
      showInPos: true,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.item).toMatchObject({
      name: "Blue Push Faucet",
      description: "Updated blue lever",
      unitPriceCentavos: 4500,
      posSection: spareCode,
      currentQuantity: 5,
      openingStock: { quantity: 50 },
    });

    // Sell 1 unit so product has both remaining stock (4) and sales history before archiving
    await request(ctx.app)
      .post("/api/pos/day/start")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ requestKey: "archive-test-day" });
    const prep = await request(ctx.app)
      .post("/api/pos/checkouts")
      .set("Cookie", cashier.cookie)
      .set("X-CSRF-Token", cashier.csrfToken)
      .send({ items: [{ kind: "MERCHANDISE", productId: faucetId, quantity: 1 }] });
    const saleRef = prep.body.checkout.reference as string;
    await request(ctx.app)
      .post(`/api/pos/checkouts/${saleRef}/confirm`)
      .set("Cookie", cashier.cookie)
      .set("X-CSRF-Token", cashier.csrfToken)
      .send({ cashReceivedCentavos: 5000 });

    // Cashier cannot archive; core containers cannot be archived
    const cashierArchive = await archiveProduct(ctx, cashier, faucetId);
    expect(cashierArchive.status).toBe(403);

    const roundItem = (
      await request(ctx.app).get("/api/inventory/items").set("Cookie", owner.cookie)
    ).body.items.find((i: any) => i.shape === "ROUND");
    const containerArchive = await archiveProduct(ctx, owner, roundItem.id);
    expect(containerArchive.status).toBe(400);

    // Owner archives Blue Push Faucet with 4 pcs remaining and 1 saved sale
    const archived = await archiveProduct(ctx, owner, faucetId);
    expect(archived.status).toBe(200);
    expect(archived.body.item).toMatchObject({
      id: faucetId,
      showInPos: false,
      currentQuantity: 4,
      archivedBy: "owner1",
    });
    expect(archived.body.item.archivedAt).toBeTruthy();

    // Hidden from active Inventory and POS catalog, preserved under ?includeArchived=true and in POS sales history
    const activeList = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
    expect(activeList.body.items.some((i: any) => i.id === faucetId)).toBe(false);

    const withArchived = await request(ctx.app)
      .get("/api/inventory/items?includeArchived=true")
      .set("Cookie", owner.cookie);
    const archivedRow = withArchived.body.items.find((i: any) => i.id === faucetId);
    expect(archivedRow).toMatchObject({
      id: faucetId,
      currentQuantity: 4,
      openingStock: { quantity: 50 },
    });

    const saleHistory = await request(ctx.app)
      .get(`/api/pos/sales/${encodeURIComponent(saleRef)}`)
      .set("Cookie", cashier.cookie);
    expect(saleHistory.status).toBe(200);
    expect(saleHistory.body.sale.items[0].displayLabel).toBe("Blue Push Faucet");

    // Archived product rejects repeat archive and active edits; name becomes reusable
    expect((await archiveProduct(ctx, owner, faucetId)).status).toBe(409);
    expect((await patchProduct(ctx, owner, faucetId, { name: "Blocked Edit" })).status).toBe(409);

    const reusedName = await postProduct(ctx, owner, {
      name: "Blue Push Faucet",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 5000,
      showInPos: false,
    });
    expect(reusedName.status).toBe(201);
  });

  it("lets Owner set and clear Low Stock levels and standalone faucet reporting types without altering balances or movements (DEC-090, DEC-093)", async () => {
    // Initialize Round container stock at 12
    const roundOpen = await postOpeningStock(ctx, owner, "ROUND", { quantity: 12 });
    expect(roundOpen.status).toBe(201);
    const revBefore = roundOpen.body.item.stockRevision as number;

    // Set Low Stock level of 5 on Round container and keep current balance/revision unchanged
    const roundLow = await patchContainer(ctx, owner, "ROUND", { lowStockLevel: 5 });
    expect(roundLow.status).toBe(200);
    expect(roundLow.body.item).toMatchObject({
      shape: "ROUND",
      currentQuantity: 12,
      stockRevision: revBefore,
      lowStockLevel: 5,
      faucetReportingType: null,
    });

    // Omitting lowStockLevel on showInPos edit preserves lowStockLevel: 5
    const roundShow = await patchContainer(ctx, owner, "ROUND", { showInPos: true });
    expect(roundShow.status).toBe(200);
    expect(roundShow.body.item).toMatchObject({
      shape: "ROUND",
      showInPos: true,
      lowStockLevel: 5,
    });

    // Clear Round lowStockLevel with null
    const roundClear = await patchContainer(ctx, owner, "ROUND", { lowStockLevel: null });
    expect(roundClear.status).toBe(200);
    expect(roundClear.body.item.lowStockLevel).toBeNull();

    // Slim can also set lowStockLevel; container faucetReportingType edits are rejected
    const slimLow = await patchContainer(ctx, owner, "SLIM", { lowStockLevel: 3 });
    expect(slimLow.status).toBe(200);
    expect(slimLow.body.item.lowStockLevel).toBe(3);

    const invalidContainerFaucet = await patchContainer(ctx, owner, "ROUND", {
      faucetReportingType: "PUSH_TYPE",
    });
    expect(invalidContainerFaucet.status).toBe(400);
    expect(invalidContainerFaucet.body.error.code).toBe("VALIDATION_FAILED");

    // Reject malformed lowStockLevel values on container and standalone merchandise
    for (const badLevel of [0, -1, 2.5, "5", true, 1_000_001]) {
      const res = await patchContainer(ctx, owner, "ROUND", { lowStockLevel: badLevel });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }

    // Create standalone merchandise with lowStockLevel and faucetReportingType
    const createdFaucet = await postProduct(ctx, owner, {
      name: "Push Gripo Pro",
      unit: "pcs",
      unitConfirmed: true,
      unitPriceCentavos: 4500,
      showInPos: true,
      posSection: "CHANGE_OF_GRIPO",
      lowStockLevel: 5,
      faucetReportingType: "PUSH_TYPE",
    });
    expect(createdFaucet.status).toBe(201);
    expect(createdFaucet.body.item).toMatchObject({
      name: "Push Gripo Pro",
      lowStockLevel: 5,
      faucetReportingType: "PUSH_TYPE",
    });
    const faucetId = createdFaucet.body.item.id as string;

    expect((await postOpeningStock(ctx, owner, faucetId, { quantity: 10 })).status).toBe(201);

    // Omitting settings on unrelated name edit preserves both lowStockLevel and faucetReportingType
    const renameOnly = await patchProduct(ctx, owner, faucetId, { name: "Push Gripo Deluxe" });
    expect(renameOnly.status).toBe(200);
    expect(renameOnly.body.item).toMatchObject({
      name: "Push Gripo Deluxe",
      currentQuantity: 10,
      lowStockLevel: 5,
      faucetReportingType: "PUSH_TYPE",
    });

    // Clear lowStockLevel and change faucetReportingType to TWIST_TYPE then null
    const updatedTypes = await patchProduct(ctx, owner, faucetId, {
      lowStockLevel: null,
      faucetReportingType: "TWIST_TYPE",
    });
    expect(updatedTypes.status).toBe(200);
    expect(updatedTypes.body.item).toMatchObject({
      lowStockLevel: null,
      faucetReportingType: "TWIST_TYPE",
    });

    const clearedFaucetType = await patchProduct(ctx, owner, faucetId, {
      faucetReportingType: null,
    });
    expect(clearedFaucetType.status).toBe(200);
    expect(clearedFaucetType.body.item.faucetReportingType).toBeNull();

    // Reject invalid faucetReportingType and Cashier edits
    const badFaucetType = await patchProduct(ctx, owner, faucetId, {
      faucetReportingType: "LEVER_TYPE",
    });
    expect(badFaucetType.status).toBe(400);

    const cashierContainerEdit = await patchContainer(ctx, cashier, "ROUND", { lowStockLevel: 4 });
    expect(cashierContainerEdit.status).toBe(403);
    expect(cashierContainerEdit.body.error.code).toBe("FORBIDDEN");

    const cashierProductEdit = await patchProduct(ctx, cashier, faucetId, { lowStockLevel: 4 });
    expect(cashierProductEdit.status).toBe(403);
    expect(cashierProductEdit.body.error.code).toBe("FORBIDDEN");

    // Verify zero stock movements were created by setting/clearing lowStockLevel
    const { rows: movRows } = await ctx.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM inventory_stock_movements`,
    );
    expect(movRows[0]!.count).toBe("0");
  });

  it("exposes pre-sale holds and reduced availableQuantity in Inventory items and blocks reconciling below active holds", async () => {
    expect(
      (
        await request(ctx.app)
          .patch("/api/inventory/containers/ROUND")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ showInPos: true })
      ).status,
    ).toBe(200);
    const opening = await postOpeningStock(ctx, owner, "ROUND", { quantity: 4 });
    expect(opening.status).toBe(201);
    const roundId = opening.body.item.id as string;
    const revision = opening.body.item.stockRevision as number;

    expect(
      (
        await request(ctx.app)
          .post("/api/pos/day/start")
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({ requestKey: "inv-hold-day" })
      ).status,
    ).toBe(201);

    const prep = await request(ctx.app)
      .post("/api/pos/checkouts")
      .set("Cookie", cashier.cookie)
      .set("X-CSRF-Token", cashier.csrfToken)
      .send({
        prepareKey: "inv-hold-prep",
        items: [
          {
            kind: "CONTAINER_PACKAGE",
            packageCode: "ROUND_PURIFIED",
            includedGripo: "PUSH_TYPE",
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

    const holdReason = "Cancelled filled order held for health office check";
    expect(
      (
        await request(ctx.app)
          .post(`/api/pos/checkouts/${encodeURIComponent(ref)}/resolve`)
          .set("Cookie", owner.cookie)
          .set("X-CSRF-Token", owner.csrfToken)
          .send({
            outcome: "FULL_REFUND",
            undeliveredConfirmed: true,
            fullRefundConfirmed: true,
            cashReceivedCentavos: 40000,
            changeAlreadyGiven: false,
            heldItems: [{ productId: roundId, quantity: 2, reason: holdReason }],
          })
      ).status,
    ).toBe(201);

    const listRes = await request(ctx.app).get("/api/inventory/items").set("Cookie", cashier.cookie);
    expect(listRes.status).toBe(200);
    const roundItem = listRes.body.items.find((item: any) => item.id === roundId);
    expect(roundItem).toMatchObject({
      currentQuantity: 4,
      heldQuantity: 2,
      availableQuantity: 2,
    });
    expect(roundItem.activeHolds).toHaveLength(1);
    expect(roundItem.activeHolds[0]).toMatchObject({
      quantity: 2,
      reason: holdReason,
      posReference: ref,
    });

    // Cannot reconcile physical count below the 2 held units
    const blockedRec = await postReconciliation(ctx, owner, "ROUND", {
      physicalCount: 1,
      reason: "Attempting count below active holds",
      expectedRevision: revision,
      expectedCurrentQuantity: 4,
      requestKey: "rec-below-hold",
    });
    expect(blockedRec.status).toBe(409);
    expect(blockedRec.body.error.code).toBe("ACTIVE_STOCK_HOLD");

    // Reconciling to >= held units succeeds
    const validRec = await postReconciliation(ctx, owner, "ROUND", {
      physicalCount: 3,
      reason: "Found 3 physical containers including 2 held filled",
      expectedRevision: revision,
      expectedCurrentQuantity: 4,
      requestKey: "rec-above-hold",
    });
    expect(validRec.status).toBe(201);
    expect(validRec.body.item).toMatchObject({
      currentQuantity: 3,
      heldQuantity: 2,
      availableQuantity: 1,
    });
  });
});

describe("Final Inventory Task 1 — operating supplies, receiving, usage, and Dashboard Trend", () => {
  let ctx: TestContext;
  let owner: Activated;
  let employee: Activated;

  beforeEach(async () => {
    ctx = await createTestContext({ clock: new ManualClock("2026-11-27T09:00:00+08:00") });
    owner = await activatedAccount(ctx, "owner_inv1", "OWNER");
    employee = await activatedAccount(ctx, "emp_inv1", "EMPLOYEE");
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("upgrades an existing pre-0021 database fixture preserving package, merchandise, and opening-count records", async () => {
    const preDir = await mkdtemp(path.join(os.tmpdir(), "hydrop-pre0021-"));
    const db = await createPgliteDatabase();
    try {
      const files = (await readdir(MIGRATIONS_DIR))
        .filter((f) => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) < 21)
        .sort();
      for (const file of files) {
        await copyFile(path.join(MIGRATIONS_DIR, file), path.join(preDir, file));
      }
      await runMigrations(db, preDir);

      const clock = new ManualClock("2026-11-27T09:30:00+08:00");
      const app = createApp({ db, clock, secureCookies: false });
      const localCtx: TestContext = { db, clock, app, close: () => db.close() };

      const ownerAcct = await activatedAccount(localCtx, "upg_owner", "OWNER");
      const empAcct = await activatedAccount(localCtx, "upg_emp", "EMPLOYEE");
      const { rows: userRows } = await db.query<{ id: string; username: string }>(
        `SELECT id, username FROM app_users WHERE username IN ('upg_owner', 'upg_emp')`,
      );
      const ownerId = userRows.find((u) => u.username === "upg_owner")!.id;
      const empId = userRows.find((u) => u.username === "upg_emp")!.id;

      // Seed pre-0021 Round opening count, standalone merchandise + opening count, and POS sale movement directly in SQL.
      const { rows: roundRows } = await db.query<{ id: string }>(
        `UPDATE inventory_items
            SET show_in_pos = true,
                pos_section = 'CONTAINERS',
                current_quantity = 9,
                stock_revision = 2
          WHERE category = 'CONTAINER' AND container_shape = 'ROUND'
          RETURNING id`,
      );
      const roundId = roundRows[0]!.id;
      await db.query(
        `INSERT INTO inventory_opening_counts (item_id, quantity, unit, recorded_by_user_id, recorded_at)
         VALUES ($1, 10, 'containers', $2, '2026-11-26T08:00:00+08:00')`,
        [roundId, ownerId],
      );

      const { rows: merchRows } = await db.query<{ id: string }>(
        `INSERT INTO inventory_items (
           code, name, category, unit, unit_price_centavos, show_in_pos, pos_section,
           current_quantity, stock_revision, created_by_user_id, created_at
         )
         VALUES ('MERCH-UPG01', 'Push-Type Faucet', 'MERCHANDISE', 'pcs', 4000, true, 'CHANGE_OF_GRIPO', 4, 2, $1, '2026-11-26T08:00:00+08:00')
         RETURNING id`,
        [ownerId],
      );
      const merchId = merchRows[0]!.id;
      await db.query(
        `INSERT INTO inventory_opening_counts (item_id, quantity, unit, recorded_by_user_id, recorded_at)
         VALUES ($1, 6, 'pcs', $2, '2026-11-26T08:00:00+08:00')`,
        [merchId, ownerId],
      );

      const { rows: dayRows } = await db.query<{ id: string }>(
        `INSERT INTO pos_business_days (business_date, started_by_user_id, started_at)
         VALUES ('2026-11-26', $1, '2026-11-26T08:00:00+08:00')
         RETURNING id`,
        [ownerId],
      );
      const dayId = dayRows[0]!.id;

      const { rows: checkoutRows } = await db.query<{ id: string }>(
        `INSERT INTO pos_checkouts (
           reference, business_day_id, business_date, created_by_user_id, status,
           quote_snapshot, quote_hash, total_centavos, total_containers, total_volume_ml,
           cash_received_centavos, change_centavos, created_at, updated_at
         )
         VALUES (
           'POS-20261126-0001', $1, '2026-11-26', $2, 'SAVED',
           '[]'::jsonb, 'hash-upg-1', 28000, 1, 25000,
           30000, 2000, '2026-11-26T09:00:00+08:00', '2026-11-26T09:01:00+08:00'
         )
         RETURNING id`,
        [dayId, empId],
      );
      const checkoutId = checkoutRows[0]!.id;

      const { rows: saleRows } = await db.query<{ id: string }>(
        `INSERT INTO pos_sales (
           reference, checkout_id, business_day_id, business_date,
           total_centavos, cash_received_centavos, change_centavos,
           total_containers, total_volume_ml, created_by_user_id, created_at
         )
         VALUES (
           'SALE-20261126-0001', $1, $2, '2026-11-26',
           28000, 30000, 2000, 1, 25000, $3, '2026-11-26T09:01:00+08:00'
         )
         RETURNING id`,
        [checkoutId, dayId, empId],
      );
      const saleId = saleRows[0]!.id;

      await db.query(
        `INSERT INTO inventory_stock_movements (
           item_id, movement_type, quantity_delta, balance_before, balance_after,
           unit, pos_sale_id, pos_reference, actor_user_id, recorded_at
         )
         VALUES
           ($1, 'POS_SALE', -1, 10, 9, 'containers', $3, 'SALE-20261126-0001', $4, '2026-11-26T09:01:00+08:00'),
           ($2, 'POS_SALE', -2, 6, 4, 'pcs', $3, 'SALE-20261126-0001', $4, '2026-11-26T09:01:00+08:00')`,
        [roundId, merchId, saleId, empId],
      );

      // Apply migrations 0021 and 0022 onto the populated database.
      const newlyApplied = await runMigrations(db, MIGRATIONS_DIR);
      expect(newlyApplied).toEqual([
        "0021_inventory_supplies_and_movements.sql",
        "0022_inventory_movement_request_tombstones.sql",
      ]);

      const afterItems = await request(app).get("/api/inventory/items").set("Cookie", empAcct.cookie);
      expect(afterItems.status).toBe(200);
      const roundAfter = afterItems.body.items.find((i: any) => i.shape === "ROUND");
      const merchAfter = afterItems.body.items.find((i: any) => i.id === merchId);
      expect(roundAfter).toMatchObject({
        currentQuantity: 9,
        allowDecimalQuantity: false,
        needsReconciliation: false,
        openingStock: { quantity: 10, unit: "containers" },
      });
      expect(merchAfter).toMatchObject({
        currentQuantity: 4,
        allowDecimalQuantity: false,
        needsReconciliation: false,
        openingStock: { quantity: 6, unit: "pcs" },
      });

      // Whole-piece items still reject fractional quantities after upgrade.
      const badRec = await postReconciliation(localCtx, ownerAcct, "ROUND", {
        physicalCount: 8.5,
        reason: "Fractional test",
        expectedRevision: roundAfter.stockRevision,
        expectedCurrentQuantity: 9,
        requestKey: "upg-bad-frac",
      });
      expect(badRec.status).toBe(400);

      const badRecv = await postReceiving(localCtx, ownerAcct, merchId, {
        quantity: 1.5,
        expectedRevision: merchAfter.stockRevision,
        expectedCurrentQuantity: 4,
        requestKey: "upg-bad-recv",
      });
      expect(badRecv.status).toBe(400);

      // Existing Dashboard Trend still verifies pre-0021 opening + POS_SALE movements cleanly after 0021.
      const roundTrend = await request(app)
        .get("/api/dashboard/stocks/ROUND/trend")
        .set("Cookie", ownerAcct.cookie);
      expect(roundTrend.status).toBe(200);
      expect(roundTrend.body.historyState).toBe("COMPLETE");
      expect(roundTrend.body.points.map((p: any) => p.balanceAfter)).toEqual([10, 9]);
    } finally {
      await db.close();
      await rm(preDir, { recursive: true, force: true });
    }
  });

  it("supports measurable operating supplies, decimal usage to negative with discrepancy flag, idempotency, permissions, and Dashboard Trend", async () => {
    // 1. Create measurable operating supply (Dishwashing Liquid in L) and whole-piece operating supply (Container Seals in pcs).
    const liquidRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Dishwashing Liquid",
      description: "Sanitizing wash",
      unit: "L",
      allowDecimalQuantity: true,
      unitConfirmed: true,
      lowStockLevel: 0.5,
    });
    expect(liquidRes.status).toBe(201);
    const liquidId = liquidRes.body.item.id as string;
    expect(liquidRes.body.item).toMatchObject({
      category: "OPERATING_SUPPLY",
      unit: "L",
      allowDecimalQuantity: true,
      needsReconciliation: false,
      showInPos: false,
      unitPriceCentavos: null,
      posSection: null,
      lowStockLevel: 0.5,
      status: "NOT_SET",
      currentQuantity: null,
    });

    const sealsRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Container Seals",
      unit: "pcs",
      allowDecimalQuantity: false,
      unitConfirmed: true,
    });
    expect(sealsRes.status).toBe(201);
    const sealsId = sealsRes.body.item.id as string;

    // Operating supplies reject POS fields; Merchandise rejects allowDecimalQuantity.
    expect(
      (
        await postProduct(ctx, owner, {
          category: "OPERATING_SUPPLY",
          name: "Bad Supply",
          unit: "kg",
          unitConfirmed: true,
          showInPos: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postProduct(ctx, owner, {
          category: "MERCHANDISE",
          name: "Bad Merch",
          unit: "pcs",
          allowDecimalQuantity: true,
          unitConfirmed: true,
          unitPriceCentavos: 1000,
        })
      ).status,
    ).toBe(400);

    // Employee cannot create products, receive stock, or reconcile.
    expect(
      (
        await postProduct(ctx, employee, {
          category: "OPERATING_SUPPLY",
          name: "Emp Supply",
          unit: "pcs",
          unitConfirmed: true,
        })
      ).status,
    ).toBe(403);

    // Not Set blocks both Stock Received and Stock Used.
    const unsetRecv = await postReceiving(ctx, owner, liquidId, {
      quantity: 1,
      expectedRevision: 0,
      expectedCurrentQuantity: 0,
      requestKey: "unset-recv",
    });
    expect(unsetRecv.status).toBe(409);
    expect(unsetRecv.body.error.code).toBe("OPENING_STOCK_NOT_SET");

    const unsetUse = await postUsage(ctx, employee, liquidId, {
      quantity: 0.5,
      purpose: "Cleaning",
      expectedRevision: 0,
      expectedCurrentQuantity: 0,
      requestKey: "unset-use",
    });
    expect(unsetUse.status).toBe(409);
    expect(unsetUse.body.error.code).toBe("OPENING_STOCK_NOT_SET");

    // Whole-piece supply rejects fractional opening count.
    expect(
      (await postOpeningStock(ctx, owner, sealsId, { quantity: 10.5 })).status,
    ).toBe(400);
    const sealsOpen = await postOpeningStock(ctx, owner, sealsId, { quantity: 500 });
    expect(sealsOpen.status).toBe(201);
    const sealsRev = sealsOpen.body.item.stockRevision as number;

    // Measurable supply initializes at 1.25 L.
    const liquidOpen = await postOpeningStock(ctx, owner, liquidId, { quantity: 1.25 });
    expect(liquidOpen.status).toBe(201);
    const liquidRev = liquidOpen.body.item.stockRevision as number;
    expect(liquidOpen.body.item).toMatchObject({
      status: "INITIALIZED",
      currentQuantity: 1.25,
      openingStock: { quantity: 1.25, unit: "L" },
    });

    // Late/future effectiveDate is blocked in Task 1 until Task 2 adds count-coverage review.
    expect(
      (
        await postUsage(ctx, employee, liquidId, {
          quantity: 0.25,
          purpose: "Yesterday wash",
          effectiveDate: "2026-11-26",
          expectedRevision: liquidRev,
          expectedCurrentQuantity: 1.25,
          requestKey: "late-use-guard",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postReceiving(ctx, owner, liquidId, {
          quantity: 1,
          effectiveDate: "2026-11-26",
          expectedRevision: liquidRev,
          expectedCurrentQuantity: 1.25,
          requestKey: "late-recv-guard",
        })
      ).status,
    ).toBe(400);

    // Whole-piece supply rejects fractional receiving & usage.
    expect(
      (
        await postReceiving(ctx, owner, sealsId, {
          quantity: 2.5,
          expectedRevision: sealsRev,
          expectedCurrentQuantity: 500,
          requestKey: "seals-bad-recv",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postUsage(ctx, employee, sealsId, {
          quantity: 1.2,
          purpose: "Sealing",
          expectedRevision: sealsRev,
          expectedCurrentQuantity: 500,
          requestKey: "seals-bad-use",
        })
      ).status,
    ).toBe(400);

    // Stock Used on non-operating-supply (ROUND) is rejected.
    const roundOpen = await postOpeningStock(ctx, owner, "ROUND", { quantity: 5 });
    expect(roundOpen.status).toBe(201);
    expect(
      (
        await postUsage(ctx, employee, "ROUND", {
          quantity: 1,
          purpose: "Not a supply",
          expectedRevision: roundOpen.body.item.stockRevision,
          expectedCurrentQuantity: 5,
          requestKey: "round-use",
        })
      ).status,
    ).toBe(400);

    // Employee records 1.5 L Stock Used -> reaches -0.25 L and sets needsReconciliation: true.
    ctx.clock.advance(60_000);
    const useRes = await postUsage(ctx, employee, liquidId, {
      quantity: 1.5,
      purpose: "Deep cleaning",
      expectedRevision: liquidRev,
      expectedCurrentQuantity: 1.25,
      requestKey: "use-liquid-1",
    });
    expect(useRes.status).toBe(201);
    expect(useRes.body.replayed).toBe(false);
    expect(useRes.body.item).toMatchObject({
      currentQuantity: -0.25,
      needsReconciliation: true,
    });
    expect(useRes.body.movement).toMatchObject({
      movementType: "STOCK_USED",
      quantity: 1.5,
      quantityDelta: -1.5,
      balanceBefore: 1.25,
      balanceAfter: -0.25,
      unit: "L",
      effectiveDate: "2026-11-27",
      note: "Deep cleaning",
      recordedBy: "emp_inv1",
    });

    // Repeat same requestKey -> 200 replayed with single stock effect.
    const useReplay = await postUsage(ctx, employee, liquidId, {
      quantity: 1.5,
      purpose: "Deep cleaning",
      expectedRevision: liquidRev,
      expectedCurrentQuantity: 1.25,
      requestKey: "use-liquid-1",
    });
    expect(useReplay.status).toBe(200);
    expect(useReplay.body.replayed).toBe(true);
    expect(useReplay.body.item.currentQuantity).toBe(-0.25);

    // Reusing same requestKey with different quantity returns 409 REQUEST_KEY_CONFLICT.
    const useConflict = await postUsage(ctx, employee, liquidId, {
      quantity: 0.5,
      purpose: "Deep cleaning",
      expectedRevision: useRes.body.item.stockRevision,
      expectedCurrentQuantity: -0.25,
      requestKey: "use-liquid-1",
    });
    expect(useConflict.status).toBe(409);
    expect(useConflict.body.error.code).toBe("REQUEST_KEY_CONFLICT");

    // Employee cannot call receiving or reconciliation (403).
    expect(
      (
        await postReceiving(ctx, employee, liquidId, {
          quantity: 2,
          expectedRevision: useRes.body.item.stockRevision,
          expectedCurrentQuantity: -0.25,
          requestKey: "emp-recv-403",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await postReconciliation(ctx, employee, liquidId, {
          physicalCount: 2,
          reason: "Emp attempt",
          expectedRevision: useRes.body.item.stockRevision,
          expectedCurrentQuantity: -0.25,
          requestKey: "emp-rec-403",
        })
      ).status,
    ).toBe(403);

    // Owner records Stock Received +2 L -> balance becomes 1.75 L, but needsReconciliation stays true (INV-009)!
    ctx.clock.advance(60_000);
    const recvRes = await postReceiving(ctx, owner, liquidId, {
      quantity: 2,
      note: "Supplier jug delivery",
      expectedRevision: useRes.body.item.stockRevision,
      expectedCurrentQuantity: -0.25,
      requestKey: "recv-liquid-1",
    });
    expect(recvRes.status).toBe(201);
    expect(recvRes.body.item).toMatchObject({
      currentQuantity: 1.75,
      needsReconciliation: true,
    });
    expect(recvRes.body.movement).toMatchObject({
      movementType: "STOCK_RECEIVED",
      quantity: 2,
      quantityDelta: 2,
      balanceBefore: -0.25,
      balanceAfter: 1.75,
      effectiveDate: "2026-11-27",
      note: "Supplier jug delivery",
    });

    // Repeat receiving requestKey -> replayed once.
    const recvReplay = await postReceiving(ctx, owner, liquidId, {
      quantity: 2,
      note: "Supplier jug delivery",
      expectedRevision: useRes.body.item.stockRevision,
      expectedCurrentQuantity: -0.25,
      requestKey: "recv-liquid-1",
    });
    expect(recvReplay.status).toBe(200);
    expect(recvReplay.body.replayed).toBe(true);
    expect(recvReplay.body.item.currentQuantity).toBe(1.75);

    // Owner runs INV-009 physical count at 2 L -> balance becomes 2 and needsReconciliation clears to false.
    ctx.clock.advance(60_000);
    const recRes = await postReconciliation(ctx, owner, liquidId, {
      physicalCount: 2,
      reason: "Measured remaining bottle after refill",
      expectedRevision: recvRes.body.item.stockRevision,
      expectedCurrentQuantity: 1.75,
      requestKey: "rec-liquid-1",
    });
    expect(recRes.status).toBe(201);
    expect(recRes.body.item).toMatchObject({
      currentQuantity: 2,
      needsReconciliation: false,
    });
    expect(recRes.body.reconciliation).toMatchObject({
      balanceBefore: 1.75,
      physicalCount: 2,
      quantityDelta: 0.25,
      balanceAfter: 2,
    });

    // Dashboard Stock Trend reads opening + STOCK_USED + STOCK_RECEIVED + PHYSICAL_COUNT_RECONCILIATION cleanly; Employee gets 403.
    const empTrend = await request(ctx.app)
      .get(`/api/dashboard/stocks/${encodeURIComponent(liquidId)}/trend`)
      .set("Cookie", employee.cookie);
    expect(empTrend.status).toBe(403);

    const ownerTrend = await request(ctx.app)
      .get(`/api/dashboard/stocks/${encodeURIComponent(liquidId)}/trend`)
      .set("Cookie", owner.cookie);
    expect(ownerTrend.status).toBe(200);
    expect(ownerTrend.body.historyState).toBe("COMPLETE");
    expect(ownerTrend.body.item).toMatchObject({
      unit: "L",
      currentQuantity: 2,
    });
    expect(ownerTrend.body.points.map((p: any) => p.movementType)).toEqual([
      "OPENING_COUNT",
      "STOCK_USED",
      "STOCK_RECEIVED",
      "PHYSICAL_COUNT_RECONCILIATION",
    ]);
    expect(ownerTrend.body.points.map((p: any) => p.balanceAfter)).toEqual([1.25, -0.25, 1.75, 2]);
  });

  it("supports archiving an operating supply and replacing it in a new unit while retaining prior history (INV-039)", async () => {
    const oldSalt = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Industrial Salt",
      unit: "packs",
      allowDecimalQuantity: false,
      unitConfirmed: true,
    });
    expect(oldSalt.status).toBe(201);
    const oldSaltId = oldSalt.body.item.id as string;

    const saltOpen = await postOpeningStock(ctx, owner, oldSaltId, { quantity: 4 });
    expect(saltOpen.status).toBe(201);
    ctx.clock.advance(60_000);
    const saltUse = await postUsage(ctx, employee, oldSaltId, {
      quantity: 1,
      purpose: "Brine tank",
      expectedRevision: saltOpen.body.item.stockRevision,
      expectedCurrentQuantity: 4,
      requestKey: "salt-use-1",
    });
    expect(saltUse.status).toBe(201);

    const archived = await archiveProduct(ctx, owner, oldSaltId);
    expect(archived.status).toBe(200);
    expect(archived.body.item.archivedAt).toBeTruthy();

    // Archived supply blocks further receiving and usage.
    expect(
      (
        await postReceiving(ctx, owner, oldSaltId, {
          quantity: 2,
          expectedRevision: saltUse.body.item.stockRevision,
          expectedCurrentQuantity: 3,
          requestKey: "archived-recv",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await postUsage(ctx, employee, oldSaltId, {
          quantity: 1,
          purpose: "Blocked",
          expectedRevision: saltUse.body.item.stockRevision,
          expectedCurrentQuantity: 3,
          requestKey: "archived-use",
        })
      ).status,
    ).toBe(409);

    // Owner creates replacement in kg with a new opening count.
    const newSalt = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Industrial Salt",
      unit: "kg",
      allowDecimalQuantity: true,
      unitConfirmed: true,
    });
    expect(newSalt.status).toBe(201);
    const newSaltId = newSalt.body.item.id as string;
    expect(newSalt.body.item.status).toBe("NOT_SET");

    const newOpen = await postOpeningStock(ctx, owner, newSaltId, { quantity: 25.5 });
    expect(newOpen.status).toBe(201);
    expect(newOpen.body.item).toMatchObject({
      unit: "kg",
      currentQuantity: 25.5,
    });

    // Archived record remains preserved in its original unit and balance when includeArchived=true.
    const withArchived = await request(ctx.app)
      .get("/api/inventory/items?includeArchived=true")
      .set("Cookie", owner.cookie);
    expect(withArchived.status).toBe(200);
    const oldArchivedView = withArchived.body.items.find((i: any) => i.id === oldSaltId);
    const newActiveView = withArchived.body.items.find((i: any) => i.id === newSaltId);
    expect(oldArchivedView).toMatchObject({
      unit: "packs",
      currentQuantity: 3,
      openingStock: { quantity: 4, unit: "packs" },
    });
    expect(newActiveView).toMatchObject({
      unit: "kg",
      currentQuantity: 25.5,
      archivedAt: null,
    });
  });

  it("Finding 1: replays same-reference receiving and usage across Manila midnight for the original actor while rejecting new backdated entries", async () => {
    const supplyRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Sanitizer",
      unit: "L",
      allowDecimalQuantity: true,
      unitConfirmed: true,
    });
    expect(supplyRes.status).toBe(201);
    const supplyId = supplyRes.body.item.id as string;

    const openRes = await postOpeningStock(ctx, owner, supplyId, { quantity: 10 });
    expect(openRes.status).toBe(201);

    // Move clock to 23:59:59 Manila on 2026-11-27 and sign in fresh sessions so they stay valid across midnight.
    ctx.clock.set("2026-11-27T23:59:59+08:00");
    const lateEmployee = await signIn(ctx.app, "emp_inv1", employee.password);
    const lateOwner = await signIn(ctx.app, "owner_inv1", owner.password);

    const initialUse = await postUsage(ctx, lateEmployee, supplyId, {
      quantity: 1,
      purpose: "Late shift wash",
      effectiveDate: "2026-11-27",
      expectedRevision: openRes.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "midnight-use-1",
    });
    expect(initialUse.status).toBe(201);
    expect(initialUse.body.item.currentQuantity).toBe(9);

    const initialRecv = await postReceiving(ctx, lateOwner, supplyId, {
      quantity: 2,
      note: "Night delivery",
      effectiveDate: "2026-11-27",
      expectedRevision: initialUse.body.item.stockRevision,
      expectedCurrentQuantity: 9,
      requestKey: "midnight-recv-1",
    });
    expect(initialRecv.status).toBe(201);
    expect(initialRecv.body.item.currentQuantity).toBe(11);

    // Cross Manila midnight to 00:00:01 on 2026-11-28 (within the active session lifetime).
    ctx.clock.set("2026-11-28T00:00:01+08:00");

    // Identical retry of 2026-11-27 usage by original actor resolves as 200 replay with no duplicate deduction.
    const replayUse = await postUsage(ctx, lateEmployee, supplyId, {
      quantity: 1,
      purpose: "Late shift wash",
      effectiveDate: "2026-11-27",
      expectedRevision: openRes.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "midnight-use-1",
    });
    expect(replayUse.status).toBe(200);
    expect(replayUse.body.replayed).toBe(true);
    expect(replayUse.body.item.currentQuantity).toBe(11);
    expect(replayUse.body.movement.effectiveDate).toBe("2026-11-27");

    // Identical retry of 2026-11-27 receiving by Owner resolves as 200 replay with no duplicate addition.
    const replayRecv = await postReceiving(ctx, lateOwner, supplyId, {
      quantity: 2,
      note: "Night delivery",
      effectiveDate: "2026-11-27",
      expectedRevision: initialUse.body.item.stockRevision,
      expectedCurrentQuantity: 9,
      requestKey: "midnight-recv-1",
    });
    expect(replayRecv.status).toBe(200);
    expect(replayRecv.body.replayed).toBe(true);
    expect(replayRecv.body.item.currentQuantity).toBe(11);

    // A different actor retrying with the original actor's key gets 409 REQUEST_KEY_CONFLICT.
    const crossActorReplay = await postUsage(ctx, lateOwner, supplyId, {
      quantity: 1,
      purpose: "Late shift wash",
      effectiveDate: "2026-11-27",
      expectedRevision: openRes.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "midnight-use-1",
    });
    expect(crossActorReplay.status).toBe(409);
    expect(crossActorReplay.body.error.code).toBe("REQUEST_KEY_CONFLICT");

    // Status lookup endpoint lets the original actor recover a saved movement (e.g. after lost response or reload) without cross-actor leakage.
    const empStatusCheck = await request(ctx.app)
      .get(`/api/inventory/movements/by-request-key/${encodeURIComponent("midnight-use-1")}`)
      .set("Cookie", lateEmployee.cookie);
    expect(empStatusCheck.status).toBe(200);
    expect(empStatusCheck.body).toMatchObject({
      status: "SAVED",
      item: { id: supplyId, currentQuantity: 11 },
      movement: {
        movementType: "STOCK_USED",
        quantity: 1,
        effectiveDate: "2026-11-27",
      },
    });

    const ownerStatusCheck = await request(ctx.app)
      .get(`/api/inventory/movements/by-request-key/${encodeURIComponent("midnight-recv-1")}`)
      .set("Cookie", lateOwner.cookie);
    expect(ownerStatusCheck.status).toBe(200);
    expect(ownerStatusCheck.body).toMatchObject({
      status: "SAVED",
      item: { id: supplyId, currentQuantity: 11 },
      movement: {
        movementType: "STOCK_RECEIVED",
        quantity: 2,
        effectiveDate: "2026-11-27",
      },
    });

    // Different actor checking another actor's requestKey receives NOT_FOUND; unsaved key also returns NOT_FOUND.
    const crossActorStatus = await request(ctx.app)
      .get(`/api/inventory/movements/by-request-key/${encodeURIComponent("midnight-use-1")}`)
      .set("Cookie", lateOwner.cookie);
    expect(crossActorStatus.status).toBe(200);
    expect(crossActorStatus.body).toEqual({ status: "NOT_FOUND" });

    const unsavedStatus = await request(ctx.app)
      .get(`/api/inventory/movements/by-request-key/${encodeURIComponent("never-saved-key")}`)
      .set("Cookie", lateEmployee.cookie);
    expect(unsavedStatus.status).toBe(200);
    expect(unsavedStatus.body).toEqual({ status: "NOT_FOUND" });

    // New backdated entries on 2026-11-28 with effectiveDate 2026-11-27 are still rejected (400).
    const newBackdatedUse = await postUsage(ctx, lateEmployee, supplyId, {
      quantity: 1,
      purpose: "New backdated attempt",
      effectiveDate: "2026-11-27",
      expectedRevision: initialRecv.body.item.stockRevision,
      expectedCurrentQuantity: 11,
      requestKey: "fresh-backdated-use",
    });
    expect(newBackdatedUse.status).toBe(400);

    const newBackdatedRecv = await postReceiving(ctx, lateOwner, supplyId, {
      quantity: 1,
      effectiveDate: "2026-11-27",
      expectedRevision: initialRecv.body.item.stockRevision,
      expectedCurrentQuantity: 11,
      requestKey: "fresh-backdated-recv",
    });
    expect(newBackdatedRecv.status).toBe(400);
  });

  it("Finding 2: rejects stale receiving/usage previews with refreshed item and allows confirming against updated stock", async () => {
    const supplyRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Chlorine Solution",
      unit: "L",
      allowDecimalQuantity: true,
      unitConfirmed: true,
    });
    expect(supplyRes.status).toBe(201);
    const supplyId = supplyRes.body.item.id as string;

    const openRes = await postOpeningStock(ctx, owner, supplyId, { quantity: 9 });
    expect(openRes.status).toBe(201);
    const revAt9 = openRes.body.item.stockRevision as number;

    // Owner concurrently records 3 L received -> balance moves from 9 L to 12 L.
    const ownerRecv = await postReceiving(ctx, owner, supplyId, {
      quantity: 3,
      note: "Morning refill",
      expectedRevision: revAt9,
      expectedCurrentQuantity: 9,
      requestKey: "f2-owner-recv",
    });
    expect(ownerRecv.status).toBe(201);
    expect(ownerRecv.body.item.currentQuantity).toBe(12);
    const revAt12 = ownerRecv.body.item.stockRevision as number;

    // Employee submits 10 L used against stale baseline (revAt9, 9 L) -> rejected with 409 STALE_STOCK_BALANCE and refreshed item.
    const staleUse = await postUsage(ctx, employee, supplyId, {
      quantity: 10,
      purpose: "Filter flush",
      expectedRevision: revAt9,
      expectedCurrentQuantity: 9,
      requestKey: "f2-emp-stale-use",
    });
    expect(staleUse.status).toBe(409);
    expect(staleUse.body.error.code).toBe("STALE_STOCK_BALANCE");
    expect(staleUse.body.item).toMatchObject({
      currentQuantity: 12,
      stockRevision: revAt12,
      needsReconciliation: false,
    });

    // Employee confirms 10 L against the refreshed baseline (revAt12, 12 L) -> succeeds to +2 L without shortage flag.
    const freshUse = await postUsage(ctx, employee, supplyId, {
      quantity: 10,
      purpose: "Filter flush",
      expectedRevision: revAt12,
      expectedCurrentQuantity: 12,
      requestKey: "f2-emp-fresh-use",
    });
    expect(freshUse.status).toBe(201);
    expect(freshUse.body.item).toMatchObject({
      currentQuantity: 2,
      needsReconciliation: false,
    });

    // Stale Stock Received against revAt9 is also rejected with 409 STALE_STOCK_BALANCE.
    const staleRecv = await postReceiving(ctx, owner, supplyId, {
      quantity: 5,
      expectedRevision: revAt9,
      expectedCurrentQuantity: 9,
      requestKey: "f2-owner-stale-recv",
    });
    expect(staleRecv.status).toBe(409);
    expect(staleRecv.body.error.code).toBe("STALE_STOCK_BALANCE");
    expect(staleRecv.body.item.currentQuantity).toBe(2);

    // Ordinary shortage posting still works once confirmed against current revision (2 L - 3 L = -1 L).
    const shortageUse = await postUsage(ctx, employee, supplyId, {
      quantity: 3,
      purpose: "Extra flush",
      expectedRevision: freshUse.body.item.stockRevision,
      expectedCurrentQuantity: 2,
      requestKey: "f2-emp-shortage-use",
    });
    expect(shortageUse.status).toBe(201);
    expect(shortageUse.body.item).toMatchObject({
      currentQuantity: -1,
      needsReconciliation: true,
    });
  });

  it("Finding 3: accepts accumulated positive and negative stored baselines beyond 1,000,000 during reconciliation while keeping single-input caps", async () => {
    const bulkRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Filter Granules",
      unit: "g",
      allowDecimalQuantity: true,
      unitConfirmed: true,
    });
    expect(bulkRes.status).toBe(201);
    const bulkId = bulkRes.body.item.id as string;

    const openRes = await postOpeningStock(ctx, owner, bulkId, { quantity: 2 });
    expect(openRes.status).toBe(201);

    // Receive max single-entry 1,000,000 -> accumulated stored balance 1,000,002.
    const recvRes = await postReceiving(ctx, owner, bulkId, {
      quantity: 1_000_000,
      expectedRevision: openRes.body.item.stockRevision,
      expectedCurrentQuantity: 2,
      requestKey: "f3-recv-max",
    });
    expect(recvRes.status).toBe(201);
    expect(recvRes.body.item.currentQuantity).toBe(1_000_002);

    // Reconcile down to 2 using stored baseline 1,000,002.
    const recPositive = await postReconciliation(ctx, owner, bulkId, {
      physicalCount: 2,
      reason: "Correct bulk entry",
      expectedRevision: recvRes.body.item.stockRevision,
      expectedCurrentQuantity: 1_000_002,
      requestKey: "f3-rec-pos",
    });
    expect(recPositive.status).toBe(201);
    expect(recPositive.body.reconciliation).toMatchObject({
      balanceBefore: 1_000_002,
      physicalCount: 2,
      quantityDelta: -1_000_000,
      balanceAfter: 2,
    });

    // Now test negative accumulated balance beyond -1,000,000: 2 - 1,000,000 - 4 = -1,000,002.
    const useLarge = await postUsage(ctx, employee, bulkId, {
      quantity: 1_000_000,
      purpose: "Bulk flush 1",
      expectedRevision: recPositive.body.item.stockRevision,
      expectedCurrentQuantity: 2,
      requestKey: "f3-use-large-1",
    });
    expect(useLarge.status).toBe(201);
    const useExtra = await postUsage(ctx, employee, bulkId, {
      quantity: 4,
      purpose: "Bulk flush 2",
      expectedRevision: useLarge.body.item.stockRevision,
      expectedCurrentQuantity: -999_998,
      requestKey: "f3-use-large-2",
    });
    expect(useExtra.status).toBe(201);
    expect(useExtra.body.item).toMatchObject({
      currentQuantity: -1_000_002,
      needsReconciliation: true,
    });

    // Reconcile back to 2 using negative stored baseline -1,000,002.
    const recNegative = await postReconciliation(ctx, owner, bulkId, {
      physicalCount: 2,
      reason: "Reconcile negative accumulated balance",
      expectedRevision: useExtra.body.item.stockRevision,
      expectedCurrentQuantity: -1_000_002,
      requestKey: "f3-rec-neg",
    });
    expect(recNegative.status).toBe(201);
    expect(recNegative.body.item).toMatchObject({
      currentQuantity: 2,
      needsReconciliation: false,
    });
    expect(recNegative.body.reconciliation).toMatchObject({
      balanceBefore: -1_000_002,
      physicalCount: 2,
      quantityDelta: 1_000_004,
      balanceAfter: 2,
    });

    // Individual input quantities above 1,000,000 remain rejected (400).
    expect(
      (
        await postReceiving(ctx, owner, bulkId, {
          quantity: 1_000_001,
          expectedRevision: recNegative.body.item.stockRevision,
          expectedCurrentQuantity: 2,
          requestKey: "f3-over-cap-recv",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postReconciliation(ctx, owner, bulkId, {
          physicalCount: 1_000_001,
          reason: "Over cap count",
          expectedRevision: recNegative.body.item.stockRevision,
          expectedCurrentQuantity: 2,
          requestKey: "f3-over-cap-rec",
        })
      ).status,
    ).toBe(400);

    // Exact 4-decimal accumulated positive and negative balances (1,500,000.0002 and -1,500,000.0002) reconcile cleanly without float-scaling drift.
    const exactSupplyRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Precision Liquid",
      unit: "L",
      allowDecimalQuantity: true,
      unitConfirmed: true,
    });
    expect(exactSupplyRes.status).toBe(201);
    const exactId = exactSupplyRes.body.item.id as string;

    const exactOpen = await postOpeningStock(ctx, owner, exactId, { quantity: 1_000_000 });
    expect(exactOpen.status).toBe(201);

    const exactRecv = await postReceiving(ctx, owner, exactId, {
      quantity: 500_000.0002,
      expectedRevision: exactOpen.body.item.stockRevision,
      expectedCurrentQuantity: 1_000_000,
      requestKey: "f3-exact-pos-recv",
    });
    expect(exactRecv.status).toBe(201);
    expect(exactRecv.body.item.currentQuantity).toBe(1_500_000.0002);

    const exactRecPos = await postReconciliation(ctx, owner, exactId, {
      physicalCount: 0,
      reason: "Reconcile exact 4-decimal positive balance",
      expectedRevision: exactRecv.body.item.stockRevision,
      expectedCurrentQuantity: 1_500_000.0002,
      requestKey: "f3-exact-pos-rec",
    });
    expect(exactRecPos.status).toBe(201);
    expect(exactRecPos.body.reconciliation).toMatchObject({
      balanceBefore: 1_500_000.0002,
      physicalCount: 0,
      quantityDelta: -1_500_000.0002,
      balanceAfter: 0,
    });

    // Negative exact 4-decimal counterpart: 0 - 1,000,000 - 500,000.0002 = -1,500,000.0002.
    const exactUse1 = await postUsage(ctx, employee, exactId, {
      quantity: 1_000_000,
      purpose: "Exact drain 1",
      expectedRevision: exactRecPos.body.item.stockRevision,
      expectedCurrentQuantity: 0,
      requestKey: "f3-exact-neg-use-1",
    });
    expect(exactUse1.status).toBe(201);
    const exactUse2 = await postUsage(ctx, employee, exactId, {
      quantity: 500_000.0002,
      purpose: "Exact drain 2",
      expectedRevision: exactUse1.body.item.stockRevision,
      expectedCurrentQuantity: -1_000_000,
      requestKey: "f3-exact-neg-use-2",
    });
    expect(exactUse2.status).toBe(201);
    expect(exactUse2.body.item).toMatchObject({
      currentQuantity: -1_500_000.0002,
      needsReconciliation: true,
    });

    const exactRecNeg = await postReconciliation(ctx, owner, exactId, {
      physicalCount: 10,
      reason: "Reconcile exact 4-decimal negative balance",
      expectedRevision: exactUse2.body.item.stockRevision,
      expectedCurrentQuantity: -1_500_000.0002,
      requestKey: "f3-exact-neg-rec",
    });
    expect(exactRecNeg.status).toBe(201);
    expect(exactRecNeg.body.item).toMatchObject({
      currentQuantity: 10,
      needsReconciliation: false,
    });
    expect(exactRecNeg.body.reconciliation).toMatchObject({
      balanceBefore: -1_500_000.0002,
      physicalCount: 10,
      quantityDelta: 1_500_010.0002,
      balanceAfter: 10,
    });

    // 5-decimal precision remains rejected (400).
    expect(
      (
        await postReceiving(ctx, owner, exactId, {
          quantity: 0.00001,
          expectedRevision: exactRecNeg.body.item.stockRevision,
          expectedCurrentQuantity: 10,
          requestKey: "f3-5dec-reject",
        })
      ).status,
    ).toBe(400);
  });

  it("Finding 1 race: preserves requestKey across in-flight status checks and blocks late commits after explicit cancel for both receiving and usage", async () => {
    const supplyRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Sanitizing Tabs",
      unit: "tabs",
      allowDecimalQuantity: false,
      unitConfirmed: true,
    });
    expect(supplyRes.status).toBe(201);
    const supplyId = supplyRes.body.item.id as string;

    const openRes = await postOpeningStock(ctx, owner, supplyId, { quantity: 10 });
    expect(openRes.status).toBe(201);
    let currentRev = openRes.body.item.stockRevision as number;

    let gate: {
      armed: boolean;
      resolveReached: () => void;
      waitToProceed: Promise<void>;
    } | null = null;

    const gatedDb: Database = {
      query: ctx.db.query.bind(ctx.db),
      exec: ctx.db.exec.bind(ctx.db),
      close: ctx.db.close.bind(ctx.db),
      async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
        if (gate && gate.armed) {
          const active = gate;
          active.armed = false;
          active.resolveReached();
          await active.waitToProceed;
        }
        return ctx.db.transaction(fn);
      },
    };
    const raceApp = createApp({ db: gatedDb, clock: ctx.clock, secureCookies: false });
    const armNextTx = () => {
      let resolveReached!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((res) => {
        resolveReached = res;
      });
      const waitToProceed = new Promise<void>((res) => {
        release = res;
      });
      gate = { armed: true, resolveReached, waitToProceed };
      return { reached, release };
    };

    // 1a. STOCK_USED: pause in-flight POST before tx begins -> status check sees NOT_FOUND without blocking late commit.
    const usePause = armNextTx();
    const pendingUseReq = request(raceApp)
      .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/usage`)
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({
        quantity: 1,
        purpose: "Container rinse",
        expectedRevision: currentRev,
        expectedCurrentQuantity: 10,
        requestKey: "race-use-status-1",
      })
      .then((res) => res);
    await usePause.reached;

    const inflightUseStatus = await request(raceApp)
      .get("/api/inventory/movements/by-request-key/race-use-status-1")
      .set("Cookie", employee.cookie);
    expect(inflightUseStatus.status).toBe(200);
    expect(inflightUseStatus.body).toEqual({ status: "NOT_FOUND" });

    usePause.release();
    const committedUse = await pendingUseReq;
    expect(committedUse.status).toBe(201);
    expect(committedUse.body.item.currentQuantity).toBe(9);
    currentRev = committedUse.body.item.stockRevision as number;

    const savedUseStatus = await request(raceApp)
      .get("/api/inventory/movements/by-request-key/race-use-status-1")
      .set("Cookie", employee.cookie);
    expect(savedUseStatus.status).toBe(200);
    expect(savedUseStatus.body).toMatchObject({
      status: "SAVED",
      item: { currentQuantity: 9 },
      movement: { movementType: "STOCK_USED", quantity: 1 },
    });

    const replayUse = await request(raceApp)
      .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/usage`)
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({
        quantity: 1,
        purpose: "Container rinse",
        expectedRevision: openRes.body.item.stockRevision,
        expectedCurrentQuantity: 10,
        requestKey: "race-use-status-1",
      });
    expect(replayUse.status).toBe(200);
    expect(replayUse.body.replayed).toBe(true);
    expect(replayUse.body.item.currentQuantity).toBe(9);

    // 1b. STOCK_RECEIVED: pause in-flight POST before tx begins -> status check sees NOT_FOUND, original commits once, retry replays.
    const recvPause = armNextTx();
    const pendingRecvReq = request(raceApp)
      .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/receiving`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        quantity: 2,
        note: "Supplier box",
        expectedRevision: currentRev,
        expectedCurrentQuantity: 9,
        requestKey: "race-recv-status-1",
      })
      .then((res) => res);
    await recvPause.reached;

    const inflightRecvStatus = await request(raceApp)
      .get("/api/inventory/movements/by-request-key/race-recv-status-1")
      .set("Cookie", owner.cookie);
    expect(inflightRecvStatus.status).toBe(200);
    expect(inflightRecvStatus.body).toEqual({ status: "NOT_FOUND" });

    recvPause.release();
    const committedRecv = await pendingRecvReq;
    expect(committedRecv.status).toBe(201);
    expect(committedRecv.body.item.currentQuantity).toBe(11);
    currentRev = committedRecv.body.item.stockRevision as number;

    const replayRecv = await request(raceApp)
      .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/receiving`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        quantity: 2,
        note: "Supplier box",
        expectedRevision: committedUse.body.item.stockRevision,
        expectedCurrentQuantity: 9,
        requestKey: "race-recv-status-1",
      });
    expect(replayRecv.status).toBe(200);
    expect(replayRecv.body.replayed).toBe(true);
    expect(replayRecv.body.item.currentQuantity).toBe(11);

    // 2a. STOCK_USED cancel race: cancel while original POST is paused before tx -> paused POST returns 409 REQUEST_KEY_CANCELLED; fresh key applies once.
    const useCancelPause = armNextTx();
    const stalledUseReq = request(raceApp)
      .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/usage`)
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({
        quantity: 1,
        purpose: "Afternoon sanitize",
        expectedRevision: currentRev,
        expectedCurrentQuantity: 11,
        requestKey: "race-use-cancel-1",
      })
      .then((res) => res);
    await useCancelPause.reached;

    const cancelUseRes = await request(raceApp)
      .post("/api/inventory/movements/by-request-key/race-use-cancel-1/cancel")
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({ itemKey: supplyId, movementType: "STOCK_USED" });
    expect(cancelUseRes.status).toBe(200);
    expect(cancelUseRes.body).toEqual({ status: "CANCELLED" });

    const cancelledUseLookup = await request(raceApp)
      .get("/api/inventory/movements/by-request-key/race-use-cancel-1")
      .set("Cookie", employee.cookie);
    expect(cancelledUseLookup.status).toBe(200);
    expect(cancelledUseLookup.body).toEqual({ status: "CANCELLED" });

    useCancelPause.release();
    const delayedUseOutcome = await stalledUseReq;
    expect(delayedUseOutcome.status).toBe(409);
    expect(delayedUseOutcome.body.error.code).toBe("REQUEST_KEY_CANCELLED");

    const afterCancelledUseItems = await request(raceApp)
      .get("/api/inventory/items")
      .set("Cookie", employee.cookie);
    expect(
      afterCancelledUseItems.body.items.find((i: any) => i.id === supplyId).currentQuantity,
    ).toBe(11);

    const freshUseRes = await request(raceApp)
      .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/usage`)
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({
        quantity: 1,
        purpose: "Afternoon sanitize",
        expectedRevision: currentRev,
        expectedCurrentQuantity: 11,
        requestKey: "race-use-fresh-1",
      });
    expect(freshUseRes.status).toBe(201);
    expect(freshUseRes.body.item.currentQuantity).toBe(10);
    currentRev = freshUseRes.body.item.stockRevision as number;

    // 2b. STOCK_RECEIVED cancel race: cancel while original POST is paused before tx -> paused POST returns 409 REQUEST_KEY_CANCELLED; fresh key applies once.
    const recvCancelPause = armNextTx();
    const stalledRecvReq = request(raceApp)
      .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/receiving`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        quantity: 3,
        note: "Evening restock",
        expectedRevision: currentRev,
        expectedCurrentQuantity: 10,
        requestKey: "race-recv-cancel-1",
      })
      .then((res) => res);
    await recvCancelPause.reached;

    const cancelRecvRes = await request(raceApp)
      .post("/api/inventory/movements/by-request-key/race-recv-cancel-1/cancel")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ itemKey: supplyId, movementType: "STOCK_RECEIVED" });
    expect(cancelRecvRes.status).toBe(200);
    expect(cancelRecvRes.body).toEqual({ status: "CANCELLED" });

    recvCancelPause.release();
    const delayedRecvOutcome = await stalledRecvReq;
    expect(delayedRecvOutcome.status).toBe(409);
    expect(delayedRecvOutcome.body.error.code).toBe("REQUEST_KEY_CANCELLED");

    const afterCancelledRecvItems = await request(raceApp)
      .get("/api/inventory/items")
      .set("Cookie", owner.cookie);
    expect(
      afterCancelledRecvItems.body.items.find((i: any) => i.id === supplyId).currentQuantity,
    ).toBe(10);

    const freshRecvRes = await request(raceApp)
      .post(`/api/inventory/items/${encodeURIComponent(supplyId)}/receiving`)
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        quantity: 3,
        note: "Evening restock",
        expectedRevision: currentRev,
        expectedCurrentQuantity: 10,
        requestKey: "race-recv-fresh-1",
      });
    expect(freshRecvRes.status).toBe(201);
    expect(freshRecvRes.body.item.currentQuantity).toBe(13);

    // 3. Cancel after commit recovers the SAVED movement without tombstoning it.
    const cancelAfterSavedUse = await request(raceApp)
      .post("/api/inventory/movements/by-request-key/race-use-fresh-1/cancel")
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({ itemKey: supplyId, movementType: "STOCK_USED" });
    expect(cancelAfterSavedUse.status).toBe(200);
    expect(cancelAfterSavedUse.body).toMatchObject({
      status: "SAVED",
      item: { currentQuantity: 13 },
      movement: { movementType: "STOCK_USED", quantity: 1 },
    });

    const cancelAfterSavedRecv = await request(raceApp)
      .post("/api/inventory/movements/by-request-key/race-recv-fresh-1/cancel")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ itemKey: supplyId, movementType: "STOCK_RECEIVED" });
    expect(cancelAfterSavedRecv.status).toBe(200);
    expect(cancelAfterSavedRecv.body).toMatchObject({
      status: "SAVED",
      item: { currentQuantity: 13 },
      movement: { movementType: "STOCK_RECEIVED", quantity: 3 },
    });

    // 4. RBAC & key conflicts on cancel endpoint.
    const empCancelRecvForbidden = await request(raceApp)
      .post("/api/inventory/movements/by-request-key/emp-cancel-recv/cancel")
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({ itemKey: supplyId, movementType: "STOCK_RECEIVED" });
    expect(empCancelRecvForbidden.status).toBe(403);
    expect(empCancelRecvForbidden.body.error.code).toBe("FORBIDDEN");

    const crossActorCancelConflict = await request(raceApp)
      .post("/api/inventory/movements/by-request-key/race-use-cancel-1/cancel")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ itemKey: supplyId, movementType: "STOCK_USED" });
    expect(crossActorCancelConflict.status).toBe(409);
    expect(crossActorCancelConflict.body.error.code).toBe("REQUEST_KEY_CONFLICT");

    const wrongTypeCancelConflict = await request(raceApp)
      .post("/api/inventory/movements/by-request-key/race-use-fresh-1/cancel")
      .set("Cookie", employee.cookie)
      .set("X-CSRF-Token", employee.csrfToken)
      .send({ itemKey: supplyId, movementType: "STOCK_RECEIVED" });
    expect(wrongTypeCancelConflict.status).toBe(403);

    const wrongTypeOwnerConflict = await request(raceApp)
      .post("/api/inventory/movements/by-request-key/race-recv-fresh-1/cancel")
      .set("Cookie", owner.cookie)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ itemKey: supplyId, movementType: "STOCK_USED" });
    expect(wrongTypeOwnerConflict.status).toBe(409);
    expect(wrongTypeOwnerConflict.body.error.code).toBe("REQUEST_KEY_CONFLICT");
  });
});
