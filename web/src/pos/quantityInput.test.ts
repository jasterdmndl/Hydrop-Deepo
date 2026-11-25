import { describe, expect, it } from "vitest";
import {
  canApplyContainerPackageQuantity,
  getContainerPackageOtherQuantity,
  getContainerPackageOverMaxMessage,
  getContainerPackageRowMax,
  getDisplayedQuantity,
  getVisibleQuantityError,
  handleQuantityBlur,
  handleQuantityEnter,
  handleQuantityEscape,
  handleQuantityTextChange,
  hasInvalidQuantityEdits,
  isQuantityEditInvalid,
  MAX_LINE_QTY,
  parseQuantityInput,
  QUANTITY_ERROR_MESSAGE,
  type QuantityEditState,
  revealInvalidQuantityEdit,
  revealInvalidQuantityEdits,
  syncContainerPackageQuantityEdit,
} from "./quantityInput";

describe("parseQuantityInput", () => {
  it("accepts whole numbers from 1 to 500 including leading zeros and surrounding whitespace", () => {
    expect(parseQuantityInput("1")).toEqual({ valid: true, value: 1 });
    expect(parseQuantityInput("12")).toEqual({ valid: true, value: 12 });
    expect(parseQuantityInput("500")).toEqual({ valid: true, value: 500 });
    expect(parseQuantityInput("012")).toEqual({ valid: true, value: 12 });
    expect(parseQuantityInput(" 5 ")).toEqual({ valid: true, value: 5 });
    expect(MAX_LINE_QTY).toBe(500);
  });

  it("rejects blank, zero, negative, decimal, over-limit, and malformed inputs", () => {
    const invalidInputs = [
      "",
      "   ",
      "0",
      "00",
      "-1",
      "2.5",
      "501",
      "99999999999999999999",
      "abc",
      "12abc",
      "1,2",
      "1 2",
      "+5",
    ];
    for (const raw of invalidInputs) {
      expect(parseQuantityInput(raw)).toEqual({
        valid: false,
        message: QUANTITY_ERROR_MESSAGE,
      });
    }
  });
});

