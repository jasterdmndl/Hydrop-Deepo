import { type FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { type NoticeEnvelope, wrapNotice } from "../notifications/noticeTiming";
import { TemporaryNotice } from "../notifications/TemporaryNotice";
import {
  type CheckoutView,
  formatCentavos,
  formatLiters,
  isPriorDayMerchandiseOnly,
  type PriorDaySettlementView,
  type SaleView,
  type SettlePriorDayResponse,
} from "./posRecovery";

export interface PriorDaySettlementModalProps {
  checkout: CheckoutView;
  todayDate: string;
  localCashReceivedCentavos?: number | null;
  onClose(): void;
  onSettled(settlement: PriorDaySettlementView, checkout: CheckoutView): void;
  onAlreadySaved(reference: string, sale: SaleView): void;
}

export function PriorDaySettlementModal({
  checkout,
  todayDate,
  localCashReceivedCentavos,
  onClose,
  onSettled,
  onAlreadySaved,
}: PriorDaySettlementModalProps) {
  const [paymentKeptConfirmed, setPaymentKeptConfirmed] = useState(false);
  const [refillDeliveredConfirmed, setRefillDeliveredConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<NoticeEnvelope<string> | null>(null);
  const isMerchandiseOnly = isPriorDayMerchandiseOnly(checkout.items);
  const merchQty = checkout.items
    .filter((item) => item.kind === "MERCHANDISE" || item.kind === "CONTAINER_PACKAGE")
    .reduce((sum, item) => sum + item.quantity, 0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || submitting) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  const recordedCash = checkout.cashReceivedCentavos ?? localCashReceivedCentavos ?? null;
  const computedChange =
    checkout.changeCentavos ??
    (recordedCash !== null && recordedCash >= checkout.totalCentavos
      ? recordedCash - checkout.totalCentavos
      : null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!paymentKeptConfirmed || !refillDeliveredConfirmed || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const payload: {
        paymentKeptConfirmed: boolean;
        refillDeliveredConfirmed?: boolean;
        itemsHandedOverConfirmed?: boolean;
        cashReceivedCentavos?: number;
        note?: string;
      } = {
        paymentKeptConfirmed: true,
        ...(isMerchandiseOnly
          ? { itemsHandedOverConfirmed: true }
          : { refillDeliveredConfirmed: true }),
      };
      if (
        checkout.cashReceivedCentavos === null &&
        localCashReceivedCentavos !== undefined &&
        localCashReceivedCentavos !== null &&
        localCashReceivedCentavos >= checkout.totalCentavos
      ) {
        payload.cashReceivedCentavos = localCashReceivedCentavos;
      }
      const trimmedNote = note.trim();
      if (trimmedNote) {
        payload.note = trimmedNote;
      }

      const res = await api<SettlePriorDayResponse>(
        `/api/pos/checkouts/${encodeURIComponent(checkout.reference)}/settle`,
        {
          method: "POST",
          body: payload,
        },
      );

      if (res.outcome === "ALREADY_SAVED" && res.sale) {
        onAlreadySaved(checkout.reference, res.sale);
        return;
      }
      if (res.settlement) {
        onSettled(res.settlement, res.checkout);
      }
    } catch (err) {
      setError(
        wrapNotice(
          err instanceof ApiError
            ? err.message
            : "Could not record the prior-day settlement. Keep this reference pending and check status.",
        ),
      );
    } finally {
      setSubmitting(false);
    }
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
        aria-labelledby="prior-day-settle-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="detail-card__header">
          <div>
            <h2 id="prior-day-settle-title">
              {isMerchandiseOnly ? "Review prior-day merchandise" : "Review prior-day refill"}
            </h2>
            <p className="muted-sm">
              Original reference <strong className="mono-ref">{checkout.reference}</strong> from{" "}
              <strong>{checkout.businessDate}</strong>
            </p>
          </div>
          <span className="pill pill--warning">Owner review</span>
        </div>

        <div className="callout callout--info">
          <p className="callout__title">No further cash is collected</p>
          <p className="callout__body">
            {isMerchandiseOnly
              ? "Record this settlement only if the station kept the payment and the customer already received all merchandise items. Leave all other outcomes pending; this deducts stock once, records separately from today's sales, and leaves closed day summaries unchanged."
              : "Record this settlement only if the station kept the payment and the customer already received the refill. Leave all other outcomes pending; this records separately from today's refill sales and leaves closed day summaries unchanged."}
          </p>
        </div>

        <dl className="detail-list">
          <div className="detail-list__row">
            <dt>Transaction reference</dt>
            <dd className="mono-ref">{checkout.reference}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Original payment date</dt>
            <dd>{checkout.businessDate}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Settlement date (Manila)</dt>
            <dd>{todayDate}</dd>
          </div>
          <div className="detail-list__row">
            <dt>Original operator</dt>
            <dd>{checkout.createdBy}</dd>
          </div>
          {(!isMerchandiseOnly || checkout.totalContainers > 0 || checkout.totalVolumeLiters > 0) && (
            <div className="detail-list__row">
              <dt>Containers &amp; water</dt>
              <dd>
                {checkout.totalContainers} container{checkout.totalContainers === 1 ? "" : "s"} ·{" "}
                {formatLiters(checkout.totalVolumeLiters)}
              </dd>
            </div>
          )}
          {isMerchandiseOnly && (
            <div className="detail-list__row">
              <dt>Merchandise items</dt>
              <dd>
                {merchQty} item{merchQty === 1 ? "" : "s"}
              </dd>
            </div>
          )}
          <div className="detail-list__row detail-list__row--total">
            <dt>Net amount kept</dt>
            <dd>{formatCentavos(checkout.totalCentavos)}</dd>
          </div>
          {recordedCash !== null && (
            <>
              <div className="detail-list__row">
                <dt>Cash received</dt>
                <dd>{formatCentavos(recordedCash)}</dd>
              </div>
              {computedChange !== null && (
                <div className="detail-list__row">
                  <dt>Change</dt>
                  <dd>{formatCentavos(computedChange)}</dd>
                </div>
              )}
            </>
          )}
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
          <div className="cancel-unpaid-box">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={paymentKeptConfirmed}
                disabled={submitting}
                onChange={(event) => {
                  setPaymentKeptConfirmed(event.target.checked);
                  setError(null);
                }}
              />
              <span>
                {isMerchandiseOnly
                  ? "Confirm the station kept the payment for this checkout"
                  : "Confirm the station kept the payment for this refill"}
              </span>
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={refillDeliveredConfirmed}
                disabled={submitting}
                onChange={(event) => {
                  setRefillDeliveredConfirmed(event.target.checked);
                  setError(null);
                }}
              />
              <span>
                {isMerchandiseOnly
                  ? "Confirm the customer received all merchandise items"
                  : "Confirm the customer received the refill"}
              </span>
            </label>
          </div>

          <label className="field">
            <span>Review note (optional)</span>
            <input
              type="text"
              maxLength={240}
              placeholder="e.g. Verified cash box and handover"
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
              closeLabel="Close settlement error"
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
              disabled={!paymentKeptConfirmed || !refillDeliveredConfirmed || submitting}
            >
              {submitting ? "Recording settlement…" : "Record prior-day settlement"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

