import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { createRequestTracker } from "../calendar/calendarView";
import {
  formatCentavos,
  formatLiters,
  formatManilaTimeOnly,
  formatManilaTimestamp,
  type PriorDaySettlementView,
  type SalesListResponse,
  type SaleView,
} from "./posRecovery";

export interface SaleHistoryProps {
  todayDate: string;
  initialReference?: string | null;
  initialSettlementRef?: string | null;
  refreshSignal?: number;
}

type StatusFilter = "ALL" | "ACTIVE" | "VOIDED";

type SelectedHistoryItem =
  | { kind: "sale"; sale: SaleView }
  | { kind: "settlement"; settlement: PriorDaySettlementView };

function saleStatusPill(status: SaleView["status"]): string {
  return status === "ACTIVE" ? "pill--completed" : "pill--overdue";
}

function saleActionLabel(action: SaleView["actionHistory"][number]["action"]): string {
  return action === "SALE_SAVED" ? "Sale saved" : "Sale voided";
}

export function SaleHistory({
  todayDate,
  initialReference,
  initialSettlementRef,
  refreshSignal = 0,
}: SaleHistoryProps) {
  const [dateFilter, setDateFilter] = useState(todayDate);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [sales, setSales] = useState<SaleView[]>([]);
  const [settlements, setSettlements] = useState<PriorDaySettlementView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<SelectedHistoryItem | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const listTrackerRef = useRef(createRequestTracker());
  const detailTrackerRef = useRef(createRequestTracker());
  const pendingFocusRef = useRef<string | null>(initialReference ?? null);
  const pendingSettlementFocusRef = useRef<string | null>(initialSettlementRef ?? null);

  useEffect(() => {
    if (!dateFilter && todayDate) {
      setDateFilter(todayDate);
    }
  }, [dateFilter, todayDate]);

  useEffect(() => {
    if (initialReference) {
      pendingFocusRef.current = initialReference;
      pendingSettlementFocusRef.current = null;
    }
  }, [initialReference]);

  useEffect(() => {
    if (initialSettlementRef) {
      pendingSettlementFocusRef.current = initialSettlementRef;
      pendingFocusRef.current = null;
    }
  }, [initialSettlementRef]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAppliedQuery(searchInput.trim());
    }, 180);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadSales = useCallback(
    async (date: string, status: StatusFilter, query: string) => {
      const requestId = listTrackerRef.current.next();
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ date, status });
        if (query) params.set("q", query);
        const res = await api<SalesListResponse>(`/api/pos/sales?${params.toString()}`);
        if (!listTrackerRef.current.isCurrent(requestId)) return;
        const loadedSettlements = res.priorDaySettlements ?? [];
        setSales(res.sales);
        setSettlements(loadedSettlements);

        const targetSettlementRef = pendingSettlementFocusRef.current;
        if (targetSettlementRef) {
          const settlementMatch = loadedSettlements.find(
            (item) => item.checkoutReference === targetSettlementRef,
          );
          if (settlementMatch) {
            pendingSettlementFocusRef.current = null;
            setSelectedItem({ kind: "settlement", settlement: settlementMatch });
            return;
          }
        }

        const targetRef = pendingFocusRef.current;
        if (targetRef) {
          const match = res.sales.find((item) => item.reference === targetRef);
          if (match) {
            pendingFocusRef.current = null;
            setSelectedItem({ kind: "sale", sale: match });
            return;
          }
        }

        setSelectedItem((current) => {
          if (current?.kind === "sale") {
            const matchedSale = res.sales.find(
              (item) => item.reference === current.sale.reference,
            );
            if (matchedSale) return { kind: "sale", sale: matchedSale };
          }
          if (current?.kind === "settlement") {
            const matchedSettlement = loadedSettlements.find(
              (item) => item.checkoutReference === current.settlement.checkoutReference,
            );
            if (matchedSettlement) {
              return { kind: "settlement", settlement: matchedSettlement };
            }
          }
          if (res.sales[0]) return { kind: "sale", sale: res.sales[0] };
          if (loadedSettlements[0]) {
            return { kind: "settlement", settlement: loadedSettlements[0] };
          }
          return null;
        });
      } catch (err) {
        if (!listTrackerRef.current.isCurrent(requestId)) return;
        setError(err instanceof ApiError ? err.message : "Could not load transaction history.");
      } finally {
        if (listTrackerRef.current.isCurrent(requestId)) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void loadSales(dateFilter, statusFilter, appliedQuery);
  }, [dateFilter, statusFilter, appliedQuery, refreshSignal, loadSales]);

  useEffect(() => {
    if (!initialReference) return;
    const requestId = detailTrackerRef.current.next();
    setDetailError(null);
    api<SaleView & { sale?: SaleView }>(`/api/pos/sales/${encodeURIComponent(initialReference)}`)
      .then((res) => {
        if (!detailTrackerRef.current.isCurrent(requestId)) return;
        const sale = res.sale ?? res;
        setSelectedItem({ kind: "sale", sale });
        setDateFilter(sale.businessDate);
      })
      .catch((err) => {
        if (!detailTrackerRef.current.isCurrent(requestId)) return;
        setDetailError(err instanceof ApiError ? err.message : "Could not load sale details.");
      });
  }, [initialReference]);

  useEffect(() => {
    if (!initialSettlementRef) return;
    const requestId = detailTrackerRef.current.next();
    setDetailError(null);
    api<PriorDaySettlementView & { settlement?: PriorDaySettlementView }>(
      `/api/pos/settlements/${encodeURIComponent(initialSettlementRef)}`,
    )
      .then((res) => {
        if (!detailTrackerRef.current.isCurrent(requestId)) return;
        const settlement = res.settlement ?? res;
        setSelectedItem({ kind: "settlement", settlement });
        setDateFilter(settlement.settlementDate);
      })
      .catch((err) => {
        if (!detailTrackerRef.current.isCurrent(requestId)) return;
        setDetailError(
          err instanceof ApiError ? err.message : "Could not load prior-day settlement details.",
        );
      });
  }, [initialSettlementRef]);

  async function selectSale(reference: string) {
    const local = sales.find((item) => item.reference === reference);
    if (local) setSelectedItem({ kind: "sale", sale: local });
    const requestId = detailTrackerRef.current.next();
    setDetailError(null);
    try {
      const res = await api<SaleView & { sale?: SaleView }>(`/api/pos/sales/${encodeURIComponent(reference)}`);
      if (!detailTrackerRef.current.isCurrent(requestId)) return;
      setSelectedItem({ kind: "sale", sale: res.sale ?? res });
    } catch (err) {
      if (!detailTrackerRef.current.isCurrent(requestId)) return;
      setDetailError(err instanceof ApiError ? err.message : "Could not refresh sale details.");
    }
  }

  async function selectSettlement(reference: string) {
    const local = settlements.find((item) => item.checkoutReference === reference);
    if (local) setSelectedItem({ kind: "settlement", settlement: local });
    const requestId = detailTrackerRef.current.next();
    setDetailError(null);
    try {
      const res = await api<PriorDaySettlementView & { settlement?: PriorDaySettlementView }>(
        `/api/pos/settlements/${encodeURIComponent(reference)}`,
      );
      if (!detailTrackerRef.current.isCurrent(requestId)) return;
      setSelectedItem({ kind: "settlement", settlement: res.settlement ?? res });
    } catch (err) {
      if (!detailTrackerRef.current.isCurrent(requestId)) return;
      setDetailError(
        err instanceof ApiError ? err.message : "Could not refresh prior-day settlement details.",
      );
    }
  }

  const selectedSale = selectedItem?.kind === "sale" ? selectedItem.sale : null;
  const selectedSettlement = selectedItem?.kind === "settlement" ? selectedItem.settlement : null;

  return (
    <section className="subview" aria-label="Transaction History">
      <div className="card pos-history-filters">
        <div className="pos-history-filters__grid">
          <label className="field">
            <span>Business / settlement date</span>
            <div className="pos-date-row">
              <input
                type="date"
                aria-label="History business date"
                value={dateFilter}
                onChange={(event) => setDateFilter(event.target.value)}
              />
              <button
                type="button"
                className="button button--ghost button--sm"
                disabled={dateFilter === todayDate}
                onClick={() => setDateFilter(todayDate)}
              >
                Today
              </button>
            </div>
          </label>

          <label className="field">
            <span>Status</span>
            <select
              aria-label="Sale status filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            >
              <option value="ALL">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="VOIDED">Voided</option>
            </select>
          </label>

          <form
            className="field"
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedQuery(searchInput.trim());
            }}
          >
            <span>Reference search</span>
            <div className="pos-search-row">
              <input
                type="search"
                aria-label="Search transaction reference"
                placeholder="e.g. HD-1119-001"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
              />
              {searchInput && (
                <button
                  type="button"
                  className="button button--ghost button--sm"
                  onClick={() => {
                    setSearchInput("");
                    setAppliedQuery("");
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </form>
        </div>
      </div>

      {error && (
        <div className="alert alert--error" role="alert">
          {error}{" "}
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={() => void loadSales(dateFilter, statusFilter, appliedQuery)}
          >
            Retry
          </button>
        </div>
      )}

      <div className="two-col-layout">
        <div className="history-list-stack">
          <article className="card history-panel">
            <div className="detail-card__header">
              <h2>Saved sales</h2>
              <span className="pill pill--neutral">
                {sales.length} transaction{sales.length === 1 ? "" : "s"}
              </span>
            </div>

            {loading ? (
              <p className="muted">Loading sales for {dateFilter}…</p>
            ) : sales.length === 0 ? (
              <p className="muted">No saved transactions match {dateFilter}.</p>
            ) : (
              <div className="table-wrap">
                <table className="history-table pos-history-table">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Time &amp; operator</th>
                      <th>Status</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.map((sale) => {
                      const isSelected = selectedSale?.reference === sale.reference;
                      return (
                        <tr
                          key={sale.reference}
                          className={`history-row ${isSelected ? "history-row--selected" : ""}`}
                          onClick={() => void selectSale(sale.reference)}
                        >
                          <td>
                            <button
                              type="button"
                              className="history-row__button"
                              aria-current={isSelected ? "true" : undefined}
                              onClick={(event) => {
                                event.stopPropagation();
                                void selectSale(sale.reference);
                              }}
                            >
                              <strong className="mono-ref">{sale.reference}</strong>
                              <span className="muted-sm">
                                {sale.totalContainers} container{sale.totalContainers === 1 ? "" : "s"} ·{" "}
                                {formatLiters(sale.totalVolumeLiters)}
                              </span>
                            </button>
                          </td>
                          <td className="history-td--completed" data-label="Time & operator">
                            <div className="history-cell-stack">
                              <span>{formatManilaTimeOnly(sale.createdAt)}</span>
                              <span className="muted-sm">{sale.createdBy}</span>
                            </div>
                          </td>
                          <td className="history-td--recorder" data-label="Status">
                            <span className={`pill ${saleStatusPill(sale.status)}`}>
                              {sale.status === "ACTIVE" ? "Active" : "Voided"}
                            </span>
                          </td>
                          <td className="history-td--recorder" data-label="Total">
                            <strong>{formatCentavos(sale.totalCentavos)}</strong>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <article className="card history-panel" aria-label="Prior-day settlements">
            <div className="detail-card__header">
              <div>
                <h2>Prior-day settlements</h2>
                <p className="muted-sm">
                  Settled on {dateFilter}, recorded separately from that day&apos;s refill sales.
                </p>
              </div>
              <span className="pill pill--neutral">
                {settlements.length} settled
              </span>
            </div>

            {loading ? (
              <p className="muted">Loading prior-day settlements for {dateFilter}…</p>
            ) : settlements.length === 0 ? (
              <p className="muted">No prior-day settlements recorded on {dateFilter}.</p>
            ) : (
              <div className="table-wrap">
                <table className="history-table pos-history-table">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Original payment</th>
                      <th>Settled on</th>
                      <th>Kept</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settlements.map((settlement) => {
                      const isSelected =
                        selectedSettlement?.checkoutReference === settlement.checkoutReference;
                      return (
                        <tr
                          key={settlement.checkoutReference}
                          className={`history-row ${isSelected ? "history-row--selected" : ""}`}
                          onClick={() => void selectSettlement(settlement.checkoutReference)}
                        >
                          <td>
                            <button
                              type="button"
                              className="history-row__button"
                              aria-current={isSelected ? "true" : undefined}
                              onClick={(event) => {
                                event.stopPropagation();
                                void selectSettlement(settlement.checkoutReference);
                              }}
                            >
                              <strong className="mono-ref">{settlement.checkoutReference}</strong>
                              <span className="muted-sm">
                                {settlement.totalContainers} container
                                {settlement.totalContainers === 1 ? "" : "s"} ·{" "}
                                {formatLiters(settlement.totalVolumeLiters)}
                              </span>
                            </button>
                          </td>
                          <td className="history-td--completed" data-label="Original payment">
                            <div className="history-cell-stack">
                              <span>{settlement.originalBusinessDate}</span>
                              <span className="muted-sm">{settlement.originalActor}</span>
                            </div>
                          </td>
                          <td className="history-td--recorder" data-label="Settled on">
                            <div className="history-cell-stack">
                              <span>{settlement.settlementDate}</span>
                              <span className="muted-sm">{settlement.settledBy}</span>
                            </div>
                          </td>
                          <td className="history-td--recorder" data-label="Kept">
                            <strong>{formatCentavos(settlement.netAmountKeptCentavos)}</strong>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        </div>

        <aside className="side-stack">
          <article className="card detail-card" aria-label="Sale details">
            <div className="detail-card__header">
              <h2>{selectedSettlement ? "Prior-day settlement" : "Sale details"}</h2>
              {selectedSale && (
                <span className={`pill ${saleStatusPill(selectedSale.status)}`}>
                  {selectedSale.status === "ACTIVE" ? "Active" : "Voided"}
                </span>
              )}
              {selectedSettlement && (
                <span className="pill pill--completed">Paid &amp; delivered</span>
              )}
            </div>

            {detailError && (
              <div className="alert alert--error" role="alert">
                {detailError}
              </div>
            )}

            {!selectedSale && !selectedSettlement ? (
              <p className="muted-sm">
                Select a transaction or prior-day settlement to inspect its items, cash details, and audit log.
              </p>
            ) : selectedSettlement ? (
              <>
                <div>
                  <h3 className="detail-card__name mono-ref">
                    {selectedSettlement.checkoutReference}
                  </h3>
                  <p className="muted-sm">
                    Settled {formatManilaTimestamp(selectedSettlement.settledAt)}
                  </p>
                </div>

                <div className="callout callout--info">
                  <p className="callout__title">No further payment collected</p>
                  <p className="callout__body">
                    Recorded on {selectedSettlement.settlementDate} for a refill paid and delivered on{" "}
                    {selectedSettlement.originalBusinessDate}. Kept separate from{" "}
                    {selectedSettlement.settlementDate} refill sales.
                  </p>
                </div>

                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>Settlement date (Manila)</dt>
                    <dd>{selectedSettlement.settlementDate}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Original payment date</dt>
                    <dd>{selectedSettlement.originalBusinessDate}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Original operator</dt>
                    <dd>{selectedSettlement.originalActor}</dd>
                  </div>
                  {selectedSettlement.originalPaymentStartedAt && (
                    <div className="detail-list__row">
                      <dt>Payment started</dt>
                      <dd>{formatManilaTimestamp(selectedSettlement.originalPaymentStartedAt)}</dd>
                    </div>
                  )}
                  <div className="detail-list__row">
                    <dt>Payment recorded</dt>
                    <dd>
                      {selectedSettlement.originalPaymentRecordedAt
                        ? formatManilaTimestamp(selectedSettlement.originalPaymentRecordedAt)
                        : "Not recorded"}
                    </dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Confirmed by Owner</dt>
                    <dd>{selectedSettlement.settledBy}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Containers</dt>
                    <dd>{selectedSettlement.totalContainers}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Water volume</dt>
                    <dd>{formatLiters(selectedSettlement.totalVolumeLiters)}</dd>
                  </div>
                </dl>

                <ul className="pos-summary-lines">
                  {selectedSettlement.items.map((item) => (
                    <li key={`${item.lineIndex}-${item.displayLabel}`} className="pos-summary-line">
                      <div className="pos-summary-line__meta">
                        <strong>{item.displayLabel}</strong>
                        <span className="muted-sm">
                          {item.quantity} × {formatCentavos(item.unitPriceCentavos)} ·{" "}
                          {formatLiters(item.lineVolumeLiters)}
                        </span>
                      </div>
                      <span className="pos-summary-line__amount">
                        {formatCentavos(item.lineTotalCentavos)}
                      </span>
                    </li>
                  ))}
                </ul>

                <dl className="detail-list">
                  <div className="detail-list__row detail-list__row--total">
                    <dt>Net amount kept</dt>
                    <dd>{formatCentavos(selectedSettlement.netAmountKeptCentavos)}</dd>
                  </div>
                  {selectedSettlement.cashReceivedCentavos !== null && (
                    <>
                      <div className="detail-list__row">
                        <dt>Cash received</dt>
                        <dd>{formatCentavos(selectedSettlement.cashReceivedCentavos)}</dd>
                      </div>
                      {selectedSettlement.changeCentavos !== null && (
                        <div className="detail-list__row">
                          <dt>Change</dt>
                          <dd>{formatCentavos(selectedSettlement.changeCentavos)}</dd>
                        </div>
                      )}
                    </>
                  )}
                </dl>

                <div className="detail-notes">
                  <h3>Settlement confirmation</h3>
                  <ul className="pos-action-log">
                    <li>
                      <strong>Payment kept &amp; refill delivered</strong> confirmed by{" "}
                      {selectedSettlement.settledBy} ·{" "}
                      {formatManilaTimestamp(selectedSettlement.settledAt)}
                      {selectedSettlement.note ? ` — ${selectedSettlement.note}` : ""}
                    </li>
                  </ul>
                </div>
              </>
            ) : selectedSale ? (
              <>
                <div>
                  <h3 className="detail-card__name mono-ref">{selectedSale.reference}</h3>
                  <p className="muted-sm">{formatManilaTimestamp(selectedSale.createdAt)}</p>
                </div>

                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>Business date</dt>
                    <dd>{selectedSale.businessDate}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Operator</dt>
                    <dd>{selectedSale.createdBy}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Containers</dt>
                    <dd>{selectedSale.totalContainers}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Water volume</dt>
                    <dd>{formatLiters(selectedSale.totalVolumeLiters)}</dd>
                  </div>
                </dl>

                <ul className="pos-summary-lines">
                  {selectedSale.items.map((item) => (
                    <li key={`${item.lineIndex}-${item.displayLabel}`} className="pos-summary-line">
                      <div className="pos-summary-line__meta">
                        <strong>{item.displayLabel}</strong>
                        <span className="muted-sm">
                          {item.quantity} × {formatCentavos(item.unitPriceCentavos)} ·{" "}
                          {formatLiters(item.lineVolumeLiters)}
                        </span>
                      </div>
                      <span className="pos-summary-line__amount">{formatCentavos(item.lineTotalCentavos)}</span>
                    </li>
                  ))}
                </ul>

                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>Total amount</dt>
                    <dd>{formatCentavos(selectedSale.totalCentavos)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Cash received</dt>
                    <dd>{formatCentavos(selectedSale.cashReceivedCentavos)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Change</dt>
                    <dd>{formatCentavos(selectedSale.changeCentavos)}</dd>
                  </div>
                </dl>

                <div className="detail-notes">
                  <h3>Action history</h3>
                  <ul className="pos-action-log">
                    {selectedSale.actionHistory.map((entry, idx) => (
                      <li key={`${entry.action}-${idx}`}>
                        <strong>{saleActionLabel(entry.action)}</strong> by {entry.actor} ·{" "}
                        {formatManilaTimestamp(entry.recordedAt)}
                        {entry.note ? ` — ${entry.note}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}
          </article>
        </aside>
      </div>
    </section>
  );
}
