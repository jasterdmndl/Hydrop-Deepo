/** Pure validation and edit-state helpers for editable POS refill quantity steppers. */

export const MIN_LINE_QTY = 1;
export const MAX_LINE_QTY = 500;
export const QUANTITY_ERROR_MESSAGE = `Enter a whole number from ${MIN_LINE_QTY} to ${MAX_LINE_QTY}.`;

export type QuantityParseResult =
  | { valid: true; value: number }
  | { valid: false; message: string };

export interface QuantityEditState {
  draft: string;
  invalid: boolean;
  errorMessage: string | null;
  showError: boolean;
}

function quantityRangeMessage(max: number): string {
  return max === MAX_LINE_QTY
    ? QUANTITY_ERROR_MESSAGE
    : `Enter a whole number from ${MIN_LINE_QTY} to ${max}.`;
}

export function parseQuantityInput(
  raw: string,
  max: number = MAX_LINE_QTY,
): QuantityParseResult {
  const cleaned = raw.trim();
  const message = quantityRangeMessage(max);
  if (!cleaned || !/^\d+$/.test(cleaned)) {
    return { valid: false, message };
  }
  const parsed = Number(cleaned);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_LINE_QTY || parsed > max) {
    return { valid: false, message };
  }
  return { valid: true, value: parsed };
}

export function getDisplayedQuantity(
  committedValue: number,
  edit: QuantityEditState | null | undefined,
): string {
  return edit ? edit.draft : String(committedValue);
}

export function isQuantityEditInvalid(
  edit: QuantityEditState | null | undefined,
): boolean {
  return Boolean(edit?.invalid);
}

export function getVisibleQuantityError(
  edit: QuantityEditState | null | undefined,
): string | null {
  return edit && edit.invalid && edit.showError ? edit.errorMessage : null;
}

export function handleQuantityTextChange(
  raw: string,
  max: number = MAX_LINE_QTY,
): { edit: QuantityEditState; validValue: number | null } {
  const parsed = parseQuantityInput(raw, max);
  if (parsed.valid) {
    return {
      edit: {
        draft: raw,
        invalid: false,
        errorMessage: null,
        showError: false,
      },
      validValue: parsed.value,
    };
  }
  return {
    edit: {
      draft: raw,
      invalid: true,
      errorMessage: parsed.message,
      showError: false,
    },
    validValue: null,
  };
}

export function handleQuantityBlur(
  edit: QuantityEditState | null | undefined,
): QuantityEditState | null {
  if (!edit) return null;
  if (!edit.invalid) return null;
  return edit.showError ? edit : { ...edit, showError: true };
}

export function handleQuantityEnter(
  edit: QuantityEditState | null | undefined,
): { nextEdit: QuantityEditState | null; shouldBlur: boolean } {
  if (!edit || !edit.invalid) {
    return { nextEdit: null, shouldBlur: true };
  }
  return {
    nextEdit: edit.showError ? edit : { ...edit, showError: true },
    shouldBlur: false,
  };
}

export function handleQuantityEscape(
  edit: QuantityEditState | null | undefined,
): { nextEdit: null; handled: boolean } {
  return { nextEdit: null, handled: edit != null };
}

export function hasInvalidQuantityEdits(
  edits: Record<string, QuantityEditState>,
): boolean {
  return Object.values(edits).some((edit) => edit.invalid);
}

export function revealInvalidQuantityEdits(
  edits: Record<string, QuantityEditState>,
): { nextEdits: Record<string, QuantityEditState>; invalidIds: string[] } {
  const invalidIds: string[] = [];
  let changed = false;
  const nextEdits: Record<string, QuantityEditState> = {};

  for (const [id, edit] of Object.entries(edits)) {
    if (edit.invalid) {
      invalidIds.push(id);
      if (!edit.showError) {
        changed = true;
        nextEdits[id] = { ...edit, showError: true };
      } else {
        nextEdits[id] = edit;
      }
    } else {
      nextEdits[id] = edit;
    }
  }

  return {
    nextEdits: changed ? nextEdits : edits,
    invalidIds,
  };
}

export function revealInvalidQuantityEdit(
  edit: QuantityEditState | null,
): QuantityEditState | null {
  if (!edit || !edit.invalid) return edit;
  return edit.showError ? edit : { ...edit, showError: true };
}
