import { describe, expect, it } from "vitest";
import {
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
