import {
  type AggregatedCheckoutHoldProduct,
  evaluateHoldDisposition,
  type HoldDraftState,
} from "./checkoutResolution";

export interface FilledHoldDispositionEditorProps {
  idPrefix: string;
  products: readonly AggregatedCheckoutHoldProduct[];
  drafts: Readonly<Record<string, HoldDraftState>>;
  verified: boolean;
  disabled?: boolean;
  onChangeDrafts: (next: Record<string, HoldDraftState>) => void;
  onChangeVerified: (verified: boolean) => void;
}

export function FilledHoldDispositionEditor({
  idPrefix,
  products,
  drafts,
  verified,
  disabled = false,
  onChangeDrafts,
  onChangeVerified,
}: FilledHoldDispositionEditorProps) {
  const filledProducts = products.filter((p) => p.filledQuantity > 0);
  if (filledProducts.length === 0) return null;

  const evaluation = evaluateHoldDisposition(products, drafts, verified);

  function updateDraft(productId: string, patch: Partial<HoldDraftState>) {
    const current = drafts[productId] ?? {
      enabled: false,
      quantityInput: "1",
      reason: "Cancelled filled container order held from ready-to-sell stock (INV-015)",
    };
    onChangeDrafts({
      ...drafts,
      [productId]: {
        ...current,
        ...patch,
      },
    });
    onChangeVerified(false);
  }

  return (
    <div className="recovery-unpaid-hold">
      <p className="field__hint">
        Record exact affected units for each filled container product. Uncheck or adjust the count
        if fewer units were actually filled.
      </p>
      {filledProducts.map((prod) => {
        const draft = drafts[prod.productId] ?? {
          enabled: true,
          quantityInput: String(prod.filledQuantity),
          reason: "Cancelled filled container order held from ready-to-sell stock (INV-015)",
        };
        const qtyInputId = `${idPrefix}-qty-${prod.productId}`;
        const reasonInputId = `${idPrefix}-reason-${prod.productId}`;
        return (
          <div key={prod.productId} className="hold-product-row">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={disabled}
                onChange={(event) => updateDraft(prod.productId, { enabled: event.target.checked })}
              />
              <span>
                Hold {prod.label} ({prod.filledQuantity} filled ordered
                {prod.emptyOrMerchQuantity > 0
                  ? `, ${prod.emptyOrMerchQuantity} empty/other excluded by default`
                  : ""}
                )
              </span>
            </label>
            {draft.enabled && (
              <div className="hold-product-row__inputs">
                <label className="field" htmlFor={qtyInputId}>
                  <span className="field__label">Affected units to hold ({prod.unit})</span>
                  <input
                    id={qtyInputId}
                    type="number"
                    min={1}
                    max={prod.orderedQuantity}
                    step={1}
                    className="input"
                    value={draft.quantityInput}
                    disabled={disabled}
                    onChange={(event) =>
                      updateDraft(prod.productId, { quantityInput: event.target.value })
                    }
                  />
                </label>
                <label className="field" htmlFor={reasonInputId}>
                  <span className="field__label">Hold reason</span>
                  <input
                    id={reasonInputId}
                    type="text"
                    maxLength={240}
                    className="input"
                    value={draft.reason}
                    disabled={disabled}
                    onChange={(event) =>
                      updateDraft(prod.productId, { reason: event.target.value })
                    }
                  />
                </label>
              </div>
            )}
          </div>
        );
      })}
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={verified}
          disabled={disabled}
          onChange={(event) => onChangeVerified(event.target.checked)}
        />
        <span>
          {evaluation.needsNoFilledConfirmed
            ? "Confirm the held quantity above matches affected filled units and all remaining filled units were never filled"
            : "Confirm the held quantity above matches the affected filled containers"}
        </span>
      </label>
    </div>
  );
}
