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
      canViewFullHistory: true,
      canViewOwnUsageHistory: true,
      canReviewPendingEntries: true,
      canCorrectMovements: true,
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
      canViewFullHistory: false,
      canViewOwnUsageHistory: true,
      canReviewPendingEntries: false,
      canCorrectMovements: false,
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

    const empRecHistory = await request(ctx.app)
      .get(`/api/inventory/items/${encodeURIComponent(faucetId)}/reconciliations`)
      .set("Cookie", cashier.cookie);
    expect(empRecHistory.status).toBe(403);
    expect(empRecHistory.body.error.code).toBe("FORBIDDEN");

    const recHistory = await request(ctx.app)
      .get(`/api/inventory/items/${encodeURIComponent(faucetId)}/reconciliations`)
      .set("Cookie", owner.cookie);
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

      // Apply migrations 0021 through 0023 onto the populated database.
      const newlyApplied = await runMigrations(db, MIGRATIONS_DIR);
      expect(newlyApplied).toEqual([
        "0021_inventory_supplies_and_movements.sql",
        "0022_inventory_movement_request_tombstones.sql",
        "0023_inventory_late_entries_and_reviews.sql",
        "0024_inventory_movement_corrections.sql",
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

    // Future effectiveDate is rejected (400), and Owner late entry without coverage when opening count covers the date is rejected (400).
    expect(
      (
        await postUsage(ctx, employee, liquidId, {
          quantity: 0.25,
          purpose: "Future wash",
          effectiveDate: "2026-11-28",
          expectedRevision: liquidRev,
          expectedCurrentQuantity: 1.25,
          requestKey: "future-use-guard",
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

    // On 2026-11-28, new backdated Employee usage when opening count on 2026-11-27 covers the date saves as PENDING_REVIEW (zero stock effect),
    // and Owner late receiving without explicit coverage confirmation is rejected (400).
    const newBackdatedUse = await postUsage(ctx, lateEmployee, supplyId, {
      quantity: 1,
      purpose: "New backdated attempt",
      effectiveDate: "2026-11-27",
      expectedRevision: initialRecv.body.item.stockRevision,
      expectedCurrentQuantity: 11,
      requestKey: "fresh-backdated-use",
    });
    expect(newBackdatedUse.status).toBe(201);
    expect(newBackdatedUse.body.movement).toMatchObject({
      entryStatus: "PENDING_REVIEW",
      quantity: 1,
      quantityDelta: 0,
      effectiveDate: "2026-11-27",
    });
    expect(newBackdatedUse.body.item.currentQuantity).toBe(11);

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

describe("Final Inventory Task 2 — late-entry review and role-scoped history (INV-023..030, INV-040, INV-041)", () => {
  let ctx: TestContext;
  let owner: Activated;
  let employee: Activated;

  beforeEach(async () => {
    ctx = await createTestContext({ clock: new ManualClock("2026-11-23T09:00:00+08:00") });
    owner = await activatedAccount(ctx, "owner1", "OWNER");
    employee = await activatedAccount(ctx, "emp1", "EMPLOYEE");
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("handles partial/full/unclear late receipts, pending review resolution, stale count recheck, and Dashboard Trend consistency", async () => {
    // 2026-11-24: Create supply and open count at 10 L.
    const supplyRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Sanitizing Liquid",
      unit: "L",
      allowDecimalQuantity: true,
      unitConfirmed: true,
    });
    expect(supplyRes.status).toBe(201);
    const supplyId = supplyRes.body.item.id as string;

    const openRes = await postOpeningStock(ctx, owner, supplyId, { quantity: 10 });
    expect(openRes.status).toBe(201);

    // 2026-11-25: Physical count reconciliation sets balance to 9 L (r1).
    ctx.clock.set("2026-11-25T10:00:00+08:00");
    const ownerDay2 = await signIn(ctx.app, "owner1", owner.password);
    const rec1 = await postReconciliation(ctx, ownerDay2, supplyId, {
      physicalCount: 9,
      reason: "Tuesday physical shelf count",
      expectedRevision: openRes.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "t2-rec-1",
    });
    expect(rec1.status).toBe(201);
    const rec1Id = rec1.body.reconciliation.id as string;

    // 2026-11-27: Owner saves a late receipt of 5 L for 2026-11-24 with 2 L covered by r1 -> adds 3 L (9 -> 12 L).
    ctx.clock.set("2026-11-27T11:00:00+08:00");
    const ownerDay4 = await signIn(ctx.app, "owner1", owner.password);
    const empDay4 = await signIn(ctx.app, "emp1", employee.password);

    const partialRecv = await postReceiving(ctx, ownerDay4, supplyId, {
      quantity: 5,
      effectiveDate: "2026-11-24",
      note: "Sunday partial covered delivery",
      coverageMode: "PARTIAL",
      coveredQuantity: 2,
      supportingReconciliationId: rec1Id,
      reviewNote: "Tuesday count included 2 L",
      expectedLatestReconciliationId: rec1Id,
      expectedOpeningCountCoversDate: false,
      expectedRevision: rec1.body.item.stockRevision,
      expectedCurrentQuantity: 9,
      requestKey: "t2-partial-recv-1",
    });
    expect(partialRecv.status).toBe(201);
    expect(partialRecv.body.item.currentQuantity).toBe(12);
    expect(partialRecv.body.movement).toMatchObject({
      entryStatus: "APPLIED",
      quantity: 5,
      enteredQuantity: 5,
      appliedQuantity: 3,
      quantityDelta: 3,
      coveredQuantity: 2,
      coverageMode: "PARTIAL",
      effectiveDate: "2026-11-24",
      recordedBy: "owner1",
      reviewedBy: "owner1",
      reviewNote: "Tuesday count included 2 L",
      supportingReconciliationId: rec1Id,
    });
    expect(partialRecv.body.movement.supportingReconciliation).toMatchObject({
      id: rec1Id,
      physicalCount: 9,
      reason: "Tuesday physical shelf count",
    });

    // Late receipt of 4 L fully covered by r1 saves history with zero stock effect (balance stays 12 L).
    const fullRecv = await postReceiving(ctx, ownerDay4, supplyId, {
      quantity: 4,
      effectiveDate: "2026-11-24",
      note: "Fully counted batch",
      coverageMode: "FULL",
      supportingReconciliationId: rec1Id,
      expectedLatestReconciliationId: rec1Id,
      expectedOpeningCountCoversDate: false,
      expectedRevision: partialRecv.body.item.stockRevision,
      expectedCurrentQuantity: 12,
      requestKey: "t2-full-recv-1",
    });
    expect(fullRecv.status).toBe(201);
    expect(fullRecv.body.item.currentQuantity).toBe(12);
    expect(fullRecv.body.movement).toMatchObject({
      entryStatus: "APPLIED",
      coverageMode: "FULL",
      quantity: 4,
      enteredQuantity: 4,
      coveredQuantity: 4,
      quantityDelta: 0,
      balanceBefore: 12,
      balanceAfter: 12,
    });

    // Owner submits an unclear late receipt of 2 L -> stays PENDING_REVIEW with zero stock effect.
    const unclearRecv = await postReceiving(ctx, ownerDay4, supplyId, {
      quantity: 2,
      effectiveDate: "2026-11-24",
      note: "Unclear coverage delivery",
      coverageMode: "UNCLEAR",
      expectedLatestReconciliationId: rec1Id,
      expectedOpeningCountCoversDate: false,
      expectedRevision: fullRecv.body.item.stockRevision,
      expectedCurrentQuantity: 12,
      requestKey: "t2-unclear-recv-1",
    });
    expect(unclearRecv.status).toBe(201);
    expect(unclearRecv.body.item.currentQuantity).toBe(12);
    expect(unclearRecv.body.movement).toMatchObject({
      entryStatus: "PENDING_REVIEW",
      coverageMode: "UNCLEAR",
      quantity: 2,
      quantityDelta: 0,
    });

    // Employee records 3 L used on 2026-11-24 -> automatically PENDING_REVIEW (because r1 on 2026-11-25 exists), zero stock effect, and no reconciliation leak.
    const empLateUsePending = await postUsage(ctx, empDay4, supplyId, {
      quantity: 3,
      purpose: "Sunday bottle wash",
      effectiveDate: "2026-11-24",
      expectedRevision: unclearRecv.body.item.stockRevision,
      expectedCurrentQuantity: 12,
      requestKey: "t2-emp-late-use-1",
    });
    expect(empLateUsePending.status).toBe(201);
    expect(empLateUsePending.body.item.currentQuantity).toBe(12);
    expect(empLateUsePending.body.item.latestReconciliation).toBeNull();
    expect(empLateUsePending.body.movement).toMatchObject({
      entryStatus: "PENDING_REVIEW",
      coverageMode: "UNCLEAR",
      quantity: 3,
      quantityDelta: 0,
      effectiveDate: "2026-11-24",
      supportingReconciliationId: null,
      supportingReconciliation: null,
    });
    const pendingUseId = empLateUsePending.body.movement.id as string;
    const originalRecordedAt = empLateUsePending.body.movement.recordedAt as string;

    // Dashboard Trend shows ONLY opening (10), r1 (9), and partial +3 (12) — zero points for FULL or PENDING_REVIEW.
    const trendBeforeResolve = await request(ctx.app)
      .get(`/api/dashboard/stocks/${encodeURIComponent(supplyId)}/trend`)
      .set("Cookie", ownerDay4.cookie);
    expect(trendBeforeResolve.status).toBe(200);
    expect(trendBeforeResolve.body.historyState).toBe("COMPLETE");
    expect(
      trendBeforeResolve.body.points.map((p: any) => ({
        movementType: p.movementType,
        quantityDelta: p.quantityDelta,
        balanceAfter: p.balanceAfter,
      })),
    ).toEqual([
      { movementType: "OPENING_COUNT", quantityDelta: 0, balanceAfter: 10 },
      { movementType: "PHYSICAL_COUNT_RECONCILIATION", quantityDelta: -1, balanceAfter: 9 },
      { movementType: "STOCK_RECEIVED", quantityDelta: 3, balanceAfter: 12 },
    ]);

    // Owner records a fresh count (r2 = 13 L) BEFORE resolving empLateUsePending -> resolving with stale expectedLatestReconciliationId = rec1Id returns 409 STALE_REVIEW_CONTEXT.
    ctx.clock.set("2026-11-27T11:05:00+08:00");
    const rec2 = await postReconciliation(ctx, ownerDay4, supplyId, {
      physicalCount: 13,
      reason: "Recount before pending review",
      expectedRevision: empLateUsePending.body.item.stockRevision,
      expectedCurrentQuantity: 12,
      requestKey: "t2-rec-2",
    });
    expect(rec2.status).toBe(201);
    const rec2Id = rec2.body.reconciliation.id as string;

    const staleResolve = await request(ctx.app)
      .post(`/api/inventory/pending-reviews/${encodeURIComponent(pendingUseId)}/resolve`)
      .set("Cookie", ownerDay4.cookie)
      .set("X-CSRF-Token", ownerDay4.csrfToken)
      .send({
        coverageMode: "PARTIAL",
        coveredQuantity: 2,
        supportingReconciliationId: rec1Id,
        expectedLatestReconciliationId: rec1Id,
        expectedOpeningCountCoversDate: false,
        expectedRevision: empLateUsePending.body.item.stockRevision,
        expectedCurrentQuantity: 12,
        requestKey: "t2-resolve-use-1",
      });
    expect(staleResolve.status).toBe(409);
    expect(staleResolve.body.error.code).toBe("STALE_REVIEW_CONTEXT");
    expect(staleResolve.body.item.currentQuantity).toBe(13);
    expect(staleResolve.body.applicableReconciliations.map((r: any) => r.id)).toEqual([rec2Id, rec1Id]);

    // Resolving against refreshed context (rec2Id, 13 L) applies -1 (3 - 2 covered) once, preserving original entry id, actor, and recordedAt.
    ctx.clock.set("2026-11-27T11:10:00+08:00");
    const resolvedUse = await request(ctx.app)
      .post(`/api/inventory/pending-reviews/${encodeURIComponent(pendingUseId)}/resolve`)
      .set("Cookie", ownerDay4.cookie)
      .set("X-CSRF-Token", ownerDay4.csrfToken)
      .send({
        coverageMode: "PARTIAL",
        coveredQuantity: 2,
        supportingReconciliationId: rec2Id,
        reviewNote: "Recount covered 2 L",
        expectedLatestReconciliationId: rec2Id,
        expectedOpeningCountCoversDate: false,
        expectedRevision: rec2.body.item.stockRevision,
        expectedCurrentQuantity: 13,
        requestKey: "t2-resolve-use-1",
      });
    expect(resolvedUse.status).toBe(200);
    expect(resolvedUse.body.replayed).toBe(false);
    expect(resolvedUse.body.item.currentQuantity).toBe(12);
    expect(resolvedUse.body.movement).toMatchObject({
      id: pendingUseId,
      entryStatus: "APPLIED",
      coverageMode: "PARTIAL",
      quantity: 3,
      enteredQuantity: 3,
      coveredQuantity: 2,
      appliedQuantity: 1,
      quantityDelta: -1,
      balanceBefore: 13,
      balanceAfter: 12,
      effectiveDate: "2026-11-24",
      recordedBy: "emp1",
      recordedAt: originalRecordedAt,
      reviewedBy: "owner1",
      supportingReconciliationId: rec2Id,
      reviewNote: "Recount covered 2 L",
    });

    // Idempotent retry of the review requestKey returns 200 replayed: true; a new key fails with 409 MOVEMENT_ALREADY_RESOLVED.
    const replayResolve = await request(ctx.app)
      .post(`/api/inventory/pending-reviews/${encodeURIComponent(pendingUseId)}/resolve`)
      .set("Cookie", ownerDay4.cookie)
      .set("X-CSRF-Token", ownerDay4.csrfToken)
      .send({
        coverageMode: "PARTIAL",
        coveredQuantity: 2,
        supportingReconciliationId: rec2Id,
        expectedLatestReconciliationId: rec2Id,
        expectedOpeningCountCoversDate: false,
        expectedRevision: rec2.body.item.stockRevision,
        expectedCurrentQuantity: 13,
        requestKey: "t2-resolve-use-1",
      });
    expect(replayResolve.status).toBe(200);
    expect(replayResolve.body.replayed).toBe(true);
    expect(replayResolve.body.item.currentQuantity).toBe(12);

    const alreadyResolved = await request(ctx.app)
      .post(`/api/inventory/pending-reviews/${encodeURIComponent(pendingUseId)}/resolve`)
      .set("Cookie", ownerDay4.cookie)
      .set("X-CSRF-Token", ownerDay4.csrfToken)
      .send({
        coverageMode: "FULL",
        supportingReconciliationId: rec2Id,
        expectedLatestReconciliationId: rec2Id,
        expectedOpeningCountCoversDate: false,
        expectedRevision: resolvedUse.body.item.stockRevision,
        expectedCurrentQuantity: 12,
        requestKey: "t2-resolve-use-2",
      });
    expect(alreadyResolved.status).toBe(409);
    expect(alreadyResolved.body.error.code).toBe("MOVEMENT_ALREADY_RESOLVED");

    // Finding 1 regression: full-coverage pending-review resolution must reject omitted snapshots (400),
    // stale count snapshots (409 STALE_REVIEW_CONTEXT), and stale stock revisions/balances (409 STALE_STOCK_BALANCE).
    const unclearRecvId = unclearRecv.body.movement.id as string;
    const resolveMissingSnapshot = await request(ctx.app)
      .post(`/api/inventory/pending-reviews/${encodeURIComponent(unclearRecvId)}/resolve`)
      .set("Cookie", ownerDay4.cookie)
      .set("X-CSRF-Token", ownerDay4.csrfToken)
      .send({
        coverageMode: "FULL",
        supportingReconciliationId: rec2Id,
        expectedRevision: resolvedUse.body.item.stockRevision,
        expectedCurrentQuantity: 12,
        requestKey: "t2-resolve-full-missing-snap",
      });
    expect(resolveMissingSnapshot.status).toBe(400);
    expect(resolveMissingSnapshot.body.error.code).toBe("VALIDATION_FAILED");

    const resolveMissingOpeningSnapshot = await request(ctx.app)
      .post(`/api/inventory/pending-reviews/${encodeURIComponent(unclearRecvId)}/resolve`)
      .set("Cookie", ownerDay4.cookie)
      .set("X-CSRF-Token", ownerDay4.csrfToken)
      .send({
        coverageMode: "FULL",
        supportingReconciliationId: rec2Id,
        expectedLatestReconciliationId: rec2Id,
        expectedRevision: resolvedUse.body.item.stockRevision,
        expectedCurrentQuantity: 12,
        requestKey: "t2-resolve-full-missing-open-snap",
      });
    expect(resolveMissingOpeningSnapshot.status).toBe(400);
    expect(resolveMissingOpeningSnapshot.body.error.code).toBe("VALIDATION_FAILED");

    const resolveFullStaleCount = await request(ctx.app)
      .post(`/api/inventory/pending-reviews/${encodeURIComponent(unclearRecvId)}/resolve`)
      .set("Cookie", ownerDay4.cookie)
      .set("X-CSRF-Token", ownerDay4.csrfToken)
      .send({
        coverageMode: "FULL",
        supportingReconciliationId: rec2Id,
        expectedLatestReconciliationId: rec1Id,
        expectedOpeningCountCoversDate: false,
        expectedRevision: resolvedUse.body.item.stockRevision,
        expectedCurrentQuantity: 12,
        requestKey: "t2-resolve-full-stale-count",
      });
    expect(resolveFullStaleCount.status).toBe(409);
    expect(resolveFullStaleCount.body.error.code).toBe("STALE_REVIEW_CONTEXT");

    const resolveFullStaleBalance = await request(ctx.app)
      .post(`/api/inventory/pending-reviews/${encodeURIComponent(unclearRecvId)}/resolve`)
      .set("Cookie", ownerDay4.cookie)
      .set("X-CSRF-Token", ownerDay4.csrfToken)
      .send({
        coverageMode: "FULL",
        supportingReconciliationId: rec2Id,
        expectedLatestReconciliationId: rec2Id,
        expectedOpeningCountCoversDate: false,
        expectedRevision: rec2.body.item.stockRevision,
        expectedCurrentQuantity: 13,
        requestKey: "t2-resolve-full-stale-balance",
      });
    expect(resolveFullStaleBalance.status).toBe(409);
    expect(resolveFullStaleBalance.body.error.code).toBe("STALE_STOCK_BALANCE");

    // Owner full-coverage resolution on unclearRecv with fresh snapshot & baseline leaves balance at 12 and adds zero Trend points.
    const resolveFullRecv = await request(ctx.app)
      .post(`/api/inventory/pending-reviews/${encodeURIComponent(unclearRecvId)}/resolve`)
      .set("Cookie", ownerDay4.cookie)
      .set("X-CSRF-Token", ownerDay4.csrfToken)
      .send({
        coverageMode: "FULL",
        supportingReconciliationId: rec2Id,
        expectedLatestReconciliationId: rec2Id,
        expectedOpeningCountCoversDate: false,
        expectedRevision: resolvedUse.body.item.stockRevision,
        expectedCurrentQuantity: 12,
        requestKey: "t2-resolve-full-recv",
      });
    expect(resolveFullRecv.status).toBe(200);
    expect(resolveFullRecv.body.item.currentQuantity).toBe(12);
    expect(resolveFullRecv.body.movement).toMatchObject({
      entryStatus: "APPLIED",
      coverageMode: "FULL",
      quantityDelta: 0,
      coveredQuantity: 2,
    });

    // Dashboard Trend now cleanly plots: opening (10) -> r1 (9) -> partial recv (12) -> r2 (13) -> resolved use (12), ignoring fullRecv & resolveFullRecv!
    const trendAfterResolve = await request(ctx.app)
      .get(`/api/dashboard/stocks/${encodeURIComponent(supplyId)}/trend`)
      .set("Cookie", ownerDay4.cookie);
    expect(trendAfterResolve.status).toBe(200);
    expect(trendAfterResolve.body.historyState).toBe("COMPLETE");
    expect(trendAfterResolve.body.points.map((p: any) => p.balanceAfter)).toEqual([10, 9, 12, 13, 12]);
  });

  it("enforces role-scoped history and blocks Employee from full history, reconciliations, and pending reviews (INV-040, INV-041)", async () => {
    const supplyRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Salt",
      unit: "kg",
      allowDecimalQuantity: true,
      unitConfirmed: true,
    });
    const supplyId = supplyRes.body.item.id as string;

    const archivedSupplyRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Old Filter",
      unit: "pcs",
      allowDecimalQuantity: false,
      unitConfirmed: true,
    });
    const archivedSupplyId = archivedSupplyRes.body.item.id as string;
    await archiveProduct(ctx, owner, archivedSupplyId);

    const openRes = await postOpeningStock(ctx, owner, supplyId, { quantity: 20 });
    expect(openRes.status).toBe(201);
    const roundOpenRes = await postOpeningStock(ctx, owner, "ROUND", { quantity: 10 });
    expect(roundOpenRes.status).toBe(201);

    // Next day: Owner records receiving + usage; Employee records late usage after no intervening reconciliation.
    ctx.clock.set("2026-11-25T10:00:00+08:00");
    const ownerDay2 = await signIn(ctx.app, "owner1", owner.password);

    const ownerRecv = await postReceiving(ctx, ownerDay2, supplyId, {
      quantity: 5,
      note: "Restock bags",
      expectedRevision: openRes.body.item.stockRevision,
      expectedCurrentQuantity: 20,
      requestKey: "rbac-owner-recv",
    });
    const ownerUse = await postUsage(ctx, ownerDay2, supplyId, {
      quantity: 2,
      purpose: "Owner brine test",
      expectedRevision: ownerRecv.body.item.stockRevision,
      expectedCurrentQuantity: 25,
      requestKey: "rbac-owner-use",
    });
    // Employee records late usage on 2026-11-25 after opening on 2026-11-24 with NO intervening reconciliation -> applies immediately!
    ctx.clock.set("2026-11-26T10:00:00+08:00");
    const empDay3 = await signIn(ctx.app, "emp1", employee.password);
    const empLateUseNoCount = await postUsage(ctx, empDay3, supplyId, {
      quantity: 1.5,
      purpose: "Backwash brine",
      effectiveDate: "2026-11-25",
      expectedRevision: ownerUse.body.item.stockRevision,
      expectedCurrentQuantity: 23,
      requestKey: "rbac-emp-use-late",
    });
    expect(empLateUseNoCount.status).toBe(201);
    expect(empLateUseNoCount.body.item.currentQuantity).toBe(21.5);
    expect(empLateUseNoCount.body.item.openingStock).toBeNull();
    expect(empLateUseNoCount.body.movement).toMatchObject({
      entryStatus: "APPLIED",
      coverageMode: "NONE",
      quantity: 1.5,
      quantityDelta: -1.5,
      effectiveDate: "2026-11-25",
    });

    // Reconcile once as Owner, then submit an unclear pending entry so Owner's review queue is non-empty.
    const ownerDay3 = await signIn(ctx.app, "owner1", owner.password);
    const recRes = await postReconciliation(ctx, ownerDay3, supplyId, {
      physicalCount: 21,
      reason: "Check brine tank",
      expectedRevision: empLateUseNoCount.body.item.stockRevision,
      expectedCurrentQuantity: 21.5,
      requestKey: "rbac-owner-rec",
    });
    expect(recRes.status).toBe(201);
    const pendingEmpUse = await postUsage(ctx, empDay3, supplyId, {
      quantity: 1,
      purpose: "Yesterday missed entry",
      effectiveDate: "2026-11-25",
      expectedRevision: recRes.body.item.stockRevision,
      expectedCurrentQuantity: 21,
      requestKey: "rbac-emp-use-pending",
    });
    expect(pendingEmpUse.status).toBe(201);
    expect(pendingEmpUse.body.movement.entryStatus).toBe("PENDING_REVIEW");

    // 1. Direct API RBAC checks for Employee:
    expect(
      (await request(ctx.app).get("/api/inventory/pending-reviews").set("Cookie", empDay3.cookie)).status,
    ).toBe(403);
    expect(
      (
        await request(ctx.app)
          .get(`/api/inventory/items/${encodeURIComponent(supplyId)}/reconciliations`)
          .set("Cookie", empDay3.cookie)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(ctx.app)
          .post(`/api/inventory/pending-reviews/${encodeURIComponent(pendingEmpUse.body.movement.id)}/resolve`)
          .set("Cookie", empDay3.cookie)
          .set("X-CSRF-Token", empDay3.csrfToken)
          .send({
            coverageMode: "NONE",
            expectedRevision: recRes.body.item.stockRevision,
            expectedCurrentQuantity: 21,
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await postUsage(ctx, empDay3, supplyId, {
          quantity: 1,
          purpose: "Attempt coverage override",
          effectiveDate: "2026-11-25",
          coverageMode: "FULL",
          expectedRevision: recRes.body.item.stockRevision,
          expectedCurrentQuantity: 21,
        })
      ).status,
    ).toBe(403);

    // 2. GET /items?includeArchived=true as Employee omits archived items, latestReconciliation, and pendingMovementReviewsCount.
    const empItemsRes = await request(ctx.app)
      .get("/api/inventory/items?includeArchived=true")
      .set("Cookie", empDay3.cookie);
    expect(empItemsRes.status).toBe(200);
    expect(empItemsRes.body.permissions).toMatchObject({
      canViewFullHistory: false,
      canViewOwnUsageHistory: true,
      canReviewPendingEntries: false,
      canCorrectMovements: false,
    });
    expect(empItemsRes.body.pendingMovementReviewsCount).toBe(0);
    expect(empItemsRes.body.items.some((i: any) => i.id === archivedSupplyId)).toBe(false);
    const empSaltItem = empItemsRes.body.items.find((i: any) => i.id === supplyId);
    expect(empSaltItem.status).toBe("INITIALIZED");
    expect(empSaltItem.currentQuantity).toBe(21);
    expect(empSaltItem.openingStock).toBeNull();
    expect(empSaltItem.latestReconciliation).toBeNull();
    expect(empSaltItem.pendingStockReviews).toEqual([]);

    // DEC-065 preserved: Employee still views Round container opening count.
    const empRoundItem = empItemsRes.body.items.find((i: any) => i.shape === "ROUND");
    expect(empRoundItem.openingStock).toMatchObject({
      quantity: 10,
      unit: "containers",
      recordedBy: "owner1",
    });

    // Recovery lookup & already-saved cancel for Employee usage also redact operating-supply openingStock.
    const empByKeyRes = await request(ctx.app)
      .get("/api/inventory/movements/by-request-key/rbac-emp-use-late")
      .set("Cookie", empDay3.cookie);
    expect(empByKeyRes.status).toBe(200);
    expect(empByKeyRes.body.status).toBe("SAVED");
    expect(empByKeyRes.body.item.openingStock).toBeNull();

    const empCancelSavedRes = await request(ctx.app)
      .post("/api/inventory/movements/by-request-key/rbac-emp-use-late/cancel")
      .set("Cookie", empDay3.cookie)
      .set("X-CSRF-Token", empDay3.csrfToken)
      .send({ itemKey: supplyId, movementType: "STOCK_USED" });
    expect(empCancelSavedRes.status).toBe(200);
    expect(empCancelSavedRes.body.status).toBe("SAVED");
    expect(empCancelSavedRes.body.item.openingStock).toBeNull();

    // 3. GET /items/:key/history as Employee returns ONLY emp1's own STOCK_USED movements (no owner1 usage, no receiving, no reconciliations, no archived item access, no supply opening audit).
    const empHistory = await request(ctx.app)
      .get(`/api/inventory/items/${encodeURIComponent(supplyId)}/history`)
      .set("Cookie", empDay3.cookie);
    expect(empHistory.status).toBe(200);
    expect(empHistory.body.scope).toBe("OWN_USAGE");
    expect(empHistory.body.item.openingStock).toBeNull();
    expect(empHistory.body.openingStock).toBeNull();
    expect(empHistory.body.reconciliations).toEqual([]);
    expect(empHistory.body.movements).toHaveLength(2);
    expect(empHistory.body.movements.every((m: any) => m.recordedBy === "emp1" && m.movementType === "STOCK_USED")).toBe(true);
    expect(empHistory.body.movements.every((m: any) => m.supportingReconciliation === null && m.supportingReconciliationId === null)).toBe(true);

    expect(
      (
        await request(ctx.app)
          .get(`/api/inventory/items/${encodeURIComponent(archivedSupplyId)}/history`)
          .set("Cookie", empDay3.cookie)
      ).status,
    ).toBe(404);

    // 4. GET /items/:key/history & GET /pending-reviews as Owner return full history, reconciliations, and pending review queue.
    const ownerHistory = await request(ctx.app)
      .get(`/api/inventory/items/${encodeURIComponent(supplyId)}/history`)
      .set("Cookie", ownerDay3.cookie);
    expect(ownerHistory.status).toBe(200);
    expect(ownerHistory.body.scope).toBe("FULL");
    expect(ownerHistory.body.openingStock).toMatchObject({ quantity: 20, unit: "kg" });
    expect(ownerHistory.body.reconciliations).toHaveLength(1);
    expect(ownerHistory.body.movements).toHaveLength(5);

    const ownerPendingRes = await request(ctx.app)
      .get("/api/inventory/pending-reviews")
      .set("Cookie", ownerDay3.cookie);
    expect(ownerPendingRes.status).toBe(200);
    expect(ownerPendingRes.body.reviews).toHaveLength(1);
    expect(ownerPendingRes.body.reviews[0].entry.id).toBe(pendingEmpUse.body.movement.id);
    expect(ownerPendingRes.body.reviews[0].applicableReconciliations).toHaveLength(1);
  });

  it("supports repeated quantity fixes, count-first resolution, negative merchandise blocks, cancellations, wrong-supply workflow, and metadata/date-crossing reviews (INV-010..022, INV-037, INV-043)", async () => {
    const supplyA = (
      await postProduct(ctx, owner, {
        category: "OPERATING_SUPPLY",
        name: "Liquid Cleanser A",
        unit: "L",
        allowDecimalQuantity: true,
        unitConfirmed: true,
      })
    ).body.item.id as string;
    const supplyB = (
      await postProduct(ctx, owner, {
        category: "OPERATING_SUPPLY",
        name: "Sanitizer B",
        unit: "L",
        allowDecimalQuantity: true,
        unitConfirmed: true,
      })
    ).body.item.id as string;
    const sealsRes = await postProduct(ctx, owner, {
      category: "MERCHANDISE",
      name: "Tamper Seals",
      unit: "pcs",
      unitPriceCentavos: 200,
      showInPos: true,
      posSection: "TAKIP_ACCESSORIES",
      unitConfirmed: true,
    });
    const sealsId = sealsRes.body.item.id as string;

    const openA = await postOpeningStock(ctx, owner, supplyA, { quantity: 10 });
    const openB = await postOpeningStock(ctx, owner, supplyB, { quantity: 10 });
    const openSeals = await postOpeningStock(ctx, owner, sealsId, { quantity: 2 });
    expect(openA.status).toBe(201);
    expect(openB.status).toBe(201);
    expect(openSeals.status).toBe(201);

    // Day 1: Stock Received +10 L on Supply A (effective 2026-11-27 -> balance 20 L).
    ctx.clock.advance(60_000);
    const recvA = await postReceiving(ctx, owner, supplyA, {
      quantity: 10,
      note: "Drum delivery",
      expectedRevision: openA.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "t3-recv-a-1",
    });
    expect(recvA.status).toBe(201);
    const recvAId = recvA.body.movement.id as string;

    // 1. Repeated quantity correction #1: 10 -> 7 L (NONE) applies -3 -> balance 17 L.
    ctx.clock.set("2026-11-28T09:00:00+08:00");
    const ownerDay2 = await signIn(ctx.app, "owner1", owner.password);
    const empDay2 = await signIn(ctx.app, "emp1", employee.password);

    // Employee is blocked (403) from all Task 3 endpoints.
    expect(
      (
        await request(ctx.app)
          .post(`/api/inventory/movements/${encodeURIComponent(recvAId)}/correct-quantity`)
          .set("Cookie", empDay2.cookie)
          .set("X-CSRF-Token", empDay2.csrfToken)
          .send({
            newQuantity: 7,
            reason: "Emp attempt",
            expectedCorrectionVersion: 0,
            expectedRevision: recvA.body.item.stockRevision,
            expectedCurrentQuantity: 20,
            expectedLatestReconciliationId: null,
            expectedOpeningCountCoversDate: false,
            requestKey: "emp-403-qty",
          })
      ).status,
    ).toBe(403);
    expect(
      (await request(ctx.app).get("/api/inventory/pending-corrections").set("Cookie", empDay2.cookie)).status,
    ).toBe(403);

    const qtyFix1 = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(recvAId)}/correct-quantity`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        newQuantity: 7,
        reason: "3 L leaked before storage",
        coverageMode: "NONE",
        expectedCorrectionVersion: 0,
        expectedRevision: recvA.body.item.stockRevision,
        expectedCurrentQuantity: 20,
        expectedLatestReconciliationId: null,
        expectedOpeningCountCoversDate: true,
        requestKey: "t3-qty-fix-1",
      });
    expect(qtyFix1.status).toBe(200);
    expect(qtyFix1.body.primaryItem.currentQuantity).toBe(17);
    expect(qtyFix1.body.movement.currentQuantityValue).toBe(7);
    expect(qtyFix1.body.movement.quantity).toBe(10); // original preserved!

    // 2. Repeated correction #2 from latest saved quantity (7 -> 9) after an intervening recount at 19 L:
    // Mark UNCLEAR first (0 stock change), recount to confirm 19 L, then resolve FULL (0 further change -> stays 19 L).
    const recA1 = await postReconciliation(ctx, ownerDay2, supplyA, {
      physicalCount: 19,
      reason: "Measured full tank including missed 2 L",
      expectedRevision: qtyFix1.body.primaryItem.stockRevision,
      expectedCurrentQuantity: 17,
      requestKey: "t3-rec-a1",
    });
    expect(recA1.status).toBe(201);
    const recA1Id = recA1.body.reconciliation.id as string;

    const qtyFix2Pending = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(recvAId)}/correct-quantity`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        newQuantity: 9,
        reason: "Invoice showed 9 L not 7 L",
        coverageMode: "UNCLEAR",
        expectedCorrectionVersion: 1,
        expectedRevision: recA1.body.item.stockRevision,
        expectedCurrentQuantity: 19,
        expectedLatestReconciliationId: recA1Id,
        expectedOpeningCountCoversDate: true,
        requestKey: "t3-qty-fix-2",
      });
    expect(qtyFix2Pending.status).toBe(200);
    expect(qtyFix2Pending.body.correction.status).toBe("PENDING_REVIEW");
    expect(qtyFix2Pending.body.primaryItem.currentQuantity).toBe(19);

    const pendingCorrList = await request(ctx.app)
      .get("/api/inventory/pending-corrections")
      .set("Cookie", ownerDay2.cookie);
    expect(pendingCorrList.status).toBe(200);
    expect(pendingCorrList.body.corrections).toHaveLength(1);
    const pendingCorrId = qtyFix2Pending.body.correction.id as string;

    // Resolving an UNCLEAR quantity correction with a pre-existing count or NONE fails; Owner must record a new physical count first.
    const resolvePreExistingFail = await request(ctx.app)
      .post(`/api/inventory/movement-corrections/${encodeURIComponent(pendingCorrId)}/resolve`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        expectedPrimaryRevision: recA1.body.item.stockRevision,
        expectedPrimaryQuantity: 19,
        requestKey: "t3-resolve-qty-2-old-rec",
        coverageMode: "FULL",
        supportingReconciliationId: recA1Id,
        expectedLatestReconciliationId: recA1Id,
        expectedOpeningCountCoversDate: true,
      });
    expect(resolvePreExistingFail.status).toBe(409);
    expect(resolvePreExistingFail.body.error.code).toBe("INTERVENING_COUNT_REVIEW_REQUIRED");

    ctx.clock.advance(60_000);
    const recA2 = await postReconciliation(ctx, ownerDay2, supplyA, {
      physicalCount: 19,
      reason: "New count after checking 9 L invoice",
      expectedRevision: recA1.body.item.stockRevision,
      expectedCurrentQuantity: 19,
      requestKey: "t3-rec-a2",
    });
    expect(recA2.status).toBe(201);
    const recA2Id = recA2.body.reconciliation.id as string;

    const resolveQtyFix2 = await request(ctx.app)
      .post(`/api/inventory/movement-corrections/${encodeURIComponent(pendingCorrId)}/resolve`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        expectedPrimaryRevision: recA2.body.item.stockRevision,
        expectedPrimaryQuantity: 19,
        requestKey: "t3-resolve-qty-2",
        coverageMode: "FULL",
        supportingReconciliationId: recA2Id,
        expectedLatestReconciliationId: recA2Id,
        expectedOpeningCountCoversDate: true,
        reviewNote: "New count verified 19 L; 0 further change",
      });
    expect(resolveQtyFix2.status).toBe(200);
    expect(resolveQtyFix2.body.primaryItem.currentQuantity).toBe(19);
    expect(resolveQtyFix2.body.correction).toMatchObject({
      status: "APPLIED",
      previousQuantity: 7,
      newQuantity: 9,
      primaryAppliedDelta: 0,
      primaryCoverageMode: "FULL",
    });

    // Repeat resolve with same key replays; new key returns 409 CORRECTION_ALREADY_RESOLVED.
    expect(
      (
        await request(ctx.app)
          .post(`/api/inventory/movement-corrections/${encodeURIComponent(pendingCorrId)}/resolve`)
          .set("Cookie", ownerDay2.cookie)
          .set("X-CSRF-Token", ownerDay2.csrfToken)
          .send({
            expectedPrimaryRevision: recA2.body.item.stockRevision,
            expectedPrimaryQuantity: 19,
            requestKey: "t3-resolve-qty-2",
            coverageMode: "FULL",
            supportingReconciliationId: recA2Id,
            expectedLatestReconciliationId: recA2Id,
            expectedOpeningCountCoversDate: true,
          })
      ).body.replayed,
    ).toBe(true);
    expect(
      (
        await request(ctx.app)
          .post(`/api/inventory/movement-corrections/${encodeURIComponent(pendingCorrId)}/resolve`)
          .set("Cookie", ownerDay2.cookie)
          .set("X-CSRF-Token", ownerDay2.csrfToken)
          .send({
            expectedPrimaryRevision: recA2.body.item.stockRevision,
            expectedPrimaryQuantity: 19,
            requestKey: "t3-resolve-qty-2-dup",
            coverageMode: "FULL",
            supportingReconciliationId: recA2Id,
            expectedLatestReconciliationId: recA2Id,
            expectedOpeningCountCoversDate: true,
          })
      ).status,
    ).toBe(409);

    // 3. Note-only correction has 0 stock change; date correction crossing counts requires review before stock change (INV-043).
    const noteFix = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(recvAId)}/correct-metadata`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        note: "Drum delivery #2 (sealed)",
        reason: "Added delivery slip reference",
        expectedCorrectionVersion: 2,
        expectedRevision: recA2.body.item.stockRevision,
        expectedCurrentQuantity: 19,
        requestKey: "t3-meta-note",
      });
    expect(noteFix.status).toBe(200);
    expect(noteFix.body.correction.status).toBe("APPLIED");
    expect(noteFix.body.primaryItem.currentQuantity).toBe(19);

    // Move receipt date forward to 2026-11-29 after counts -> pending review -> resolve NONE.
    ctx.clock.set("2026-11-29T10:00:00+08:00");
    const ownerDay3 = await signIn(ctx.app, "owner1", owner.password);
    const empDay3 = await signIn(ctx.app, "emp1", employee.password);

    const dateFixCrossPending = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(recvAId)}/correct-metadata`)
      .set("Cookie", ownerDay3.cookie)
      .set("X-CSRF-Token", ownerDay3.csrfToken)
      .send({
        effectiveDate: "2026-11-29",
        reason: "Delivery actually arrived on Nov 29 after Nov 28 count",
        expectedCorrectionVersion: 3,
        expectedRevision: recA2.body.item.stockRevision,
        expectedCurrentQuantity: 19,
        requestKey: "t3-meta-date-cross",
      });
    expect(dateFixCrossPending.status).toBe(200);
    expect(dateFixCrossPending.body.correction.status).toBe("PENDING_REVIEW");
    expect(dateFixCrossPending.body.movement.currentEffectiveDate).toBe("2026-11-23");

    // Resolving pending date correction with NONE (Nov 29 has no counts at/after Nov 29 -> full +9 net needed vs +7 already applied = +2 -> balance 21 L).
    const resolveDateCross = await request(ctx.app)
      .post(
        `/api/inventory/movement-corrections/${encodeURIComponent(dateFixCrossPending.body.correction.id)}/resolve`,
      )
      .set("Cookie", ownerDay3.cookie)
      .set("X-CSRF-Token", ownerDay3.csrfToken)
      .send({
        expectedPrimaryRevision: recA2.body.item.stockRevision,
        expectedPrimaryQuantity: 19,
        requestKey: "t3-resolve-date-cross",
        coverageMode: "NONE",
        expectedLatestReconciliationId: null,
        expectedOpeningCountCoversDate: false,
      });
    expect(resolveDateCross.status).toBe(200);
    expect(resolveDateCross.body.primaryItem.currentQuantity).toBe(21);
    expect(resolveDateCross.body.movement.currentEffectiveDate).toBe("2026-11-29");
    expect(resolveDateCross.body.movement.effectiveDate).toBe("2026-11-23"); // original preserved!

    // 4. Negative merchandise block requiring count first (INV-018):
    // Receive 5 Tamper Seals (2 -> 7), reconcile to 4 (used 3), then try to cancel receipt of 5 without covering count -> 4 - 5 = -1 -> 409!
    const recvSeals = await postReceiving(ctx, ownerDay3, sealsId, {
      quantity: 5,
      note: "Wrong pack",
      expectedRevision: openSeals.body.item.stockRevision,
      expectedCurrentQuantity: 2,
      requestKey: "t3-recv-seals",
    });
    expect(recvSeals.status).toBe(201);
    const recSeals = await postReconciliation(ctx, ownerDay3, sealsId, {
      physicalCount: 4,
      reason: "3 used during packing",
      expectedRevision: recvSeals.body.item.stockRevision,
      expectedCurrentQuantity: 7,
      requestKey: "t3-rec-seals",
    });
    expect(recSeals.status).toBe(201);

    const negCancelBlocked = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(recvSeals.body.movement.id)}/cancel`)
      .set("Cookie", ownerDay3.cookie)
      .set("X-CSRF-Token", ownerDay3.csrfToken)
      .send({
        reason: "Delivery never arrived",
        coverageMode: "NONE",
        expectedCorrectionVersion: 0,
        expectedRevision: recSeals.body.item.stockRevision,
        expectedCurrentQuantity: 4,
        expectedLatestReconciliationId: recSeals.body.reconciliation.id,
        expectedOpeningCountCoversDate: false,
        requestKey: "t3-cancel-seals-neg",
      });
    expect(negCancelBlocked.status).toBe(409);
    expect(negCancelBlocked.body.error.code).toBe("COUNT_REQUIRED_BEFORE_NEGATIVE_STOCK");

    // 5. Wrong-supply Stock Used cancellation + late usage on right supply (INV-022, INV-037):
    const wrongUse = await postUsage(ctx, empDay3, supplyA, {
      quantity: 2.5,
      purpose: "Filter flush",
      expectedRevision: resolveDateCross.body.primaryItem.stockRevision,
      expectedCurrentQuantity: 21,
      requestKey: "t3-wrong-use-a",
    });
    expect(wrongUse.status).toBe(201);
    expect(wrongUse.body.item.currentQuantity).toBe(18.5);

    const cancelWrongUse = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(wrongUse.body.movement.id)}/cancel`)
      .set("Cookie", ownerDay3.cookie)
      .set("X-CSRF-Token", ownerDay3.csrfToken)
      .send({
        reason: "Recorded against Cleanser A instead of Sanitizer B",
        coverageMode: "NONE",
        expectedCorrectionVersion: 0,
        expectedRevision: wrongUse.body.item.stockRevision,
        expectedCurrentQuantity: 18.5,
        expectedLatestReconciliationId: null,
        expectedOpeningCountCoversDate: false,
        requestKey: "t3-cancel-wrong-use",
      });
    expect(cancelWrongUse.status).toBe(200);
    expect(cancelWrongUse.body.primaryItem.currentQuantity).toBe(21);
    expect(cancelWrongUse.body.movement.isCancelled).toBe(true);

    // Record actual usage on Sanitizer B (2.5 L -> balance 7.5 L).
    const rightUse = await postUsage(ctx, ownerDay3, supplyB, {
      quantity: 2.5,
      purpose: "Filter flush (moved from Cleanser A)",
      expectedRevision: openB.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "t3-right-use-b",
    });
    expect(rightUse.status).toBe(201);
    expect(rightUse.body.item.currentQuantity).toBe(7.5);

    // Dashboard Stock Trend stays COMPLETE across all corrections, pending reviews, and cancellations!
    const trendA = await request(ctx.app)
      .get(`/api/dashboard/stocks/${encodeURIComponent(supplyA)}/trend`)
      .set("Cookie", ownerDay3.cookie);
    expect(trendA.status).toBe(200);
    expect(trendA.body.historyState).toBe("COMPLETE");

    // Full history shows original values & every correction cleanly.
    const historyA = await request(ctx.app)
      .get(`/api/inventory/items/${encodeURIComponent(supplyA)}/history`)
      .set("Cookie", ownerDay3.cookie);
    expect(historyA.status).toBe(200);
    const origRecvEntry = historyA.body.movements.find((m: any) => m.id === recvAId);
    expect(origRecvEntry.corrections).toHaveLength(4);
    expect(origRecvEntry.note).toBe("Drum delivery");
    expect(origRecvEntry.currentNote).toBe("Drum delivery #2 (sealed)");
    expect(origRecvEntry.effectiveDate).toBe("2026-11-23");
    expect(origRecvEntry.currentEffectiveDate).toBe("2026-11-29");
  });

  it("handles two-item receipt corrections across partial coverage, pending review, negative-merchandise blocks, different units, and atomic rollback/replay (INV-031..036)", async () => {
    const roundOpen = await postOpeningStock(ctx, owner, "ROUND", { quantity: 10 });
    const slimOpen = await postOpeningStock(ctx, owner, "SLIM", { quantity: 10 });
    const saltRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Industrial Salt Bags",
      unit: "bags",
      allowDecimalQuantity: false,
      unitConfirmed: true,
    });
    const saltId = saltRes.body.item.id as string;
    const saltOpen = await postOpeningStock(ctx, owner, saltId, { quantity: 4 });
    expect(roundOpen.status).toBe(201);
    expect(slimOpen.status).toBe(201);
    expect(saltOpen.status).toBe(201);

    // Receive 5 SLIM wrongly recorded against ROUND (ROUND 10 -> 15).
    ctx.clock.advance(60_000);
    const wrongRecv = await postReceiving(ctx, owner, "ROUND", {
      quantity: 5,
      note: "Container delivery",
      expectedRevision: roundOpen.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "t3-2item-wrong-recv",
    });
    expect(wrongRecv.status).toBe(201);
    const wrongRecvId = wrongRecv.body.movement.id as string;

    // 1. Round count fixes all 5 (10), Slim count fixes 2 of the 5 (12): Round 0 further change, Slim +3 (15)!
    ctx.clock.set("2026-11-28T09:00:00+08:00");
    const ownerDay2 = await signIn(ctx.app, "owner1", owner.password);
    const recRound = await postReconciliation(ctx, ownerDay2, "ROUND", {
      physicalCount: 10,
      reason: "Actual count excluded Slim containers",
      expectedRevision: wrongRecv.body.item.stockRevision,
      expectedCurrentQuantity: 15,
      requestKey: "t3-2item-rec-round",
    });
    const recSlim = await postReconciliation(ctx, ownerDay2, "SLIM", {
      physicalCount: 12,
      reason: "2 new Slim containers already counted",
      expectedRevision: slimOpen.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "t3-2item-rec-slim",
    });
    expect(recRound.status).toBe(201);
    expect(recSlim.status).toBe(201);

    // Unknown coverage on Slim leaves two-item correction PENDING_REVIEW with 0 stock change on both items.
    const twoItemPending = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(wrongRecvId)}/correct-item`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        newItemKey: "SLIM",
        reason: "Delivery was Slim not Round",
        expectedCorrectionVersion: 0,
        expectedPrimaryRevision: recRound.body.item.stockRevision,
        expectedPrimaryQuantity: 10,
        expectedSecondaryRevision: recSlim.body.item.stockRevision,
        expectedSecondaryQuantity: 12,
        primaryCoverage: {
          coverageMode: "FULL",
          supportingReconciliationId: recRound.body.reconciliation.id,
          expectedLatestReconciliationId: recRound.body.reconciliation.id,
          expectedOpeningCountCoversDate: true,
        },
        secondaryCoverage: {
          coverageMode: "UNCLEAR",
          expectedLatestReconciliationId: recSlim.body.reconciliation.id,
          expectedOpeningCountCoversDate: true,
        },
        requestKey: "t3-2item-switch-1",
      });
    expect(twoItemPending.status).toBe(200);
    expect(twoItemPending.body.correction.status).toBe("PENDING_REVIEW");
    expect(twoItemPending.body.primaryItem.currentQuantity).toBe(10);
    expect(twoItemPending.body.secondaryItem.currentQuantity).toBe(12);

    // Resolve two-item pending correction: Round FULL (0 change -> 10), Slim PARTIAL covered 2 (+3 -> 15).
    const resolveTwoItem = await request(ctx.app)
      .post(
        `/api/inventory/movement-corrections/${encodeURIComponent(twoItemPending.body.correction.id)}/resolve`,
      )
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        expectedPrimaryRevision: recRound.body.item.stockRevision,
        expectedPrimaryQuantity: 10,
        expectedSecondaryRevision: recSlim.body.item.stockRevision,
        expectedSecondaryQuantity: 12,
        primaryCoverage: {
          coverageMode: "FULL",
          supportingReconciliationId: recRound.body.reconciliation.id,
          expectedLatestReconciliationId: recRound.body.reconciliation.id,
          expectedOpeningCountCoversDate: true,
        },
        secondaryCoverage: {
          coverageMode: "PARTIAL",
          coveredQuantity: 2,
          supportingReconciliationId: recSlim.body.reconciliation.id,
          expectedLatestReconciliationId: recSlim.body.reconciliation.id,
          expectedOpeningCountCoversDate: true,
        },
        requestKey: "t3-2item-resolve-1",
      });
    expect(resolveTwoItem.status).toBe(200);
    expect(resolveTwoItem.body.primaryItem.currentQuantity).toBe(10);
    expect(resolveTwoItem.body.secondaryItem.currentQuantity).toBe(15);

    // Visible in BOTH Round and Slim histories!
    const roundHist = await request(ctx.app)
      .get("/api/inventory/items/ROUND/history")
      .set("Cookie", ownerDay2.cookie);
    const slimHist = await request(ctx.app)
      .get("/api/inventory/items/SLIM/history")
      .set("Cookie", ownerDay2.cookie);
    expect(roundHist.body.movements.some((m: any) => m.id === wrongRecvId)).toBe(true);
    expect(slimHist.body.movements.some((m: any) => m.id === wrongRecvId)).toBe(true);

    // 2. Different units (SLIM containers vs Industrial Salt Bags bags) requires counts on both first (INV-036).
    const diffUnitsBlocked = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(wrongRecvId)}/correct-item`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        newItemKey: saltId,
        reason: "Unit mismatch test",
        expectedCorrectionVersion: 1,
        expectedPrimaryRevision: resolveTwoItem.body.secondaryItem.stockRevision,
        expectedPrimaryQuantity: 15,
        expectedSecondaryRevision: saltOpen.body.item.stockRevision,
        expectedSecondaryQuantity: 4,
        primaryCoverage: {
          coverageMode: "NONE",
          expectedLatestReconciliationId: recSlim.body.reconciliation.id,
          expectedOpeningCountCoversDate: false,
        },
        secondaryCoverage: {
          coverageMode: "NONE",
          expectedLatestReconciliationId: null,
          expectedOpeningCountCoversDate: false,
        },
        requestKey: "t3-diff-unit-need-rec",
      });
    expect(diffUnitsBlocked.status).toBe(409);
    expect(diffUnitsBlocked.body.error.code).toBe("DIFFERENT_UNIT_RECONCILIATION_REQUIRED");

    ctx.clock.advance(60_000);
    const recSlimDiff = await postReconciliation(ctx, ownerDay2, "SLIM", {
      physicalCount: 10,
      reason: "Reconcile Slim in containers",
      expectedRevision: resolveTwoItem.body.secondaryItem.stockRevision,
      expectedCurrentQuantity: 15,
      requestKey: "t3-diff-rec-slim",
    });
    const recSaltDiff = await postReconciliation(ctx, ownerDay2, saltId, {
      physicalCount: 6,
      reason: "Reconcile Salt in bags",
      expectedRevision: saltOpen.body.item.stockRevision,
      expectedCurrentQuantity: 4,
      requestKey: "t3-diff-rec-salt",
    });
    const diffUnitsOk = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(wrongRecvId)}/correct-item`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        newItemKey: saltId,
        reason: "Was 2 bags salt not 5 containers",
        expectedCorrectionVersion: 1,
        expectedPrimaryRevision: recSlimDiff.body.item.stockRevision,
        expectedPrimaryQuantity: 10,
        expectedSecondaryRevision: recSaltDiff.body.item.stockRevision,
        expectedSecondaryQuantity: 6,
        differentUnitReconciliation: {
          primarySupportingReconciliationId: recSlimDiff.body.reconciliation.id,
          secondarySupportingReconciliationId: recSaltDiff.body.reconciliation.id,
        },
        requestKey: "t3-diff-unit-ok",
      });
    expect(diffUnitsOk.status).toBe(200);
    expect(diffUnitsOk.body.correction.primaryCoverageMode).toBe("DIFFERENT_UNIT_RECONCILED");
    expect(diffUnitsOk.body.primaryItem.currentQuantity).toBe(10);
    expect(diffUnitsOk.body.secondaryItem.currentQuantity).toBe(6);

    // 3. Insufficient wrong-item merchandise (< delivery qty) + atomic mid-transaction rollback & idempotent retry.
    const slimRecvNegTest = await postReceiving(ctx, ownerDay2, "SLIM", {
      quantity: 6,
      note: "For neg and atomic test",
      expectedRevision: recSlimDiff.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "t3-2item-neg-recv",
    });
    expect(slimRecvNegTest.status).toBe(201);
    ctx.clock.advance(60_000);
    const slimRecDown = await postReconciliation(ctx, ownerDay2, "SLIM", {
      physicalCount: 2,
      reason: "Sold/used down before correction",
      expectedRevision: slimRecvNegTest.body.item.stockRevision,
      expectedCurrentQuantity: 16,
      requestKey: "t3-2item-rec-down",
    });
    expect(slimRecDown.status).toBe(201);

    const negSwitchBlocked = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(slimRecvNegTest.body.movement.id)}/correct-item`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        newItemKey: "ROUND",
        reason: "Blocked negative wrong-item switch",
        expectedCorrectionVersion: 0,
        expectedPrimaryRevision: slimRecDown.body.item.stockRevision,
        expectedPrimaryQuantity: 2,
        expectedSecondaryRevision: resolveTwoItem.body.primaryItem.stockRevision,
        expectedSecondaryQuantity: 10,
        primaryCoverage: {
          coverageMode: "NONE",
          expectedLatestReconciliationId: slimRecDown.body.reconciliation.id,
          expectedOpeningCountCoversDate: false,
        },
        secondaryCoverage: {
          coverageMode: "NONE",
          expectedLatestReconciliationId: recRound.body.reconciliation.id,
          expectedOpeningCountCoversDate: false,
        },
        requestKey: "t3-2item-neg-blocked",
      });
    expect(negSwitchBlocked.status).toBe(409);
    expect(negSwitchBlocked.body.error.code).toBe("COUNT_REQUIRED_BEFORE_NEGATIVE_STOCK");

    // Atomic failure injection on a valid same-unit Round -> Slim receipt switch (6 containers, Round has 10):
    const roundRecvAtomic = await postReceiving(ctx, ownerDay2, "ROUND", {
      quantity: 4,
      note: "Atomic switch test",
      expectedRevision: resolveTwoItem.body.primaryItem.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "t3-atomic-recv",
    });
    expect(roundRecvAtomic.status).toBe(201); // ROUND 14

    const origTransaction = ctx.db.transaction.bind(ctx.db);
    let injectedOnce = false;
    ctx.db.transaction = async <T>(fn: (tx: any) => Promise<T>): Promise<T> =>
      origTransaction(async (tx) => {
        const wrappedTx = {
          exec: tx.exec.bind(tx),
          query: async (sql: string, params?: unknown[]) => {
            if (
              !injectedOnce &&
              sql.includes("UPDATE inventory_stock_movements") &&
              sql.includes("current_item_id")
            ) {
              injectedOnce = true;
              throw new Error("Simulated mid-two-item commit failure");
            }
            return tx.query(sql, params);
          },
        };
        return fn(wrappedTx);
      });

    const atomicSwitchPayload = {
      newItemKey: "SLIM",
      reason: "Atomic rollback verification",
      expectedCorrectionVersion: 0,
      expectedPrimaryRevision: roundRecvAtomic.body.item.stockRevision,
      expectedPrimaryQuantity: 14,
      expectedSecondaryRevision: slimRecDown.body.item.stockRevision,
      expectedSecondaryQuantity: 2,
      primaryCoverage: {
        coverageMode: "NONE",
        expectedLatestReconciliationId: recRound.body.reconciliation.id,
        expectedOpeningCountCoversDate: false,
      },
      secondaryCoverage: {
        coverageMode: "NONE",
        expectedLatestReconciliationId: slimRecDown.body.reconciliation.id,
        expectedOpeningCountCoversDate: false,
      },
      requestKey: "t3-atomic-switch-key",
    };

    const failedAttempt = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(roundRecvAtomic.body.movement.id)}/correct-item`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send(atomicSwitchPayload);
    expect(failedAttempt.status).toBe(500);
    ctx.db.transaction = origTransaction;

    // Both balances remained completely rolled back (ROUND=14, SLIM=2)!
    const afterFailItems = await request(ctx.app).get("/api/inventory/items").set("Cookie", ownerDay2.cookie);
    expect(afterFailItems.body.items.find((i: any) => i.shape === "ROUND").currentQuantity).toBe(14);
    expect(afterFailItems.body.items.find((i: any) => i.shape === "SLIM").currentQuantity).toBe(2);

    // Repeating with the exact same requestKey now commits atomically (ROUND=10, SLIM=6), and a replay leaves it unchanged!
    const retryOk = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(roundRecvAtomic.body.movement.id)}/correct-item`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send(atomicSwitchPayload);
    expect(retryOk.status).toBe(200);
    expect(retryOk.body.replayed).toBe(false);
    expect(retryOk.body.primaryItem.currentQuantity).toBe(10);
    expect(retryOk.body.secondaryItem.currentQuantity).toBe(6);

    const replayOk = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(roundRecvAtomic.body.movement.id)}/correct-item`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send(atomicSwitchPayload);
    expect(replayOk.status).toBe(200);
    expect(replayOk.body.replayed).toBe(true);
    expect(replayOk.body.primaryItem.currentQuantity).toBe(10);
    expect(replayOk.body.secondaryItem.currentQuantity).toBe(6);
  });

  it("Task 3 Findings 1–4 regressions: requires new count on unclear correction, cancels only un-covered debit, blocks cross-unit delta without target qty, and preserves cleared null notes", async () => {
    const supplyRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Sanitizer Solution",
      unit: "L",
      allowDecimalQuantity: true,
      unitConfirmed: true,
    });
    const supplyId = supplyRes.body.item.id as string;
    const bagsRes = await postProduct(ctx, owner, {
      category: "OPERATING_SUPPLY",
      name: "Clean Salt Bags",
      unit: "bags",
      allowDecimalQuantity: false,
      unitConfirmed: true,
    });
    const bagsId = bagsRes.body.item.id as string;
    const partialSupplyId = (
      await postProduct(ctx, owner, {
        category: "OPERATING_SUPPLY",
        name: "Rinse Liquid",
        unit: "L",
        allowDecimalQuantity: true,
        unitConfirmed: true,
      })
    ).body.item.id as string;

    const openSupply = await postOpeningStock(ctx, owner, supplyId, { quantity: 15 });
    const openBags = await postOpeningStock(ctx, owner, bagsId, { quantity: 10 });
    const openPartial = await postOpeningStock(ctx, owner, partialSupplyId, { quantity: 10 });
    expect(openSupply.status).toBe(201);
    expect(openBags.status).toBe(201);
    expect(openPartial.status).toBe(201);

    // Day 1 (2026-11-23): initial usage of 2 L (15 -> 13 L) and receipt of 5 L with initial note.
    ctx.clock.advance(60_000);
    const initUse = await postUsage(ctx, owner, supplyId, {
      quantity: 2,
      purpose: "Opening sanitize",
      expectedRevision: openSupply.body.item.stockRevision,
      expectedCurrentQuantity: 15,
      requestKey: "f14-use-1",
    });
    expect(initUse.status).toBe(201); // 13 L

    ctx.clock.set("2026-11-24T09:00:00+08:00");
    const ownerDay2 = await signIn(ctx.app, "owner1", owner.password);
    const initRec = await postReconciliation(ctx, ownerDay2, supplyId, {
      physicalCount: 13,
      reason: "Day 2 baseline check",
      expectedRevision: initUse.body.item.stockRevision,
      expectedCurrentQuantity: 13,
      requestKey: "f14-rec-1",
    });
    expect(initRec.status).toBe(201);
    const oldRecId = initRec.body.reconciliation.id as string;

    // --- Finding 1 regression ---
    // Queue usage quantity correction 2 L -> 1 L with UNCLEAR (balance stays 13 L).
    const unclearQty = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(initUse.body.movement.id)}/correct-quantity`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        newQuantity: 1,
        reason: "Unclear usage qty",
        coverageMode: "UNCLEAR",
        expectedCorrectionVersion: 0,
        expectedRevision: initRec.body.item.stockRevision,
        expectedCurrentQuantity: 13,
        expectedLatestReconciliationId: oldRecId,
        expectedOpeningCountCoversDate: true,
        requestKey: "f1-qty-unclear",
      });
    expect(unclearQty.status).toBe(200);
    expect(unclearQty.body.correction.status).toBe("PENDING_REVIEW");
    const f1CorrId = unclearQty.body.correction.id as string;

    // Resolving with NONE returns 400; resolving with pre-existing oldRecId returns 409 INTERVENING_COUNT_REVIEW_REQUIRED; balance stays 13 L.
    const f1ResolveNone = await request(ctx.app)
      .post(`/api/inventory/movement-corrections/${encodeURIComponent(f1CorrId)}/resolve`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        expectedPrimaryRevision: initRec.body.item.stockRevision,
        expectedPrimaryQuantity: 13,
        requestKey: "f1-resolve-none",
        coverageMode: "NONE",
        expectedLatestReconciliationId: oldRecId,
        expectedOpeningCountCoversDate: true,
      });
    expect(f1ResolveNone.status).toBe(400);

    const f1ResolveOldCount = await request(ctx.app)
      .post(`/api/inventory/movement-corrections/${encodeURIComponent(f1CorrId)}/resolve`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        expectedPrimaryRevision: initRec.body.item.stockRevision,
        expectedPrimaryQuantity: 13,
        requestKey: "f1-resolve-old",
        coverageMode: "FULL",
        supportingReconciliationId: oldRecId,
        expectedLatestReconciliationId: oldRecId,
        expectedOpeningCountCoversDate: true,
      });
    expect(f1ResolveOldCount.status).toBe(409);
    expect(f1ResolveOldCount.body.error.code).toBe("INTERVENING_COUNT_REVIEW_REQUIRED");

    // Record a NEW physical count (14 L) and resolve FULL -> succeeds with 0 further stock effect (stays 14 L).
    ctx.clock.advance(60_000);
    const newRecAfterUnclear = await postReconciliation(ctx, ownerDay2, supplyId, {
      physicalCount: 14,
      reason: "Recount after unclear usage check",
      expectedRevision: initRec.body.item.stockRevision,
      expectedCurrentQuantity: 13,
      requestKey: "f1-new-rec",
    });
    expect(newRecAfterUnclear.status).toBe(201);
    const newRecId = newRecAfterUnclear.body.reconciliation.id as string;

    const f1ResolveOk = await request(ctx.app)
      .post(`/api/inventory/movement-corrections/${encodeURIComponent(f1CorrId)}/resolve`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        expectedPrimaryRevision: newRecAfterUnclear.body.item.stockRevision,
        expectedPrimaryQuantity: 14,
        requestKey: "f1-resolve-ok",
        coverageMode: "FULL",
        supportingReconciliationId: newRecId,
        expectedLatestReconciliationId: newRecId,
        expectedOpeningCountCoversDate: true,
      });
    expect(f1ResolveOk.status).toBe(200);
    expect(f1ResolveOk.body.primaryItem.currentQuantity).toBe(14);
    expect(f1ResolveOk.body.correction.primaryAppliedDelta).toBe(0);
    expect(f1ResolveOk.body.correction.status).toBe("APPLIED");

    // --- Finding 2 regression ---
    // Late 5 L usage on Rinse Liquid (opened 2026-11-23 at 10 L) where opening count covered 2 L -> deducts 3 L (10 -> 7 L).
    const partialLateUse = await postUsage(ctx, ownerDay2, partialSupplyId, {
      quantity: 5,
      purpose: "Late tank wash",
      effectiveDate: "2026-11-23",
      coverageMode: "PARTIAL",
      coveredQuantity: 2,
      coveredByOpeningCount: true,
      expectedLatestReconciliationId: null,
      expectedOpeningCountCoversDate: true,
      expectedRevision: openPartial.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "f2-partial-use",
    });
    expect(partialLateUse.status).toBe(201);
    expect(partialLateUse.body.item.currentQuantity).toBe(7);

    // Owner cancels this usage with NONE (no extra count covered cancellation) -> restores ONLY 3 L (7 -> 10 L, NOT 12 L)!
    const cancelPartialUse = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(partialLateUse.body.movement.id)}/cancel`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        reason: "None of Rinse Liquid was actually used",
        coverageMode: "NONE",
        expectedCorrectionVersion: 0,
        expectedRevision: partialLateUse.body.item.stockRevision,
        expectedCurrentQuantity: 7,
        expectedLatestReconciliationId: null,
        expectedOpeningCountCoversDate: true,
        requestKey: "f2-cancel-partial",
      });
    expect(cancelPartialUse.status).toBe(200);
    expect(cancelPartialUse.body.primaryItem.currentQuantity).toBe(10);
    expect(cancelPartialUse.body.correction.primaryAppliedDelta).toBe(3);

    const partialTrend = await request(ctx.app)
      .get(`/api/dashboard/stocks/${encodeURIComponent(partialSupplyId)}/trend`)
      .set("Cookie", ownerDay2.cookie);
    expect(partialTrend.status).toBe(200);
    expect(partialTrend.body.historyState).toBe("COMPLETE");
    expect(partialTrend.body.points.map((p: any) => p.balanceAfter)).toEqual([10, 7, 10]);

    // --- Finding 3 & Finding 4 regressions ---
    // Receive 5 L on Sanitizer Solution (14 -> 19 L) with an initial note.
    ctx.clock.advance(60_000);
    const recvForF34 = await postReceiving(ctx, ownerDay2, supplyId, {
      quantity: 5,
      note: "Initial delivery slip #1",
      expectedRevision: newRecAfterUnclear.body.item.stockRevision,
      expectedCurrentQuantity: 14,
      requestKey: "f34-recv-5l",
    });
    expect(recvForF34.status).toBe(201);
    const f34MovId = recvForF34.body.movement.id as string;

    // Finding 4: Clear the note (note: null), then make another metadata edit -> previousNote MUST be null (not "Initial delivery slip #1")!
    const clearNoteRes = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(f34MovId)}/correct-metadata`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        note: null,
        reason: "Remove erroneous slip note",
        expectedCorrectionVersion: 0,
        expectedRevision: recvForF34.body.item.stockRevision,
        expectedCurrentQuantity: 19,
        requestKey: "f4-clear-note",
      });
    expect(clearNoteRes.status).toBe(200);
    expect(clearNoteRes.body.movement.currentNote).toBeNull();
    expect(clearNoteRes.body.movement.note).toBe("Initial delivery slip #1");

    const reEditNoteRes = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(f34MovId)}/correct-metadata`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        note: "Replacement delivery slip #2",
        reason: "Record verified slip number",
        expectedCorrectionVersion: 1,
        expectedRevision: recvForF34.body.item.stockRevision,
        expectedCurrentQuantity: 19,
        requestKey: "f4-reedit-note",
      });
    expect(reEditNoteRes.status).toBe(200);
    expect(reEditNoteRes.body.correction.previousNote).toBeNull();
    expect(reEditNoteRes.body.correction.newNote).toBe("Replacement delivery slip #2");
    expect(reEditNoteRes.body.movement.currentNote).toBe("Replacement delivery slip #2");

    // Clear again so Finding 4 leaves currentNote === null visible in GET /history as well.
    const clearNoteAgain = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(f34MovId)}/correct-metadata`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        note: null,
        reason: "Blank note confirmed",
        expectedCorrectionVersion: 2,
        expectedRevision: recvForF34.body.item.stockRevision,
        expectedCurrentQuantity: 19,
        requestKey: "f4-clear-note-2",
      });
    expect(clearNoteAgain.status).toBe(200);
    expect(clearNoteAgain.body.movement.currentNote).toBeNull();

    // Finding 3: Reconcile both L (14 L) and bags (10 bags), switch 5 L receipt to bags -> preserves original 5 L, leaves newQuantity/currentQuantityValue null, blocks subsequent cancel/correct-qty!
    ctx.clock.advance(60_000);
    const recSupplyForDiff = await postReconciliation(ctx, ownerDay2, supplyId, {
      physicalCount: 14,
      reason: "Wrong liquid receipt reconciled out in L",
      expectedRevision: recvForF34.body.item.stockRevision,
      expectedCurrentQuantity: 19,
      requestKey: "f3-rec-liquid",
    });
    const recBagsForDiff = await postReconciliation(ctx, ownerDay2, bagsId, {
      physicalCount: 10,
      reason: "Actual bag count reconciled in bags",
      expectedRevision: openBags.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "f3-rec-bags",
    });

    const switchDiffUnit = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(f34MovId)}/correct-item`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        newItemKey: bagsId,
        reason: "Delivery was bags of salt, not sanitizer L",
        expectedCorrectionVersion: 3,
        expectedPrimaryRevision: recSupplyForDiff.body.item.stockRevision,
        expectedPrimaryQuantity: 14,
        expectedSecondaryRevision: recBagsForDiff.body.item.stockRevision,
        expectedSecondaryQuantity: 10,
        differentUnitReconciliation: {
          primarySupportingReconciliationId: recSupplyForDiff.body.reconciliation.id,
          secondarySupportingReconciliationId: recBagsForDiff.body.reconciliation.id,
        },
        requestKey: "f3-switch-diff",
      });
    expect(switchDiffUnit.status).toBe(200);
    expect(switchDiffUnit.body.secondaryItem.currentQuantity).toBe(10);
    expect(switchDiffUnit.body.correction.previousQuantity).toBe(5);
    expect(switchDiffUnit.body.correction.newQuantity).toBeNull();
    expect(switchDiffUnit.body.correction.previousUnit).toBe("L");
    expect(switchDiffUnit.body.correction.newUnit).toBe("bags");
    expect(switchDiffUnit.body.movement.currentQuantityValue).toBeNull();
    expect(switchDiffUnit.body.movement.quantity).toBe(5);
    expect(switchDiffUnit.body.movement.unit).toBe("L");
    expect(switchDiffUnit.body.movement.currentNote).toBeNull();

    // Subsequent cancel or quantity edit MUST fail with 409 DIFFERENT_UNIT_RECONCILIATION_REQUIRED and leave bags at 10 (NOT 5)!
    const blockedCrossUnitCancel = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(f34MovId)}/cancel`)
      .set("Cookie", ownerDay2.cookie)
      .set("X-CSRF-Token", ownerDay2.csrfToken)
      .send({
        reason: "Attempt cancel after unit switch",
        coverageMode: "NONE",
        expectedCorrectionVersion: 4,
        expectedRevision: recBagsForDiff.body.item.stockRevision,
        expectedCurrentQuantity: 10,
        expectedLatestReconciliationId: recBagsForDiff.body.reconciliation.id,
        expectedOpeningCountCoversDate: false,
        requestKey: "f3-cancel-blocked",
      });
    expect(blockedCrossUnitCancel.status).toBe(409);
    expect(blockedCrossUnitCancel.body.error.code).toBe("DIFFERENT_UNIT_RECONCILIATION_REQUIRED");

    const bagsAfter = await request(ctx.app)
      .get(`/api/inventory/items/${encodeURIComponent(bagsId)}/history`)
      .set("Cookie", ownerDay2.cookie);
    expect(bagsAfter.status).toBe(200);
    expect(bagsAfter.body.item.currentQuantity).toBe(10);
    const bagsEntry = bagsAfter.body.movements.find((m: any) => m.id === f34MovId);
    expect(bagsEntry.currentQuantityValue).toBeNull();
    expect(bagsEntry.currentNote).toBeNull();
  });

  it("Task 3 17bce02 re-review regressions: allows same-second later counts for unclear resolution and cancels switched receipts using target-item net delta", async () => {
    // 1. Sub-second count eligibility for unclear pending correction resolution (Finding 1 remaining)
    const supplyA = (
      await postProduct(ctx, owner, {
        category: "OPERATING_SUPPLY",
        name: "Filter Wash L",
        unit: "L",
        allowDecimalQuantity: true,
        unitConfirmed: true,
      })
    ).body.item.id as string;
    const sourceB = (
      await postProduct(ctx, owner, {
        category: "OPERATING_SUPPLY",
        name: "Source Sanitizing Solution",
        unit: "L",
        allowDecimalQuantity: true,
        unitConfirmed: true,
      })
    ).body.item.id as string;
    const targetC = (
      await postProduct(ctx, owner, {
        category: "OPERATING_SUPPLY",
        name: "Target Rinsing Solution",
        unit: "L",
        allowDecimalQuantity: true,
        unitConfirmed: true,
      })
    ).body.item.id as string;

    // Opening counts on 2026-11-22 (BASE_MANILA)
    const openA = await postOpeningStock(ctx, owner, supplyA, { quantity: 10 });
    const openB = await postOpeningStock(ctx, owner, sourceB, { quantity: 10 });
    const openC = await postOpeningStock(ctx, owner, targetC, { quantity: 10 });
    expect(openA.status).toBe(201);
    expect(openB.status).toBe(201);
    expect(openC.status).toBe(201);

    // Move to 2026-11-24 and sign in as owner.
    ctx.clock.set("2026-11-24T10:00:00+08:00");
    const owner24 = await signIn(ctx.app, "owner1", owner.password);

    // Record a normal receipt on Filter Wash L (10 -> 15 L)
    const recvA = await postReceiving(ctx, owner24, supplyA, {
      quantity: 5,
      note: "Morning refill chemical",
      expectedRevision: openA.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "subsec-recv-a",
    });
    expect(recvA.status).toBe(201);

    // Record an earlier count at 10:00:06.900 (this must NOT qualify as a post-pending count)
    ctx.clock.set("2026-11-24T10:00:06.900+08:00");
    const earlierRec = await postReconciliation(ctx, owner24, supplyA, {
      physicalCount: 15,
      reason: "Earlier baseline count",
      expectedRevision: recvA.body.item.stockRevision,
      expectedCurrentQuantity: 15,
      requestKey: "subsec-rec-earlier",
    });
    expect(earlierRec.status).toBe(201);

    // Queue pending unclear quantity correction (5 -> 4 L) at 10:00:07.000
    ctx.clock.set("2026-11-24T10:00:07.000+08:00");
    const unclearQty = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(recvA.body.movement.id)}/correct-quantity`)
      .set("Cookie", owner24.cookie)
      .set("X-CSRF-Token", owner24.csrfToken)
      .send({
        newQuantity: 4,
        reason: "Need count check",
        coverageMode: "UNCLEAR",
        expectedCorrectionVersion: 0,
        expectedRevision: earlierRec.body.item.stockRevision,
        expectedCurrentQuantity: 15,
        expectedLatestReconciliationId: earlierRec.body.reconciliation.id,
        expectedOpeningCountCoversDate: false,
        requestKey: "subsec-unclear",
      });
    expect(unclearQty.status).toBe(200);
    expect(unclearQty.body.correction.status).toBe("PENDING_REVIEW");
    const pendingId = unclearQty.body.correction.id as string;

    // Save a genuinely later count 250ms later within the SAME display second (10:00:07.250)
    ctx.clock.advance(250);
    const sameSecRec = await postReconciliation(ctx, owner24, supplyA, {
      physicalCount: 14,
      reason: "Recount within same second",
      expectedRevision: earlierRec.body.item.stockRevision,
      expectedCurrentQuantity: 15,
      requestKey: "subsec-rec-later",
    });
    expect(sameSecRec.status).toBe(201);
    const sameSecRecId = sameSecRec.body.reconciliation.id as string;
    // Both formatted response timestamps truncate to 10:00:07+08:00
    expect(sameSecRec.body.reconciliation.recordedAt).toBe(unclearQty.body.correction.createdAt);

    // Pending reviews expose exact DB-precision qualifyingPrimaryReconciliationIds
    const pendingListRes = await request(ctx.app)
      .get("/api/inventory/pending-corrections")
      .set("Cookie", owner24.cookie);
    expect(pendingListRes.status).toBe(200);
    const reviewItem = pendingListRes.body.corrections.find((r: any) => r.correction.id === pendingId);
    expect(reviewItem.qualifyingPrimaryReconciliationIds).toContain(sameSecRecId);
    expect(reviewItem.qualifyingPrimaryReconciliationIds).not.toContain(earlierRec.body.reconciliation.id);

    // Resolving with the same-second later count succeeds (200) with 0 further stock effect
    const resolveSameSec = await request(ctx.app)
      .post(`/api/inventory/movement-corrections/${encodeURIComponent(pendingId)}/resolve`)
      .set("Cookie", owner24.cookie)
      .set("X-CSRF-Token", owner24.csrfToken)
      .send({
        expectedPrimaryRevision: sameSecRec.body.item.stockRevision,
        expectedPrimaryQuantity: 14,
        requestKey: "subsec-resolve-ok",
        coverageMode: "FULL",
        supportingReconciliationId: sameSecRecId,
        expectedLatestReconciliationId: sameSecRecId,
        expectedOpeningCountCoversDate: false,
      });
    expect(resolveSameSec.status).toBe(200);
    expect(resolveSameSec.body.correction.status).toBe("APPLIED");
    expect(resolveSameSec.body.correction.primaryAppliedDelta).toBe(0);
    expect(resolveSameSec.body.primaryItem.currentQuantity).toBe(14);

    // 2. Cancelling after a same-unit receipt switch uses target item's net delta (Finding 2 remaining)
    // Record late 5 L receipt on Source (effectiveDate 2026-11-22) where opening count covered 2 L -> Source rises 10 -> 13 L (+3 L net on Source).
    const lateSourceRecv = await postReceiving(ctx, owner24, sourceB, {
      quantity: 5,
      note: "Late drum receipt",
      effectiveDate: "2026-11-22",
      coverageMode: "PARTIAL",
      coveredQuantity: 2,
      coveredByOpeningCount: true,
      expectedLatestReconciliationId: null,
      expectedOpeningCountCoversDate: true,
      expectedRevision: openB.body.item.stockRevision,
      expectedCurrentQuantity: 10,
      requestKey: "switch-late-src",
    });
    expect(lateSourceRecv.status).toBe(201);
    expect(lateSourceRecv.body.item.currentQuantity).toBe(13);
    const switchedMovId = lateSourceRecv.body.movement.id as string;

    // Switch receipt same-unit from Source (PARTIAL 2 covered -> -3 L, 13 -> 10 L) to Target (NONE -> +5 L, 10 -> 15 L).
    const switchToTarget = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(switchedMovId)}/correct-item`)
      .set("Cookie", owner24.cookie)
      .set("X-CSRF-Token", owner24.csrfToken)
      .send({
        newItemKey: targetC,
        reason: "Receipt belonged to Target Rinsing Solution",
        expectedCorrectionVersion: 0,
        expectedPrimaryRevision: lateSourceRecv.body.item.stockRevision,
        expectedPrimaryQuantity: 13,
        expectedSecondaryRevision: openC.body.item.stockRevision,
        expectedSecondaryQuantity: 10,
        primaryCoverage: {
          coverageMode: "PARTIAL",
          coveredQuantity: 2,
          coveredByOpeningCount: true,
          expectedLatestReconciliationId: null,
          expectedOpeningCountCoversDate: true,
        },
        secondaryCoverage: {
          coverageMode: "NONE",
          expectedLatestReconciliationId: null,
          expectedOpeningCountCoversDate: true,
        },
        requestKey: "switch-src-to-target",
      });
    expect(switchToTarget.status).toBe(200);
    expect(switchToTarget.body.primaryItem.currentQuantity).toBe(10);
    expect(switchToTarget.body.secondaryItem.currentQuantity).toBe(15);
    expect(switchToTarget.body.movement.appliedNetDelta).toBe(5);

    // Target item history also reports appliedNetDelta: 5 (not Source's +3!)
    const targetHistoryBeforeCancel = await request(ctx.app)
      .get(`/api/inventory/items/${encodeURIComponent(targetC)}/history`)
      .set("Cookie", owner24.cookie);
    expect(targetHistoryBeforeCancel.status).toBe(200);
    const switchedEntry = targetHistoryBeforeCancel.body.movements.find(
      (m: any) => m.id === switchedMovId,
    );
    expect(switchedEntry.appliedNetDelta).toBe(5);

    // Cancel the switched receipt on Target with NONE -> reverses full 5 L added to Target (15 -> 10 L, NOT 12 L!)
    const cancelOnTarget = await request(ctx.app)
      .post(`/api/inventory/movements/${encodeURIComponent(switchedMovId)}/cancel`)
      .set("Cookie", owner24.cookie)
      .set("X-CSRF-Token", owner24.csrfToken)
      .send({
        reason: "Duplicate delivery slip",
        coverageMode: "NONE",
        expectedCorrectionVersion: 1,
        expectedRevision: switchToTarget.body.secondaryItem.stockRevision,
        expectedCurrentQuantity: 15,
        expectedLatestReconciliationId: null,
        expectedOpeningCountCoversDate: true,
        requestKey: "switch-cancel-target",
      });
    expect(cancelOnTarget.status).toBe(200);
    expect(cancelOnTarget.body.correction.primaryAppliedDelta).toBe(-5);
    expect(cancelOnTarget.body.primaryItem.currentQuantity).toBe(10);

    // Dashboard Stock Trend on Target remains COMPLETE with balance series [10, 15, 10]
    const targetTrend = await request(ctx.app)
      .get(`/api/dashboard/stocks/${encodeURIComponent(targetC)}/trend`)
      .set("Cookie", owner24.cookie);
    expect(targetTrend.status).toBe(200);
    expect(targetTrend.body.historyState).toBe("COMPLETE");
    expect(targetTrend.body.points.map((p: any) => p.balanceAfter)).toEqual([10, 15, 10]);
  });
});
