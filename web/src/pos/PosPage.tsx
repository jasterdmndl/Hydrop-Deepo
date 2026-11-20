import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useSignedInUser } from "../auth/AuthContext";
import { createRequestTracker } from "../calendar/calendarView";
import { AppShell, useModulesData } from "../ChooseModule";
import { CheckoutRecovery } from "./CheckoutRecovery";
import {
  cartLinesSignature,
  type CartDraftLine,
  type CatalogRefill,
  type CheckoutLookupView,
  type CheckoutView,
  clearPendingRecovery,
  clearUnpaidCart,
  computeCashSummary,
  type ConfirmSaleResponse,
  currentManilaIso,
  type DaySummaryView,
  type EndDayResponse,
  formatCentavos,
  formatLiters,
  formatManilaTimestamp,
  loadPendingRecovery,
  loadUnpaidCart,
  parseLitersInput,
  parsePesoInputToCentavos,
  type PendingCheckoutRecovery,
  type PosDayResponse,
  type PrepareCheckoutResponse,
  savePendingRecovery,
  saveUnpaidCart,
  type SaleView,
  stationStatusFromDay,
  toCartItemInputs,
  type WaterType,
} from "./posRecovery";
import { SaleHistory } from "./SaleHistory";

type PosTab = "sale" | "history";
type SaleStep = "select" | "review";

const MAX_LINES = 50;
const MAX_LINE_QTY = 500;

function generateKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultLineId(waterType: WaterType): string {
  return `std-${waterType}`;
}

