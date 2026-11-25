import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useSignedInUser } from "../auth/AuthContext";
import { createRequestTracker, type RemindersResponse } from "../calendar/calendarView";
import { AppShell, useModulesData } from "../ChooseModule";
import { type InventoryItemsResponse, type InventoryItemView, type PosSectionView } from "../inventory/inventoryView";
import {
  type DashboardPeriod,
  type DashboardSalesReport,
  type DashboardStockTrendResponse,
  type DashboardViewMode,
  formatCutoffClock,
  formatManilaDateRange,
  getDefaultWeekStartManila,
  getTodayManilaDate,
  validateCustomRange,
} from "./dashboardView";
import { SalesView } from "./SalesView";
import { StocksView } from "./StocksView";

function CalendarPillIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="16" rx="2" />
      <path d="M8 2.5v4M16 2.5v4M3.5 10h17" />
    </svg>
  );
}

function buildSalesKey(period: DashboardPeriod, customRange: { from: string; to: string }): string {
  return period === "custom" ? `custom:${customRange.from}:${customRange.to}` : period;
}

export function DashboardPage() {
  const user = useSignedInUser();
  const { data: modulesData } = useModulesData();

  const initialToday = useMemo(() => getTodayManilaDate(), []);
  const initialWeekStart = useMemo(() => getDefaultWeekStartManila(), []);

  const [viewMode, setViewMode] = useState<DashboardViewMode>("sales");
  const [period, setPeriod] = useState<DashboardPeriod>("week");
  const [draftFrom, setDraftFrom] = useState(initialWeekStart);
  const [draftTo, setDraftTo] = useState(initialToday);
  const [appliedCustom, setAppliedCustom] = useState({ from: initialWeekStart, to: initialToday });
  const [customValidationError, setCustomValidationError] = useState<string | null>(null);

  const [salesReportState, setSalesReportState] = useState<{
    key: string;
    report: DashboardSalesReport;
  } | null>(null);
  const [salesErrorState, setSalesErrorState] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [salesLoadingKey, setSalesLoadingKey] = useState<string | null>(null);

  const [reminders, setReminders] = useState<RemindersResponse | null>(null);
  const [remindersLoading, setRemindersLoading] = useState(true);
  const [remindersError, setRemindersError] = useState<string | null>(null);

  const [stockItems, setStockItems] = useState<InventoryItemView[]>([]);
  const [stockSections, setStockSections] = useState<PosSectionView[]>([]);
  const [stocksHasLoaded, setStocksHasLoaded] = useState(false);
  const [stocksLoading, setStocksLoading] = useState(false);
  const [stocksError, setStocksError] = useState<string | null>(null);

  const [selectedTrendItemKey, setSelectedTrendItemKey] = useState<string | null>(null);
  const [stockTrendState, setStockTrendState] = useState<{
    key: string;
    trend: DashboardStockTrendResponse;
  } | null>(null);
  const [stockTrendErrorState, setStockTrendErrorState] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [stockTrendLoadingKey, setStockTrendLoadingKey] = useState<string | null>(null);

  const salesTrackerRef = useRef(createRequestTracker());
  const remindersTrackerRef = useRef(createRequestTracker());
  const stocksTrackerRef = useRef(createRequestTracker());
  const stockTrendTrackerRef = useRef(createRequestTracker());

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Dashboard — Hydrop Deepo";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const activeSalesKey = useMemo(
    () => buildSalesKey(period, appliedCustom),
    [period, appliedCustom],
  );

  const loadSales = useCallback(
    async (targetPeriod: DashboardPeriod, customRange: { from: string; to: string }) => {
      if (user.role !== "OWNER") return;
      const key = buildSalesKey(targetPeriod, customRange);
      const requestId = salesTrackerRef.current.next();
      setSalesLoadingKey(key);
      setSalesErrorState((prev) => (prev?.key === key ? null : prev));

      const params = new URLSearchParams({ period: targetPeriod });
      if (targetPeriod === "custom") {
        params.set("from", customRange.from);
        params.set("to", customRange.to);
      }

      try {
        const next = await api<DashboardSalesReport>(`/api/dashboard/sales?${params.toString()}`);
        if (!salesTrackerRef.current.isCurrent(requestId)) return;
        setSalesReportState({ key, report: next });
        setSalesErrorState(null);
      } catch (err) {
        if (!salesTrackerRef.current.isCurrent(requestId)) return;
        setSalesErrorState({
          key,
          message: err instanceof ApiError ? err.message : "Could not load Dashboard sales report.",
        });
      } finally {
        if (salesTrackerRef.current.isCurrent(requestId)) {
          setSalesLoadingKey((current) => (current === key ? null : current));
        }
      }
    },
    [user.role],
  );

  const loadReminders = useCallback(async () => {
    if (user.role !== "OWNER") return;
    const requestId = remindersTrackerRef.current.next();
    setRemindersLoading(true);
    setRemindersError(null);
    try {
      const next = await api<RemindersResponse>("/api/calendar/reminders", { background: true });
      if (!remindersTrackerRef.current.isCurrent(requestId)) return;
      setReminders(next);
    } catch (err) {
      if (!remindersTrackerRef.current.isCurrent(requestId)) return;
      setRemindersError(
        err instanceof ApiError ? err.message : "Could not load station reminders.",
      );
    } finally {
      if (remindersTrackerRef.current.isCurrent(requestId)) {
        setRemindersLoading(false);
      }
    }
  }, [user.role]);

  const loadStocks = useCallback(async () => {
    if (user.role !== "OWNER") return;
    const requestId = stocksTrackerRef.current.next();
    setStocksLoading(true);
    setStocksError(null);
    try {
      const next = await api<InventoryItemsResponse>("/api/inventory/items");
      if (!stocksTrackerRef.current.isCurrent(requestId)) return;
      setStockItems(next.items);
      setStockSections(next.posSections ?? []);
      setStocksHasLoaded(true);
      const activeKeys = next.items.map((item) => item.shape ?? item.id ?? item.code);
      setSelectedTrendItemKey((prev) => {
        if (prev && activeKeys.includes(prev)) return prev;
        return activeKeys[0] ?? null;
      });
    } catch (err) {
      if (!stocksTrackerRef.current.isCurrent(requestId)) return;
      setStocksError(
        err instanceof ApiError ? err.message : "Could not load current Inventory stock.",
      );
    } finally {
      if (stocksTrackerRef.current.isCurrent(requestId)) {
        setStocksLoading(false);
      }
    }
  }, [user.role]);

  const loadStockTrend = useCallback(
    async (itemKey: string) => {
      if (user.role !== "OWNER" || !itemKey) return;
      const requestId = stockTrendTrackerRef.current.next();
      setStockTrendLoadingKey(itemKey);
      setStockTrendErrorState((prev) => (prev?.key === itemKey ? null : prev));
      try {
        const next = await api<DashboardStockTrendResponse>(
          `/api/dashboard/stocks/${encodeURIComponent(itemKey)}/trend`,
        );
        if (!stockTrendTrackerRef.current.isCurrent(requestId)) return;
        setStockTrendState({ key: itemKey, trend: next });
        setStockTrendErrorState(null);
      } catch (err) {
        if (!stockTrendTrackerRef.current.isCurrent(requestId)) return;
        setStockTrendErrorState({
          key: itemKey,
          message: err instanceof ApiError ? err.message : "Could not load product stock trend.",
        });
      } finally {
        if (stockTrendTrackerRef.current.isCurrent(requestId)) {
          setStockTrendLoadingKey((current) => (current === itemKey ? null : current));
        }
      }
    },
    [user.role],
  );

  useEffect(() => {
    if (user.role !== "OWNER") return;
    void loadReminders();
  }, [user.role, loadReminders]);

  useEffect(() => {
    if (user.role !== "OWNER") return;
    void loadSales(period, appliedCustom);
  }, [user.role, period, appliedCustom, loadSales]);

  useEffect(() => {
    if (user.role !== "OWNER" || viewMode !== "stocks") return;
    void loadStocks();
  }, [user.role, viewMode, loadStocks]);

  useEffect(() => {
    if (user.role !== "OWNER" || viewMode !== "stocks" || !selectedTrendItemKey) return;
    void loadStockTrend(selectedTrendItemKey);
  }, [user.role, viewMode, selectedTrendItemKey, loadStockTrend]);

  if (user.role !== "OWNER") {
    return <Navigate to="/" replace />;
  }

  const visibleReport =
    salesReportState?.key === activeSalesKey ? salesReportState.report : null;
  const visibleSalesError =
    salesErrorState?.key === activeSalesKey ? salesErrorState.message : null;
  const visibleSalesLoading = salesLoadingKey === activeSalesKey;
  const serverToday = salesReportState?.report.range.todayDate ?? initialToday;

  const visibleStockTrend =
    selectedTrendItemKey && stockTrendState?.key === selectedTrendItemKey
      ? stockTrendState.trend
      : null;
  const visibleStockTrendError =
    selectedTrendItemKey && stockTrendErrorState?.key === selectedTrendItemKey
      ? stockTrendErrorState.message
      : null;
  const visibleStockTrendLoading =
    Boolean(selectedTrendItemKey && stockTrendLoadingKey === selectedTrendItemKey);

  function selectSalesPeriod(nextPeriod: DashboardPeriod) {
    setViewMode("sales");
    setCustomValidationError(null);
    let nextCustom = appliedCustom;
    if (nextPeriod === "custom" && period !== "custom" && salesReportState?.report) {
      nextCustom = {
        from: salesReportState.report.range.from,
        to: salesReportState.report.range.to,
      };
      setDraftFrom(nextCustom.from);
      setDraftTo(nextCustom.to);
      setAppliedCustom(nextCustom);
    }
    setPeriod(nextPeriod);
    const nextKey = buildSalesKey(nextPeriod, nextCustom);
    const sameCustom =
      nextPeriod !== "custom" ||
      (nextCustom.from === appliedCustom.from && nextCustom.to === appliedCustom.to);
    if (
      nextPeriod === period &&
      sameCustom &&
      (viewMode !== "sales" || salesErrorState?.key === nextKey || visibleReport === null)
    ) {
      void loadSales(nextPeriod, nextCustom);
    }
  }

  function handleApplyCustomRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateCustomRange(draftFrom, draftTo, serverToday);
    if (validation) {
      setCustomValidationError(validation);
      return;
    }
    setCustomValidationError(null);
    const nextRange = { from: draftFrom.trim(), to: draftTo.trim() };
    setViewMode("sales");
    setPeriod("custom");
    if (
      period === "custom" &&
      appliedCustom.from === nextRange.from &&
      appliedCustom.to === nextRange.to
    ) {
      void loadSales("custom", nextRange);
    } else {
      setAppliedCustom(nextRange);
    }
  }

  return (
    <AppShell
      activeKey="dashboard"
      sectionName="Dashboard"
      pageLabel="Dashboard"
      modulesData={modulesData}
    >
      <div className="page-header page-header--split">
        <div>
          <h1>Dashboard</h1>
          <p className="page-subtitle">
            {viewMode === "sales"
              ? "A clear view of your station’s performance."
              : "Monitor your inventory stocks and track product availability."}
          </p>
        </div>

        <div className="page-header__actions">
          {viewMode === "sales" ? (
            visibleReport ? (
              <span className="dash-range-pill" aria-label="Selected sales date range">
                <span className="dash-range-pill__icon" aria-hidden="true">
                  <CalendarPillIcon />
                </span>
                <span>{formatManilaDateRange(visibleReport.range.from, visibleReport.range.to)}</span>
              </span>
            ) : visibleSalesLoading ? (
              <span className="dash-range-pill dash-range-pill--muted">Loading range…</span>
            ) : null
          ) : (
            <span className="dash-range-pill" aria-label="Stock snapshot timing">
              <span className="dash-range-pill__icon" aria-hidden="true">
                <CalendarPillIcon />
              </span>
              <span>Current snapshot</span>
            </span>
          )}
        </div>
      </div>

      <div className="dash-controls-row">
        <div className="dash-filter-bar" role="group" aria-label="Dashboard view and sales period">
          <button
            type="button"
            className={`dash-filter-btn ${viewMode === "sales" && period === "today" ? "dash-filter-btn--active" : ""}`}
            aria-pressed={viewMode === "sales" && period === "today"}
            onClick={() => selectSalesPeriod("today")}
          >
            Today
          </button>
          <button
            type="button"
            className={`dash-filter-btn ${viewMode === "sales" && period === "week" ? "dash-filter-btn--active" : ""}`}
            aria-pressed={viewMode === "sales" && period === "week"}
            onClick={() => selectSalesPeriod("week")}
          >
            This week
          </button>
          <button
            type="button"
            className={`dash-filter-btn ${viewMode === "sales" && period === "month" ? "dash-filter-btn--active" : ""}`}
            aria-pressed={viewMode === "sales" && period === "month"}
            onClick={() => selectSalesPeriod("month")}
          >
            This month
          </button>
          <button
            type="button"
            className={`dash-filter-btn ${viewMode === "sales" && period === "custom" ? "dash-filter-btn--active" : ""}`}
            aria-pressed={viewMode === "sales" && period === "custom"}
            onClick={() => selectSalesPeriod("custom")}
          >
            Custom
          </button>
          <button
            type="button"
            className={`dash-filter-btn ${viewMode === "stocks" ? "dash-filter-btn--active" : ""}`}
            aria-pressed={viewMode === "stocks"}
            onClick={() => setViewMode("stocks")}
          >
            Stocks
          </button>
        </div>

        <p className="dash-updated-meta">
          {viewMode === "sales"
            ? visibleReport
              ? `Updated ${formatCutoffClock(visibleReport.range.cutoffAt)} · Asia/Manila`
              : "Asia/Manila business dates"
            : "Current Inventory snapshot · Not filtered by sales dates"}
        </p>
      </div>

      {viewMode === "sales" && period === "custom" && (
        <form
          className="card dash-custom-range"
          onSubmit={handleApplyCustomRange}
          noValidate
          aria-label="Custom date range"
        >
          <div className="dash-custom-range__fields">
            <label className="field">
              <span>From</span>
              <input
                type="date"
                max={serverToday}
                value={draftFrom}
                onChange={(e) => {
                  setDraftFrom(e.target.value);
                  setCustomValidationError(null);
                }}
              />
            </label>
            <label className="field">
              <span>To</span>
              <input
                type="date"
                max={serverToday}
                value={draftTo}
                onChange={(e) => {
                  setDraftTo(e.target.value);
                  setCustomValidationError(null);
                }}
              />
            </label>
            <button type="submit" className="button button--primary dash-custom-range__submit">
              Apply range
            </button>
          </div>
          {customValidationError && (
            <p className="dash-custom-range__error" role="alert">
              {customValidationError}
            </p>
          )}
        </form>
      )}

      {viewMode === "sales" ? (
        <SalesView
          report={visibleReport}
          loading={visibleSalesLoading}
          error={visibleSalesError}
          onRetrySales={() => void loadSales(period, appliedCustom)}
          reminders={reminders}
          remindersLoading={remindersLoading}
          remindersError={remindersError}
          onRetryReminders={() => void loadReminders()}
        />
      ) : (
        <StocksView
          items={stockItems}
          posSections={stockSections}
          hasLoaded={stocksHasLoaded}
          loading={stocksLoading}
          error={stocksError}
          onRetry={() => {
            void loadStocks();
            if (selectedTrendItemKey) void loadStockTrend(selectedTrendItemKey);
          }}
          selectedTrendItemKey={selectedTrendItemKey}
          onSelectTrendItem={(itemKey) => setSelectedTrendItemKey(itemKey)}
          stockTrend={visibleStockTrend}
          stockTrendLoading={visibleStockTrendLoading}
          stockTrendError={visibleStockTrendError}
          onRetryTrend={() => {
            if (selectedTrendItemKey) void loadStockTrend(selectedTrendItemKey);
          }}
        />
      )}
    </AppShell>
  );
}
