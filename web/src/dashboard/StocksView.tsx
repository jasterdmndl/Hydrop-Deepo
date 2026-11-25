import { Link } from "react-router-dom";
import {
  formatQuantityLabel,
  formatRecordedAtManila,
  type InventoryItemView,
  type PosSectionView,
} from "../inventory/inventoryView";
import {
  buildStocksSnapshot,
  type DashboardStockTrendResponse,
  formatStockMovementTypeLabel,
} from "./dashboardView";

interface StocksViewProps {
  items: InventoryItemView[];
  posSections: PosSectionView[];
  hasLoaded: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedTrendItemKey: string | null;
  onSelectTrendItem: (itemKey: string) => void;
  stockTrend: DashboardStockTrendResponse | null;
  stockTrendLoading: boolean;
  stockTrendError: string | null;
  onRetryTrend: () => void;
}

function getPickerItemKey(item: InventoryItemView): string {
  return item.shape ?? item.id ?? item.code;
}

function StockTrendChart({ trend }: { trend: DashboardStockTrendResponse }) {
  const points = trend.points;
  if (points.length === 0) return null;

  const balances = points.map((p) => p.balanceAfter);
  const minVal = Math.min(0, ...balances);
  const maxVal = Math.max(1, ...balances);
  const range = Math.max(1, maxVal - minVal);

  const width = 640;
  const height = 180;
  const padLeft = 44;
  const padRight = 24;
  const padTop = 20;
  const padBottom = 28;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  const coords = points.map((point, index) => {
    const x =
      points.length === 1
        ? padLeft + innerW / 2
        : padLeft + (index / (points.length - 1)) * innerW;
    const y = padTop + innerH - ((point.balanceAfter - minVal) / range) * innerH;
    return { x, y, point };
  });

  const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");

  return (
    <div className="dash-stock-chart-wrap">
      <svg
        className="dash-stock-chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Inventory trend for ${trend.item.name} in ${trend.item.unit}: starts at ${formatQuantityLabel(points[0]!.balanceAfter, trend.item.unit)} and ends at ${formatQuantityLabel(points[points.length - 1]!.balanceAfter, trend.item.unit)} across ${points.length} ${points.length === 1 ? "record" : "records"}`}
      >
        <line
          x1={padLeft}
          y1={padTop}
          x2={padLeft}
          y2={height - padBottom}
          stroke="#cbd5e1"
          strokeWidth="1.5"
        />
        <line
          x1={padLeft}
          y1={height - padBottom}
          x2={width - padRight}
          y2={height - padBottom}
          stroke="#cbd5e1"
          strokeWidth="1.5"
        />
        <text x={padLeft - 6} y={padTop + 4} textAnchor="end" className="dash-stock-chart-axis">
          {maxVal}
        </text>
        <text
          x={padLeft - 6}
          y={height - padBottom + 4}
          textAnchor="end"
          className="dash-stock-chart-axis"
        >
          {minVal}
        </text>
        {coords.length > 1 && (
          <polyline
            fill="none"
            stroke="#1d63dc"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={polylinePoints}
          />
        )}
        {coords.map((c, idx) => (
          <g key={c.point.movementId ?? `opening-${idx}`}>
            <circle cx={c.x} cy={c.y} r="5" fill="#1d63dc" stroke="#ffffff" strokeWidth="2" />
            <text
              x={c.x}
              y={Math.max(12, c.y - 9)}
              textAnchor="middle"
              className="dash-stock-chart-val"
            >
              {c.point.balanceAfter}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function StocksView({
  items,
  posSections,
  hasLoaded,
  loading,
  error,
  onRetry,
  selectedTrendItemKey,
  onSelectTrendItem,
  stockTrend,
  stockTrendLoading,
  stockTrendError,
  onRetryTrend,
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
  const activePickerItems = items.filter((item) => item.archivedAt === null || item.archivedAt === undefined);

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
              <p className="muted-sm">Out of Stock, Low Stock, Not Set, and reconciliation items</p>
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
                        : alert.severity === "NEEDS_RECONCILIATION" || alert.severity === "LOW_STOCK"
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

      <section className="card dash-panel" aria-labelledby="inventory-trend-heading">
        <div className="dash-panel__header">
          <div>
            <h2 id="inventory-trend-heading">Inventory Trend</h2>
            <p className="muted-sm">
              Recorded balance history for one active product in its stock unit (from opening count)
            </p>
          </div>

          {activePickerItems.length > 0 && (
            <label className="dash-trend-picker" htmlFor="dash-stock-trend-select">
              <span className="muted-sm">Product</span>
              <select
                id="dash-stock-trend-select"
                aria-label="Select Inventory product for trend"
                value={selectedTrendItemKey ?? ""}
                onChange={(e) => onSelectTrendItem(e.target.value)}
              >
                {activePickerItems.map((item) => {
                  const key = getPickerItemKey(item);
                  return (
                    <option key={key} value={key}>
                      {item.name} ({item.unit})
                    </option>
                  );
                })}
              </select>
            </label>
          )}
        </div>

        {activePickerItems.length === 0 ? (
          <p className="muted-sm">No active Inventory products to display.</p>
        ) : stockTrendError ? (
          <div className="alert alert--error dash-inline-alert" role="alert">
            <span>{stockTrendError}</span>
            <button type="button" className="button button--ghost button--sm" onClick={onRetryTrend}>
              Retry
            </button>
          </div>
        ) : stockTrendLoading && !stockTrend ? (
          <p className="muted-sm" role="status">
            Loading product stock trend…
          </p>
        ) : !stockTrend ? (
          <p className="muted-sm">Select a product to view its recorded stock history.</p>
        ) : (
          <div className="dash-trend-body">
            {stockTrendLoading && (
              <div className="dash-refresh-note" role="status">
                Updating product stock trend…
              </div>
            )}

            <div className="dash-trend-meta-row">
              <span className="pill pill--neutral">
                Current balance:{" "}
                {stockTrend.item.status === "NOT_SET"
                  ? "Not Set"
                  : formatQuantityLabel(stockTrend.item.currentQuantity, stockTrend.item.unit)}
              </span>
              <span className="muted-sm">Unit: {stockTrend.item.unit}</span>
              {stockTrend.item.lowStockLevel !== null && (
                <span className="muted-sm">
                  Low stock alert: ≤ {formatQuantityLabel(stockTrend.item.lowStockLevel, stockTrend.item.unit)}
                </span>
              )}
            </div>

            {stockTrend.historyState === "NOT_SET" && (
              <div className="dash-empty-box">
                <p className="dash-empty-box__title">Not Set</p>
                <p className="muted-sm">
                  {stockTrend.historyMessage ?? "Opening count has not been recorded yet."}
                </p>
              </div>
            )}

            {stockTrend.historyState === "INCOMPLETE" && (
              <div className="callout callout--warning" role="status">
                <p className="callout__title">Stock history is incomplete</p>
                <p className="callout__body">
                  {stockTrend.historyMessage ??
                    "Available history cannot be reconciled to the current recorded balance."}
                </p>
              </div>
            )}

            {stockTrend.historyState === "COMPLETE" && (
              <>
                <StockTrendChart trend={stockTrend} />

                <div className="dash-table-wrap">
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th scope="col">Recorded At (Manila)</th>
                        <th scope="col">Event</th>
                        <th scope="col">Change</th>
                        <th scope="col">Balance</th>
                        <th scope="col">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stockTrend.points.map((point, idx) => (
                        <tr key={point.movementId ?? `opening-${idx}`}>
                          <td>{formatRecordedAtManila(point.recordedAt)}</td>
                          <td>{formatStockMovementTypeLabel(point.movementType)}</td>
                          <td>
                            {point.pointKind === "OPENING" ? (
                              "Opening"
                            ) : (
                              <span
                                className={
                                  point.quantityDelta > 0
                                    ? "dash-delta--positive"
                                    : "dash-delta--negative"
                                }
                              >
                                {point.quantityDelta > 0
                                  ? `+${formatQuantityLabel(point.quantityDelta, point.unit)}`
                                  : `−${formatQuantityLabel(Math.abs(point.quantityDelta), point.unit)}`}
                              </span>
                            )}
                          </td>
                          <td>
                            <strong>{formatQuantityLabel(point.balanceAfter, point.unit)}</strong>
                          </td>
                          <td>
                            {[point.reference, point.note, `By ${point.actor}`]
                              .filter(Boolean)
                              .join(" · ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </section>

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