describe("quantity edit state transitions", () => {
  it("tracks valid and invalid drafts while keeping errors hidden until blur, Enter, or submit", () => {
    const blank = handleQuantityTextChange("");
    expect(blank).toEqual({
      edit: {
        draft: "",
        invalid: true,
        errorMessage: QUANTITY_ERROR_MESSAGE,
        showError: false,
      },
      validValue: null,
    });
    expect(getDisplayedQuantity(3, blank.edit)).toBe("");
    expect(isQuantityEditInvalid(blank.edit)).toBe(true);
    expect(getVisibleQuantityError(blank.edit)).toBeNull();

    const afterBlur = handleQuantityBlur(blank.edit);
    expect(afterBlur).toEqual({
      draft: "",
      invalid: true,
      errorMessage: QUANTITY_ERROR_MESSAGE,
      showError: true,
    });
    expect(getVisibleQuantityError(afterBlur)).toBe(QUANTITY_ERROR_MESSAGE);

    const corrected = handleQuantityTextChange("012");
    expect(corrected).toEqual({
      edit: {
        draft: "012",
        invalid: false,
        errorMessage: null,
        showError: false,
      },
      validValue: 12,
    });
    expect(getDisplayedQuantity(12, corrected.edit)).toBe("012");
    expect(isQuantityEditInvalid(corrected.edit)).toBe(false);
    expect(getVisibleQuantityError(corrected.edit)).toBeNull();

    // Blur clears valid draft so normalized "12" displays from committed value.
    expect(handleQuantityBlur(corrected.edit)).toBeNull();
    expect(getDisplayedQuantity(12, null)).toBe("12");
  });

  it("preserves untouched resting zero without error on blur or Enter", () => {
    expect(getDisplayedQuantity(0, null)).toBe("0");
    expect(handleQuantityBlur(null)).toBeNull();
    expect(handleQuantityBlur(undefined)).toBeNull();
    expect(handleQuantityEnter(null)).toEqual({ nextEdit: null, shouldBlur: true });
  });

  it("handles Enter and Escape appropriately for valid, unnormalized, and invalid drafts", () => {
    const valid = handleQuantityTextChange("12").edit;
    expect(handleQuantityEnter(valid)).toEqual({ nextEdit: null, shouldBlur: true });
    expect(handleQuantityEscape(valid)).toEqual({ nextEdit: null, handled: true });

    const padded = handleQuantityTextChange("012").edit;
    expect(handleQuantityEscape(padded)).toEqual({ nextEdit: null, handled: true });

    const invalid = handleQuantityTextChange("501").edit;
    expect(handleQuantityEnter(invalid)).toEqual({
      nextEdit: { ...invalid, showError: true },
      shouldBlur: false,
    });
    expect(handleQuantityEscape(invalid)).toEqual({ nextEdit: null, handled: true });
    expect(handleQuantityEscape(null)).toEqual({ nextEdit: null, handled: false });
    expect(handleQuantityEscape(undefined)).toEqual({ nextEdit: null, handled: false });
  });

  it("detects and reveals invalid fields across multiple lines", () => {
    const validEdit: QuantityEditState = {
      draft: "12",
      invalid: false,
      errorMessage: null,
      showError: false,
    };
    const hiddenInvalid: QuantityEditState = {
      draft: "abc",
      invalid: true,
      errorMessage: QUANTITY_ERROR_MESSAGE,
      showError: false,
    };
    const shownInvalid: QuantityEditState = {
      draft: "0",
      invalid: true,
      errorMessage: QUANTITY_ERROR_MESSAGE,
      showError: true,
    };

    expect(hasInvalidQuantityEdits({ "std-PURIFIED": validEdit })).toBe(false);
    expect(
      hasInvalidQuantityEdits({
        "std-PURIFIED": validEdit,
        "std-ALKALINE": hiddenInvalid,
      }),
    ).toBe(true);

    const revealed = revealInvalidQuantityEdits({
      "std-PURIFIED": validEdit,
      "std-ALKALINE": hiddenInvalid,
      "custom-1": shownInvalid,
    });
    expect(revealed.invalidIds).toEqual(["std-ALKALINE", "custom-1"]);
    expect(revealed.nextEdits["std-ALKALINE"]?.showError).toBe(true);
    expect(revealed.nextEdits["std-PURIFIED"]).toEqual(validEdit);

    expect(revealInvalidQuantityEdit(hiddenInvalid)).toEqual({
      ...hiddenInvalid,
      showError: true,
    });
    expect(revealInvalidQuantityEdit(validEdit)).toEqual(validEdit);
    expect(revealInvalidQuantityEdit(null)).toBeNull();
  });
});

