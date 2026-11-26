import { useEffect, useMemo, useState } from "react";
import { type NoticeEnvelope } from "../notifications/noticeTiming";
import { TemporaryNotice } from "../notifications/TemporaryNotice";
import {
  aggregateCheckoutProductsForHold,
  buildInitialHoldDrafts,
  evaluateHoldDisposition,
  type HoldDraftState,
} from "./checkoutResolution";
import { FilledHoldDispositionEditor } from "./FilledHoldDispositionEditor";
import {
  type CheckoutResolutionView,
  classifyCheckoutComposition,
  formatCentavos,
  formatLiters,
  formatManilaTimestamp,
  type PendingCheckoutRecovery,
  type PriorDaySettlementView,
  reconcileRecoveryTodayDate,
  type RecoveryTone,
  resolveRecoveryPresentation,
  type SaleView,
} from "./posRecovery";

export interface CheckoutRecoveryProps {
  record: PendingCheckoutRecovery;
  allRecoveries?: PendingCheckoutRecovery[];
  currentUsername: string;
  currentUserRole?: "OWNER" | "EMPLOYEE";
  todayDate?: string;
  checking: boolean;
  retrying: boolean;
  cancellingUnpaid?: boolean;
  statusNotice?: NoticeEnvelope<string> | null;
  errorNotice: NoticeEnvelope<string> | null;
  onDismissStatusNotice?: () => void;
  onDismissError(): void;
  onSelectReference?: (reference: string) => void;
  onCheckStatus(): void;
  onRetry(): void;
  onContinueSaved(reference: string, sale: SaleView): void;
  onViewSavedReceipt?: (reference: string, sale: SaleView) => void;
  onOpenPriorDaySettle?: (record: PendingCheckoutRecovery) => void;
  onOpenResolveNoCash?: (record: PendingCheckoutRecovery) => void;
  onOpenResolveFullRefund?: (record: PendingCheckoutRecovery) => void;
  onContinueSettled?: (reference: string, settlement: PriorDaySettlementView) => void;
  onContinueResolved?: (reference: string, resolution: CheckoutResolutionView) => void;
  onDismissCancelled?: (reference: string) => void;
  onCancelUnpaid?: (
    reference: string,
    options?: {
      heldItems?: Array<{ productId: string; quantity: number; reason: string }>;
      noFilledUnitsHeldConfirmed?: boolean;
    },
  ) => void;
  onCloseServerInspection?: () => void;
}

function pillClassForTone(tone: RecoveryTone): string {
  switch (tone) {
    case "success":
      return "pill--completed";
    case "danger":
      return "pill--overdue";
    case "warning":
      return "pill--warning";
    case "neutral":
      return "pill--neutral";
  }
}

