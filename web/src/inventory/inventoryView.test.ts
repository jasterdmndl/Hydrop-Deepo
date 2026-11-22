import { describe, expect, it } from "vitest";
import {
  formatAlreadySetNotice,
  formatQuantityLabel,
  formatRecordedAtManila,
  type InventoryItemView,
  MAX_OPENING_QUANTITY,
  parseOpeningQuantityInput,
} from "./inventoryView";

describe("inventoryView helpers", () => {
  it("parses explicit zero and positive whole container quantities while rejecting invalid inputs", () => {
    expect(parseOpeningQuantityInput("0")).toEqual({ ok: true, quantity: 0 });
    expect(parseOpeningQuantityInput(" 00 ")).toEqual({ ok: true, quantity: 0 });
    expect(parseOpeningQuantityInput("24")).toEqual({ ok: true, quantity: 24 });
    expect(parseOpeningQuantityInput(String(MAX_OPENING_QUANTITY))).toEqual({
      ok: true,
      quantity: MAX_OPENING_QUANTITY,
    });

    expect(parseOpeningQuantityInput("")).toEqual({
      ok: false,
      message: "Enter the actual container count (0 or more).",
    });
    expect(parseOpeningQuantityInput("   ")).toEqual({
      ok: false,
      message: "Enter the actual container count (0 or more).",
    });
    expect(parseOpeningQuantityInput("-1").ok).toBe(false);
    expect(parseOpeningQuantityInput("1.5").ok).toBe(false);
    expect(parseOpeningQuantityInput("12 containers").ok).toBe(false);
    expect(parseOpeningQuantityInput(String(MAX_OPENING_QUANTITY + 1)).ok).toBe(false);
  });

  it("formats Not Set separately from explicit zero and pluralizes containers", () => {
    expect(formatQuantityLabel(null, "containers")).toBe("Not Set");
    expect(formatQuantityLabel(0, "containers")).toBe("0 containers");
    expect(formatQuantityLabel(1, "containers")).toBe("1 container");
    expect(formatQuantityLabel(18, "containers")).toBe("18 containers");
  });

  it("formats timestamps in Asia/Manila regardless of local system timezone", () => {
    expect(formatRecordedAtManila("2026-11-22T09:05:00+08:00")).toBe("Nov 22, 2026 · 9:05 AM");
    expect(formatRecordedAtManila("2026-11-22T16:30:00.000Z")).toBe("Nov 23, 2026 · 12:30 AM");
    expect(formatRecordedAtManila("not-a-timestamp")).toBe("not-a-timestamp");
  });

  it("formats conflict notices with rejected quantity, saved balance, and fallback", () => {
    const slimInitialized: InventoryItemView = {
      code: "SLIM",
      name: "Slim Container",
      category: "CONTAINER",
      shape: "SLIM",
      unit: "containers",
      status: "INITIALIZED",
      currentQuantity: 14,
      openingStock: {
        quantity: 14,
        unit: "containers",
        recordedBy: "owner_a",
        recordedAt: "2026-11-22T14:30:00+08:00",
      },
    };
    expect(
      formatAlreadySetNotice(
        "Slim Container",
        22,
        "containers",
        slimInitialized,
        "Opening stock for Slim Container is already set.",
      ),
    ).toBe(
      "Your entry of 22 containers was not saved. Opening stock for Slim Container is already set to 14 containers (recorded by owner_a).",
    );

    const roundZero: InventoryItemView = {
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
        recordedBy: "owner_a",
        recordedAt: "2026-11-22T14:30:00+08:00",
      },
    };
    expect(
      formatAlreadySetNotice(
        "Round Container",
        1,
        "containers",
        roundZero,
        "Opening stock for Round Container is already set.",
      ),
    ).toBe(
      "Your entry of 1 container was not saved. Opening stock for Round Container is already set to 0 containers (recorded by owner_a).",
    );

    expect(
      formatAlreadySetNotice(
        "Slim Container",
        22,
        "containers",
        null,
        "Opening stock for Slim Container is already set.",
      ),
    ).toBe("Opening stock for Slim Container is already set.");
  });
});