describe("container package shared quantity helpers", () => {
  it("uses overMaxMessage only for positive whole numbers above max", () => {
    const overMaxMsg = "Only 8 available for this option.";
    expect(parseQuantityInput("8", 8, overMaxMsg)).toEqual({ valid: true, value: 8 });
    expect(parseQuantityInput("9", 8, overMaxMsg)).toEqual({
      valid: false,
      message: overMaxMsg,
    });
    expect(parseQuantityInput("99999999999999999999", 8, overMaxMsg)).toEqual({
      valid: false,
      message: overMaxMsg,
    });

    for (const nonPositiveOrMalformed of ["", "0", "00", "-1", "2.5", "abc"]) {
      expect(parseQuantityInput(nonPositiveOrMalformed, 8, overMaxMsg)).toEqual({
        valid: false,
        message: "Enter a whole number from 1 to 8.",
      });
    }

    const change = handleQuantityTextChange("9", 8, overMaxMsg);
    expect(change).toEqual({
      edit: {
        draft: "9",
        invalid: true,
        errorMessage: overMaxMsg,
        showError: false,
      },
      validValue: null,
    });
  });

  it("computes shared container limits across fill and gripo lines while ignoring other shapes and refills", () => {
    const lines = [
      { id: "std-PURIFIED", kind: "STANDARD", quantity: 4 },
      { id: "pkg-ROUND_ALKALINE-PUSH_TYPE", kind: "CONTAINER_PACKAGE", productId: "round-1", quantity: 2 },
      { id: "pkg-ROUND_ALKALINE-TWIST_TYPE", kind: "CONTAINER_PACKAGE", productId: "round-1", quantity: 1 },
      { id: "pkg-ROUND_EMPTY-PUSH_TYPE", kind: "CONTAINER_PACKAGE", productId: "round-1", quantity: 3 },
      { id: "pkg-SLIM_EMPTY-PUSH_TYPE", kind: "CONTAINER_PACKAGE", productId: "slim-1", quantity: 5 },
    ];

    expect(
      getContainerPackageOtherQuantity(lines, "round-1", "pkg-ROUND_ALKALINE-TWIST_TYPE"),
    ).toBe(5);
    expect(
      getContainerPackageRowMax(lines, "round-1", "pkg-ROUND_ALKALINE-TWIST_TYPE", 10),
    ).toBe(5);
    expect(
      getContainerPackageRowMax(lines, "round-1", "pkg-ROUND_PURIFIED-PUSH_TYPE", 10),
    ).toBe(4);
    expect(
      getContainerPackageRowMax(lines, "round-1", "pkg-ROUND_PURIFIED-PUSH_TYPE", 4),
    ).toBe(0);
    expect(
      getContainerPackageRowMax(lines, "round-1", "pkg-ROUND_PURIFIED-PUSH_TYPE", null),
    ).toBe(0);
    expect(
      getContainerPackageRowMax([], "round-1", "pkg-ROUND_PURIFIED-PUSH_TYPE", 750),
    ).toBe(MAX_LINE_QTY);
  });

  it("formats stock-specific over-max messages and allows stale-cart reductions without allowing increases", () => {
    expect(getContainerPackageOverMaxMessage(0, null)).toBe(
      "Opening stock is not set for this option.",
    );
    expect(getContainerPackageOverMaxMessage(0, 0)).toBe(
      "No remaining stock available for this option.",
    );
    expect(getContainerPackageOverMaxMessage(8, 10)).toBe("Only 8 available for this option.");
    expect(getContainerPackageOverMaxMessage(MAX_LINE_QTY, 600)).toBeUndefined();

    // Normal in-stock row
    expect(canApplyContainerPackageQuantity(1, 8, 8)).toBe(true);
    expect(canApplyContainerPackageQuantity(1, 9, 8)).toBe(false);

    // Stale cart after stock dropped below currentQty (current=6, rowMax=4)
    expect(canApplyContainerPackageQuantity(6, 5, 4)).toBe(true);
    expect(canApplyContainerPackageQuantity(6, 4, 4)).toBe(true);
    expect(canApplyContainerPackageQuantity(6, 0, 4)).toBe(true);
    expect(canApplyContainerPackageQuantity(6, 7, 4)).toBe(false);
  });

  it("keeps pending over-limit drafts visible for explicit confirmation when stock frees up and clears unreachable disabled rows", () => {
    const rejectedNine: QuantityEditState = {
      draft: "9",
      invalid: true,
      errorMessage: "Only 8 available for this option.",
      showError: true,
    };

    // Freeing stock from 8 -> 9 marks the draft as pending confirmation instead of discarding it.
    const nowFits = syncContainerPackageQuantityEdit(rejectedNine, 1, 9, 10, true);
    expect(nowFits).toEqual({
      draft: "9",
      invalid: true,
      errorMessage: "9 now fits. Apply 9 or keep 1.",
      showError: true,
      pendingCommitValue: 9,
    });

    // Idempotent when called again with unchanged availability.
    expect(syncContainerPackageQuantityEdit(nowFits!, 1, 9, 10, true)).toBe(nowFits);

    // If stock tightens back to 8, pending confirmation clears and reverts to stock-limit message.
    const tightAgain = syncContainerPackageQuantityEdit(nowFits!, 1, 8, 10, true);
    expect(tightAgain).toEqual({
      draft: "9",
      invalid: true,
      errorMessage: "Only 8 available for this option.",
      showError: true,
      pendingCommitValue: null,
    });

    // A fully unavailable unselected row clears its edit so it cannot block checkout.
    expect(syncContainerPackageQuantityEdit(rejectedNine, 0, 0, 10, true)).toBeNull();
  });
});