function formatRecoveryCountPill(items: PendingCheckoutRecovery["quoteItems"], totalContainers: number): string {
  const merchQty = items
    .filter((item) => item.kind === "MERCHANDISE" || item.kind === "CONTAINER_PACKAGE")
    .reduce((sum, item) => sum + item.quantity, 0);
  const parts: string[] = [];
  if (totalContainers > 0 || merchQty === 0) {
    parts.push(`${totalContainers} container${totalContainers === 1 ? "" : "s"}`);
  }
  if (merchQty > 0) {
    parts.push(`${merchQty} item${merchQty === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function StatusBadgeIcon({ tone }: { tone: RecoveryTone }) {
  if (tone === "success") {
    return (
      <span className="recovery-icon recovery-icon--success" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2">
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 12.5 11 15l4.5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (tone === "danger") {
    return (
      <span className="recovery-icon recovery-icon--danger" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5" strokeLinecap="round" />
          <circle cx="12" cy="16.2" r="0.8" fill="currentColor" stroke="none" />
        </svg>
      </span>
    );
  }
  return (
    <span className="recovery-icon recovery-icon--warning" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 3 4 6.5V12c0 5 3.4 8.5 8 9.8 4.6-1.3 8-4.8 8-9.8V6.5L12 3Z" />
        <path d="M12 8.5v4.5" strokeLinecap="round" />
        <circle cx="12" cy="16.2" r="0.8" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}

export function CheckoutRecovery({
  record,
  allRecoveries,
  currentUsername,
  currentUserRole = "EMPLOYEE",
  todayDate,
  checking,
  retrying,
  cancellingUnpaid = false,
  statusNotice,
  errorNotice,
  onDismissStatusNotice,
  onDismissError,
  onSelectReference,
  onCheckStatus,
  onRetry,
  onContinueSaved,
  onViewSavedReceipt,
  onOpenPriorDaySettle,
  onOpenResolveNoCash,
  onOpenResolveFullRefund,
  onContinueSettled,
  onContinueResolved,
  onDismissCancelled,
  onCancelUnpaid,
  onCloseServerInspection,
}: CheckoutRecoveryProps) {
  const effectiveTodayDate = reconcileRecoveryTodayDate(todayDate, record.lastLookup?.checkedAt);
  const presentation = resolveRecoveryPresentation(
    record,
    currentUsername,
    currentUserRole,
    effectiveTodayDate,
  );
  const [confirmNoCashCancelled, setConfirmNoCashCancelled] = useState(false);
  const [confirmNoCashUnpaid, setConfirmNoCashUnpaid] = useState(false);
  const unpaidFilledProducts = useMemo(
    () =>
      aggregateCheckoutProductsForHold(presentation.amounts.items).filter(
        (p) => p.filledQuantity > 0,
      ),
    [presentation.amounts.items],
  );
  const [unpaidHoldDrafts, setUnpaidHoldDrafts] = useState<Record<string, HoldDraftState>>(() =>
    buildInitialHoldDrafts(unpaidFilledProducts),
  );
  const [unpaidHoldVerified, setUnpaidHoldVerified] = useState(false);
  const unpaidHoldEval = useMemo(
    () => evaluateHoldDisposition(unpaidFilledProducts, unpaidHoldDrafts, unpaidHoldVerified),
    [unpaidFilledProducts, unpaidHoldDrafts, unpaidHoldVerified],
  );

  useEffect(() => {
    setConfirmNoCashCancelled(false);
    setConfirmNoCashUnpaid(false);
    setUnpaidHoldDrafts(buildInitialHoldDrafts(unpaidFilledProducts));
    setUnpaidHoldVerified(false);
  }, [record.reference, presentation.screen, unpaidFilledProducts]);

  function renderCancelUnpaidBox() {
    if (!onCancelUnpaid) return null;
    return (
      <div className="cancel-unpaid-box">
        {unpaidFilledProducts.length > 0 && (
          <FilledHoldDispositionEditor
            idPrefix={`recovery-${record.reference}`}
            products={unpaidFilledProducts}
            drafts={unpaidHoldDrafts}
            verified={unpaidHoldVerified}
            disabled={checking || retrying || cancellingUnpaid}
            onChangeDrafts={setUnpaidHoldDrafts}
            onChangeVerified={setUnpaidHoldVerified}
          />
        )}
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={confirmNoCashUnpaid}
            disabled={checking || retrying || cancellingUnpaid}
            onChange={(event) => setConfirmNoCashUnpaid(event.target.checked)}
          />
          <span>Confirm no cash was received from the customer</span>
        </label>
        <button
          type="button"
          className="button button--ghost button--block"
          disabled={
            !confirmNoCashUnpaid ||
            (unpaidFilledProducts.length > 0 && !unpaidHoldEval.valid) ||
            checking ||
            retrying ||
            cancellingUnpaid
          }
          onClick={() =>
            onCancelUnpaid(
              record.reference,
              unpaidFilledProducts.length === 0
                ? undefined
                : {
                    ...(unpaidHoldEval.heldItems.length > 0
                      ? { heldItems: unpaidHoldEval.heldItems }
                      : {}),
                    ...(unpaidHoldEval.needsNoFilledConfirmed
                      ? { noFilledUnitsHeldConfirmed: true }
                      : {}),
                  },
            )
          }
        >
          {cancellingUnpaid ? "Cancelling unpaid checkout…" : "Cancel unpaid checkout"}
        </button>
      </div>
    );
  }

  return (
    <div className="pos-layout">
      <div className="recovery-main">
        {allRecoveries && allRecoveries.length > 1 && onSelectReference && (
          <div
            className="callout callout--warning recovery-switcher"
            role="region"
            aria-label="Pending checkouts on this device"
          >
            <p className="callout__title">
              {allRecoveries.length} pending recoveries on this workstation
            </p>
            <p className="callout__body">
              Select each transaction reference below to check its status and finish or verify it separately.
            </p>
            <div className="recovery-switcher__list">
              {allRecoveries.map((item) => {
                const selected = item.reference === record.reference;
                return (
                  <button
                    key={item.reference}
                    type="button"
                    aria-pressed={selected}
                    className={`recovery-switcher__btn ${
                      selected ? "recovery-switcher__btn--active" : ""
                    }`}
                    onClick={() => onSelectReference(item.reference)}
                  >
                    <span className="mono-ref">{item.reference}</span>
                    <span className="muted-sm">
                      {formatCentavos(item.totalCentavos)} · {item.initiatedBy}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <article className="card recovery-card" aria-live="polite">
          <div className="recovery-card__header">
            <StatusBadgeIcon tone={presentation.statusPillTone} />
            <div className="recovery-card__titles">
              <h2>{presentation.headline}</h2>
              <p className="muted-sm">{presentation.subline}</p>
            </div>
          </div>

          <div className={`callout callout--${presentation.calloutTone}`} role="status">
            <p className="callout__title">{presentation.calloutTitle}</p>
            <p className="callout__body">{presentation.calloutBody}</p>
          </div>

          <dl className="detail-list">
            <div className="detail-list__row">
              <dt>Transaction reference</dt>
              <dd className="mono-ref">{record.reference}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Original payment date</dt>
              <dd>{record.businessDate}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Attempted at</dt>
              <dd>{formatManilaTimestamp(record.attemptedAt)}</dd>
            </div>
            {presentation.settlement && (
              <>
                <div className="detail-list__row">
                  <dt>Settlement date (Manila)</dt>
                  <dd>{presentation.settlement.settlementDate}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Settled by</dt>
                  <dd>{presentation.settlement.settledBy}</dd>
                </div>
              </>
            )}
            {presentation.resolution && (
              <>
                <div className="detail-list__row">
                  <dt>Resolution date (Manila)</dt>
                  <dd>{presentation.resolution.resolutionDate}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Resolved by</dt>
                  <dd>{presentation.resolution.resolvedBy}</dd>
                </div>
                {presentation.resolution.outcome === "FULL_REFUND" &&
                  presentation.resolution.refundedAmountCentavos !== null && (
                    <div className="detail-list__row">
                      <dt>Refunded amount</dt>
                      <dd>{formatCentavos(presentation.resolution.refundedAmountCentavos)}</dd>
                    </div>
                  )}
              </>
            )}
            <div className="detail-list__row">
              <dt>Employee</dt>
              <dd>{record.initiatedBy}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Amount</dt>
              <dd>{formatCentavos(presentation.amounts.totalCentavos)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Saved status</dt>
              <dd>
                <span className={`pill ${pillClassForTone(presentation.statusPillTone)}`}>
                  {presentation.statusPillLabel}
                </span>
              </dd>
            </div>
          </dl>

          {statusNotice && (
            <TemporaryNotice
              occurrenceId={statusNotice.id}
              duration="brief"
              className="alert alert--info"
              role="status"
              closeLabel="Close status check result"
              onDismiss={onDismissStatusNotice ?? (() => undefined)}
            >
              {statusNotice.data}
            </TemporaryNotice>
          )}

          {errorNotice && (
            <TemporaryNotice
              occurrenceId={errorNotice.id}
              duration="brief"
              className="alert alert--error"
              role="alert"
              closeLabel="Close recovery error"
              onDismiss={onDismissError}
            >
              {errorNotice.data}
            </TemporaryNotice>
          )}

          <div className="recovery-actions">
            {presentation.screen === "UNKNOWN" && (
              <>
                <button
                  type="button"
                  className="button button--primary button--block"
                  aria-busy={checking}
                  disabled={checking || retrying}
                  onClick={onCheckStatus}
                >
                  {checking ? "Checking transaction status…" : "Check transaction status"}
                </button>
                <button type="button" className="button button--ghost button--block" disabled>
                  {presentation.isDifferentAccount
                    ? `Retry restricted to ${record.initiatedBy}`
                    : "Retry unavailable until status is checked"}
                </button>
                {record.source === "server" && onCloseServerInspection && (
                  <button
                    type="button"
                    className="button button--ghost button--block"
                    disabled={checking || retrying}
                    onClick={onCloseServerInspection}
                  >
                    Back to New Sale
                  </button>
                )}
              </>
            )}

            {presentation.screen === "SAVED" && presentation.sale && (
              <>
                <button
                  type="button"
                  className="button button--primary button--block"
                  onClick={() => onContinueSaved(record.reference, presentation.sale!)}
                >
                  Continue with saved sale
                </button>
                {onViewSavedReceipt && (
                  <button
                    type="button"
                    className="button button--ghost button--block"
                    onClick={() => onViewSavedReceipt(record.reference, presentation.sale!)}
                  >
                    View saved receipt in History
                  </button>
                )}
              </>
            )}

            {presentation.screen === "SAFE_TO_RETRY" && (
              <>
                {presentation.canRetry && (
                  <button
                    type="button"
                    className="button button--primary button--block"
                    disabled={retrying || checking || cancellingUnpaid}
                    onClick={onRetry}
                  >
                    {retrying ? "Saving transaction…" : "Retry saving this transaction"}
                  </button>
                )}
                <button
                  type="button"
                  className={`button ${
                    presentation.needsOriginalBrowserForRetry ? "button--primary" : "button--ghost"
                  } button--block`}
                  aria-busy={checking}
                  disabled={retrying || checking || cancellingUnpaid}
                  onClick={onCheckStatus}
                >
                  {checking ? "Checking transaction status…" : "Check transaction status"}
                </button>
                {presentation.needsOriginalBrowserForRetry &&
                  presentation.canCancelUnpaid &&
                  renderCancelUnpaidBox()}
                {presentation.canResolveFullRefund && onOpenResolveFullRefund && (
                  <button
                    type="button"
                    className="button button--ghost button--block"
                    disabled={checking || retrying || cancellingUnpaid}
                    onClick={() => onOpenResolveFullRefund(record)}
                  >
                    Record full refund (undelivered)
                  </button>
                )}
                {presentation.needsOriginalBrowserForRetry && onCloseServerInspection && (
                  <button
                    type="button"
                    className="button button--ghost button--block"
                    disabled={checking || retrying || cancellingUnpaid}
                    onClick={onCloseServerInspection}
                  >
                    Back to New Sale
                  </button>
                )}
              </>
            )}

            {presentation.screen === "UNKNOWN" &&
              presentation.canResolveFullRefund &&
              onOpenResolveFullRefund && (
                <button
                  type="button"
                  className="button button--ghost button--block"
                  disabled={checking || retrying}
                  onClick={() => onOpenResolveFullRefund(record)}
                >
                  Record full refund (undelivered)
                </button>
              )}

            {presentation.screen === "REVIEW_REQUIRED" && (
              <>
                {presentation.canCancelUnpaid && renderCancelUnpaidBox()}
                {presentation.canSettlePriorDay && onOpenPriorDaySettle && (
                  <button
                    type="button"
                    className="button button--primary button--block"
                    disabled={checking || retrying}
                    onClick={() => onOpenPriorDaySettle(record)}
                  >
                    {(() => {
                      const comp = classifyCheckoutComposition(presentation.amounts.items);
                      if (comp === "MIXED") return "Review & settle prior-day mixed order";
                      if (comp === "MERCHANDISE_ONLY") return "Review & settle prior-day merchandise";
                      return "Review & settle prior-day refill";
                    })()}
                  </button>
                )}
                {presentation.canResolveNoCashPriorDay && onOpenResolveNoCash && (
                  <button
                    type="button"
                    className="button button--ghost button--block"
                    disabled={checking || retrying}
                    onClick={() => onOpenResolveNoCash(record)}
                  >
                    Cancel prior-day checkout (no cash)
                  </button>
                )}
                {presentation.canResolveFullRefund && onOpenResolveFullRefund && (
                  <button
                    type="button"
                    className="button button--ghost button--block"
                    disabled={checking || retrying}
                    onClick={() => onOpenResolveFullRefund(record)}
                  >
                    Record full refund (undelivered)
                  </button>
                )}
                <button
                  type="button"
                  className="button button--ghost button--block"
                  aria-busy={checking}
                  disabled={checking}
                  onClick={onCheckStatus}
                >
                  {checking ? "Checking status…" : "Check transaction status"}
                </button>
                {record.source === "server" && onCloseServerInspection && (
                  <button
                    type="button"
                    className="button button--ghost button--block"
                    disabled={checking || retrying}
                    onClick={onCloseServerInspection}
                  >
                    Back to New Sale
                  </button>
                )}
                <p className="muted-sm">
                  {presentation.canCancelUnpaid
                    ? "Record the filled-container disposition and confirm no cash was received above to cancel this unpaid draft so the station day can close."
                    : currentUserRole === "EMPLOYEE" &&
                        effectiveTodayDate &&
                        record.businessDate < effectiveTodayDate
                      ? "Keep this reference for Owner review. Only the Owner can settle or resolve a prior-day checkout; partial and uncertain outcomes remain pending."
                      : "Keep this reference for Owner review. Leave partial or uncertain outcomes pending."}
                </p>
              </>
            )}

            {presentation.screen === "SETTLED_PRIOR_DAY" &&
              presentation.settlement &&
              onContinueSettled && (
                <button
                  type="button"
                  className="button button--primary button--block"
                  onClick={() => onContinueSettled(record.reference, presentation.settlement!)}
                >
                  Continue with settled record
                </button>
              )}

            {(presentation.screen === "CANCELLED_NO_CASH" ||
              presentation.screen === "REFUNDED_UNSAVED") &&
              presentation.resolution &&
              onContinueResolved && (
                <>
                  {presentation.resolution.heldItems.length > 0 && (
                    <div className="callout callout--warning" role="status">
                      <p className="callout__title">Held / unavailable stock recorded</p>
                      <ul className="conflict-list">
                        {presentation.resolution.heldItems.map((hold) => (
                          <li key={hold.id}>
                            <strong>
                              {hold.quantity} {hold.unit}
                            </strong>{" "}
                            {hold.itemName} — {hold.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <button
                    type="button"
                    className="button button--primary button--block"
                    onClick={() => onContinueResolved(record.reference, presentation.resolution!)}
                  >
                    Return to New Sale
                  </button>
                </>
              )}

            {presentation.screen === "CANCELLED" &&
              presentation.canDismissCancelled &&
              onDismissCancelled && (
                <>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={confirmNoCashCancelled}
                      disabled={checking || retrying}
                      onChange={(event) => setConfirmNoCashCancelled(event.target.checked)}
                    />
                    <span>Confirm no cash was received for this cancelled checkout</span>
                  </label>
                  <button
                    type="button"
                    className="button button--primary button--block"
                    disabled={!confirmNoCashCancelled || checking || retrying}
                    onClick={() => onDismissCancelled(record.reference)}
                  >
                    Return to New Sale
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--block"
                    aria-busy={checking}
                    disabled={checking || retrying}
                    onClick={onCheckStatus}
                  >
                    {checking ? "Checking status…" : "Check transaction status"}
                  </button>
                  {record.source === "server" && onCloseServerInspection && (
                    <button
                      type="button"
                      className="button button--ghost button--block"
                      disabled={checking || retrying}
                      onClick={onCloseServerInspection}
                    >
                      Back to New Sale
                    </button>
                  )}
                  <p className="muted-sm">
                    Returning to New Sale clears only this reference from this browser&apos;s recovery list and
                    keeps the cancelled server record and any other pending references intact. If cash was
                    received, keep this reference for Owner review.
                  </p>
                </>
              )}
          </div>
        </article>

        <p className="muted-sm recovery-footer-note">
          If the check cannot connect, keep this reference and check again. Do not start a new sale for the same
          payment.
        </p>
      </div>

      <aside className="side-stack" aria-label="Attempted sale summary">
        <article className="card detail-card">
          <div className="detail-card__header">
            <h2>Current sale</h2>
            <span className="pill pill--scheduled">
              {formatRecoveryCountPill(presentation.amounts.items, presentation.amounts.totalContainers)}
            </span>
          </div>

          <ul className="pos-summary-lines">
            {presentation.amounts.items.map((item) => (
              <li key={`${item.lineIndex}-${item.displayLabel}`} className="pos-summary-line">
                <div className="pos-summary-line__meta">
                  <strong>{item.displayLabel}</strong>
                  <span className="muted-sm">
                    {item.quantity} × {formatCentavos(item.unitPriceCentavos)}
                    {item.kind === "STANDARD" ||
                    item.kind === "CUSTOM" ||
                    (item.kind === "CONTAINER_PACKAGE" && item.lineVolumeLiters > 0)
                      ? ` · ${formatLiters(item.lineVolumeLiters)}`
                      : ""}
                  </span>
                </div>
                <span className="pos-summary-line__amount">{formatCentavos(item.lineTotalCentavos)}</span>
              </li>
            ))}
          </ul>

          <dl className="detail-list">
            <div className="detail-list__row">
              <dt>Containers</dt>
              <dd>{presentation.amounts.totalContainers}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Total water</dt>
              <dd>{formatLiters(presentation.amounts.totalVolumeLiters)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Total amount</dt>
              <dd>{formatCentavos(presentation.amounts.totalCentavos)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>
                {presentation.screen === "CANCELLED"
                  ? "Cash entered on this device"
                  : "Cash received"}
              </dt>
              <dd>
                {presentation.amounts.cashReceivedCentavos !== null
                  ? formatCentavos(presentation.amounts.cashReceivedCentavos)
                  : "Not recorded on this device"}
              </dd>
            </div>
            <div className="detail-list__row">
              <dt>{presentation.screen === "CANCELLED" ? "Calculated change" : "Change"}</dt>
              <dd>
                {presentation.amounts.changeCentavos !== null
                  ? formatCentavos(presentation.amounts.changeCentavos)
                  : "—"}
              </dd>
            </div>
            {presentation.screen === "CANCELLED" && (
              <div className="detail-list__row">
                <dt>Server payment record</dt>
                <dd>None recorded</dd>
              </div>
            )}
          </dl>
        </article>

        <article className="card trust-card">
          <h3>Every sale, saved once.</h3>
          <p className="muted-sm">
            Wait for a saved confirmation before refilling. If saving is uncertain, check the transaction before
            retrying.
          </p>
        </article>
      </aside>
    </div>
  );
}
