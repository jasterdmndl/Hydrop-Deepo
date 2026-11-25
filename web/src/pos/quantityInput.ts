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
  pendingCommitValue?: number | null;
}

function quantityRangeMessage(max: number): string {
  return max === MAX_LINE_QTY
    ? QUANTITY_ERROR_MESSAGE
    : `Enter a whole number from ${MIN_LINE_QTY} to ${max}.`;
}

export function parseQuantityInput(
  raw: string,
  max: number = MAX_LINE_QTY,
  overMaxMessage?: string,
): QuantityParseResult {
  const cleaned = raw.trim();
  const message = quantityRangeMessage(max);
  if (!cleaned || !/^\d+$/.test(cleaned) || /^0+$/.test(cleaned)) {
    return { valid: false, message };
  }
  const parsed = Number(cleaned);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    return { valid: false, message: overMaxMessage ?? message };
  }
  if (parsed < MIN_LINE_QTY) {
    return { valid: false, message };
  }
  return { valid: true, value: parsed };
}

export interface ContainerPackageQuantityLine {
  id: string;
  kind: string;
  productId?: string;
  quantity: number;
}

export function getContainerPackageOtherQuantity(
  lines: readonly ContainerPackageQuantityLine[],
  productId: string,
  rowId: string,
): number {
  let otherQty = 0;
  for (const line of lines) {
    if (line.kind === "CONTAINER_PACKAGE" && line.productId === productId && line.id !== rowId) {
      otherQty += line.quantity;
    }
  }
  return otherQty;
}

export function getContainerPackageRowMax(
  lines: readonly ContainerPackageQuantityLine[],
  productId: string,
  rowId: string,
  availableQuantity: number | null,
  maxLineQty: number = MAX_LINE_QTY,
): number {
  if (availableQuantity === null) return 0;
  const otherQty = getContainerPackageOtherQuantity(lines, productId, rowId);
  return Math.max(0, Math.min(maxLineQty, availableQuantity - otherQty));
}

export function getContainerPackageOverMaxMessage(
  rowMax: number,
  availableQuantity: number | null,
  maxLineQty: number = MAX_LINE_QTY,
): string | undefined {
  if (availableQuantity === null) {
    return "Opening stock is not set for this option.";
  }
  if (rowMax <= 0) {
    return "No remaining stock available for this option.";
  }
  if (rowMax < maxLineQty) {
    return `Only ${rowMax} available for this option.`;
  }
  return undefined;
}

export function canApplyContainerPackageQuantity(
  currentQty: number,
  nextQty: number,
  rowMax: number,
): boolean {
  if (!Number.isInteger(nextQty) || nextQty < 0) {
    return false;
  }
  return nextQty <= currentQty || nextQty <= rowMax;
}

export function syncContainerPackageQuantityEdit(
  edit: QuantityEditState,
  currentQty: number,
  rowMax: number,
  availableQuantity: number | null,
  isInStock: boolean,
  maxLineQty: number = MAX_LINE_QTY,
): QuantityEditState | null {
  if (currentQty === 0 && (!isInStock || rowMax <= 0)) {
    return null;
  }
  if (!edit.invalid) {
    return edit;
  }
  const effectiveMax = Math.max(rowMax, currentQty);
  const overMaxMessage = getContainerPackageOverMaxMessage(
    rowMax,
    availableQuantity,
    maxLineQty,
  );
  const recheck = parseQuantityInput(edit.draft, effectiveMax, overMaxMessage);
  if (recheck.valid) {
    const nextMessage = `${recheck.value} now fits. Apply ${recheck.value} or keep ${currentQty}.`;
    if (
      edit.showError &&
      edit.pendingCommitValue === recheck.value &&
      edit.errorMessage === nextMessage
    ) {
      return edit;
    }
    return {
      ...edit,
      showError: true,
      pendingCommitValue: recheck.value,
      errorMessage: nextMessage,
    };
  }
  if (!edit.pendingCommitValue && edit.errorMessage === recheck.message) {
    return edit;
  }
  return {
    ...edit,
    pendingCommitValue: null,
    errorMessage: recheck.message,
  };
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
  overMaxMessage?: string,
): { edit: QuantityEditState; validValue: number | null } {
  const parsed = parseQuantityInput(raw, max, overMaxMessage);
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
