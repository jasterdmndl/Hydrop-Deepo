import { Link } from "react-router-dom";
import { formatQuantityLabel, type InventoryItemView, type PosSectionView } from "../inventory/inventoryView";
import { buildStocksSnapshot } from "./dashboardView";

interface StocksViewProps {
  items: InventoryItemView[];
  posSections: PosSectionView[];
  hasLoaded: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export function StocksView({
  items,
  posSections,
  hasLoaded,
  loading,
  error,
  onRetry,
}: StocksViewProps) {
  if (!hasLoaded && error) {
    return (
      <section className="card dash-error-card" role="alert" aria-label="Stocks snapshot unavailable">
        <h2>Current stocks unavailable</h2>
        <p className="muted-sm">{error}</p>
        <div className="dash-error-card__actions">
          <button type="button" className="button button--primary button--sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!hasLoaded && loading) {
    return (
      <section className="card dash-loading-card" role="status">
        <p className="muted">Loading current Inventory snapshot…</p>
      </section>
    );
  }

  const snapshot = buildStocksSnapshot(items, posSections);

  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  let runningOffset = 0;

  return (
    <div className="dash-view-stack">
      {error && (
        <div className="alert alert--error dash-inline-alert" role="alert">
          <span>{error}</span>
          <button type="button" className="button button--ghost button--sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {loading && (
        <div className="dash-refresh-note" role="status">
          Refreshing Inventory snapshot…
        </div>
      )}

      <section className="dash-kpi-grid" aria-label="Current stock status counts">
        <article className="card dash-kpi-card dash-kpi-card--blue">
          <span className="dash-kpi-card__label">Total Products</span>
          <p className="dash-kpi-card__value">{snapshot.counts.totalProducts}</p>
          <p className="dash-kpi-card__caption">Active Inventory items</p>
        </article>

        <article className="card dash-kpi-card dash-kpi-card--green">
          <span className="dash-kpi-card__label">In Stock</span>
          <p className="dash-kpi-card__value">{snapshot.counts.inStock}</p>
          <p className="dash-kpi-card__caption">Positive on-hand balance</p>
        </article>

        <article className="card dash-kpi-card dash-kpi-card--red">
          <span className="dash-kpi-card__label">Out of Stock</span>
          <p className="dash-kpi-card__value">{snapshot.counts.outOfStock}</p>
          <p className="dash-kpi-card__caption">Initialized at 0 needing restock</p>
        </article>

        <article className="card dash-kpi-card dash-kpi-card--amber">
          <span className="dash-kpi-card__label">Not Set</span>
          <p className="dash-kpi-card__value">{snapshot.counts.notSet}</p>
          <p className="dash-kpi-card__caption">Opening count not yet entered</p>
        </article>
      </section>

      {snapshot.counts.needsReconciliation > 0 && (
        <div className="callout callout--warning" role="status">
          <p className="callout__title">
            {snapshot.counts.needsReconciliation}{" "}
            {snapshot.counts.needsReconciliation === 1 ? "item needs" : "items need"} physical count
            reconciliation
          </p>
          <p className="callout__body">
            Negative supply balances are flagged under INV-008/009 and are excluded from In Stock until
            reconciled in Inventory.
          </p>
        </div>
      )}

      <div className="dash-stocks-top-grid">
        <section className="card dash-panel" aria-labelledby="stock-overview-heading">
          <div className="dash-panel__header">
            <div>
              <h2 id="stock-overview-heading">Stock Overview</h2>
              <p className="muted-sm">Active product counts by Inventory group</p>
            </div>
          </div>

          {snapshot.overviewGroups.length === 0 ? (
            <p className="muted-sm">No active Inventory products to display.</p>
          ) : (
            <div className="dash-overview-body">
              <div className="dash-donut-wrap">
                <svg
                  className="dash-donut-svg"
                  viewBox="0 0 160 160"
                  role="img"
                  aria-label={`Stock Overview: ${snapshot.counts.totalProducts} active products across ${snapshot.overviewGroups.length} groups`}
                >
                  <circle
                    cx="80"
                    cy="80"
                    r={radius}
                    fill="none"
                    stroke="#e2e8f0"
                    strokeWidth="22"
                  />
                  {snapshot.overviewGroups.map((group) => {
                    const ratio =
                      snapshot.counts.totalProducts > 0
                        ? group.productCount / snapshot.counts.totalProducts
                        : 0;
                    const segmentLength = ratio * circumference;
                    const dashOffset = -runningOffset;
                    runningOffset += segmentLength;
                    return (
                      <circle
                        key={group.key}
                        cx="80"
                        cy="80"
                        r={radius}
                        fill="none"
                        stroke={group.color}
                        strokeWidth="22"
                        strokeDasharray={`${segmentLength} ${circumference}`}
                        strokeDashoffset={dashOffset}
                        transform="rotate(-90 80 80)"
                      />
                    );
                  })}
                  <text x="80" y="76" textAnchor="middle" className="dash-donut-total">
                    {snapshot.counts.totalProducts}
                  </text>
                  <text x="80" y="96" textAnchor="middle" className="dash-donut-label">
                    Total products
                  </text>
                </svg>
              </div>

              <ul className="dash-overview-legend">
                {snapshot.overviewGroups.map((group) => (
                  <li key={group.key} className="dash-overview-legend__row">
                    <span className="dash-overview-legend__label">
                      <span
                        className="dash-dot"
                        style={{ backgroundColor: group.color }}
                        aria-hidden="true"
                      />
                      <span>{group.title}</span>
                    </span>
                    <span className="muted-sm">
                      {group.productCount} {group.productCount === 1 ? "product" : "products"} ·{" "}
                      {group.sharePercent}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="card dash-panel" aria-labelledby="stock-alerts-heading">
          <div className="dash-panel__header">
            <div>
              <h2 id="stock-alerts-heading">Stock Alerts</h2>
              <p className="muted-sm">Out of Stock, Not Set, and reconciliation items</p>
            </div>
            {snapshot.alerts.length > 0 && (
              <span className="pill pill--neutral">{snapshot.alerts.length}</span>
            )}
          </div>

          {snapshot.alerts.length === 0 ? (
            <p className="muted-sm">All active products are currently in stock.</p>
          ) : (
            <ul className="dash-alert-list">
              {snapshot.alerts.map((alert) => (
                <li
                  key={alert.key}
                  className={`dash-alert-item dash-alert-item--${alert.severity.toLowerCase()}`}
                >
                  <div className="dash-alert-item__main">
                    <strong>{alert.productName}</strong>
                    <span className="muted-sm">
                      {alert.groupTitle} · {alert.detail}
                    </span>
                  </div>
                  <span
                    className={`pill ${
                      alert.severity === "OUT_OF_STOCK"
                        ? "pill--overdue"
                        : alert.severity === "NEEDS_RECONCILIATION"
                          ? "pill--warning"
                          : "pill--neutral"
                    }`}
                  >
                    {alert.badgeLabel}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="dash-panel__footer-link">
            <Link to="/inventory" className="dash-card-link">
              Open Inventory →
            </Link>
          </div>
        </section>
      </div>

      <section className="card dash-panel" aria-labelledby="stock-by-category-heading">
        <div className="dash-panel__header">
          <div>
            <h2 id="stock-by-category-heading">Stock by Category</h2>
            <p className="muted-sm">
              Initialized quantities grouped by category and recording unit (units kept separate)
            </p>
          </div>
        </div>

        {snapshot.categoryUnits.length === 0 ? (
          <p className="muted-sm">No active Inventory products to display.</p>
        ) : (
          <ul className="dash-category-list">
            {snapshot.categoryUnits.map((row) => {
              const barPercent =
                !row.isUnsetOnly &&
                row.totalQuantity !== null &&
                row.totalQuantity > 0 &&
                row.unitMaxQuantity > 0
                  ? Math.max(4, Math.round((row.totalQuantity / row.unitMaxQuantity) * 100))
                  : 0;

              return (
                <li key={row.key} className="dash-category-row">
                  <div className="dash-category-row__label">
                    <strong>{row.groupTitle}</strong>
                    <span className="muted-sm">
                      Unit: {row.unit}
                      {row.unsetCount > 0 && !row.isUnsetOnly
                        ? ` · ${row.unsetCount} Not Set`
                        : ""}
                    </span>
                  </div>

                  <div className="dash-category-row__track" aria-hidden="true">
                    {row.isUnsetOnly ? (
                      <div className="dash-category-row__unset-line" />
                    ) : row.totalQuantity !== null && row.totalQuantity < 0 ? (
                      <div className="dash-category-row__bar dash-category-row__bar--negative" />
                    ) : row.totalQuantity === 0 ? (
                      <div className="dash-category-row__bar dash-category-row__bar--zero" />
                    ) : (
                      <div
                        className="dash-category-row__bar"
                        style={{ width: `${barPercent}%` }}
                      />
                    )}
                  </div>

                  <div className="dash-category-row__value">
                    {row.isUnsetOnly ? (
                      <span className="pill pill--neutral">Not Set</span>
                    ) : (
                      <span className={row.hasNegative ? "dash-negative-qty" : ""}>
                        {formatQuantityLabel(row.totalQuantity, row.unit)}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
