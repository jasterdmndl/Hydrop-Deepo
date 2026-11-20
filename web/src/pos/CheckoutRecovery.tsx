import {
  formatCentavos,
  formatLiters,
  formatManilaTimestamp,
  type PendingCheckoutRecovery,
  type RecoveryTone,
  resolveRecoveryPresentation,
  type SaleView,
} from "./posRecovery";

export interface CheckoutRecoveryProps {
  record: PendingCheckoutRecovery;
  allRecoveries?: PendingCheckoutRecovery[];
  currentUsername: string;
  checking: boolean;
  retrying: boolean;
  errorMessage: string | null;
  onSelectReference?: (reference: string) => void;
  onCheckStatus(): void;
  onRetry(): void;
  onContinueSaved(reference: string, sale: SaleView): void;
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
  checking,
  retrying,
  errorMessage,
  onSelectReference,
  onCheckStatus,
  onRetry,
  onContinueSaved,
}: CheckoutRecoveryProps) {
  const presentation = resolveRecoveryPresentation(record, currentUsername);

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
              <dt>Attempted at</dt>
              <dd>{formatManilaTimestamp(record.attemptedAt)}</dd>
            </div>
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

          {errorMessage && (
            <div className="alert alert--error" role="alert">
              {errorMessage}
            </div>
          )}

          <div className="recovery-actions">
            {presentation.screen === "UNKNOWN" && (
              <>
                <button
                  type="button"
                  className="button button--primary button--block"
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
              </>
            )}

            {presentation.screen === "SAVED" && presentation.sale && (
              <button
                type="button"
                className="button button--primary button--block"
                onClick={() => onContinueSaved(record.reference, presentation.sale!)}
              >
                Continue with saved sale
              </button>
            )}

            {presentation.screen === "SAFE_TO_RETRY" && (
              <>
                <button
                  type="button"
                  className="button button--primary button--block"
                  disabled={retrying || checking}
                  onClick={onRetry}
                >
                  {retrying ? "Saving transaction…" : "Retry saving this transaction"}
                </button>
                <button
                  type="button"
                  className="button button--ghost button--block"
                  disabled={retrying || checking}
                  onClick={onCheckStatus}
                >
                  {checking ? "Checking status…" : "Check transaction status"}
                </button>
              </>
            )}

            {presentation.screen === "REVIEW_REQUIRED" && (
              <>
                <button
                  type="button"
                  className="button button--ghost button--block"
                  disabled={checking}
                  onClick={onCheckStatus}
                >
                  {checking ? "Checking status…" : "Check transaction status"}
                </button>
                <p className="muted-sm">
                  Keep this reference for Owner review. Automated refunds and backdated sales are not performed in this
                  version.
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
              {presentation.amounts.totalContainers} container{presentation.amounts.totalContainers === 1 ? "" : "s"}
            </span>
          </div>

          <ul className="pos-summary-lines">
            {presentation.amounts.items.map((item) => (
              <li key={`${item.lineIndex}-${item.displayLabel}`} className="pos-summary-line">
                <div className="pos-summary-line__meta">
                  <strong>{item.displayLabel}</strong>
                  <span className="muted-sm">
                    {item.quantity} × {formatCentavos(item.unitPriceCentavos)} · {formatLiters(item.lineVolumeLiters)}
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
              <dt>Cash received</dt>
              <dd>{formatCentavos(presentation.amounts.cashReceivedCentavos)}</dd>
            </div>
            <div className="detail-list__row">
              <dt>Change</dt>
              <dd>{formatCentavos(presentation.amounts.changeCentavos)}</dd>
            </div>
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
