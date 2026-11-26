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

describe("Inventory Round/Slim opening stock and merchandise products (DEC-065, DEC-068, DEC-069)", () => {
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
