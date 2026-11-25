import { Link } from "react-router-dom";
import { formatTime12h, type RemindersResponse } from "../calendar/calendarView";
import { formatRecordedAtManila } from "../inventory/inventoryView";
import {
  describeTrendLeader,
  formatComparisonChangeSummary,
  formatDashboardPeso,
  formatDashboardPesoCompact,
  formatFullManilaDateLabel,
  formatManilaDateRange,
  formatTrendAxisLabel,
  formatWaterLiters,
  sortStationReminders,
  type DashboardSalesReport,
} from "./dashboardView";

interface SalesViewProps {
  report: DashboardSalesReport | null;
  loading: boolean;
  error: string | null;
  onRetrySales: () => void;
  reminders: RemindersResponse | null;
  remindersLoading: boolean;
  remindersError: string | null;
  onRetryReminders: () => void;
}

function CashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  );
}

function DropIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5c-3.8 4.6-6 8-6 11a6 6 0 0 0 12 0c0-3-2.2-6.4-6-11Z" />
      <path d="M9.5 15.5a2.8 2.8 0 0 0 2.5 2" />
    </svg>
  );
}

function WavesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8c2.2-1.5 4.3-1.5 6.5 0s4.3 1.5 6.5 0 3.3-1.2 5 0" />
      <path d="M3 13c2.2-1.5 4.3-1.5 6.5 0s4.3 1.5 6.5 0 3.3-1.2 5 0" />
      <path d="M3 18c2.2-1.5 4.3-1.5 6.5 0s4.3 1.5 6.5 0 3.3-1.2 5 0" />
    </svg>
  );
}

function ReceiptIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5h12v17l-2.5-1.5-2 1.5-1.5-1.5-1.5 1.5-2-1.5L6 20.5Z" />
      <path d="M9 8.5h6M9 12h6M9 15.5h3.5" />
    </svg>
  );
}

function CalendarCardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="16" rx="2" />
      <path d="M8 2.5v4M16 2.5v4M3.5 10h17" />
    </svg>
  );
}

function dayStatusLabel(status: "OPEN" | "CLOSED" | "NO_RECORD"): string {
  switch (status) {
    case "OPEN":
      return "Open";
    case "CLOSED":
      return "Closed";
    case "NO_RECORD":
      return "No record";
  }
}

function faucetLeaderPill(leader: "PUSH_TYPE" | "TWIST_TYPE" | "TIE" | null): string {
  switch (leader) {
    case "PUSH_TYPE":
      return "Push-Type leads";
    case "TWIST_TYPE":
      return "Twist-Type leads";
    case "TIE":
      return "Tie";
    default:
      return "0 units";
  }
}

