import { useRef } from "react";
import {
  getDisplayedQuantity,
  getVisibleQuantityError,
  handleQuantityBlur,
  handleQuantityEnter,
  handleQuantityEscape,
  handleQuantityTextChange,
  MAX_LINE_QTY,
  type QuantityEditState,
} from "./quantityInput";

export interface QuantityStepperProps {
  value: number;
  edit: QuantityEditState | null | undefined;
  onEditChange: (nextEdit: QuantityEditState | null) => void;
  onCommitValidValue: (nextQty: number) => boolean | void;
  onStep: (delta: -1 | 1) => void;
  groupLabel: string;
  inputLabel: string;
  decreaseLabel: string;
  increaseLabel: string;
  disabled?: boolean;
  decreaseDisabled?: boolean;
  increaseDisabled?: boolean;
  allowRestingZero?: boolean;
  max?: number;
  overMaxMessage?: string;
  errorId?: string;
  inputRef?: (el: HTMLInputElement | null) => void;
}

export function QuantityStepper({
  value,
  edit,
  onEditChange,
  onCommitValidValue,
  onStep,
  groupLabel,
  inputLabel,
  decreaseLabel,
  increaseLabel,
  disabled = false,
  decreaseDisabled = false,
  increaseDisabled = false,
  allowRestingZero = false,
  max = MAX_LINE_QTY,
  overMaxMessage,
  errorId,
  inputRef,
}: QuantityStepperProps) {
  const localInputRef = useRef<HTMLInputElement | null>(null);
  const pointerDownBeforeFocusRef = useRef(false);
  const suppressBlurRef = useRef(false);

  const displayed = getDisplayedQuantity(value, edit);
  const visibleError = getVisibleQuantityError(edit);

  function setInputNode(el: HTMLInputElement | null) {
    localInputRef.current = el;
    inputRef?.(el);
  }

  function applyTextChange(raw: string) {
    const { edit: nextEdit, validValue } = handleQuantityTextChange(raw, max, overMaxMessage);
    if (validValue !== null) {
      const committed = onCommitValidValue(validValue);
      if (committed === false) {
        onEditChange(null);
        return;
      }
    }
    onEditChange(nextEdit);
  }

  function blurInputWithoutReapplyingEdit(inputEl: HTMLInputElement) {
    suppressBlurRef.current = true;
    inputEl.blur();
    suppressBlurRef.current = false;
  }

  function handleStepClick(delta: -1 | 1) {
    onStep(delta);
    if (localInputRef.current && document.activeElement === localInputRef.current) {
      blurInputWithoutReapplyingEdit(localInputRef.current);
    }
  }

  const stepperClasses = [
    "qty-stepper",
    visibleError ? "qty-stepper--invalid" : "",
    disabled ? "qty-stepper--disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={stepperClasses} role="group" aria-label={groupLabel}>
      <button
        type="button"
        className="qty-stepper__btn"
        aria-label={decreaseLabel}
        disabled={disabled || decreaseDisabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => handleStepClick(-1)}
      >
        −
      </button>
      <input
        ref={setInputNode}
        type="text"
        inputMode="numeric"
        enterKeyHint="done"
        autoComplete="off"
        spellCheck={false}
        className="qty-stepper__value"
        aria-label={inputLabel}
        aria-invalid={visibleError ? true : undefined}
        aria-describedby={visibleError && errorId ? errorId : undefined}
        disabled={disabled}
        value={displayed}
        onPointerDown={(event) => {
          pointerDownBeforeFocusRef.current = document.activeElement !== event.currentTarget;
        }}
        onPointerCancel={() => {
          pointerDownBeforeFocusRef.current = false;
        }}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        onMouseUp={(event) => {
          if (pointerDownBeforeFocusRef.current) {
            event.preventDefault();
            pointerDownBeforeFocusRef.current = false;
          }
        }}
        onInput={(event) => {
          // React suppresses onChange when DOM text remains "0" on an unselected card;
          // catch explicit "0" typing/pasting via onInput while leaving focus/Tab untouched.
          if (!edit && allowRestingZero && value === 0 && event.currentTarget.value === "0") {
            applyTextChange("0");
          }
        }}
        onChange={(event) => {
          applyTextChange(event.target.value);
        }}
        onBlur={() => {
          pointerDownBeforeFocusRef.current = false;
          if (suppressBlurRef.current) {
            suppressBlurRef.current = false;
            return;
          }
          onEditChange(handleQuantityBlur(edit));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (edit?.pendingCommitValue != null) {
              const committed = onCommitValidValue(edit.pendingCommitValue);
              if (committed === false) {
                onEditChange(null);
                return;
              }
              onEditChange(null);
              blurInputWithoutReapplyingEdit(event.currentTarget);
              return;
            }
            const { nextEdit, shouldBlur } = handleQuantityEnter(edit);
            onEditChange(nextEdit);
            if (shouldBlur) {
              blurInputWithoutReapplyingEdit(event.currentTarget);
            }
            return;
          }
          if (event.key === "Escape") {
            const { nextEdit, handled } = handleQuantityEscape(edit);
            if (handled) {
              event.preventDefault();
              event.stopPropagation();
              onEditChange(nextEdit);
            }
          }
        }}
      />
      <button
        type="button"
        className="qty-stepper__btn"
        aria-label={increaseLabel}
        disabled={disabled || increaseDisabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => handleStepClick(1)}
      >
        +
      </button>
    </div>
  );
}