export function PosPage() {
  const user = useSignedInUser();
  const { data: modulesData } = useModulesData();

  const [catalog, setCatalog] = useState<CatalogRefill[]>([]);
  const [dayStatus, setDayStatus] = useState<PosDayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const [tab, setTab] = useState<PosTab>("sale");
  const [step, setStep] = useState<SaleStep>("select");
  const [lines, setLines] = useState<CartDraftLine[]>([]);
  const [preparedCheckout, setPreparedCheckout] = useState<CheckoutView | null>(null);
  const [prepareKey, setPrepareKey] = useState<string | null>(null);
  const [prepareSignature, setPrepareSignature] = useState<string | null>(null);
  const [cashInput, setCashInput] = useState("");
  const [saleError, setSaleError] = useState<string | null>(null);

  const [pendingRecovery, setPendingRecovery] = useState<PendingCheckoutRecovery | null>(() =>
    loadPendingRecovery(),
  );
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [retryingRecovery, setRetryingRecovery] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const [lastSavedSale, setLastSavedSale] = useState<SaleView | null>(null);
  const [lastClosedSummary, setLastClosedSummary] = useState<DaySummaryView | null>(null);
  const [historyFocusRef, setHistoryFocusRef] = useState<string | null>(null);
  const [historyRefreshSignal, setHistoryRefreshSignal] = useState(0);

  const [startingDay, setStartingDay] = useState(false);
  const [startRequestKey, setStartRequestKey] = useState<string | null>(null);
  const [dayActionError, setDayActionError] = useState<string | null>(null);

  const [preparingCheckout, setPreparingCheckout] = useState(false);
  const [confirmingSale, setConfirmingSale] = useState(false);
  const [cancellingDraft, setCancellingDraft] = useState(false);

  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [customWaterType, setCustomWaterType] = useState<WaterType>("PURIFIED");
  const [customLitersInput, setCustomLitersInput] = useState("");
  const [customPriceInput, setCustomPriceInput] = useState("");
  const [customQty, setCustomQty] = useState(1);
  const [customError, setCustomError] = useState<string | null>(null);

  const [endDayOpen, setEndDayOpen] = useState(false);
  const [endDayClearDrafts, setEndDayClearDrafts] = useState(false);
  const [closeRequestKey, setCloseRequestKey] = useState<string | null>(null);
  const [endingDay, setEndingDay] = useState(false);
  const [endDayError, setEndDayError] = useState<string | null>(null);

  const hydratedRef = useRef(false);
  const loadTrackerRef = useRef(createRequestTracker());
  const preparedCheckoutRef = useRef<CheckoutView | null>(null);
  preparedCheckoutRef.current = preparedCheckout;

  const applyServerDayStatus = useCallback((dayRes: PosDayResponse) => {
    setDayStatus(dayRes);
    const currentPrepared = preparedCheckoutRef.current;
    if (!currentPrepared) return;
    const stillValid =
      dayRes.state === "OPEN" &&
      currentPrepared.businessDate === dayRes.todayDate &&
      dayRes.unpaidDrafts.some((d) => d.reference === currentPrepared.reference);
    if (!stillValid) {
      setPreparedCheckout(null);
      setPrepareKey(null);
      setPrepareSignature(null);
      setStep("select");
      setCashInput("");
    }
  }, []);

  const loadPosState = useCallback(async () => {
    const requestId = loadTrackerRef.current.next();
    setLoading(true);
    setPageError(null);
    try {
      const [catRes, dayRes] = await Promise.all([
        api<{ items: CatalogRefill[] }>("/api/pos/catalog", { background: true }),
        api<PosDayResponse>("/api/pos/day", { background: true }),
      ]);
      if (!loadTrackerRef.current.isCurrent(requestId)) return;
      setCatalog(catRes.items);
      applyServerDayStatus(dayRes);
    } catch (err) {
      if (!loadTrackerRef.current.isCurrent(requestId)) return;
      setPageError(err instanceof ApiError ? err.message : "Could not load Point of Sale.");
    } finally {
      if (loadTrackerRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  }, [applyServerDayStatus]);

  useEffect(() => {
    const pending = loadPendingRecovery();
    setPendingRecovery(pending);
    if (!pending) {
      const savedCart = loadUnpaidCart(user.username);
      if (savedCart) {
        setLines(savedCart.lines);
        setPreparedCheckout(savedCart.preparedCheckout);
        setPrepareKey(savedCart.prepareKey);
        setPrepareSignature(savedCart.prepareSignature);
        setStep(savedCart.preparedCheckout ? "review" : "select");
      } else {
        setLines([]);
        setPreparedCheckout(null);
        setPrepareKey(null);
        setPrepareSignature(null);
        setStep("select");
      }
    }
    hydratedRef.current = true;
    void loadPosState();
  }, [user.username, loadPosState]);

  // Persist unpaid cart only for the signed-in account while no recovery is active.
  useEffect(() => {
    if (!hydratedRef.current || pendingRecovery) return;
    if (lines.length === 0 && !preparedCheckout) {
      clearUnpaidCart(user.username);
      return;
    }
    saveUnpaidCart({
      ownerUsername: user.username,
      businessDate: dayStatus?.todayDate ?? "",
      lines,
      preparedCheckout,
      prepareKey,
      prepareSignature,
    });
  }, [user.username, dayStatus?.todayDate, lines, preparedCheckout, prepareKey, prepareSignature, pendingRecovery]);

  // Close Customize or End Day modals cleanly on Escape.
  useEffect(() => {
    if (!customizeOpen && !endDayOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (customizeOpen) setCustomizeOpen(false);
      if (endDayOpen && !endingDay) setEndDayOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [customizeOpen, endDayOpen, endingDay]);

  const stationStatus = dayStatus ? stationStatusFromDay(dayStatus) : null;

  const cartTotals = useMemo(() => {
    let totalCentavos = 0;
    let totalContainers = 0;
    let totalVolumeLiters = 0;
    for (const line of lines) {
      totalCentavos += line.unitPriceCentavos * line.quantity;
      totalContainers += line.quantity;
      totalVolumeLiters += line.unitVolumeLiters * line.quantity;
    }
    return {
      totalCentavos,
      totalContainers,
      totalVolumeLiters: Number(totalVolumeLiters.toFixed(2)),
    };
  }, [lines]);

  const standardQtyByType = useMemo(() => {
    const map = new Map<WaterType, number>();
    for (const line of lines) {
      if (line.kind === "STANDARD") {
        map.set(line.waterType, line.quantity);
      }
    }
    return map;
  }, [lines]);

  const customLines = useMemo(() => lines.filter((line) => line.kind === "CUSTOM"), [lines]);

  function setStandardQuantity(item: CatalogRefill, nextQty: number) {
    const clamped = Math.max(0, Math.min(MAX_LINE_QTY, Math.trunc(nextQty)));
    setSaleError(null);
    setLastSavedSale(null);
    setLines((prev) => {
      const id = defaultLineId(item.waterType);
      const existingIdx = prev.findIndex((l) => l.id === id);
      if (clamped === 0) {
        return existingIdx === -1 ? prev : prev.filter((l) => l.id !== id);
      }
      if (existingIdx !== -1) {
        return prev.map((l) => (l.id === id ? { ...l, quantity: clamped } : l));
      }
      if (prev.length >= MAX_LINES) {
        setSaleError(`Maximum ${MAX_LINES} lines per sale.`);
        return prev;
      }
      return [
        ...prev,
        {
          id,
          kind: "STANDARD",
          waterType: item.waterType,
          displayName: item.displayName,
          unitVolumeMl: item.unitVolumeMl,
          unitVolumeLiters: item.unitVolumeLiters,
          unitPriceCentavos: item.unitPriceCentavos,
          quantity: clamped,
        },
      ];
    });
  }

  function adjustCustomLineQuantity(id: string, delta: number) {
    setSaleError(null);
    setLines((prev) =>
      prev
        .map((line) =>
          line.id === id
            ? { ...line, quantity: Math.min(MAX_LINE_QTY, line.quantity + delta) }
            : line,
        )
        .filter((line) => line.quantity > 0),
    );
  }

  function removeLine(id: string) {
    setSaleError(null);
    setLines((prev) => prev.filter((line) => line.id !== id));
  }

  function openCustomizeModal() {
    setCustomWaterType("PURIFIED");
    setCustomLitersInput("");
    setCustomPriceInput("");
    setCustomQty(1);
    setCustomError(null);
    setCustomizeOpen(true);
  }

  const parsedCustomLiters = parseLitersInput(customLitersInput);
  const parsedCustomPriceCentavos = parsePesoInputToCentavos(customPriceInput);

  function handleAddCustomLine(event: FormEvent) {
    event.preventDefault();
    setCustomError(null);
    if (parsedCustomLiters === null) {
      setCustomError("Enter liters per container between 0.01 and 1000 (up to 2 decimal places).");
      return;
    }
    if (parsedCustomPriceCentavos === null) {
      setCustomError("Enter the Owner-agreed price per container (greater than ₱0.00).");
      return;
    }
    if (!Number.isInteger(customQty) || customQty < 1 || customQty > MAX_LINE_QTY) {
      setCustomError(`Quantity must be a whole number between 1 and ${MAX_LINE_QTY}.`);
      return;
    }

    const typeLabel = customWaterType === "PURIFIED" ? "Purified" : "Alkaline";
    const displayName = `Custom ${typeLabel} refill · ${formatLiters(parsedCustomLiters)}`;

    let limitHit = false;
    setLines((prev) => {
      const match = prev.find(
        (l) =>
          l.kind === "CUSTOM" &&
          l.waterType === customWaterType &&
          l.unitVolumeLiters === parsedCustomLiters &&
          l.unitPriceCentavos === parsedCustomPriceCentavos,
      );
      if (match) {
        return prev.map((l) =>
          l.id === match.id
            ? { ...l, quantity: Math.min(MAX_LINE_QTY, l.quantity + customQty) }
            : l,
        );
      }
      if (prev.length >= MAX_LINES) {
        limitHit = true;
        return prev;
      }
      return [
        ...prev,
        {
          id: `custom-${generateKey()}`,
          kind: "CUSTOM",
          waterType: customWaterType,
          displayName,
          unitVolumeLiters: parsedCustomLiters,
          unitPriceCentavos: parsedCustomPriceCentavos,
          quantity: customQty,
        },
      ];
    });

    if (limitHit) {
      setCustomError(`Maximum ${MAX_LINES} lines per sale.`);
      return;
    }
    setLastSavedSale(null);
    setSaleError(null);
    setCustomizeOpen(false);
  }

  async function handleStartDay() {
    setStartingDay(true);
    setDayActionError(null);
    const key = startRequestKey ?? generateKey();
    setStartRequestKey(key);
    try {
      const started = await api<PosDayResponse>("/api/pos/day/start", {
        method: "POST",
        body: { requestKey: key },
      });
      setDayStatus(started);
      setStartRequestKey(null);
      setLastClosedSummary(null);
    } catch (err) {
      setDayActionError(err instanceof ApiError ? err.message : "Could not start the station day.");
      void loadPosState();
    } finally {
      setStartingDay(false);
    }
  }

  async function openEndDayModal() {
    setEndDayError(null);
    setEndDayClearDrafts(false);
    setCloseRequestKey(generateKey());
    setEndDayOpen(true);
    try {
      const freshDay = await api<PosDayResponse>("/api/pos/day", { background: true });
      applyServerDayStatus(freshDay);
    } catch {
      // Keep existing dayStatus and allow retry if refresh fails.
    }
  }

  async function handleConfirmEndDay() {
    if (!dayStatus?.day) return;
    setEndingDay(true);
    setEndDayError(null);
    const key = closeRequestKey ?? generateKey();
    setCloseRequestKey(key);
    try {
      const closed = await api<EndDayResponse>("/api/pos/day/end", {
        method: "POST",
        body: {
          requestKey: key,
          clearUnpaidDrafts: endDayClearDrafts,
          expectedBusinessDate: dayStatus.day.businessDate,
        },
      });
      if (preparedCheckout && closed.clearedDraftReferences.includes(preparedCheckout.reference)) {
        setPreparedCheckout(null);
        setPrepareKey(null);
        setPrepareSignature(null);
        setStep("select");
      }
      setLastClosedSummary(closed.summary);
      setEndDayOpen(false);
      setCloseRequestKey(null);
      await loadPosState();
    } catch (err) {
      setEndDayError(err instanceof ApiError ? err.message : "Could not close the station day.");
      await loadPosState();
    } finally {
      setEndingDay(false);
    }
  }

  async function handleProceedToCash() {
    if (lines.length === 0 || !dayStatus?.canSell) return;
    setPreparingCheckout(true);
    setSaleError(null);
    setLastSavedSale(null);

    const signature = cartLinesSignature(lines);
    const keyToUse = prepareSignature === signature && prepareKey ? prepareKey : generateKey();
    setPrepareKey(keyToUse);
    setPrepareSignature(signature);

    loadTrackerRef.current.next();
    try {
      const res = await api<PrepareCheckoutResponse>("/api/pos/checkouts", {
        method: "POST",
        body: {
          prepareKey: keyToUse,
          items: toCartItemInputs(lines),
        },
      });
      setDayStatus((prev) =>
        prev
          ? {
              ...prev,
              unpaidDrafts: prev.unpaidDrafts.some((d) => d.reference === res.checkout.reference)
                ? prev.unpaidDrafts
                : [...prev.unpaidDrafts, res.checkout],
            }
          : prev,
      );
      setPreparedCheckout(res.checkout);
      setCashInput("");
      setStep("review");
    } catch (err) {
      setSaleError(err instanceof ApiError ? err.message : "Could not prepare checkout.");
      await loadPosState();
    } finally {
      setPreparingCheckout(false);
    }
  }

  const parsedCashCentavos = parsePesoInputToCentavos(cashInput);
  const reviewTotalCentavos = preparedCheckout?.totalCentavos ?? cartTotals.totalCentavos;
  const cashSummary = computeCashSummary(reviewTotalCentavos, parsedCashCentavos);

  async function handleBackToSelection() {
    if (!preparedCheckout) {
      setStep("select");
      return;
    }
    setCancellingDraft(true);
    setSaleError(null);
    try {
      await api(`/api/pos/checkouts/${encodeURIComponent(preparedCheckout.reference)}/cancel`, {
        method: "POST",
        body: { reason: "Returned to refill selection" },
      });
      setPreparedCheckout(null);
      setPrepareKey(null);
      setPrepareSignature(null);
      setCashInput("");
      setStep("select");
      await loadPosState();
    } catch (err) {
      setSaleError(
        err instanceof ApiError
          ? err.message
          : "Could not cancel draft checkout. Check status or retry.",
      );
      await loadPosState();
    } finally {
      setCancellingDraft(false);
    }
  }

  function persistReviewRequiredFromError(
    baseRecord: PendingCheckoutRecovery,
    err: ApiError,
  ): PendingCheckoutRecovery | null {
    const checkout = err.details?.checkout as CheckoutView | undefined;
    if (!checkout) return null;
    const syntheticLookup: CheckoutLookupView = {
      recoveryState: "REVIEW_REQUIRED",
      reason: checkout.resolutionReason ?? "REVIEW_REQUIRED",
      canRetry: false,
      ownedByCurrentUser: checkout.createdBy.toLowerCase() === user.username.toLowerCase(),
      checkedAt: currentManilaIso(),
      checkout,
      sale: null,
    };
    const updated: PendingCheckoutRecovery = {
      ...baseRecord,
      lastLookup: syntheticLookup,
      lastError: err.message,
    };
    savePendingRecovery(updated);
    return updated;
  }

  async function handleConfirmPayment() {
    if (!preparedCheckout || parsedCashCentavos === null || !cashSummary.sufficient) return;

    const itemInputs = toCartItemInputs(lines);
    const pendingRecord: PendingCheckoutRecovery = {
      reference: preparedCheckout.reference,
      businessDate: preparedCheckout.businessDate,
      initiatedBy: user.username,
      items: itemInputs,
      quoteItems: preparedCheckout.items,
      totalCentavos: preparedCheckout.totalCentavos,
      totalContainers: preparedCheckout.totalContainers,
      totalVolumeMl: preparedCheckout.totalVolumeMl,
      totalVolumeLiters: preparedCheckout.totalVolumeLiters,
      cashReceivedCentavos: parsedCashCentavos,
      changeCentavos: parsedCashCentavos - preparedCheckout.totalCentavos,
      attemptedAt: currentManilaIso(),
      lastLookup: null,
      lastError: null,
    };

    // Persist checkout reference and payment context on workstation BEFORE sending confirm.
    savePendingRecovery(pendingRecord);
    clearUnpaidCart(user.username);
    setConfirmingSale(true);
    setSaleError(null);
    setRecoveryError(null);

    try {
      const confirmed = await api<ConfirmSaleResponse>(
        `/api/pos/checkouts/${encodeURIComponent(preparedCheckout.reference)}/confirm`,
        {
          method: "POST",
          body: {
            cashReceivedCentavos: parsedCashCentavos,
            items: itemInputs,
            expectedTotalCentavos: preparedCheckout.totalCentavos,
          },
        },
      );
      clearPendingRecovery();
      setPendingRecovery(null);
      setLines([]);
      setPreparedCheckout(null);
      setPrepareKey(null);
      setPrepareSignature(null);
      setCashInput("");
      setLastSavedSale(confirmed.sale);
      setStep("select");
      setHistoryRefreshSignal((n) => n + 1);
      await loadPosState();
    } catch (err) {
      if (err instanceof ApiError && err.code === "INSUFFICIENT_CASH") {
        clearPendingRecovery();
        setSaleError(err.message);
        return;
      }

      if (err instanceof ApiError && err.code === "CHECKOUT_REVIEW_REQUIRED") {
        const updated = persistReviewRequiredFromError(pendingRecord, err) ?? pendingRecord;
        setPendingRecovery(updated);
        setRecoveryError(err.message);
        setPreparedCheckout(null);
        setLines([]);
        setPrepareKey(null);
        setPrepareSignature(null);
        return;
      }

      // Network drop, timeout, 5xx, or 401 session expiry: keep pending recovery visible & durable.
      setPendingRecovery(pendingRecord);
      setRecoveryError(
        err instanceof ApiError
          ? err.message
          : "Could not confirm whether the sale was saved. Check transaction status before taking another step.",
      );
      setPreparedCheckout(null);
      setLines([]);
      setPrepareKey(null);
      setPrepareSignature(null);
    } finally {
      setConfirmingSale(false);
    }
  }

  async function handleCheckRecoveryStatus() {
    if (!pendingRecovery) return;
    setCheckingStatus(true);
    setRecoveryError(null);
    try {
      const lookup = await api<CheckoutLookupView>(
        `/api/pos/checkouts/${encodeURIComponent(pendingRecovery.reference)}`,
      );
      const updated: PendingCheckoutRecovery = {
        ...pendingRecovery,
        lastLookup: lookup,
        lastError: null,
      };
      savePendingRecovery(updated);
      setPendingRecovery(updated);
    } catch (err) {
      setRecoveryError(
        err instanceof ApiError
          ? err.message
          : "Status check could not reach the server. Keep this reference and check again.",
      );
    } finally {
      setCheckingStatus(false);
    }
  }

  async function handleRetryRecovery() {
    if (!pendingRecovery) return;
    setRetryingRecovery(true);
    setRecoveryError(null);
    try {
      const confirmed = await api<ConfirmSaleResponse>(
        `/api/pos/checkouts/${encodeURIComponent(pendingRecovery.reference)}/confirm`,
        {
          method: "POST",
          body: {
            cashReceivedCentavos: pendingRecovery.cashReceivedCentavos,
            items: pendingRecovery.items,
            expectedTotalCentavos: pendingRecovery.totalCentavos,
          },
        },
      );
      clearPendingRecovery();
      clearUnpaidCart(user.username);
      setPendingRecovery(null);
      setLines([]);
      setPreparedCheckout(null);
      setPrepareKey(null);
      setPrepareSignature(null);
      setCashInput("");
      setLastSavedSale(confirmed.sale);
      setStep("select");
      setHistoryRefreshSignal((n) => n + 1);
      await loadPosState();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CHECKOUT_REVIEW_REQUIRED") {
        const updated = persistReviewRequiredFromError(pendingRecovery, err);
        if (updated) setPendingRecovery(updated);
        setRecoveryError(err.message);
        return;
      }
      setRecoveryError(
        err instanceof ApiError
          ? err.message
          : "Retry could not reach the server. Check transaction status before trying again.",
      );
    } finally {
      setRetryingRecovery(false);
    }
  }

  function handleContinueSavedSale(sale: SaleView) {
    clearPendingRecovery();
    clearUnpaidCart(user.username);
    setPendingRecovery(null);
    setRecoveryError(null);
    setLines([]);
    setPreparedCheckout(null);
    setPrepareKey(null);
    setPrepareSignature(null);
    setCashInput("");
    setLastSavedSale(sale);
    setStep("select");
    setHistoryRefreshSignal((n) => n + 1);
    void loadPosState();
  }

  const activeStepperNumber = pendingRecovery ? 3 : step === "review" ? 2 : 1;

  const localBlockingRecovery =
    pendingRecovery && dayStatus?.day && pendingRecovery.businessDate === dayStatus.day.businessDate
      ? pendingRecovery
      : null;

  const serverUnresolved = dayStatus?.unresolvedCheckouts ?? [];
  const hasBlockingUnresolved = serverUnresolved.length > 0 || localBlockingRecovery !== null;
  const serverDrafts = dayStatus?.unpaidDrafts ?? [];
  const draftsNeedAck = serverDrafts.length > 0 && !endDayClearDrafts;

  return (
    <AppShell
      activeKey="pos"
      sectionName="POS"
      modulesData={modulesData}
      stationStatusOverride={stationStatus}
    >
      <section className="page-header page-header--split">
        <div>
          <h1>Point of Sale</h1>
          <p className="page-subtitle">Select refills, receive cash, and confirm the sale.</p>
        </div>
        <div className="page-header__actions">
          <span className="pill pill--neutral">Cash payments only</span>
          {dayStatus?.canStartDay && (
            <button
              type="button"
              className="button button--primary"
              disabled={startingDay}
              onClick={() => void handleStartDay()}
            >
              {startingDay ? "Starting day…" : "Start Day"}
            </button>
          )}
          {dayStatus?.canEndDay && (
            <button
              type="button"
              className={`button ${dayStatus.state === "PREVIOUS_DAY_OPEN" ? "button--primary" : "button--ghost"}`}
              onClick={() => void openEndDayModal()}
            >
              {dayStatus.state === "PREVIOUS_DAY_OPEN" ? "Review & Close Previous Day" : "End Day"}
            </button>
          )}
        </div>
      </section>

      <div className="tabs-header">
        <div className="tab-bar" role="tablist" aria-label="POS workspace">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "sale"}
            className={`tab ${tab === "sale" ? "tab--active" : ""}`}
            onClick={() => setTab("sale")}
          >
            New Sale
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "history"}
            className={`tab ${tab === "history" ? "tab--active" : ""}`}
            onClick={() => setTab("history")}
          >
            Transaction History
          </button>
        </div>

        <div className="summary-pills">
          {dayStatus?.day && (
            <span className="pill pill--scheduled">
              {dayStatus.day.businessDate} · {dayStatus.day.summary.validTransactionCount} sale
              {dayStatus.day.summary.validTransactionCount === 1 ? "" : "s"} (
              {formatCentavos(dayStatus.day.summary.totalSalesCentavos)})
            </span>
          )}
          {pendingRecovery && (
            <span className="pill pill--overdue">Recovery active: {pendingRecovery.reference}</span>
          )}
        </div>
      </div>

      {pageError && (
        <div className="alert alert--error" role="alert">
          {pageError}{" "}
          <button type="button" className="button button--ghost button--sm" onClick={() => void loadPosState()}>
            Retry
          </button>
        </div>
      )}

      {dayActionError && (
        <div className="alert alert--error" role="alert">
          {dayActionError}
        </div>
      )}

      {tab === "history" ? (
        <SaleHistory
          todayDate={dayStatus?.todayDate ?? currentManilaIso().slice(0, 10)}
          initialReference={historyFocusRef}
          refreshSignal={historyRefreshSignal}
        />
      ) : loading && !dayStatus ? (
        <div className="card">
          <p className="muted">Loading station business day and refill options…</p>
        </div>
      ) : (
        <section className="subview" aria-label="Cash refill checkout">
          <ol className="pos-stepper" aria-label="Checkout progress">
            <li
              className={`pos-step ${activeStepperNumber === 1 ? "pos-step--active" : ""} ${
                activeStepperNumber > 1 ? "pos-step--done" : ""
              }`}
            >
              <span className="pos-step__num">1</span>
              <span>Select refills</span>
            </li>
            <li
              className={`pos-step ${activeStepperNumber === 2 ? "pos-step--active" : ""} ${
                activeStepperNumber > 2 ? "pos-step--done" : ""
              }`}
            >
              <span className="pos-step__num">2</span>
              <span>Review &amp; receive cash</span>
            </li>
            <li className={`pos-step ${activeStepperNumber === 3 ? "pos-step--active" : ""}`}>
              <span className="pos-step__num">3</span>
              <span>Save sale</span>
            </li>
          </ol>

          {pendingRecovery ? (
            <CheckoutRecovery
              record={pendingRecovery}
              currentUsername={user.username}
              checking={checkingStatus}
              retrying={retryingRecovery}
              errorMessage={recoveryError}
              onCheckStatus={() => void handleCheckRecoveryStatus()}
              onRetry={() => void handleRetryRecovery()}
              onContinueSaved={handleContinueSavedSale}
            />
          ) : (
            <>
              {lastClosedSummary && dayStatus?.state === "CLOSED" && (
                <div className="callout callout--success" role="status">
                  <p className="callout__title">Business day {lastClosedSummary.businessDate} closed</p>
                  <p className="callout__body">
                    Recorded {lastClosedSummary.validTransactionCount} valid transaction
                    {lastClosedSummary.validTransactionCount === 1 ? "" : "s"} totaling{" "}
                    {formatCentavos(lastClosedSummary.totalSalesCentavos)} ({formatLiters(lastClosedSummary.totalVolumeLiters)}
                    ).
                  </p>
                </div>
              )}

              {dayStatus && dayStatus.state !== "OPEN" && (
                <div
                  className={`callout ${
                    dayStatus.state === "PREVIOUS_DAY_OPEN" ? "callout--warning" : "callout--info"
                  }`}
                  role="status"
                >
                  <p className="callout__title">
                    {dayStatus.state === "NOT_STARTED"
                      ? "Today's station day is not started"
                      : dayStatus.state === "PREVIOUS_DAY_OPEN"
                        ? `Previous day (${dayStatus.day?.businessDate}) is still open`
                        : "Today's business day is closed"}
                  </p>
                  <p className="callout__body">
                    {dayStatus.state === "NOT_STARTED"
                      ? "Start the station day before selecting refills or receiving cash."
                      : dayStatus.state === "PREVIOUS_DAY_OPEN"
                        ? "Review and close the open previous day before starting today's sales."
                        : "Sales are locked for today. You can still view Transaction History."}
                  </p>
                  <div className="callout__actions">
                    {dayStatus.canStartDay && (
                      <button
                        type="button"
                        className="button button--primary button--sm"
                        disabled={startingDay}
                        onClick={() => void handleStartDay()}
                      >
                        {startingDay ? "Starting day…" : "Start Day"}
                      </button>
                    )}
                    {dayStatus.canEndDay && (
                      <button
                        type="button"
                        className="button button--primary button--sm"
                        onClick={() => void openEndDayModal()}
                      >
                        Review &amp; Close Previous Day
                      </button>
                    )}
                    {dayStatus.state === "CLOSED" && (
                      <button
                        type="button"
                        className="button button--ghost button--sm"
                        onClick={() => setTab("history")}
                      >
                        Open Transaction History
                      </button>
                    )}
                  </div>
                </div>
              )}

              {step === "select" ? (
                <div className="pos-layout">
                  <div className="pos-main">
                    <article className="card pos-selection-card">
                      <div className="detail-card__header">
                        <div>
                          <h2>Refill Window</h2>
                          <p className="muted-sm">Choose the quantity for each customer-owned container service.</p>
                        </div>
                      </div>

                      {saleError && (
                        <div className="alert alert--error" role="alert">
                          {saleError}
                        </div>
                      )}

                      <div className="refill-grid">
                        {catalog.map((item) => {
                          const qty = standardQtyByType.get(item.waterType) ?? 0;
                          const isSelected = qty > 0;
                          const labelBase = item.waterType === "PURIFIED" ? "Purified Refill" : "Alkaline Refill";
                          const desc =
                            item.waterType === "PURIFIED" ? "Purified drinking water" : "Alkaline drinking water";
                          return (
                            <div
                              key={item.code}
                              className={`refill-card ${isSelected ? "refill-card--selected" : ""}`}
                            >
                              <div className="refill-card__info">
                                <h3>{labelBase}</h3>
                                <p className="muted-sm">{desc}</p>
                              </div>
                              <div className="refill-card__bottom">
                                <span className="refill-card__price">
                                  <strong>{formatCentavos(item.unitPriceCentavos)}</strong>
                                  <span className="muted-sm">/{formatLiters(item.unitVolumeLiters).replace(" ", "")}</span>
                                </span>
                                <div className="qty-stepper" aria-label={`${labelBase} quantity`}>
                                  <button
                                    type="button"
                                    className="qty-stepper__btn"
                                    aria-label={`Decrease ${labelBase}`}
                                    disabled={!dayStatus?.canSell || qty === 0}
                                    onClick={() => setStandardQuantity(item, qty - 1)}
                                  >
                                    −
                                  </button>
                                  <span className="qty-stepper__value" aria-live="polite">
                                    {qty}
                                  </span>
                                  <button
                                    type="button"
                                    className="qty-stepper__btn"
                                    aria-label={`Increase ${labelBase}`}
                                    disabled={!dayStatus?.canSell || qty >= MAX_LINE_QTY}
                                    onClick={() => setStandardQuantity(item, qty + 1)}
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div className="pos-customize-row">
                        <button
                          type="button"
                          className="button button--primary"
                          disabled={!dayStatus?.canSell}
                          onClick={openCustomizeModal}
                        >
                          Customize
                        </button>
                        <span className="muted-sm">
                          Enter custom liters and Owner-agreed price per container for non-25 L refills.
                        </span>
                      </div>

                      {customLines.length > 0 && (
                        <div className="custom-line-list" aria-label="Custom refill items">
                          <h3>Custom refills</h3>
                          {customLines.map((line) => (
                            <div key={line.id} className="custom-line-row">
                              <div className="custom-line-row__info">
                                <strong>{line.displayName}</strong>
                                <span className="muted-sm">
                                  {formatCentavos(line.unitPriceCentavos)} per container · Line total{" "}
                                  {formatCentavos(line.unitPriceCentavos * line.quantity)}
                                </span>
                              </div>
                              <div className="custom-line-row__controls">
                                <div className="qty-stepper" aria-label={`${line.displayName} quantity`}>
                                  <button
                                    type="button"
                                    className="qty-stepper__btn"
                                    aria-label={`Decrease ${line.displayName}`}
                                    disabled={!dayStatus?.canSell}
                                    onClick={() => adjustCustomLineQuantity(line.id, -1)}
                                  >
                                    −
                                  </button>
                                  <span className="qty-stepper__value">{line.quantity}</span>
                                  <button
                                    type="button"
                                    className="qty-stepper__btn"
                                    aria-label={`Increase ${line.displayName}`}
                                    disabled={!dayStatus?.canSell || line.quantity >= MAX_LINE_QTY}
                                    onClick={() => adjustCustomLineQuantity(line.id, 1)}
                                  >
                                    +
                                  </button>
                                </div>
                                <button
                                  type="button"
                                  className="button button--ghost button--sm"
                                  onClick={() => removeLine(line.id)}
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  </div>

                  <aside className="side-stack">
                    {lastSavedSale && (
                      <div className="callout callout--success" role="status">
                        <p className="callout__title">Sale {lastSavedSale.reference} saved successfully</p>
                        <p className="callout__body">
                          {formatCentavos(lastSavedSale.cashReceivedCentavos)} received for{" "}
                          {formatCentavos(lastSavedSale.totalCentavos)} total. Return{" "}
                          <strong>{formatCentavos(lastSavedSale.changeCentavos)}</strong> change, refill{" "}
                          {lastSavedSale.totalContainers} container{lastSavedSale.totalContainers === 1 ? "" : "s"} (
                          {formatLiters(lastSavedSale.totalVolumeLiters)}), and hand over.
                        </p>
                        <div className="callout__actions">
                          <button
                            type="button"
                            className="button button--ghost button--sm"
                            onClick={() => {
                              setHistoryFocusRef(lastSavedSale.reference);
                              setTab("history");
                            }}
                          >
                            View in History
                          </button>
                        </div>
                      </div>
                    )}

                    <article className="card detail-card" aria-label="Current sale summary">
                      <div className="detail-card__header">
                        <h2>Current sale</h2>
                        <span className="pill pill--scheduled">
                          {cartTotals.totalContainers} container{cartTotals.totalContainers === 1 ? "" : "s"}
                        </span>
                      </div>

                      {lines.length === 0 ? (
                        <p className="muted">No services selected. Choose a refill to start the sale.</p>
                      ) : (
                        <ul className="pos-summary-lines">
                          {lines.map((line) => (
                            <li key={line.id} className="pos-summary-line">
                              <div className="pos-summary-line__meta">
                                <strong>{line.displayName}</strong>
                                <span className="muted-sm">
                                  {line.quantity} × {formatCentavos(line.unitPriceCentavos)} ·{" "}
                                  {formatLiters(line.unitVolumeLiters * line.quantity)}
                                </span>
                              </div>
                              <span className="pos-summary-line__amount">
                                {formatCentavos(line.unitPriceCentavos * line.quantity)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}

                      <dl className="detail-list">
                        <div className="detail-list__row">
                          <dt>Containers</dt>
                          <dd>{cartTotals.totalContainers}</dd>
                        </div>
                        <div className="detail-list__row">
                          <dt>Total water</dt>
                          <dd>{formatLiters(cartTotals.totalVolumeLiters)}</dd>
                        </div>
                        <div className="detail-list__row detail-list__row--total">
                          <dt>Total amount</dt>
                          <dd>{formatCentavos(cartTotals.totalCentavos)}</dd>
                        </div>
                      </dl>

                      <div className="pos-summary-actions">
                        <button
                          type="button"
                          className="button button--primary button--block"
                          disabled={!dayStatus?.canSell || lines.length === 0 || preparingCheckout}
                          onClick={() => void handleProceedToCash()}
                        >
                          {preparingCheckout ? "Preparing checkout…" : "Review & receive cash"}
                        </button>
                        {lines.length > 0 && (
                          <button
                            type="button"
                            className="button button--ghost button--block"
                            disabled={preparingCheckout}
                            onClick={() => {
                              setLines([]);
                              setSaleError(null);
                            }}
                          >
                            Clear sale
                          </button>
                        )}
                      </div>
                    </article>

                    <article className="card trust-card">
                      <h3>Every sale, saved once.</h3>
                      <p className="muted-sm">
                        Wait for a saved confirmation before refilling. If saving is uncertain, check the transaction
                        before retrying.
                      </p>
                    </article>
                  </aside>
                </div>
              ) : (
                <div className="pos-layout">
                  <div className="pos-main">
                    <article className="card pos-cash-card">
                      <div className="detail-card__header">
                        <h2>Review &amp; receive cash</h2>
                        <span className="pill pill--neutral mono-ref">{preparedCheckout?.reference}</span>
                      </div>

                      <div className="callout callout--info">
                        <p className="callout__title">Count the cash before confirming</p>
                        <p className="callout__body">
                          Confirm only after receiving payment from the customer. Refill containers after the sale is
                          saved.
                        </p>
                      </div>

                      {saleError && (
                        <div className="alert alert--error" role="alert">
                          {saleError}
                        </div>
                      )}

                      <label className="field">
                        <span>Cash received (₱)</span>
                        <div className="cash-input-wrap">
                          <span className="cash-input-prefix" aria-hidden="true">
                            ₱
                          </span>
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label="Cash received"
                            placeholder="0.00"
                            value={cashInput}
                            onChange={(event) => {
                              setCashInput(event.target.value);
                              setSaleError(null);
                            }}
                          />
                        </div>
                      </label>

                      <div className="quick-tender-row" aria-label="Quick cash amounts">
                        <button
                          type="button"
                          className="button button--ghost button--sm"
                          onClick={() => setCashInput((reviewTotalCentavos / 100).toFixed(2))}
                        >
                          Exact amount
                        </button>
                        {[50, 100, 200, 500, 1000].map((peso) => (
                          <button
                            key={peso}
                            type="button"
                            className="button button--ghost button--sm"
                            onClick={() => setCashInput(peso.toFixed(2))}
                          >
                            ₱{peso.toLocaleString("en-US")}
                          </button>
                        ))}
                      </div>

                      {parsedCashCentavos === null ? (
                        <div className="change-box change-box--idle" role="status">
                          <span className="muted-sm">
                            Enter cash received covering at least {formatCentavos(reviewTotalCentavos)}.
                          </span>
                        </div>
                      ) : !cashSummary.sufficient ? (
                        <div className="change-box change-box--short" role="status">
                          <strong>Insufficient cash</strong>
                          <span>
                            Need {formatCentavos(cashSummary.shortfallCentavos)} more to cover{" "}
                            {formatCentavos(reviewTotalCentavos)}.
                          </span>
                        </div>
                      ) : (
                        <div className="change-box change-box--ok" role="status">
                          <span className="change-box__label">Change to give customer</span>
                          <strong className="change-box__value">
                            {formatCentavos(cashSummary.changeCentavos!)}
                          </strong>
                          <span className="muted-sm">
                            {formatCentavos(parsedCashCentavos)} cash − {formatCentavos(reviewTotalCentavos)} total
                          </span>
                        </div>
                      )}

                      <div className="pos-summary-actions">
                        <button
                          type="button"
                          className="button button--primary button--block"
                          disabled={!cashSummary.sufficient || confirmingSale || cancellingDraft}
                          onClick={() => void handleConfirmPayment()}
                        >
                          {confirmingSale
                            ? "Saving sale…"
                            : `Confirm payment · ${formatCentavos(reviewTotalCentavos)}`}
                        </button>
                        <button
                          type="button"
                          className="button button--ghost button--block"
                          disabled={confirmingSale || cancellingDraft}
                          onClick={() => void handleBackToSelection()}
                        >
                          {cancellingDraft ? "Returning to refills…" : "Back to refill selection"}
                        </button>
                      </div>
                    </article>
                  </div>

                  <aside className="side-stack">
                    <article className="card detail-card" aria-label="Prepared checkout summary">
                      <div className="detail-card__header">
                        <h2>Current sale</h2>
                        <span className="pill pill--scheduled">
                          {preparedCheckout?.totalContainers ?? cartTotals.totalContainers} container
                          {(preparedCheckout?.totalContainers ?? cartTotals.totalContainers) === 1 ? "" : "s"}
                        </span>
                      </div>

                      <ul className="pos-summary-lines">
                        {(preparedCheckout?.items ?? []).map((item) => (
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
                          <dt>Containers</dt>
                          <dd>{preparedCheckout?.totalContainers ?? cartTotals.totalContainers}</dd>
                        </div>
                        <div className="detail-list__row">
                          <dt>Total water</dt>
                          <dd>{formatLiters(preparedCheckout?.totalVolumeLiters ?? cartTotals.totalVolumeLiters)}</dd>
                        </div>
                        <div className="detail-list__row detail-list__row--total">
                          <dt>Total amount</dt>
                          <dd>{formatCentavos(reviewTotalCentavos)}</dd>
                        </div>
                        <div className="detail-list__row">
                          <dt>Cash received</dt>
                          <dd>{parsedCashCentavos !== null ? formatCentavos(parsedCashCentavos) : "—"}</dd>
                        </div>
                        <div className="detail-list__row">
                          <dt>Change</dt>
                          <dd>{cashSummary.changeCentavos !== null ? formatCentavos(cashSummary.changeCentavos) : "—"}</dd>
                        </div>
                      </dl>
                    </article>

                    <article className="card trust-card">
                      <h3>Every sale, saved once.</h3>
                      <p className="muted-sm">
                        Wait for a saved confirmation before refilling. If saving is uncertain, check the transaction
                        before retrying.
                      </p>
                    </article>
                  </aside>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {customizeOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setCustomizeOpen(false)}
        >
          <div
            className="modal modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="customize-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="detail-card__header">
              <div>
                <h2 id="customize-title">Customize refill</h2>
                <p className="muted-sm">Choose water type, liters per container, and Owner-discussed price.</p>
              </div>
            </div>

            <form className="subview" onSubmit={handleAddCustomLine}>
              <div className="customize-water-grid" role="radiogroup" aria-label="Choose your water type">
                {(["PURIFIED", "ALKALINE"] as const).map((type) => {
                  const selected = customWaterType === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`customize-water-card ${selected ? "customize-water-card--selected" : ""}`}
                      onClick={() => setCustomWaterType(type)}
                    >
                      <strong>{type === "PURIFIED" ? "Purified Refill" : "Alkaline Refill"}</strong>
                      <span className="muted-sm">
                        {type === "PURIFIED" ? "Purified drinking water" : "Alkaline drinking water"}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="field-row">
                <label className="field">
                  <span>Edit Liters (per container)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="Liters per container"
                    placeholder="e.g. 11"
                    value={customLitersInput}
                    onChange={(event) => {
                      setCustomLitersInput(event.target.value);
                      setCustomError(null);
                    }}
                  />
                </label>

                <label className="field">
                  <span>Edit Price (₱ per container)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="Price per container"
                    placeholder="e.g. 120.00"
                    value={customPriceInput}
                    onChange={(event) => {
                      setCustomPriceInput(event.target.value);
                      setCustomError(null);
                    }}
                  />
                </label>
              </div>

              <div className="customize-qty-row">
                <span className="customize-qty-row__label">Quantity (containers)</span>
                <div className="qty-stepper" aria-label="Custom refill quantity">
                  <button
                    type="button"
                    className="qty-stepper__btn"
                    aria-label="Decrease custom quantity"
                    disabled={customQty <= 1}
                    onClick={() => setCustomQty((q) => Math.max(1, q - 1))}
                  >
                    −
                  </button>
                  <span className="qty-stepper__value">{customQty}</span>
                  <button
                    type="button"
                    className="qty-stepper__btn"
                    aria-label="Increase custom quantity"
                    disabled={customQty >= MAX_LINE_QTY}
                    onClick={() => setCustomQty((q) => Math.min(MAX_LINE_QTY, q + 1))}
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="callout callout--info">
                <p className="callout__body">
                  {parsedCustomLiters !== null && parsedCustomPriceCentavos !== null
                    ? `${customQty} × ${formatLiters(parsedCustomLiters)} at ${formatCentavos(
                        parsedCustomPriceCentavos,
                      )} = ${formatCentavos(parsedCustomPriceCentavos * customQty)} (${formatLiters(
                        Number((parsedCustomLiters * customQty).toFixed(2)),
                      )})`
                    : "Cashier consults Owner for the custom price, then enters liters and price per container."}
                </p>
              </div>

              {customError && (
                <div className="alert alert--error" role="alert">
                  {customError}
                </div>
              )}

              <div className="modal__actions">
                <button type="button" className="button button--ghost" onClick={() => setCustomizeOpen(false)}>
                  Discard
                </button>
                <button type="submit" className="button button--primary">
                  Add To Cart
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {endDayOpen && dayStatus?.day && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!endingDay) setEndDayOpen(false);
          }}
        >
          <div
            className="modal modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="end-day-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="end-day-title">End business day ({dayStatus.day.businessDate})</h2>
            <p className="muted-sm">
              Started by <strong>{dayStatus.day.startedBy}</strong> at{" "}
              {formatManilaTimestamp(dayStatus.day.startedAt)}. Closing is permanent for this business date.
            </p>

            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Total valid sales</dt>
                <dd>{formatCentavos(dayStatus.day.summary.totalSalesCentavos)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Valid transactions</dt>
                <dd>{dayStatus.day.summary.validTransactionCount}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Purified refills</dt>
                <dd>
                  {dayStatus.day.summary.purifiedQuantity} ({formatLiters(dayStatus.day.summary.purifiedVolumeMl / 1000)})
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Alkaline refills</dt>
                <dd>
                  {dayStatus.day.summary.alkalineQuantity} ({formatLiters(dayStatus.day.summary.alkalineVolumeMl / 1000)})
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Total water sold</dt>
                <dd>{formatLiters(dayStatus.day.summary.totalVolumeLiters)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>Voided transactions</dt>
                <dd>
                  {dayStatus.day.summary.voidedCount} ({formatCentavos(dayStatus.day.summary.voidedTotalCentavos)})
                </dd>
              </div>
            </dl>

            {hasBlockingUnresolved && (
              <div className="callout callout--danger" role="alert">
                <p className="callout__title">Unresolved checkouts block End Day</p>
                <p className="callout__body">Resolve pending or review-required transactions before closing this day:</p>
                <ul className="conflict-list">
                  {serverUnresolved.map((c) => (
                    <li key={c.reference}>
                      <span className="mono-ref">{c.reference}</span> — {c.resolutionReason ?? c.status}
                    </li>
                  ))}
                  {localBlockingRecovery &&
                    !serverUnresolved.some((c) => c.reference === localBlockingRecovery.reference) && (
                      <li>
                        <span className="mono-ref">{localBlockingRecovery.reference}</span> — Pending workstation
                        payment recovery ({localBlockingRecovery.initiatedBy})
                      </li>
                    )}
                </ul>
              </div>
            )}

            {!hasBlockingUnresolved && serverDrafts.length > 0 && (
              <div className="callout callout--warning" role="status">
                <p className="callout__title">Unpaid checkout draft(s) open</p>
                <ul className="conflict-list">
                  {serverDrafts.map((draft) => (
                    <li key={draft.reference}>
                      <span className="mono-ref">{draft.reference}</span> · {formatCentavos(draft.totalCentavos)} (
                      {draft.createdBy})
                    </li>
                  ))}
                </ul>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={endDayClearDrafts}
                    onChange={(event) => setEndDayClearDrafts(event.target.checked)}
                  />
                  <span>Clear listed unpaid checkout draft(s) and close the day</span>
                </label>
              </div>
            )}

            {endDayError && (
              <div className="alert alert--error" role="alert">
                {endDayError}
              </div>
            )}

            <div className="modal__actions">
              <button
                type="button"
                className="button button--ghost"
                disabled={endingDay}
                onClick={() => setEndDayOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={endingDay || hasBlockingUnresolved || draftsNeedAck}
                onClick={() => void handleConfirmEndDay()}
              >
                {endingDay ? "Closing day…" : "Confirm End Day"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