export function SalesView({
  report,
  loading,
  error,
  onRetrySales,
  reminders,
  remindersLoading,
  remindersError,
  onRetryReminders,
}: SalesViewProps) {
  const sortedReminders = reminders ? sortStationReminders(reminders.items) : [];
  const visibleReminders = sortedReminders.slice(0, 5);
  const extraReminderCount = Math.max(0, sortedReminders.length - visibleReminders.length);

  const maxDailySales = report
    ? Math.max(0, ...report.trend.map((point) => point.salesCentavos ?? 0))
    : 0;
  const purifiedService = report?.service.find((s) => s.waterType === "PURIFIED");
  const alkalineService = report?.service.find((s) => s.waterType === "ALKALINE");
  const totalRefillVolumeMl =
    (purifiedService?.waterVolumeMl ?? 0) + (alkalineService?.waterVolumeMl ?? 0);
  const compactAxis = (report?.trend.length ?? 0) > 14;
  const trendLeaderCaption = report ? describeTrendLeader(report.trend) : null;
  const comparisonSummary = report ? formatComparisonChangeSummary(report.comparison) : null;

  const pushFaucet = report?.faucetSales.items.find((i) => i.type === "PUSH_TYPE");
  const twistFaucet = report?.faucetSales.items.find((i) => i.type === "TWIST_TYPE");
  const roundContainers = report?.containerSales.items.filter((i) => i.shape === "ROUND") ?? [];
  const slimContainers = report?.containerSales.items.filter((i) => i.shape === "SLIM") ?? [];

  return (
    <div className="dash-view-stack">
      {!report && error && (
        <section className="card dash-error-card" role="alert" aria-label="Sales report unavailable">
          <h2>Sales report unavailable</h2>
          <p className="muted-sm">{error}</p>
          <div className="dash-error-card__actions">
            <button type="button" className="button button--primary button--sm" onClick={onRetrySales}>
              Retry
            </button>
          </div>
        </section>
      )}

      {!report && !error && (
        <section className="card dash-loading-card" role="status">
          <p className="muted">Loading sales report…</p>
        </section>
      )}

      {report && (
        <>
          {error && (
            <div className="alert alert--error dash-inline-alert" role="alert">
              <span>{error}</span>
              <button type="button" className="button button--ghost button--sm" onClick={onRetrySales}>
                Retry
              </button>
            </div>
          )}

          {loading && (
            <div className="dash-refresh-note" role="status">
              Updating sales report…
            </div>
          )}

          <section className="dash-kpi-grid" aria-label="Sales summary metrics">
            <article className="card dash-kpi-card">
              <div className="dash-kpi-card__top">
                <span className="dash-kpi-card__label">Total Sales</span>
                <span className="dash-kpi-card__icon" aria-hidden="true">
                  <CashIcon />
                </span>
              </div>
              <p className="dash-kpi-card__value">{formatDashboardPeso(report.totals.salesCentavos)}</p>
              {comparisonSummary && (
                <div className="dash-kpi-diff">
                  <span
                    className={`dash-kpi-diff__badge dash-kpi-diff__badge--${comparisonSummary.tone}`}
                  >
                    {comparisonSummary.headline}
                  </span>
                  <span className="dash-kpi-diff__range">{comparisonSummary.rangeSummary}</span>
                  {!report.comparison.available && report.comparison.unavailableMessage && (
                    <span className="dash-kpi-diff__reason">{report.comparison.unavailableMessage}</span>
                  )}
                </div>
              )}
            </article>

            <article className="card dash-kpi-card">
              <div className="dash-kpi-card__top">
                <span className="dash-kpi-card__label">Containers Refilled</span>
                <span className="dash-kpi-card__icon" aria-hidden="true">
                  <DropIcon />
                </span>
              </div>
              <p className="dash-kpi-card__value">
                {report.totals.containersRefilled.toLocaleString("en-US")}
              </p>
              <p className="dash-kpi-card__caption">Standalone water refills</p>
            </article>

            <article className="card dash-kpi-card">
              <div className="dash-kpi-card__top">
                <span className="dash-kpi-card__label">Water Sold (L)</span>
                <span className="dash-kpi-card__icon" aria-hidden="true">
                  <WavesIcon />
                </span>
              </div>
              <p className="dash-kpi-card__value">{formatWaterLiters(report.totals.waterVolumeMl)}</p>
              <p className="dash-kpi-card__caption">Standalone refills &amp; filled packages</p>
            </article>

            <article className="card dash-kpi-card">
              <div className="dash-kpi-card__top">
                <span className="dash-kpi-card__label">Transactions</span>
                <span className="dash-kpi-card__icon" aria-hidden="true">
                  <ReceiptIcon />
                </span>
              </div>
              <p className="dash-kpi-card__value">
                {report.totals.transactions.toLocaleString("en-US")}
              </p>
              <p className="dash-kpi-card__caption">Active receipts · excludes voids</p>
            </article>
          </section>

          {report.range.recordedDayCount === 0 && (
            <div className="callout callout--info" role="status">
              <p className="callout__title">No recorded station business days in this range</p>
              <p className="callout__body">
                No Start Day or closed business-day records exist for{" "}
                {formatManilaDateRange(report.range.from, report.range.to)}. Days without a station record
                are marked <strong>No record</strong> rather than ₱0.
              </p>
            </div>
          )}

          <div className="dash-sales-main-grid">
            <section className="card dash-panel" aria-labelledby="sales-trend-heading">
              <div className="dash-panel__header">
                <div>
                  <h2 id="sales-trend-heading">Sales Trend</h2>
                  <p className="muted-sm">
                    Daily cash sales · {formatManilaDateRange(report.range.from, report.range.to)}
                  </p>
                </div>
                <span className="dash-total-pill">
                  {formatDashboardPesoCompact(report.totals.salesCentavos)} total
                </span>
              </div>

              <div className="dash-trend-scroll">
                <div
                  className={`dash-trend-bars ${compactAxis ? "dash-trend-bars--wide" : ""}`}
                  role="list"
                  aria-label="Daily sales trend"
                >
                  {report.trend.map((point) => {
                    const isToday = point.businessDate === report.range.todayDate;
                    const amount = point.salesCentavos;
                    const heightPct =
                      point.hasBusinessDay && amount !== null && maxDailySales > 0
                        ? Math.max(4, Math.round((amount / maxDailySales) * 100))
                        : 0;

                    return (
                      <div
                        key={point.businessDate}
                        role="listitem"
                        className="dash-trend-col"
                        aria-label={`${formatFullManilaDateLabel(point.businessDate)}: ${point.hasBusinessDay && amount !== null
                            ? `${formatDashboardPeso(amount)} (${dayStatusLabel(point.dayStatus)})`
                            : "No record"
                          }`}
                      >
                        <span
                          className={`dash-trend-col__value ${point.hasBusinessDay ? "" : "dash-trend-col__value--missing"
                            }`}
                        >
                          {point.hasBusinessDay && amount !== null
                            ? formatDashboardPesoCompact(amount)
                            : "No record"}
                        </span>

                        <div className="dash-trend-col__track">
                          {point.hasBusinessDay ? (
                            <div
                              className={`dash-trend-col__bar ${isToday ? "dash-trend-col__bar--today" : ""
                                } ${amount === 0 ? "dash-trend-col__bar--zero" : ""}`}
                              style={{ height: amount === 0 ? "4px" : `${heightPct}%` }}
                            />
                          ) : (
                            <div className="dash-trend-col__gap" aria-hidden="true" />
                          )}
                        </div>

                        <span
                          className={`dash-trend-col__date ${isToday ? "dash-trend-col__date--today" : ""
                            }`}
                        >
                          {formatTrendAxisLabel(point.businessDate, compactAxis)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {trendLeaderCaption && <p className="dash-panel__footnote">{trendLeaderCaption}</p>}

              <details className="dash-table-details">
                <summary className="dash-table-summary">
                  Daily sales table ({report.trend.length} {report.trend.length === 1 ? "day" : "days"})
                </summary>
                <div className="dash-table-wrap">
                  <table className="dash-table">
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Day Status</th>
                        <th scope="col">Transactions</th>
                        <th scope="col">Sales</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.trend.map((point) => (
                        <tr key={point.businessDate}>
                          <td>{formatFullManilaDateLabel(point.businessDate)}</td>
                          <td>
                            <span
                              className={`pill ${point.dayStatus === "NO_RECORD"
                                  ? "pill--neutral"
                                  : point.dayStatus === "OPEN"
                                    ? "pill--scheduled"
                                    : "pill--completed"
                                }`}
                            >
                              {dayStatusLabel(point.dayStatus)}
                            </span>
                          </td>
                          <td>
                            {point.transactions === null
                              ? "—"
                              : point.transactions.toLocaleString("en-US")}
                          </td>
                          <td>
                            {point.salesCentavos === null
                              ? "No record"
                              : formatDashboardPeso(point.salesCentavos)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>

            <section className="card dash-panel" aria-labelledby="refills-service-heading">
              <div className="dash-panel__header">
                <div>
                  <h2 id="refills-service-heading">Refills by Service</h2>
                  <p className="muted-sm">
                    {report.totals.containersRefilled > 0
                      ? `${report.totals.containersRefilled.toLocaleString("en-US")} standalone ${report.totals.containersRefilled === 1 ? "refill" : "refills"
                      } · ${formatWaterLiters(totalRefillVolumeMl)}`
                      : "Standalone customer-owned refills"}
                  </p>
                </div>
              </div>

              {report.totals.containersRefilled === 0 ? (
                <div className="dash-empty-box">
                  <p className="dash-empty-box__title">No standalone refills recorded in this period.</p>
                  {report.totals.waterVolumeMl > 0 && (
                    <p className="muted-sm">
                      Filled container packages contributed {formatWaterLiters(report.totals.waterVolumeMl)}{" "}
                      to Water Sold (L).
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <div className="dash-service-bar" role="presentation" aria-hidden="true">
                    {purifiedService && purifiedService.containers > 0 && (
                      <div
                        className="dash-service-bar__purified"
                        style={{ width: `${purifiedService.sharePercent ?? 0}%` }}
                      />
                    )}
                    {alkalineService && alkalineService.containers > 0 && (
                      <div
                        className="dash-service-bar__alkaline"
                        style={{ width: `${alkalineService.sharePercent ?? 0}%` }}
                      />
                    )}
                  </div>

                  <ul className="dash-service-list">
                    {report.service.map((item) => (
                      <li key={item.waterType} className="dash-service-row">
                        <div className="dash-service-row__meta">
                          <span className="dash-service-row__title">
                            <span
                              className={`dash-dot ${item.waterType === "PURIFIED"
                                  ? "dash-dot--purified"
                                  : "dash-dot--alkaline"
                                }`}
                              aria-hidden="true"
                            />
                            <strong>
                              {item.waterType === "PURIFIED" ? "Purified Refill" : "Alkaline Refill"}
                            </strong>
                          </span>
                          <span className="muted-sm">
                            {item.containers.toLocaleString("en-US")}{" "}
                            {item.containers === 1 ? "container" : "containers"} ·{" "}
                            {item.sharePercent !== null ? `${item.sharePercent}%` : "0%"} ·{" "}
                            {formatWaterLiters(item.waterVolumeMl)}
                          </span>
                        </div>
                        <span className="dash-service-row__amount">
                          {formatDashboardPeso(item.salesCentavos)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </div>

          <div className="dash-sales-breakdowns-grid">
            <section className="card dash-panel" aria-labelledby="faucet-sales-heading">
              <div className="dash-panel__header">
                <div>
                  <h2 id="faucet-sales-heading">Faucet Sales</h2>
                  <p className="muted-sm">
                    Standalone Push-Type &amp; Twist-Type purchases (excludes included package gripo)
                  </p>
                </div>
                <span className="pill pill--neutral">
                  {faucetLeaderPill(report.faucetSales.leader)}
                </span>
              </div>

              {report.faucetSales.totalUnits === 0 ? (
                <div className="dash-empty-box">
                  <p className="dash-empty-box__title">
                    No typed standalone faucet sales recorded in this period.
                  </p>
                </div>
              ) : (
                <>
                  <div className="dash-service-bar" role="presentation" aria-hidden="true">
                    {pushFaucet && pushFaucet.units > 0 && (
                      <div
                        className="dash-faucet-bar__push"
                        style={{ width: `${pushFaucet.sharePercent ?? 0}%` }}
                      />
                    )}
                    {twistFaucet && twistFaucet.units > 0 && (
                      <div
                        className="dash-faucet-bar__twist"
                        style={{ width: `${twistFaucet.sharePercent ?? 0}%` }}
                      />
                    )}
                  </div>

                  <ul className="dash-service-list">
                    {report.faucetSales.items.map((item) => (
                      <li key={item.type} className="dash-service-row">
                        <div className="dash-service-row__meta">
                          <span className="dash-service-row__title">
                            <span
                              className={`dash-dot ${item.type === "PUSH_TYPE" ? "dash-dot--push" : "dash-dot--twist"
                                }`}
                              aria-hidden="true"
                            />
                            <strong>{item.label}</strong>
                          </span>
                          <span className="muted-sm">
                            {item.units.toLocaleString("en-US")}{" "}
                            {item.units === 1 ? "unit" : "units"} ·{" "}
                            {item.sharePercent !== null ? `${item.sharePercent}%` : "0%"}
                          </span>
                        </div>
                        <span className="dash-service-row__amount">
                          {formatDashboardPeso(item.salesCentavos)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {report.faucetSales.unclassifiedUnits > 0 && (
                <p className="dash-panel__footnote" role="status">
                  {report.faucetSales.unclassifiedUnits.toLocaleString("en-US")} standalone{" "}
                  {report.faucetSales.unclassifiedUnits === 1 ? "faucet unit" : "faucet units"} (
                  {formatDashboardPeso(report.faucetSales.unclassifiedSalesCentavos)}) had no saved
                  Push/Twist classification and remain in Total Sales only.
                </p>
              )}
            </section>

            <section className="card dash-panel" aria-labelledby="container-sales-heading">
              <div className="dash-panel__header">
                <div>
                  <h2 id="container-sales-heading">Container Sales</h2>
                  <p className="muted-sm">New container packages with full saved package price</p>
                </div>
                <span className="dash-total-pill">
                  {report.containerSales.totalUnits.toLocaleString("en-US")}{" "}
                  {report.containerSales.totalUnits === 1 ? "unit" : "units"} ·{" "}
                  {formatDashboardPesoCompact(report.containerSales.totalSalesCentavos)}
                </span>
              </div>

              {report.containerSales.totalUnits === 0 ? (
                <div className="dash-empty-box">
                  <p className="dash-empty-box__title">
                    No container package sales recorded in this period.
                  </p>
                </div>
              ) : (
                <div className="dash-container-groups">
                  {[
                    { title: "Round Containers", items: roundContainers },
                    { title: "Slim Containers", items: slimContainers },
                  ].map((group) => (
                    <div key={group.title} className="dash-container-group">
                      <h3 className="dash-container-group__title">{group.title}</h3>
                      <ul className="dash-service-list">
                        {group.items.map((item) => (
                          <li key={item.packageCode} className="dash-service-row">
                            <div className="dash-service-row__meta">
                              <strong>{item.label}</strong>
                              <span className="muted-sm">
                                {item.units.toLocaleString("en-US")}{" "}
                                {item.units === 1 ? "package" : "packages"}
                                {item.waterVolumeMl > 0
                                  ? ` · ${formatWaterLiters(item.waterVolumeMl)}`
                                  : ""}
                              </span>
                            </div>
                            <span className="dash-service-row__amount">
                              {formatDashboardPeso(item.salesCentavos)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {report.priorDaySettlements.length > 0 && (
            <section className="card dash-panel" aria-labelledby="prior-day-settlements-heading">
              <div className="dash-panel__header">
                <div>
                  <h2 id="prior-day-settlements-heading">Prior-Day Settlements</h2>
                  <p className="muted-sm">
                    Settled separately on actual settlement date (DEC-048 / DEC-075). Not added to normal
                    daily sales or closed reports.
                  </p>
                </div>
                <span className="pill pill--warning">
                  {report.priorDaySettlements.length}{" "}
                  {report.priorDaySettlements.length === 1 ? "settlement" : "settlements"}
                </span>
              </div>

              <ul className="dash-settlement-list">
                {report.priorDaySettlements.map((entry) => (
                  <li key={entry.checkoutReference} className="dash-settlement-row">
                    <div className="dash-settlement-row__info">
                      <strong>{entry.checkoutReference}</strong>
                      <span className="muted-sm">
                        Original day: {formatFullManilaDateLabel(entry.originalBusinessDate)} · Settled:{" "}
                        {formatFullManilaDateLabel(entry.settlementDate)} (
                        {formatRecordedAtManila(entry.settledAt)}) · By {entry.settledBy}
                      </span>
                      {entry.note && <span className="muted-sm">Note: {entry.note}</span>}
                    </div>
                    <span className="dash-settlement-row__amount">
                      {formatDashboardPeso(entry.netAmountKeptCentavos)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <div className="dash-sales-bottom-grid">
        {report && (
          <section className="card dash-panel" aria-labelledby="recommendations-heading">
            <div className="dash-panel__header">
              <div>
                <h2 id="recommendations-heading">What the Numbers Tell You</h2>
                <p className="muted-sm">Rule-based observations from current station records</p>
              </div>
              <span className="pill pill--neutral">{report.recommendations.length}</span>
            </div>

            {report.recommendations.length === 0 ? (
              <div className="dash-empty-box">
                <p className="dash-empty-box__title">
                  No Recommendations Available for the Current Data
                </p>
              </div>
            ) : (
              <ul className="dash-rec-list">
                {report.recommendations.map((rec) => (
                  <li key={rec.id} className="dash-rec-item">
                    <strong className="dash-rec-item__title">{rec.title}</strong>
                    <p className="muted-sm">
                      <strong>Observation:</strong> {rec.observation}
                    </p>
                    <p className="muted-sm">
                      <strong>Suggested action:</strong> {rec.suggestedAction}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="card dash-panel" aria-labelledby="station-reminders-heading">
          <div className="dash-panel__header">
            <div>
              <h2 id="station-reminders-heading">Station Reminders</h2>
              <p className="muted-sm">Live Calendar reminder window (overdue first, unaffected by sales dates)</p>
            </div>
            <span className="dash-kpi-card__icon" aria-hidden="true">
              <CalendarCardIcon />
            </span>
          </div>

          {remindersError ? (
            <div className="alert alert--error dash-inline-alert" role="alert">
              <span>{remindersError}</span>
              <button type="button" className="button button--ghost button--sm" onClick={onRetryReminders}>
                Retry
              </button>
            </div>
          ) : remindersLoading && !reminders ? (
            <p className="muted-sm" role="status">
              Checking station reminders…
            </p>
          ) : reminders && reminders.items.length === 0 ? (
            <p className="muted-sm">No overdue or upcoming activities in the next 7 days.</p>
          ) : (
            <div className="dash-reminders-body">
              {reminders && (
                <div className="dash-reminders-counts">
                  <span className={`pill ${reminders.overdueCount > 0 ? "pill--overdue" : "pill--neutral"}`}>
                    {reminders.overdueCount} overdue
                  </span>
                  <span className="pill pill--scheduled">{reminders.upcomingCount} upcoming</span>
                </div>
              )}
              <ul className="dash-reminder-list">
                {visibleReminders.map((item) => (
                  <li
                    key={item.reference}
                    className={`dash-reminder-item ${item.status === "OVERDUE" ? "dash-reminder-item--overdue" : ""
                      }`}
                  >
                    <div className="dash-reminder-item__main">
                      <span
                        className={`pill ${item.status === "OVERDUE" ? "pill--overdue" : "pill--scheduled"
                          }`}
                      >
                        {item.status === "OVERDUE" ? "Overdue" : "Upcoming"}
                      </span>
                      <strong>{item.name}</strong>
                    </div>
                    <span className="muted-sm">
                      {formatFullManilaDateLabel(item.scheduledDate)} · {formatTime12h(item.scheduledTime)}
                    </span>
                  </li>
                ))}
              </ul>
              {extraReminderCount > 0 && (
                <p className="muted-sm">
                  +{extraReminderCount} more {extraReminderCount === 1 ? "activity" : "activities"} in Activity
                  Calendar.
                </p>
              )}
            </div>
          )}

          <div className="dash-panel__footer-link">
            <Link to="/calendar" className="dash-card-link">
              View Activity Calendar →
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
