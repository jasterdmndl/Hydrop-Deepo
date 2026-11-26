import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { type NoticeEnvelope, wrapNotice } from "../notifications/noticeTiming";
import { TemporaryNotice } from "../notifications/TemporaryNotice";
import {
  aggregateCheckoutProductsForHold,
  buildInitialHoldDrafts,
  computeRefundSummary,
  evaluateHoldDisposition,
  type HoldDraftState,
  isRefundConfirmationValid,
} from "./checkoutResolution";
import {
  type CheckoutResolutionView,
  type CheckoutView,
  formatCentavos,
  formatLiters,
  parsePesoInputToCentavos,
  type PriorDaySettlementView,
  type ResolveCheckoutResponse,
  type SaleView,
} from "./posRecovery";

export interface CheckoutResolutionModalProps {
  checkout: CheckoutView;
  mode: "NO_CASH_CANCELLED" | "FULL_REFUND";
  todayDate: string;
  localCashReceivedCentavos?: number | null;
  onClose(): void;
  onResolved(resolution: CheckoutResolutionView, checkout: CheckoutView): void;
  onAlreadySaved(reference: string, sale: SaleView): void;
  onAlreadySettled(reference: string, settlement: PriorDaySettlementView): void;
}

export function CheckoutResolutionModal({
  checkout,
  mode,
  todayDate,
  localCashReceivedCentavos,
  onClose,
  onResolved,
  onAlreadySaved,
  onAlreadySettled,
}: CheckoutResolutionModalProps) {
  const serverCash = checkout.cashReceivedCentavos;
  const initialCash = serverCash ?? localCashReceivedCentavos ?? null;
  const [cashInput, setCashInput] = useState(
    initialCash !== null ? (initialCash / 100).toFixed(2) : "",
  );
  const [changeAlreadyGiven, setChangeAlreadyGiven] = useState<boolean>(false);
  const [noCashReceivedConfirmed, setNoCashReceivedConfirmed] = useState(false);
  const [undeliveredConfirmed, setUndeliveredConfirmed] = useState(false);
  const [confirmedRefundSignature, setConfirmedRefundSignature] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<NoticeEnvelope<string> | null>(null);

  const checkoutProducts = useMemo(
    () => aggregateCheckoutProductsForHold(checkout.items),
    [checkout.items],
  );
  const [holdDrafts, setHoldDrafts] = useState<Record<string, HoldDraftState>>(() =>
    buildInitialHoldDrafts(aggregateCheckoutProductsForHold(checkout.items)),
  );
  const [holdDispositionVerified, setHoldDispositionVerified] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || submitting) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  const effectiveCashCentavos =
    serverCash !== null ? serverCash : parsePesoInputToCentavos(cashInput);

  const refundSummary = useMemo(
    () => computeRefundSummary(checkout.totalCentavos, effectiveCashCentavos, changeAlreadyGiven),
    [checkout.totalCentavos, effectiveCashCentavos, changeAlreadyGiven],
  );

  const refundConfirmed = isRefundConfirmationValid(
    confirmedRefundSignature,
    refundSummary.confirmationSignature,
  );

  const holdEvaluation = useMemo(
    () => evaluateHoldDisposition(checkoutProducts, holdDrafts, holdDispositionVerified),
    [checkoutProducts, holdDrafts, holdDispositionVerified],
  );

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (!holdEvaluation.valid) {
      setError(
        wrapNotice(
          holdEvaluation.errorMessage ?? "Verify held / affected unit quantities before submitting.",
        ),
      );
      return;
    }

    if (mode === "NO_CASH_CANCELLED") {
      if (!noCashReceivedConfirmed) return;
      setSubmitting(true);
      try {
        const res = await api<ResolveCheckoutResponse>(
          `/api/pos/checkouts/${encodeURIComponent(checkout.reference)}/resolve`,
          {
            method: "POST",
            body: {
              outcome: "NO_CASH_CANCELLED",
              noCashReceivedConfirmed: true,
              ...(holdEvaluation.needsNoFilledConfirmed
                ? { noFilledUnitsHeldConfirmed: true }
                : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
              ...(holdEvaluation.heldItems.length > 0
                ? { heldItems: holdEvaluation.heldItems }
                : {}),
            },
          },
        );
        onResolved(res.resolution, res.checkout);
      } catch (err) {
        if (handleConflictOutcome(err)) return;
        setError(
          wrapNotice(
            err instanceof ApiError
              ? err.message
              : "Could not cancel the prior-day checkout. Keep it pending and check status.",
          ),
        );
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!undeliveredConfirmed || !refundConfirmed) return;
    if (!refundSummary.valid || effectiveCashCentavos === null || refundSummary.refundCentavos === null) {
      setError(wrapNotice(refundSummary.validationMessage ?? "Enter valid cash refund details."));
      return;
    }

    setSubmitting(true);
    try {
      const res = await api<ResolveCheckoutResponse>(
        `/api/pos/checkouts/${encodeURIComponent(checkout.reference)}/resolve`,
        {
          method: "POST",
          body: {
            outcome: "FULL_REFUND",
            undeliveredConfirmed: true,
            fullRefundConfirmed: true,
            ...(holdEvaluation.needsNoFilledConfirmed
              ? { noFilledUnitsHeldConfirmed: true }
              : {}),
            ...(serverCash === null ? { cashReceivedCentavos: effectiveCashCentavos } : {}),
            changeAlreadyGiven,
            refundedAmountCentavos: refundSummary.refundCentavos,
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(holdEvaluation.heldItems.length > 0
              ? { heldItems: holdEvaluation.heldItems }
              : {}),
          },
        },
      );
      onResolved(res.resolution, res.checkout);
    } catch (err) {
      if (handleConflictOutcome(err)) return;
      setError(
        wrapNotice(
          err instanceof ApiError
            ? err.message
            : "Could not record the full refund. Keep this reference pending and check status.",
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleConflictOutcome(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false;
    if (err.code === "CHECKOUT_ALREADY_SAVED" && err.details?.sale) {
      onAlreadySaved(checkout.reference, err.details.sale as SaleView);
      return true;
    }
    if (err.code === "CHECKOUT_ALREADY_SETTLED" && err.details?.settlement) {
      onAlreadySettled(checkout.reference, err.details.settlement as PriorDaySettlementView);
      return true;
    }
    if (err.code === "CHECKOUT_ALREADY_RESOLVED" && err.details?.resolution && err.details?.checkout) {
      onResolved(
        err.details.resolution as CheckoutResolutionView,
        err.details.checkout as CheckoutView,
      );
      return true;
    }
    return false;
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-resolution-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="detail-card__header">
          <div>
            <h2 id="checkout-resolution-title">
              {mode === "NO_CASH_CANCELLED"
                ? "Cancel prior-day checkout (no cash)"
                : "Record full refund for unsaved checkout"}
            </h2>
            <p className="muted-sm">
              Original reference <strong className="mono-ref">{checkout.reference}</strong> from{" "}
              <strong>{checkout.businessDate}</strong>
            </p>
          </div>
          <span className="pill pill--warning">Owner review</span>
        </div>

        <div className="callout callout--info">
          <p className="callout__title">
            {mode === "NO_CASH_CANCELLED"
              ? "Cancel only if no cash was received"
              : "Refund only the cash actually retained"}
          </p>
          <p className="callout__body">
            {mode === "NO_CASH_CANCELLED"
              ? "Confirm no payment was taken for this prior-day checkout. This cancels the checkout without creating a sale and releases any reserved merchandise stock. Leave uncertain outcomes pending."
              : "Use this only when the order was undelivered and the customer received a full refund. No sale is created, ordinary stock reservations are released, and any affected filled units can be held out of ready-to-sell stock."}
          </p>
        </div>

        <dl className="detail-list">
          <div className="detail-list__row">
            <dt>Transaction reference</dt>
            <dd className="mono-ref">{checkout.reference}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Original business date</dt>
            <dd>{checkout.businessDate}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Resolution date (Manila)</dt>
            <dd>{todayDate}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Original operator</dt>
            <dd>{checkout.createdBy}</dd>
          </div>
          <div className="detail-list__row detail-list__row--total">
            <dt>Quoted order total</dt>
            <dd>{formatCentavos(checkout.totalCentavos)}</dd>
          </div>
        </dl>

        <ul className="pos-summary-lines">
          {checkout.items.map((item) => (
            <li key={`${item.lineIndex}-${item.displayLabel}`} className="pos-summary-line">
              <div className="pos-summary-line__meta">
                <strong>{item.displayLabel}</strong>
                <span className="muted-sm">
                  {item.quantity} × {formatCentavos(item.unitPriceCentavos)}
                  {item.kind !== "MERCHANDISE" ? ` · ${formatLiters(item.lineVolumeLiters)}` : ""}
                </span>
              </div>
              <span className="pos-summary-line__amount">
                {formatCentavos(item.lineTotalCentavos)}
              </span>
            </li>
          ))}
        </ul>

        <form className="subview" onSubmit={(event) => void handleSubmit(event)}>
          {mode === "NO_CASH_CANCELLED" ? (
            <div className="cancel-unpaid-box">
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={noCashReceivedConfirmed}
                  disabled={submitting}
                  onChange={(event) => {
                    setNoCashReceivedConfirmed(event.target.checked);
                    setError(null);
                  }}
                />
                <span>Confirm no cash was received from the customer for this checkout</span>
              </label>
            </div>
          ) : (
            <>
              {serverCash !== null ? (
                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>Recorded cash received</dt>
                    <dd>{formatCentavos(serverCash)}</dd>
                  </div>
                </dl>
              ) : (
                <label className="field">
                  <span>Cash received from customer (₱) *</span>
                  <div className="cash-input-wrap">
                    <span className="cash-input-prefix" aria-hidden="true">
                      ₱
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label="Cash received from customer"
                      placeholder="0.00"
                      disabled={submitting}
                      value={cashInput}
                      onChange={(event) => {
                        setCashInput(event.target.value);
                        setConfirmedRefundSignature(null);
                        setError(null);
                      }}
                    />
                  </div>
                </label>
              )}

              <div className="cancel-unpaid-box">
                <label className="checkbox-field">
                  <input
                    type="radio"
                    name="changeAlreadyGiven"
                    checked={!changeAlreadyGiven}
                    disabled={submitting}
                    onChange={() => {
                      setChangeAlreadyGiven(false);
                      setConfirmedRefundSignature(null);
                      setError(null);
                    }}
                  />
                  <span>No change was given to the customer</span>
                </label>
                <label className="checkbox-field">
                  <input
                    type="radio"
                    name="changeAlreadyGiven"
                    checked={changeAlreadyGiven}
                    disabled={submitting}
                    onChange={() => {
                      setChangeAlreadyGiven(true);
                      setConfirmedRefundSignature(null);
                      setError(null);
                    }}
                  />
                  <span>Change was already given to the customer</span>
                </label>
              </div>

              {refundSummary.valid && refundSummary.refundCentavos !== null ? (
                <div className="change-box change-box--ok" role="status">
                  <span className="change-box__label">Full refund amount</span>
                  <strong className="change-box__value">
                    {formatCentavos(refundSummary.refundCentavos)}
                  </strong>
                  <span className="muted-sm">
                    {formatCentavos(effectiveCashCentavos!)} tender −{" "}
                    {formatCentavos(refundSummary.changeGivenCentavos ?? 0)} change already given
                  </span>
                </div>
              ) : (
                <div className="change-box change-box--short" role="status">
                  <strong>{refundSummary.validationMessage}</strong>
                </div>
              )}

              <div className="cancel-unpaid-box">
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={undeliveredConfirmed}
                    disabled={submitting}
                    onChange={(event) => {
                      setUndeliveredConfirmed(event.target.checked);
                      setError(null);
                    }}
                  />
                  <span>Confirm the order was not delivered or handed over to the customer</span>
                </label>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={refundConfirmed}
                    disabled={submitting || !refundSummary.valid}
                    onChange={(event) => {
                      setConfirmedRefundSignature(
                        event.target.checked ? refundSummary.confirmationSignature : null,
                      );
                      setError(null);
                    }}
                  />
                  <span>
                    Confirm{" "}
                    {refundSummary.refundCentavos !== null
                      ? formatCentavos(refundSummary.refundCentavos)
                      : "the full retained payment"}{" "}
                    was refunded in full to the customer
                  </span>
                </label>
              </div>
            </>
          )}

          {checkoutProducts.length > 0 && (
            <div className="cancel-unpaid-box">
              <p className="callout__title">Held / unavailable units</p>
              <p className="muted-sm">
                Filled container packages cancelled before sale stay out of ready-to-sell stock under
                INV-015. Verify the actual affected units at the station.
              </p>
              {checkoutProducts.map((prod) => {
                const draft = holdDrafts[prod.productId]!;
                return (
                  <div key={prod.productId} className="subview">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        disabled={submitting}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setHoldDrafts((prev) => ({
                            ...prev,
                            [prod.productId]: { ...draft, enabled: checked },
                          }));
                          setHoldDispositionVerified(false);
                          setError(null);
                        }}
                      />
                      <span>
                        Hold {prod.label} out of ready-to-sell stock (ordered{" "}
                        {prod.orderedQuantity} {prod.unit}
                        {prod.filledQuantity > 0
                          ? ` · ${prod.filledQuantity} filled, ${prod.emptyOrMerchQuantity} empty/other`
                          : ""}
                        )
                      </span>
                    </label>
                    {draft.enabled && (
                      <div className="field-row">
                        <label className="field">
                          <span>Held quantity ({prod.unit})</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            disabled={submitting}
                            value={draft.quantityInput}
                            onChange={(event) => {
                              const nextVal = event.target.value;
                              setHoldDrafts((prev) => ({
                                ...prev,
                                [prod.productId]: { ...draft, quantityInput: nextVal },
                              }));
                              setHoldDispositionVerified(false);
                              setError(null);
                            }}
                          />
                        </label>
                        <label className="field">
                          <span>Hold reason *</span>
                          <input
                            type="text"
                            maxLength={240}
                            disabled={submitting}
                            value={draft.reason}
                            onChange={(event) => {
                              const nextReason = event.target.value;
                              setHoldDrafts((prev) => ({
                                ...prev,
                                [prod.productId]: { ...draft, reason: nextReason },
                              }));
                              setHoldDispositionVerified(false);
                              setError(null);
                            }}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
              {holdEvaluation.requiresVerification && (
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={holdDispositionVerified}
                    disabled={submitting}
                    onChange={(event) => {
                      setHoldDispositionVerified(event.target.checked);
                      setError(null);
                    }}
                  />
                  <span>
                    {holdEvaluation.needsNoFilledConfirmed
                      ? "Confirm the held quantities above and that any unheld filled units were never filled"
                      : "Confirm the actual held / affected unit quantities above"}
                  </span>
                </label>
              )}
            </div>
          )}

          <label className="field">
            <span>Review note (optional)</span>
            <input
              type="text"
              maxLength={240}
              placeholder="e.g. Verified cash drawer and returned full payment"
              disabled={submitting}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>

          {error && (
            <TemporaryNotice
              occurrenceId={error.id}
              duration="brief"
              className="alert alert--error"
              role="alert"
              closeLabel="Close resolution error"
              onDismiss={() => setError(null)}
            >
              {error.data}
            </TemporaryNotice>
          )}

          <div className="modal__actions">
            <button
              type="button"
              className="button button--ghost"
              disabled={submitting}
              onClick={onClose}
            >
              Leave pending
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={
                submitting ||
                !holdEvaluation.valid ||
                (mode === "NO_CASH_CANCELLED"
                  ? !noCashReceivedConfirmed
                  : !undeliveredConfirmed || !refundConfirmed || !refundSummary.valid)
              }
            >
              {submitting
                ? "Recording resolution…"
                : mode === "NO_CASH_CANCELLED"
                  ? "Confirm no-cash cancellation"
                  : "Record full refund"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
