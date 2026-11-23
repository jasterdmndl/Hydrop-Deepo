import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useSignedInUser } from "../auth/AuthContext";
import { createRequestTracker } from "../calendar/calendarView";
import { AppShell, useModulesData } from "../ChooseModule";
import { type NoticeEnvelope, wrapNotice } from "../notifications/noticeTiming";
import { TemporaryNotice } from "../notifications/TemporaryNotice";
import { CheckoutRecovery } from "./CheckoutRecovery";
import {
  type BeginPaymentResponse,
  cartLinesSignature,
  type CartDraftLine,
  type CatalogRefill,
  type CheckoutLookupView,
  type CheckoutView,
  clearUnpaidCart,
  clearUnpaidCartIfMatchesReference,
  computeCashSummary,
  type ConfirmSaleResponse,
  type ContainerPackageCode,
  currentManilaIso,
  type DaySummaryView,
  type EndDayResponse,
  evaluateEndDayGuard,
  formatCentavos,
  formatIncludedGripoLabel,
  formatLiters,
  formatManilaTimestamp,
  type IncludedGripoType,
  isPendingRecoveryStorageKey,
  isPriorDayMerchandiseOnly,
  isPriorDaySettleableComposition,
  loadPendingRecoveries,
  loadUnpaidCart,
  notifyPosStateChanged,
  parseLitersInput,
  parsePesoInputToCentavos,
  type PendingCheckoutRecovery,
  type PosContainerPackageItem,
  type PosDayResponse,
  type PosMerchandiseItem,
  type PosSectionInfo,
  type PrepareCheckoutResponse,
  type PriorDaySettlementView,
  type QuoteLineItem,
  removePendingRecovery,
  savePendingRecovery,
  saveUnpaidCart,
  type SaleView,
  stationStatusFromDay,
  toCartItemInputs,
  type WaterType,
} from "./posRecovery";
import {
  getVisibleQuantityError,
  hasInvalidQuantityEdits,
  isQuantityEditInvalid,
  MAX_LINE_QTY,
  QUANTITY_ERROR_MESSAGE,
  type QuantityEditState,
  revealInvalidQuantityEdit,
  revealInvalidQuantityEdits,
} from "./quantityInput";
import { QuantityStepper } from "./QuantityStepper";
import { PriorDaySettlementModal } from "./PriorDaySettlementModal";
import { SaleHistory } from "./SaleHistory";

type PosTab = "sale" | "history";
type SaleStep = "select" | "review";

const MAX_LINES = 50;

function generateKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const DEFAULT_MERCHANDISE_SECTIONS: readonly PosSectionInfo[] = [
  {
    code: "TAKIP_ACCESSORIES",
    name: "Takip Types / Accessories",
    isBuiltIn: true,
    sortOrder: 20,
  },
  {
    code: "CHANGE_OF_GRIPO",
    name: "Change of Gripo",
    isBuiltIn: true,
    sortOrder: 30,
  },
];

function sectionSubtitleFor(code: string): string {
  switch (code) {
    case "CONTAINERS":
      return "Choose the container type.";
    case "TAKIP_ACCESSORIES":
      return "Choose caps, dividers, or accessories.";
    case "CHANGE_OF_GRIPO":
      return "Choose the type of gripo.";
    default:
      return "Choose merchandise items.";
  }
}

function defaultLineId(waterType: WaterType): string {
  return `std-${waterType}`;
}

function merchLineId(productId: string): string {
  return `merch-${productId}`;
}

const INCLUDED_GRIPO_OPTIONS: readonly { value: IncludedGripoType; label: string }[] = [
  { value: "PUSH_TYPE", label: "Push-Type gripo" },
  { value: "TWIST_TYPE", label: "Twist-Type gripo" },
];

function containerPkgKey(packageCode: ContainerPackageCode, includedGripo: IncludedGripoType): string {
  return `${packageCode}:${includedGripo}`;
}

function containerPkgLineId(
  packageCode: ContainerPackageCode,
  includedGripo: IncludedGripoType | null,
): string {
  return `pkg-${packageCode}-${includedGripo ?? "UNSPECIFIED"}`;
}

function formatCartCountPill(containers: number, merchandiseQty: number): string {
  const parts: string[] = [];
  if (containers > 0 || merchandiseQty === 0) {
    parts.push(`${containers} container${containers === 1 ? "" : "s"}`);
  }
  if (merchandiseQty > 0) {
    parts.push(`${merchandiseQty} item${merchandiseQty === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function formatSavedSaleHandover(sale: SaleView): string {
  const merchQty = sale.items
    .filter((item) => item.kind === "MERCHANDISE" || item.kind === "CONTAINER_PACKAGE")
    .reduce((sum, item) => sum + item.quantity, 0);
  if (sale.totalContainers > 0 && merchQty > 0) {
    return `refill ${sale.totalContainers} container${sale.totalContainers === 1 ? "" : "s"} (${formatLiters(
      sale.totalVolumeLiters,
    )}) and hand over ${merchQty} merchandise item${merchQty === 1 ? "" : "s"}.`;
  }
  if (sale.totalContainers === 0 && merchQty > 0) {
    return `hand over ${merchQty} merchandise item${merchQty === 1 ? "" : "s"}.`;
  }
  return `refill ${sale.totalContainers} container${sale.totalContainers === 1 ? "" : "s"} (${formatLiters(
    sale.totalVolumeLiters,
  )}), and hand over.`;
}

function quoteItemsToDraftLines(items: QuoteLineItem[]): CartDraftLine[] {
  return items.map((item) => {
    if (item.kind === "STANDARD") {
      const waterType = item.waterType ?? "PURIFIED";
      return {
        id: defaultLineId(waterType),
        kind: "STANDARD",
        waterType,
        displayName: item.displayLabel,
        unitVolumeMl: item.unitVolumeMl,
        unitVolumeLiters: item.unitVolumeLiters,
        unitPriceCentavos: item.unitPriceCentavos,
        quantity: item.quantity,
      };
    }
    if (item.kind === "CUSTOM") {
      const waterType = item.waterType ?? "PURIFIED";
      return {
        id: `custom-${item.lineIndex}-${waterType}-${item.unitVolumeMl}-${item.unitPriceCentavos}`,
        kind: "CUSTOM",
        waterType,
        displayName: item.displayLabel,
        unitVolumeLiters: item.unitVolumeLiters,
        unitPriceCentavos: item.unitPriceCentavos,
        quantity: item.quantity,
      };
    }
    if (item.kind === "CONTAINER_PACKAGE") {
      const packageCode = (item.catalogCode ?? "ROUND_EMPTY") as ContainerPackageCode;
      const includedGripo: IncludedGripoType | null = item.includedGripo ?? null;
      return {
        id: containerPkgLineId(packageCode, includedGripo),
        kind: "CONTAINER_PACKAGE",
        packageCode,
        includedGripo,
        productId: item.productId ?? `pkg-${item.lineIndex}`,
        displayName: item.displayLabel,
        unitVolumeMl: item.unitVolumeMl,
        unitVolumeLiters: item.unitVolumeLiters,
        unitPriceCentavos: item.unitPriceCentavos,
        stockUnit: item.stockUnit ?? "containers",
        quantity: item.quantity,
      };
    }
    const productId = item.productId ?? `line-${item.lineIndex}`;
    return {
      id: merchLineId(productId),
      kind: "MERCHANDISE",
      productId,
      displayName: item.displayLabel,
      description: null,
      stockUnit: item.stockUnit ?? "pcs",
      posSection: item.posSection ?? "TAKIP_ACCESSORIES",
      unitPriceCentavos: item.unitPriceCentavos,
      quantity: item.quantity,
    };
  });
}

export function PosPage() {
  const user = useSignedInUser();
  const { data: modulesData } = useModulesData();

  const [catalog, setCatalog] = useState<CatalogRefill[]>([]);
  const [merchandise, setMerchandise] = useState<PosMerchandiseItem[]>([]);
  const [containerPackages, setContainerPackages] = useState<PosContainerPackageItem[]>([]);
  const [posSections, setPosSections] = useState<PosSectionInfo[]>([]);
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
  const [confirmNoCashChecked, setConfirmNoCashChecked] = useState(false);
  const [saleError, setSaleError] = useState<NoticeEnvelope<string> | null>(null);

  const [pendingRecoveries, setPendingRecoveries] = useState<PendingCheckoutRecovery[]>(() =>
    loadPendingRecoveries(),
  );
  const [selectedRecoveryRef, setSelectedRecoveryRef] = useState<string | null>(
    () => loadPendingRecoveries()[0]?.reference ?? null,
  );
  const [activeConfirming, setActiveConfirming] = useState<PendingCheckoutRecovery | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [retryingRecovery, setRetryingRecovery] = useState(false);
  const [recoveryError, setRecoveryError] = useState<NoticeEnvelope<string> | null>(null);

  const [lastSavedSale, setLastSavedSale] = useState<NoticeEnvelope<SaleView> | null>(null);
  const [lastClosedSummary, setLastClosedSummary] = useState<NoticeEnvelope<DaySummaryView> | null>(null);
  const [lastSettledPriorDay, setLastSettledPriorDay] =
    useState<NoticeEnvelope<PriorDaySettlementView> | null>(null);
  const [lastAlreadySavedPriorDay, setLastAlreadySavedPriorDay] =
    useState<NoticeEnvelope<SaleView> | null>(null);
  const [historyFocusRef, setHistoryFocusRef] = useState<string | null>(null);
  const [historySettlementFocusRef, setHistorySettlementFocusRef] = useState<string | null>(null);
  const [historyRefreshSignal, setHistoryRefreshSignal] = useState(0);
  const [settlementTarget, setSettlementTarget] = useState<{
    checkout: CheckoutView;
    localCashReceivedCentavos?: number | null;
  } | null>(null);

  const [startingDay, setStartingDay] = useState(false);
  const [startRequestKey, setStartRequestKey] = useState<string | null>(null);
  const [dayActionError, setDayActionError] = useState<NoticeEnvelope<string> | null>(null);

  const [preparingCheckout, setPreparingCheckout] = useState(false);
  const [startingPayment, setStartingPayment] = useState(false);
  const [confirmingSale, setConfirmingSale] = useState(false);
  const [cancellingDraft, setCancellingDraft] = useState(false);

  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [customWaterType, setCustomWaterType] = useState<WaterType>("PURIFIED");
  const [customLitersInput, setCustomLitersInput] = useState("");
  const [customPriceInput, setCustomPriceInput] = useState("");
  const [customQty, setCustomQty] = useState(1);
  const [customQtyEdit, setCustomQtyEdit] = useState<QuantityEditState | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);

  const [qtyEdits, setQtyEdits] = useState<Record<string, QuantityEditState>>({});

  const [endDayOpen, setEndDayOpen] = useState(false);
  const [endDayClearDrafts, setEndDayClearDrafts] = useState(false);
  const [closeRequestKey, setCloseRequestKey] = useState<string | null>(null);
  const [endingDay, setEndingDay] = useState(false);
  const [endDayError, setEndDayError] = useState<NoticeEnvelope<string> | null>(null);

  const [cartHydratedUser, setCartHydratedUser] = useState<string | null>(null);
  const isCartHydrated = cartHydratedUser === user.username;
  const loadTrackerRef = useRef(createRequestTracker());
  const preparedCheckoutRef = useRef<CheckoutView | null>(null);
  preparedCheckoutRef.current = preparedCheckout;
  const activeConfirmingRef = useRef<PendingCheckoutRecovery | null>(null);
  const qtyInputRefs = useRef(new Map<string, HTMLInputElement | null>());
  const customQtyInputRef = useRef<HTMLInputElement | null>(null);

  const activeRecovery = useMemo(
    () =>
      pendingRecoveries.find((r) => r.reference === selectedRecoveryRef) ??
      pendingRecoveries[0] ??
      null,
    [pendingRecoveries, selectedRecoveryRef],
  );

  const inActiveCashStep =
    step === "review" && preparedCheckout !== null && preparedCheckout.status === "PAYMENT_PENDING";
  const showRecoveryScreen =
    activeRecovery !== null && activeConfirming === null && !inActiveCashStep;

  const clearAllQtyEdits = useCallback(() => {
    setQtyEdits({});
  }, []);

  const closeCustomizeModal = useCallback(() => {
    setCustomizeOpen(false);
    setCustomQty(1);
    setCustomQtyEdit(null);
    setCustomError(null);
  }, []);

  const applyServerDayStatus = useCallback(
    (dayRes: PosDayResponse) => {
      setDayStatus(dayRes);
      if (!dayRes.canSell) {
        clearAllQtyEdits();
        closeCustomizeModal();
      }
      if (activeConfirmingRef.current !== null) return;
      const currentPrepared = preparedCheckoutRef.current;
      if (!currentPrepared) return;

      const matched =
        dayRes.state === "OPEN" && currentPrepared.businessDate === dayRes.todayDate
          ? (dayRes.unresolvedCheckouts.find(
            (c) => c.reference === currentPrepared.reference && c.status === "PAYMENT_PENDING",
          ) ?? dayRes.unpaidDrafts.find((d) => d.reference === currentPrepared.reference))
          : undefined;

      if (!matched) {
        setPreparedCheckout(null);
        setPrepareKey(null);
        setPrepareSignature(null);
        setStep("select");
        setCashInput("");
        setConfirmNoCashChecked(false);
      } else if (
        matched.status !== currentPrepared.status ||
        matched.updatedAt !== currentPrepared.updatedAt
      ) {
        setPreparedCheckout(matched);
      }
    },
    [clearAllQtyEdits, closeCustomizeModal],
  );

  const loadPosState = useCallback(async () => {
    const requestId = loadTrackerRef.current.next();
    setLoading(true);
    setPageError(null);
    try {
      const [catRes, dayRes] = await Promise.all([
        api<{
          items: CatalogRefill[];
          merchandise?: PosMerchandiseItem[];
          containerPackages?: PosContainerPackageItem[];
          posSections?: PosSectionInfo[];
        }>("/api/pos/catalog", {
          background: true,
        }),
        api<PosDayResponse>("/api/pos/day", { background: true }),
      ]);
      if (!loadTrackerRef.current.isCurrent(requestId)) return;
      setCatalog(catRes.items);
      setMerchandise(catRes.merchandise ?? []);
      setContainerPackages(catRes.containerPackages ?? []);
      setPosSections(catRes.posSections ?? []);
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
    const recoveries = loadPendingRecoveries();
    setPendingRecoveries(recoveries);
    setSelectedRecoveryRef((prev) =>
      prev && recoveries.some((r) => r.reference === prev)
        ? prev
        : (recoveries[0]?.reference ?? null),
    );
    setLines([]);
    setPreparedCheckout(null);
    setPrepareKey(null);
    setPrepareSignature(null);
    setStep("select");
    setConfirmNoCashChecked(false);
    clearAllQtyEdits();
    setCustomQtyEdit(null);
    setCartHydratedUser(null);
    void loadPosState();
  }, [user.username, loadPosState, clearAllQtyEdits]);

  // Synchronize per-reference recovery records across browser tabs in real time.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!isPendingRecoveryStorageKey(event.key)) return;
      const next = loadPendingRecoveries();
      setPendingRecoveries(next);
      setSelectedRecoveryRef((prev) =>
        prev && next.some((r) => r.reference === prev) ? prev : (next[0]?.reference ?? null),
      );
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Hydrate the signed-in account's saved unpaid cart before persistence writes resume.
  useEffect(() => {
    if (isCartHydrated || showRecoveryScreen || activeConfirming !== null) return;
    const savedCart = loadUnpaidCart(user.username);
    if (savedCart) {
      setLines(Array.isArray(savedCart.lines) ? savedCart.lines : []);
      setPreparedCheckout(savedCart.preparedCheckout ?? null);
      setPrepareKey(savedCart.prepareKey ?? null);
      setPrepareSignature(savedCart.prepareSignature ?? null);
      setStep(savedCart.preparedCheckout ? "review" : "select");
    } else {
      setLines([]);
      setPreparedCheckout(null);
      setPrepareKey(null);
      setPrepareSignature(null);
      setStep("select");
    }
    setCartHydratedUser(user.username);
  }, [user.username, isCartHydrated, showRecoveryScreen, activeConfirming]);

  // Persist unpaid cart only for the signed-in account while not on recovery/confirming.
  useEffect(() => {
    if (!isCartHydrated || activeConfirming !== null || showRecoveryScreen) return;
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
  }, [
    user.username,
    dayStatus?.todayDate,
    isCartHydrated,
    lines,
    preparedCheckout,
    prepareKey,
    prepareSignature,
    activeConfirming,
    showRecoveryScreen,
  ]);

  // Close Customize or End Day modals cleanly on Escape unless a child input handled it.
  useEffect(() => {
    if (!customizeOpen && !endDayOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (customizeOpen) closeCustomizeModal();
      if (endDayOpen && !endingDay) setEndDayOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [customizeOpen, endDayOpen, endingDay, closeCustomizeModal]);

  const stationStatus = dayStatus ? stationStatusFromDay(dayStatus) : null;

  const cartTotals = useMemo(() => {
    let totalCentavos = 0;
    let totalContainers = 0;
    let totalMerchandiseQty = 0;
    let totalVolumeLiters = 0;
    for (const line of lines) {
      totalCentavos += line.unitPriceCentavos * line.quantity;
      if (line.kind === "MERCHANDISE") {
        totalMerchandiseQty += line.quantity;
      } else if (line.kind === "CONTAINER_PACKAGE") {
        totalMerchandiseQty += line.quantity;
        totalVolumeLiters += line.unitVolumeLiters * line.quantity;
      } else {
        totalContainers += line.quantity;
        totalVolumeLiters += line.unitVolumeLiters * line.quantity;
      }
    }
    return {
      totalCentavos,
      totalContainers,
      totalMerchandiseQty,
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

  const merchandiseQtyById = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of lines) {
      if (line.kind === "MERCHANDISE") {
        map.set(line.productId, line.quantity);
      }
    }
    return map;
  }, [lines]);

  const containerPkgQtyByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of lines) {
      if (line.kind === "CONTAINER_PACKAGE" && line.includedGripo) {
        map.set(containerPkgKey(line.packageCode, line.includedGripo), line.quantity);
      }
    }
    return map;
  }, [lines]);

  const selectedContainerQtyByProductId = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of lines) {
      if (line.kind === "CONTAINER_PACKAGE") {
        map.set(line.productId, (map.get(line.productId) ?? 0) + line.quantity);
      }
    }
    return map;
  }, [lines]);

  const merchandiseSections = useMemo(() => {
    const orderedSections = (posSections.length > 0 ? posSections : DEFAULT_MERCHANDISE_SECTIONS)
      .filter((s) => s.code !== "CONTAINERS")
      .slice()
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });

    const knownCodes = new Set(orderedSections.map((s) => s.code));
    const groups = orderedSections
      .map((meta) => ({
        section: meta.code,
        title: meta.name,
        subtitle: sectionSubtitleFor(meta.code),
        items: merchandise.filter((item) => item.posSection === meta.code),
      }))
      .filter((group) => group.items.length > 0);

    const extraCodes = Array.from(
      new Set(merchandise.map((item) => item.posSection).filter((code) => !knownCodes.has(code))),
    ).sort();
    for (const code of extraCodes) {
      groups.push({
        section: code,
        title: code,
        subtitle: sectionSubtitleFor(code),
        items: merchandise.filter((item) => item.posSection === code),
      });
    }
    return groups;
  }, [merchandise, posSections]);

  const customLines = useMemo(() => lines.filter((line) => line.kind === "CUSTOM"), [lines]);

  const customLabelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const line of customLines) {
      counts.set(line.displayName, (counts.get(line.displayName) ?? 0) + 1);
    }
    return counts;
  }, [customLines]);

  const endDayGuard = useMemo(
    () =>
      evaluateEndDayGuard({
        businessDate: dayStatus?.day?.businessDate ?? null,
        serverUnresolved: dayStatus?.unresolvedCheckouts ?? [],
        serverUnpaidDrafts: dayStatus?.unpaidDrafts ?? [],
        localPendingRecoveries: pendingRecoveries,
        activeConfirming,
      }),
    [dayStatus, pendingRecoveries, activeConfirming],
  );

  const localRecoveryRefSet = useMemo(
    () => new Set(pendingRecoveries.map((r) => r.reference.trim().toUpperCase())),
    [pendingRecoveries],
  );

  const serverOnlyUnresolved = useMemo(
    () =>
      (dayStatus?.unresolvedCheckouts ?? []).filter(
        (c) => !localRecoveryRefSet.has(c.reference.trim().toUpperCase()),
      ),
    [dayStatus?.unresolvedCheckouts, localRecoveryRefSet],
  );

  const serverOnlyClosedPriorDayReview = useMemo(
    () =>
      (dayStatus?.priorDayReviewCheckouts ?? []).filter(
        (c) => !localRecoveryRefSet.has(c.reference.trim().toUpperCase()),
      ),
    [dayStatus?.priorDayReviewCheckouts, localRecoveryRefSet],
  );

  function setFieldQtyEdit(fieldId: string, nextEdit: QuantityEditState | null) {
    if (!nextEdit?.showError) {
      setSaleError(null);
    }
    setQtyEdits((prev) => {
      if (nextEdit === null) {
        if (!(fieldId in prev)) return prev;
        const copy = { ...prev };
        delete copy[fieldId];
        return copy;
      }
      return { ...prev, [fieldId]: nextEdit };
    });
  }

  function clearFieldQtyEdit(fieldId: string) {
    setQtyEdits((prev) => {
      if (!(fieldId in prev)) return prev;
      const copy = { ...prev };
      delete copy[fieldId];
      return copy;
    });
  }

  function setStandardQuantity(item: CatalogRefill, nextQty: number): boolean {
    const clamped = Math.max(0, Math.min(MAX_LINE_QTY, Math.trunc(nextQty)));
    const id = defaultLineId(item.waterType);
    const existingIdx = lines.findIndex((l) => l.id === id);

    if (clamped > 0 && existingIdx === -1 && lines.length >= MAX_LINES) {
      setSaleError(wrapNotice(`Maximum ${MAX_LINES} lines per sale.`));
      return false;
    }

    setSaleError(null);
    setLastSavedSale(null);
    setLastSettledPriorDay(null);
    setLastAlreadySavedPriorDay(null);
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (clamped === 0) {
        return idx === -1 ? prev : prev.filter((l) => l.id !== id);
      }
      if (idx !== -1) {
        return prev.map((l) => (l.id === id ? { ...l, quantity: clamped } : l));
      }
      if (prev.length >= MAX_LINES) {
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
    return true;
  }

  function setMerchandiseQuantity(item: PosMerchandiseItem, nextQty: number): boolean {
    const maxAllowed =
      item.availableQuantity !== null ? Math.min(MAX_LINE_QTY, item.availableQuantity) : 0;
    const clamped = Math.max(0, Math.min(maxAllowed, Math.trunc(nextQty)));
    const id = merchLineId(item.id);
    const existingIdx = lines.findIndex((l) => l.id === id);

    if (clamped > 0 && existingIdx === -1 && lines.length >= MAX_LINES) {
      setSaleError(wrapNotice(`Maximum ${MAX_LINES} lines per sale.`));
      return false;
    }

    setSaleError(null);
    setLastSavedSale(null);
    setLastSettledPriorDay(null);
    setLastAlreadySavedPriorDay(null);
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (clamped === 0) {
        return idx === -1 ? prev : prev.filter((l) => l.id !== id);
      }
      if (idx !== -1) {
        return prev.map((l) =>
          l.id === id
            ? {
                ...l,
                displayName: item.name,
                unitPriceCentavos: item.unitPriceCentavos,
                quantity: clamped,
              }
            : l,
        );
      }
      if (prev.length >= MAX_LINES) {
        return prev;
      }
      return [
        ...prev,
        {
          id,
          kind: "MERCHANDISE",
          productId: item.id,
          displayName: item.name,
          description: item.description,
          stockUnit: item.unit,
          posSection: item.posSection,
          unitPriceCentavos: item.unitPriceCentavos,
          quantity: clamped,
        },
      ];
    });
    return true;
  }

  function setContainerPackageQuantity(
    pkg: PosContainerPackageItem,
    includedGripo: IncludedGripoType,
    nextQty: number,
  ): boolean {
    const currentQty = containerPkgQtyByKey.get(containerPkgKey(pkg.packageCode, includedGripo)) ?? 0;
    const otherQty = Math.max(0, (selectedContainerQtyByProductId.get(pkg.productId) ?? 0) - currentQty);
    const remainingAvailable =
      pkg.availableQuantity !== null ? Math.max(0, pkg.availableQuantity - otherQty) : 0;
    const maxAllowed = Math.min(MAX_LINE_QTY, currentQty + remainingAvailable);
    const clamped = Math.max(0, Math.min(maxAllowed, Math.trunc(nextQty)));
    const id = containerPkgLineId(pkg.packageCode, includedGripo);
    const displayName = `${pkg.name} · ${formatIncludedGripoLabel(includedGripo)}`;
    const existingIdx = lines.findIndex((l) => l.id === id);

    if (clamped > 0 && existingIdx === -1 && lines.length >= MAX_LINES) {
      setSaleError(wrapNotice(`Maximum ${MAX_LINES} lines per sale.`));
      return false;
    }

    setSaleError(null);
    setLastSavedSale(null);
    setLastSettledPriorDay(null);
    setLastAlreadySavedPriorDay(null);
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (clamped === 0) {
        return idx === -1 ? prev : prev.filter((l) => l.id !== id);
      }
      if (idx !== -1) {
        return prev.map((l) =>
          l.id === id
            ? {
                ...l,
                displayName,
                unitPriceCentavos: pkg.unitPriceCentavos,
                quantity: clamped,
              }
            : l,
        );
      }
      if (prev.length >= MAX_LINES) {
        return prev;
      }
      return [
        ...prev,
        {
          id,
          kind: "CONTAINER_PACKAGE",
          packageCode: pkg.packageCode,
          includedGripo,
          productId: pkg.productId,
          displayName,
          unitVolumeMl: pkg.unitVolumeMl,
          unitVolumeLiters: pkg.unitVolumeLiters,
          unitPriceCentavos: pkg.unitPriceCentavos,
          stockUnit: pkg.unit,
          quantity: clamped,
        },
      ];
    });
    return true;
  }

  function setCustomLineQuantity(id: string, nextQty: number) {
    const clamped = Math.max(1, Math.min(MAX_LINE_QTY, Math.trunc(nextQty)));
    setSaleError(null);
    setLastSavedSale(null);
    setLastSettledPriorDay(null);
    setLastAlreadySavedPriorDay(null);
    setLines((prev) =>
      prev.map((line) => (line.id === id ? { ...line, quantity: clamped } : line)),
    );
  }

  function adjustCustomLineQuantity(id: string, delta: number) {
    clearFieldQtyEdit(id);
    setSaleError(null);
    setLastSavedSale(null);
    setLastSettledPriorDay(null);
    setLastAlreadySavedPriorDay(null);
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
    clearFieldQtyEdit(id);
    setSaleError(null);
    setLines((prev) => prev.filter((line) => line.id !== id));
  }

  function openCustomizeModal() {
    setQtyEdits((prev) => revealInvalidQuantityEdits(prev).nextEdits);
    if (
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.classList.contains("qty-stepper__value")
    ) {
      document.activeElement.blur();
    }
    setCustomWaterType("PURIFIED");
    setCustomLitersInput("");
    setCustomPriceInput("");
    setCustomQty(1);
    setCustomQtyEdit(null);
    setCustomError(null);
    setCustomizeOpen(true);
  }

  const parsedCustomLiters = parseLitersInput(customLitersInput);
  const parsedCustomPriceCentavos = parsePesoInputToCentavos(customPriceInput);
  const visibleCustomQtyError = getVisibleQuantityError(customQtyEdit);
  const hasInvalidLineEdits = hasInvalidQuantityEdits(qtyEdits);

  function handleAddCustomLine(event: FormEvent) {
    event.preventDefault();
    setCustomError(null);
    if (isQuantityEditInvalid(customQtyEdit)) {
      setCustomQtyEdit(revealInvalidQuantityEdit(customQtyEdit));
      setCustomError(QUANTITY_ERROR_MESSAGE);
      customQtyInputRef.current?.focus();
      return;
    }
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

    const existingMatch = lines.find(
      (l) =>
        l.kind === "CUSTOM" &&
        l.waterType === customWaterType &&
        l.unitVolumeLiters === parsedCustomLiters &&
        l.unitPriceCentavos === parsedCustomPriceCentavos,
    );
    if (!existingMatch && lines.length >= MAX_LINES) {
      setCustomError(`Maximum ${MAX_LINES} lines per sale.`);
      return;
    }

    const typeLabel = customWaterType === "PURIFIED" ? "Purified" : "Alkaline";
    const displayName = `Custom ${typeLabel} refill · ${formatLiters(parsedCustomLiters)}`;

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

    if (existingMatch) {
      clearFieldQtyEdit(existingMatch.id);
    }
    setLastSavedSale(null);
    setLastSettledPriorDay(null);
    setLastAlreadySavedPriorDay(null);
    setSaleError(null);
    closeCustomizeModal();
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
      notifyPosStateChanged("day-started");
      setStartRequestKey(null);
      setLastClosedSummary(null);
    } catch (err) {
      setDayActionError(
        wrapNotice(err instanceof ApiError ? err.message : "Could not start the station day."),
      );
      void loadPosState();
    } finally {
      setStartingDay(false);
    }
  }

  async function openEndDayModal() {
    setEndDayError(null);
    setEndDayClearDrafts(false);
    setCloseRequestKey(generateKey());
    setPendingRecoveries(loadPendingRecoveries());
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
    const latestGuard = evaluateEndDayGuard({
      businessDate: dayStatus.day.businessDate,
      serverUnresolved: dayStatus.unresolvedCheckouts,
      serverUnpaidDrafts: dayStatus.unpaidDrafts,
      localPendingRecoveries: loadPendingRecoveries(),
      activeConfirming: activeConfirmingRef.current,
    });
    if (latestGuard.blocked) {
      setEndDayError(
        wrapNotice("Resolve or finish in-progress checkout confirmation before closing the day."),
      );
      return;
    }

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
        clearAllQtyEdits();
        setStep("select");
      }
      setLastClosedSummary(wrapNotice(closed.summary));
      setEndDayOpen(false);
      notifyPosStateChanged("day-ended");
      setCloseRequestKey(null);
      await loadPosState();
    } catch (err) {
      setEndDayError(
        wrapNotice(err instanceof ApiError ? err.message : "Could not close the station day."),
      );
      await loadPosState();
    } finally {
      setEndingDay(false);
    }
  }

  async function handleProceedToCash() {
    if (preparingCheckout || lines.length === 0 || !dayStatus?.canSell) return;
    const { nextEdits, invalidIds } = revealInvalidQuantityEdits(qtyEdits);
    if (invalidIds.length > 0) {
      qtyInputRefs.current.get(invalidIds[0]!)?.focus();
      setQtyEdits(nextEdits);
      setSaleError(wrapNotice("Fix invalid refill quantities before reviewing checkout."));
      return;
    }

    setPreparingCheckout(true);
    setSaleError(null);
    setLastSavedSale(null);
    setLastSettledPriorDay(null);
    setLastAlreadySavedPriorDay(null);
    setLastSettledPriorDay(null);

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
      setDayStatus((prev) => {
        if (!prev) return prev;
        if (res.checkout.status === "PAYMENT_PENDING") {
          return {
            ...prev,
            unpaidDrafts: prev.unpaidDrafts.filter((d) => d.reference !== res.checkout.reference),
            unresolvedCheckouts: prev.unresolvedCheckouts.some(
              (c) => c.reference === res.checkout.reference,
            )
              ? prev.unresolvedCheckouts
              : [...prev.unresolvedCheckouts, res.checkout],
          };
        }
        return {
          ...prev,
          unpaidDrafts: prev.unpaidDrafts.some((d) => d.reference === res.checkout.reference)
            ? prev.unpaidDrafts
            : [...prev.unpaidDrafts, res.checkout],
        };
      });
      setPreparedCheckout(res.checkout);
      setCashInput("");
      setConfirmNoCashChecked(false);
      clearAllQtyEdits();
      setStep("review");
    } catch (err) {
      setSaleError(wrapNotice(err instanceof ApiError ? err.message : "Could not prepare checkout."));
      await loadPosState();
    } finally {
      setPreparingCheckout(false);
    }
  }

  async function handleBeginPayment() {
    if (!preparedCheckout || startingPayment) return;
    setStartingPayment(true);
    setSaleError(null);
    loadTrackerRef.current.next();
    try {
      const res = await api<BeginPaymentResponse>(
        `/api/pos/checkouts/${encodeURIComponent(preparedCheckout.reference)}/begin-payment`,
        {
          method: "POST",
          body: {},
        },
      );
      setDayStatus((prev) =>
        prev
          ? {
            ...prev,
            unpaidDrafts: prev.unpaidDrafts.filter((d) => d.reference !== res.checkout.reference),
            unresolvedCheckouts: prev.unresolvedCheckouts.some(
              (c) => c.reference === res.checkout.reference,
            )
              ? prev.unresolvedCheckouts.map((c) =>
                c.reference === res.checkout.reference ? res.checkout : c,
              )
              : [...prev.unresolvedCheckouts, res.checkout],
          }
          : prev,
      );
      setPreparedCheckout(res.checkout);
      notifyPosStateChanged("payment-started");
      setConfirmNoCashChecked(false);
    } catch (err) {
      setSaleError(
        wrapNotice(
          err instanceof ApiError ? err.message : "Could not start cash payment for this checkout.",
        ),
      );
      await loadPosState();
    } finally {
      setStartingPayment(false);
    }
  }

  function handleResumeServerPending(checkout: CheckoutView) {
    const hydrated = quoteItemsToDraftLines(checkout.items);
    setLines(hydrated);
    clearAllQtyEdits();
    setPreparedCheckout(checkout);
    setPrepareKey(null);
    setPrepareSignature(cartLinesSignature(hydrated));
    setCashInput("");
    setConfirmNoCashChecked(false);
    setSaleError(null);
    setLastSavedSale(null);
    setLastSettledPriorDay(null);
    setLastAlreadySavedPriorDay(null);
    setStep("review");
  }

  const parsedCashCentavos = parsePesoInputToCentavos(cashInput);
  const reviewTotalCentavos = preparedCheckout?.totalCentavos ?? cartTotals.totalCentavos;
  const cashSummary = computeCashSummary(reviewTotalCentavos, parsedCashCentavos);
  const draftHasMissingGripo =
    preparedCheckout?.status === "DRAFT" &&
    preparedCheckout.items.some(
      (item) => item.kind === "CONTAINER_PACKAGE" && !item.includedGripo,
    );

  async function handleBackToSelection() {
    if (!preparedCheckout) {
      setStep("select");
      return;
    }
    const hadMissingGripo =
      draftHasMissingGripo ||
      lines.some((line) => line.kind === "CONTAINER_PACKAGE" && !line.includedGripo);
    setCancellingDraft(true);
    setSaleError(null);
    try {
      await api(`/api/pos/checkouts/${encodeURIComponent(preparedCheckout.reference)}/cancel`, {
        method: "POST",
        body: { reason: "Returned to refill selection" },
      });
      if (hadMissingGripo) {
        setLines((prev) =>
          prev.filter((line) => line.kind !== "CONTAINER_PACKAGE" || line.includedGripo !== null),
        );
      }
      setPreparedCheckout(null);
      setPrepareKey(null);
      setPrepareSignature(null);
      setCashInput("");
      setConfirmNoCashChecked(false);
      setStep("select");
      await loadPosState();
      if (hadMissingGripo) {
        setSaleError(
          wrapNotice(
            "Select Push-Type or Twist-Type gripo for each container package before continuing to payment.",
          ),
        );
      }
    } catch (err) {
      setSaleError(
        wrapNotice(
          err instanceof ApiError
            ? err.message
            : "Could not cancel draft checkout. Check status or retry.",
        ),
      );
      await loadPosState();
    } finally {
      setCancellingDraft(false);
    }
  }

  async function handleCancelPaymentPending() {
    if (!preparedCheckout || !confirmNoCashChecked) return;
    setCancellingDraft(true);
    setSaleError(null);
    try {
      await api(`/api/pos/checkouts/${encodeURIComponent(preparedCheckout.reference)}/cancel`, {
        method: "POST",
        body: { confirmNoCashTaken: true, reason: "No cash received" },
      });
      removePendingRecovery(preparedCheckout.reference);
      notifyPosStateChanged("payment-cancelled");
      setPendingRecoveries(loadPendingRecoveries());
      clearUnpaidCart(user.username);
      setPreparedCheckout(null);
      setPrepareKey(null);
      setPrepareSignature(null);
      setCashInput("");
      setConfirmNoCashChecked(false);
      setStep("select");
      await loadPosState();
    } catch (err) {
      setSaleError(
        wrapNotice(
          err instanceof ApiError
            ? err.message
            : "Could not cancel unpaid checkout. Check status or retry.",
        ),
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

    // Persist per-reference recovery AND mark confirming active BEFORE sending confirm.
    savePendingRecovery(pendingRecord);
    activeConfirmingRef.current = pendingRecord;
    setActiveConfirming(pendingRecord);
    setPendingRecoveries(loadPendingRecoveries());
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
      removePendingRecovery(pendingRecord.reference);
      notifyPosStateChanged("sale-saved");
      activeConfirmingRef.current = null;
      setActiveConfirming(null);
      const remaining = loadPendingRecoveries();
      setPendingRecoveries(remaining);
      setSelectedRecoveryRef((prev) =>
        prev && remaining.some((r) => r.reference === prev)
          ? prev
          : (remaining[0]?.reference ?? null),
      );
      setLines([]);
      clearAllQtyEdits();
      setPreparedCheckout(null);
      setPrepareKey(null);
      setPrepareSignature(null);
      setCashInput("");
      setConfirmNoCashChecked(false);
      setLastSavedSale(wrapNotice(confirmed.sale));
      setStep("select");
      setHistoryRefreshSignal((n) => n + 1);
      await loadPosState();
    } catch (err) {
      activeConfirmingRef.current = null;
      setActiveConfirming(null);

      if (err instanceof ApiError && err.code === "INSUFFICIENT_CASH") {
        removePendingRecovery(pendingRecord.reference);
        setPendingRecoveries(loadPendingRecoveries());
        setSaleError(wrapNotice(err.message));
        return;
      }

      if (err instanceof ApiError && err.code === "CHECKOUT_REVIEW_REQUIRED") {
        const updated = persistReviewRequiredFromError(pendingRecord, err) ?? pendingRecord;
        setPendingRecoveries(loadPendingRecoveries());
        setSelectedRecoveryRef(updated.reference);
        setRecoveryError(wrapNotice(err.message));
        setPreparedCheckout(null);
        setLines([]);
        clearAllQtyEdits();
        setPrepareKey(null);
        setPrepareSignature(null);
        setCashInput("");
        setConfirmNoCashChecked(false);
        setStep("select");
        return;
      }

      // Network drop, timeout, 5xx, or 401 session expiry: keep this exact reference durable.
      const errorMsg =
        err instanceof ApiError
          ? err.message
          : "Could not confirm whether the sale was saved. Check transaction status before taking another step.";
      savePendingRecovery({ ...pendingRecord, lastError: errorMsg });
      setPendingRecoveries(loadPendingRecoveries());
      setSelectedRecoveryRef(pendingRecord.reference);
      setRecoveryError(wrapNotice(errorMsg));
      setPreparedCheckout(null);
      setLines([]);
      clearAllQtyEdits();
      setPrepareKey(null);
      setPrepareSignature(null);
      setCashInput("");
      setConfirmNoCashChecked(false);
      setStep("select");
    } finally {
      activeConfirmingRef.current = null;
      setActiveConfirming(null);
      setConfirmingSale(false);
    }
  }

  async function handleCheckRecoveryStatus() {
    const target = activeRecovery;
    if (!target) return;
    setCheckingStatus(true);
    setRecoveryError(null);
    try {
      const lookup = await api<CheckoutLookupView>(
        `/api/pos/checkouts/${encodeURIComponent(target.reference)}`,
      );
      const updated: PendingCheckoutRecovery = {
        ...target,
        lastLookup: lookup,
        lastError: null,
      };
      savePendingRecovery(updated);
      setPendingRecoveries(loadPendingRecoveries());
      setSelectedRecoveryRef(updated.reference);
    } catch (err) {
      setRecoveryError(
        wrapNotice(
          err instanceof ApiError
            ? err.message
            : "Status check could not reach the server. Keep this reference and check again.",
        ),
      );
    } finally {
      setCheckingStatus(false);
    }
  }

  async function handleRetryRecovery() {
    const target = activeRecovery;
    if (!target) return;
    activeConfirmingRef.current = target;
    setActiveConfirming(target);
    setRetryingRecovery(true);
    setRecoveryError(null);
    try {
      const confirmed = await api<ConfirmSaleResponse>(
        `/api/pos/checkouts/${encodeURIComponent(target.reference)}/confirm`,
        {
          method: "POST",
          body: {
            cashReceivedCentavos: target.cashReceivedCentavos,
            items: target.items,
            expectedTotalCentavos: target.totalCentavos,
          },
        },
      );
      removePendingRecovery(target.reference);
      notifyPosStateChanged("sale-saved");
      activeConfirmingRef.current = null;
      setActiveConfirming(null);
      clearMatchingPreparedCheckout(target.reference);
      const remaining = loadPendingRecoveries();
      setPendingRecoveries(remaining);
      setSelectedRecoveryRef(remaining[0]?.reference ?? null);
      setLastSavedSale(wrapNotice(confirmed.sale));
      setHistoryRefreshSignal((n) => n + 1);
      await loadPosState();
    } catch (err) {
      activeConfirmingRef.current = null;
      setActiveConfirming(null);
      if (err instanceof ApiError && err.code === "CHECKOUT_REVIEW_REQUIRED") {
        persistReviewRequiredFromError(target, err);
        setPendingRecoveries(loadPendingRecoveries());
        setSelectedRecoveryRef(target.reference);
        setRecoveryError(wrapNotice(err.message));
        return;
      }
      setRecoveryError(
        wrapNotice(
          err instanceof ApiError
            ? err.message
            : "Retry could not reach the server. Check transaction status before trying again.",
        ),
      );
    } finally {
      activeConfirmingRef.current = null;
      setActiveConfirming(null);
      setRetryingRecovery(false);
    }
  }

  function clearMatchingPreparedCheckout(targetReference: string) {
    const normalizedTarget = targetReference.trim().toUpperCase();
    clearUnpaidCartIfMatchesReference(user.username, normalizedTarget);
    if (preparedCheckoutRef.current?.reference.trim().toUpperCase() !== normalizedTarget) {
      return;
    }
    clearUnpaidCart(user.username);
    setLines([]);
    clearAllQtyEdits();
    setPreparedCheckout(null);
    setPrepareKey(null);
    setPrepareSignature(null);
    setCashInput("");
    setConfirmNoCashChecked(false);
    setStep("select");
  }

  function handleContinueSavedSale(reference: string, sale: SaleView) {
    removePendingRecovery(reference);
    notifyPosStateChanged("sale-saved");
    clearMatchingPreparedCheckout(reference);
    const remaining = loadPendingRecoveries();
    setPendingRecoveries(remaining);
    setSelectedRecoveryRef(remaining[0]?.reference ?? null);
    setRecoveryError(null);
    setLastSavedSale(wrapNotice(sale));
    setLastSettledPriorDay(null);
    setLastAlreadySavedPriorDay(null);
    setSettlementTarget(null);
    setHistoryRefreshSignal((n) => n + 1);
    void loadPosState();
  }

  function handlePriorDayAlreadySaved(reference: string, sale: SaleView) {
    removePendingRecovery(reference);
    notifyPosStateChanged("sale-saved");
    clearMatchingPreparedCheckout(reference);
    const remaining = loadPendingRecoveries();
    setPendingRecoveries(remaining);
    setSelectedRecoveryRef(remaining[0]?.reference ?? null);
    setSettlementTarget(null);
    setRecoveryError(null);
    setLastSavedSale(null);
    setLastSettledPriorDay(null);
    setLastAlreadySavedPriorDay(wrapNotice(sale));
    setHistoryRefreshSignal((n) => n + 1);
    void loadPosState();
  }

  function openPriorDaySettleForCheckout(
    checkout: CheckoutView,
    localCashReceivedCentavos?: number | null,
  ) {
    setEndDayOpen(false);
    setDayActionError(null);
    setRecoveryError(null);
    setLastAlreadySavedPriorDay(null);
    setSettlementTarget({
      checkout,
      localCashReceivedCentavos: localCashReceivedCentavos ?? null,
    });
  }

  function handleOpenPriorDaySettleFromRecovery(record: PendingCheckoutRecovery) {
    const checkout: CheckoutView = record.lastLookup?.checkout ?? {
      reference: record.reference,
      businessDate: record.businessDate,
      status: "REVIEW_REQUIRED",
      createdBy: record.initiatedBy,
      createdAt: record.attemptedAt,
      updatedAt: record.attemptedAt,
      totalCentavos: record.totalCentavos,
      totalContainers: record.totalContainers,
      totalVolumeMl: record.totalVolumeMl,
      totalVolumeLiters: record.totalVolumeLiters,
      cashReceivedCentavos: record.cashReceivedCentavos,
      changeCentavos: record.changeCentavos,
      paymentStartedAt: record.attemptedAt,
      paymentRecordedAt: record.attemptedAt,
      resolutionReason: "BUSINESS_DATE_CROSSED",
      items: record.quoteItems,
    };
    openPriorDaySettleForCheckout(checkout, record.cashReceivedCentavos);
  }

  async function handlePriorDaySettled(settlement: PriorDaySettlementView) {
    removePendingRecovery(settlement.checkoutReference);
    notifyPosStateChanged("prior-day-settled");
    clearMatchingPreparedCheckout(settlement.checkoutReference);
    const remaining = loadPendingRecoveries();
    setPendingRecoveries(remaining);
    setSelectedRecoveryRef(remaining[0]?.reference ?? null);
    setSettlementTarget(null);
    setRecoveryError(null);
    setLastSavedSale(null);
    setLastAlreadySavedPriorDay(null);
    setLastSettledPriorDay(wrapNotice(settlement));
    setHistoryRefreshSignal((n) => n + 1);
    await loadPosState();
  }

  function handleContinueSettledSale(reference: string, settlement: PriorDaySettlementView) {
    removePendingRecovery(reference);
    notifyPosStateChanged("prior-day-settled");
    clearMatchingPreparedCheckout(reference);
    const remaining = loadPendingRecoveries();
    setPendingRecoveries(remaining);
    setSelectedRecoveryRef(remaining[0]?.reference ?? null);
    setSettlementTarget(null);
    setRecoveryError(null);
    setLastSavedSale(null);
    setLastAlreadySavedPriorDay(null);
    setLastSettledPriorDay(wrapNotice(settlement));
    setHistoryRefreshSignal((n) => n + 1);
    void loadPosState();
  }

  function switchPosTab(nextTab: PosTab) {
    if (nextTab === tab) return;
    if (nextTab === "history") {
      setLastSavedSale(null);
      setLastClosedSummary(null);
      setLastSettledPriorDay(null);
      setLastAlreadySavedPriorDay(null);
      setSaleError(null);
      setDayActionError(null);
      setRecoveryError(null);
    }
    setTab(nextTab);
  }

  const activeStepperNumber = showRecoveryScreen ? 3 : step === "review" ? 2 : 1;
  const hasBlockingUnresolved = endDayGuard.blocked;
  const clearableDrafts = endDayGuard.clearableDrafts;
  const draftsNeedAck = clearableDrafts.length > 0 && !endDayClearDrafts;

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
            onClick={() => switchPosTab("sale")}
          >
            New Sale
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "history"}
            className={`tab ${tab === "history" ? "tab--active" : ""}`}
            onClick={() => switchPosTab("history")}
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
          {pendingRecoveries.length === 1 && (
            <span className="pill pill--overdue">Recovery active: {pendingRecoveries[0]!.reference}</span>
          )}
          {pendingRecoveries.length > 1 && (
            <span className="pill pill--overdue">{pendingRecoveries.length} recoveries active</span>
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
        <TemporaryNotice
          occurrenceId={dayActionError.id}
          duration="brief"
          className="alert alert--error"
          role="alert"
          closeLabel="Close day error"
          onDismiss={() => setDayActionError(null)}
        >
          {dayActionError.data}
        </TemporaryNotice>
      )}

      {tab === "history" ? (
        <SaleHistory
          todayDate={dayStatus?.todayDate ?? currentManilaIso().slice(0, 10)}
          initialReference={historyFocusRef}
          initialSettlementRef={historySettlementFocusRef}
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
              className={`pos-step ${activeStepperNumber === 1 ? "pos-step--active" : ""} ${activeStepperNumber > 1 ? "pos-step--done" : ""
                }`}
            >
              <span className="pos-step__num">1</span>
              <span>Select refills</span>
            </li>
            <li
              className={`pos-step ${activeStepperNumber === 2 ? "pos-step--active" : ""} ${activeStepperNumber > 2 ? "pos-step--done" : ""
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

          {showRecoveryScreen && activeRecovery ? (
            <>
              {lastSavedSale && (
                <TemporaryNotice
                  occurrenceId={lastSavedSale.id}
                  duration="detailed"
                  className="callout callout--success"
                  role="status"
                  closeLabel="Close sale confirmation"
                  onDismiss={() => setLastSavedSale(null)}
                >
                  <p className="callout__title">Sale {lastSavedSale.data.reference} saved successfully</p>
                  <p className="callout__body">
                    {formatCentavos(lastSavedSale.data.cashReceivedCentavos)} received for{" "}
                    {formatCentavos(lastSavedSale.data.totalCentavos)} total. Remaining pending transaction(s) on this
                    workstation still require status verification below.
                  </p>
                </TemporaryNotice>
              )}
              {lastAlreadySavedPriorDay && (
                <TemporaryNotice
                  occurrenceId={lastAlreadySavedPriorDay.id}
                  duration="detailed"
                  className="callout callout--success"
                  role="status"
                  closeLabel="Close prior-day confirmation"
                  onDismiss={() => setLastAlreadySavedPriorDay(null)}
                >
                  <p className="callout__title">
                    Original sale {lastAlreadySavedPriorDay.data.reference} was already saved
                  </p>
                  <p className="callout__body">
                    Already delivered — do not refill or hand over again, and collect no further payment.
                    Remaining pending transaction(s) on this workstation still require verification below.
                  </p>
                </TemporaryNotice>
              )}
              <CheckoutRecovery
                record={activeRecovery}
                allRecoveries={pendingRecoveries}
                currentUsername={user.username}
                currentUserRole={user.role}
                todayDate={dayStatus?.todayDate}
                checking={checkingStatus}
                retrying={retryingRecovery}
                errorNotice={recoveryError}
                onDismissError={() => setRecoveryError(null)}
                onSelectReference={(ref) => {
                  setSelectedRecoveryRef(ref);
                  setRecoveryError(null);
                }}
                onCheckStatus={() => void handleCheckRecoveryStatus()}
                onRetry={() => void handleRetryRecovery()}
                onContinueSaved={handleContinueSavedSale}
                onOpenPriorDaySettle={handleOpenPriorDaySettleFromRecovery}
                onContinueSettled={handleContinueSettledSale}
              />
            </>
          ) : (
            <>
              {lastClosedSummary && dayStatus?.state === "CLOSED" && (
                <TemporaryNotice
                  occurrenceId={lastClosedSummary.id}
                  duration="detailed"
                  className="callout callout--success"
                  role="status"
                  closeLabel="Close day summary"
                  onDismiss={() => setLastClosedSummary(null)}
                >
                  <p className="callout__title">Business day {lastClosedSummary.data.businessDate} closed</p>
                  <p className="callout__body">
                    Recorded {lastClosedSummary.data.validTransactionCount} valid transaction
                    {lastClosedSummary.data.validTransactionCount === 1 ? "" : "s"} totaling{" "}
                    {formatCentavos(lastClosedSummary.data.totalSalesCentavos)} (
                    {formatLiters(lastClosedSummary.data.totalVolumeLiters)}).
                  </p>
                </TemporaryNotice>
              )}

              {lastAlreadySavedPriorDay && (
                <TemporaryNotice
                  occurrenceId={lastAlreadySavedPriorDay.id}
                  duration="detailed"
                  className="callout callout--success"
                  role="status"
                  closeLabel="Close prior-day confirmation"
                  onDismiss={() => setLastAlreadySavedPriorDay(null)}
                >
                  <p className="callout__title">
                    Original sale {lastAlreadySavedPriorDay.data.reference} was already saved
                  </p>
                  <p className="callout__body">
                    Already delivered — do not refill or hand over again, and collect no further payment. No
                    duplicate settlement was created; original receipt from{" "}
                    {lastAlreadySavedPriorDay.data.businessDate} for{" "}
                    {formatCentavos(lastAlreadySavedPriorDay.data.totalCentavos)} (
                    {formatCentavos(lastAlreadySavedPriorDay.data.cashReceivedCentavos)} received,{" "}
                    {formatCentavos(lastAlreadySavedPriorDay.data.changeCentavos)} change,{" "}
                    {lastAlreadySavedPriorDay.data.totalContainers} container
                    {lastAlreadySavedPriorDay.data.totalContainers === 1 ? "" : "s"} ·{" "}
                    {formatLiters(lastAlreadySavedPriorDay.data.totalVolumeLiters)}).
                  </p>
                  <div className="callout__actions">
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => {
                        setHistorySettlementFocusRef(null);
                        setHistoryFocusRef(lastAlreadySavedPriorDay.data.reference);
                        switchPosTab("history");
                      }}
                    >
                      View original receipt in History
                    </button>
                  </div>
                </TemporaryNotice>
              )}

              {lastSettledPriorDay && (
                <TemporaryNotice
                  occurrenceId={lastSettledPriorDay.id}
                  duration="detailed"
                  className="callout callout--success"
                  role="status"
                  closeLabel="Close settlement confirmation"
                  onDismiss={() => setLastSettledPriorDay(null)}
                >
                  <p className="callout__title">
                    {isPriorDayMerchandiseOnly(lastSettledPriorDay.data.items)
                      ? `Prior-day merchandise ${lastSettledPriorDay.data.checkoutReference} settled`
                      : `Prior-day refill ${lastSettledPriorDay.data.checkoutReference} settled`}
                  </p>
                  <p className="callout__body">
                    Net amount kept {formatCentavos(lastSettledPriorDay.data.netAmountKeptCentavos)} · Original payment
                    date {lastSettledPriorDay.data.originalBusinessDate} · Settlement date (Manila){" "}
                    {lastSettledPriorDay.data.settlementDate}. No further payment collected; recorded separately from{" "}
                    {isPriorDayMerchandiseOnly(lastSettledPriorDay.data.items)
                      ? "today's sales."
                      : "today's refill sales."}
                  </p>
                  <div className="callout__actions">
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => {
                        setHistoryFocusRef(null);
                        setHistorySettlementFocusRef(lastSettledPriorDay.data.checkoutReference);
                        switchPosTab("history");
                      }}
                    >
                      View in History
                    </button>
                  </div>
                </TemporaryNotice>
              )}

              {dayStatus && dayStatus.state !== "OPEN" && (
                <div
                  className={`callout ${dayStatus.state === "PREVIOUS_DAY_OPEN" ? "callout--warning" : "callout--info"
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
                        onClick={() => switchPosTab("history")}
                      >
                        Open Transaction History
                      </button>
                    )}
                  </div>
                </div>
              )}

              {step === "select" && serverOnlyUnresolved.length > 0 && (
                <div className="callout callout--warning" role="status">
                  <p className="callout__title">Cash-protected checkout(s) awaiting completion or review</p>
                  <div className="callout__body">
                    {serverOnlyUnresolved.map((c) => {
                      const canResumeHere =
                        c.status === "PAYMENT_PENDING" &&
                        c.createdBy.toLowerCase() === user.username.toLowerCase() &&
                        dayStatus?.state === "OPEN" &&
                        c.businessDate === dayStatus.todayDate;
                      const isPriorDay = Boolean(
                        dayStatus?.todayDate && c.businessDate < dayStatus.todayDate,
                      );
                      const canSettleHere =
                        user.role === "OWNER" &&
                        isPriorDay &&
                        isPriorDaySettleableComposition(c.items) &&
                        (c.status === "REVIEW_REQUIRED" || c.status === "PAYMENT_PENDING");
                      return (
                        <div key={c.reference} className="pos-unresolved-row">
                          <span>
                            <strong className="mono-ref">{c.reference}</strong> ·{" "}
                            {formatCentavos(c.totalCentavos)} ({c.createdBy}, original date{" "}
                            {c.businessDate}) —{" "}
                            {c.status === "PAYMENT_PENDING"
                              ? canResumeHere
                                ? "Cash payment started"
                                : isPriorDay
                                  ? "Prior-day payment pending Owner review"
                                  : "Started by another operator"
                              : c.resolutionReason ?? "Owner review required"}
                          </span>
                          {(canResumeHere || canSettleHere) && (
                            <span className="callout__actions">
                              {canResumeHere && (
                                <button
                                  type="button"
                                  className="button button--ghost button--sm"
                                  onClick={() => handleResumeServerPending(c)}
                                >
                                  Resume cash payment
                                </button>
                              )}
                              {canSettleHere && (
                                <button
                                  type="button"
                                  className="button button--primary button--sm"
                                  onClick={() => openPriorDaySettleForCheckout(c)}
                                >
                                  Review prior-day checkout
                                </button>
                              )}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {step === "select" && serverOnlyClosedPriorDayReview.length > 0 && (
                <div className="callout callout--warning" role="status">
                  <p className="callout__title">Closed prior-day checkout(s) awaiting Owner review</p>
                  <div className="callout__body">
                    {serverOnlyClosedPriorDayReview.map((c) => (
                      <div key={c.reference} className="pos-unresolved-row">
                        <span>
                          <strong className="mono-ref">{c.reference}</strong> ·{" "}
                          {formatCentavos(c.totalCentavos)} ({c.createdBy}, original date {c.businessDate}) —{" "}
                          {c.resolutionReason ?? "Prior-day payment pending Owner review"}
                        </span>
                        {user.role === "OWNER" && isPriorDaySettleableComposition(c.items) && (
                          <span className="callout__actions">
                            <button
                              type="button"
                              className="button button--primary button--sm"
                              onClick={() => openPriorDaySettleForCheckout(c)}
                            >
                              Review prior-day checkout
                            </button>
                          </span>
                        )}
                      </div>
                    ))}
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
                        <TemporaryNotice
                          occurrenceId={saleError.id}
                          duration="brief"
                          className="alert alert--error"
                          role="alert"
                          closeLabel="Close sale error"
                          onDismiss={() => setSaleError(null)}
                        >
                          {saleError.data}
                        </TemporaryNotice>
                      )}

                      <div className="refill-grid">
                        {catalog.map((item) => {
                          const fieldId = defaultLineId(item.waterType);
                          const qty = standardQtyByType.get(item.waterType) ?? 0;
                          const isSelected = qty > 0;
                          const labelBase = item.waterType === "PURIFIED" ? "Purified Refill" : "Alkaline Refill";
                          const desc =
                            item.waterType === "PURIFIED" ? "Purified drinking water" : "Alkaline drinking water";
                          const edit = qtyEdits[fieldId];
                          const visibleError = getVisibleQuantityError(edit);
                          const errorId = `qty-error-${fieldId}`;
                          return (
                            <div
                              key={item.code}
                              className={`refill-card ${isSelected ? "refill-card--selected" : ""}`}
                            >
                              <div className="refill-card__info">
                                <h3>{labelBase}</h3>
                                <p className="muted-sm">{desc}</p>
                              </div>
                              <div className="refill-card__footer">
                                <div className="refill-card__bottom">
                                  <span className="refill-card__price">
                                    <strong>{formatCentavos(item.unitPriceCentavos)}</strong>
                                    <span className="muted-sm">/{formatLiters(item.unitVolumeLiters).replace(" ", "")}</span>
                                  </span>
                                  <QuantityStepper
                                    value={qty}
                                    edit={edit}
                                    onEditChange={(nextEdit) => setFieldQtyEdit(fieldId, nextEdit)}
                                    onCommitValidValue={(nextQty) => setStandardQuantity(item, nextQty)}
                                    onStep={(delta) => {
                                      clearFieldQtyEdit(fieldId);
                                      setStandardQuantity(item, qty + delta);
                                    }}
                                    groupLabel={`${labelBase} quantity controls`}
                                    inputLabel={`${labelBase} quantity`}
                                    decreaseLabel={`Decrease ${labelBase}`}
                                    increaseLabel={`Increase ${labelBase}`}
                                    disabled={!dayStatus?.canSell || preparingCheckout}
                                    decreaseDisabled={!dayStatus?.canSell || preparingCheckout || qty === 0}
                                    increaseDisabled={!dayStatus?.canSell || preparingCheckout || qty >= MAX_LINE_QTY}
                                    allowRestingZero
                                    errorId={errorId}
                                    inputRef={(el) => {
                                      if (el) qtyInputRefs.current.set(fieldId, el);
                                      else qtyInputRefs.current.delete(fieldId);
                                    }}
                                  />
                                </div>
                                {visibleError && (
                                  <p id={errorId} className="qty-stepper__error" role="alert">
                                    {visibleError}
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div className="pos-customize-row">
                        <button
                          type="button"
                          className="button button--primary"
                          disabled={!dayStatus?.canSell || preparingCheckout}
                          onMouseDown={(event) => {
                            if (hasInvalidLineEdits) event.preventDefault();
                          }}
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
                          {customLines.map((line) => {
                            const baseQtyLabel =
                              (customLabelCounts.get(line.displayName) ?? 0) > 1
                                ? `${line.displayName} (${formatCentavos(line.unitPriceCentavos)})`
                                : line.displayName;
                            const edit = qtyEdits[line.id];
                            const visibleError = getVisibleQuantityError(edit);
                            const errorId = `qty-error-${line.id}`;
                            return (
                              <div key={line.id} className="custom-line-row">
                                <div className="custom-line-row__info">
                                  <strong>{line.displayName}</strong>
                                  <span className="muted-sm">
                                    {formatCentavos(line.unitPriceCentavos)} per container · Line total{" "}
                                    {formatCentavos(line.unitPriceCentavos * line.quantity)}
                                  </span>
                                </div>
                                <div className="custom-line-row__controls">
                                  <QuantityStepper
                                    value={line.quantity}
                                    edit={edit}
                                    onEditChange={(nextEdit) => setFieldQtyEdit(line.id, nextEdit)}
                                    onCommitValidValue={(nextQty) => setCustomLineQuantity(line.id, nextQty)}
                                    onStep={(delta) => adjustCustomLineQuantity(line.id, delta)}
                                    groupLabel={`${baseQtyLabel} quantity controls`}
                                    inputLabel={`${baseQtyLabel} quantity`}
                                    decreaseLabel={`Decrease ${baseQtyLabel}`}
                                    increaseLabel={`Increase ${baseQtyLabel}`}
                                    disabled={!dayStatus?.canSell || preparingCheckout}
                                    decreaseDisabled={!dayStatus?.canSell || preparingCheckout}
                                    increaseDisabled={
                                      !dayStatus?.canSell || preparingCheckout || line.quantity >= MAX_LINE_QTY
                                    }
                                    errorId={errorId}
                                    inputRef={(el) => {
                                      if (el) qtyInputRefs.current.set(line.id, el);
                                      else qtyInputRefs.current.delete(line.id);
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className="button button--ghost button--sm"
                                    disabled={!dayStatus?.canSell || preparingCheckout}
                                    onMouseDown={(event) => {
                                      if (hasInvalidLineEdits) event.preventDefault();
                                    }}
                                    onClick={() => removeLine(line.id)}
                                  >
                                    Remove
                                  </button>
                                </div>
                                {visibleError && (
                                  <p
                                    id={errorId}
                                    className="qty-stepper__error qty-stepper__error--row"
                                    role="alert"
                                  >
                                    {visibleError}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </article>

                    {containerPackages.length > 0 && (
                      <article className="card pos-selection-card" aria-label="Containers">
                        <div className="detail-card__header">
                          <div>
                            <h2>Containers</h2>
                            <p className="muted-sm">
                              Choose new Round or Slim packages. Empty and filled options share each shape&apos;s balance.
                            </p>
                          </div>
                        </div>

                        <div className="refill-grid">
                          {containerPackages.map((pkg) => {
                            const pushQty =
                              containerPkgQtyByKey.get(containerPkgKey(pkg.packageCode, "PUSH_TYPE")) ?? 0;
                            const twistQty =
                              containerPkgQtyByKey.get(containerPkgKey(pkg.packageCode, "TWIST_TYPE")) ?? 0;
                            const isSelected = pushQty + twistQty > 0;
                            const totalShapeSelected = selectedContainerQtyByProductId.get(pkg.productId) ?? 0;
                            const shapeRemaining =
                              pkg.availableQuantity === null
                                ? 0
                                : Math.max(0, pkg.availableQuantity - totalShapeSelected);
                            const isInStock = pkg.stockStatus === "IN_STOCK" && (pkg.availableQuantity ?? 0) > 0;
                            const stockLabel =
                              pkg.stockStatus === "NOT_SET"
                                ? "Opening stock not set"
                                : (pkg.availableQuantity ?? 0) === 0
                                  ? "Out of stock"
                                  : totalShapeSelected > 0
                                    ? `${shapeRemaining} of ${pkg.availableQuantity} ${pkg.unit} left`
                                    : `${pkg.availableQuantity} ${pkg.unit} available`;

                            return (
                              <div
                                key={pkg.packageCode}
                                className={`refill-card ${isSelected ? "refill-card--selected" : ""}`}
                              >
                                <div className="refill-card__info">
                                  <h3>{pkg.name}</h3>
                                  <p className="muted-sm">{pkg.description}</p>
                                  <p
                                    className={`pos-stock-note ${
                                      pkg.stockStatus === "NOT_SET"
                                        ? "pos-stock-note--warn"
                                        : (pkg.availableQuantity ?? 0) === 0 || shapeRemaining === 0
                                          ? "pos-stock-note--out"
                                          : ""
                                    }`}
                                  >
                                    {stockLabel}
                                  </p>
                                </div>

                                <div className="refill-card__footer">
                                  <div className="refill-card__price-row">
                                    <span className="refill-card__price">
                                      <strong>{formatCentavos(pkg.unitPriceCentavos)}</strong>
                                    </span>
                                    <span className="muted-sm">Same price for either gripo</span>
                                  </div>

                                  <div className="pos-gripo-rows">
                                    {INCLUDED_GRIPO_OPTIONS.map((gripo) => {
                                      const fieldId = containerPkgLineId(pkg.packageCode, gripo.value);
                                      const qty =
                                        containerPkgQtyByKey.get(
                                          containerPkgKey(pkg.packageCode, gripo.value),
                                        ) ?? 0;
                                      const edit = qtyEdits[fieldId];
                                      const visibleError = getVisibleQuantityError(edit);
                                      const errorId = `qty-error-${fieldId}`;
                                      const otherQty = Math.max(0, totalShapeSelected - qty);
                                      const remainingAvailable =
                                        pkg.availableQuantity === null
                                          ? 0
                                          : Math.max(0, pkg.availableQuantity - otherQty);
                                      const maxStep = isInStock
                                        ? Math.min(MAX_LINE_QTY, qty + remainingAvailable)
                                        : MAX_LINE_QTY;
                                      const labelWithGripo = `${pkg.name} (${gripo.label})`;

                                      return (
                                        <div key={gripo.value} className="pos-gripo-row-wrap">
                                          <div className="pos-gripo-row">
                                            <span className="pos-gripo-row__label">{gripo.label}</span>
                                            <QuantityStepper
                                              value={qty}
                                              edit={edit}
                                              onEditChange={(nextEdit) => setFieldQtyEdit(fieldId, nextEdit)}
                                              onCommitValidValue={(nextQty) =>
                                                setContainerPackageQuantity(pkg, gripo.value, nextQty)
                                              }
                                              onStep={(delta) => {
                                                clearFieldQtyEdit(fieldId);
                                                setContainerPackageQuantity(pkg, gripo.value, qty + delta);
                                              }}
                                              groupLabel={`${labelWithGripo} quantity controls`}
                                              inputLabel={`${labelWithGripo} quantity`}
                                              decreaseLabel={`Decrease ${labelWithGripo}`}
                                              increaseLabel={`Increase ${labelWithGripo}`}
                                              disabled={
                                                !dayStatus?.canSell ||
                                                preparingCheckout ||
                                                (!isInStock && qty === 0)
                                              }
                                              decreaseDisabled={
                                                !dayStatus?.canSell || preparingCheckout || qty === 0
                                              }
                                              increaseDisabled={
                                                !dayStatus?.canSell ||
                                                preparingCheckout ||
                                                !isInStock ||
                                                remainingAvailable <= 0 ||
                                                qty >= maxStep
                                              }
                                              allowRestingZero
                                              max={maxStep}
                                              errorId={errorId}
                                              inputRef={(el) => {
                                                if (el) qtyInputRefs.current.set(fieldId, el);
                                                else qtyInputRefs.current.delete(fieldId);
                                              }}
                                            />
                                          </div>
                                          {visibleError && (
                                            <p id={errorId} className="qty-stepper__error" role="alert">
                                              {visibleError}
                                            </p>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </article>
                    )}

                    {merchandiseSections.map((group) => (
                      <article
                        key={group.section}
                        className="card pos-selection-card"
                        aria-label={group.title}
                      >
                        <div className="detail-card__header">
                          <div>
                            <h2>{group.title}</h2>
                            <p className="muted-sm">{group.subtitle}</p>
                          </div>
                        </div>

                        <div className="refill-grid">
                          {group.items.map((item) => {
                            const fieldId = merchLineId(item.id);
                            const qty = merchandiseQtyById.get(item.id) ?? 0;
                            const isSelected = qty > 0;
                            const edit = qtyEdits[fieldId];
                            const visibleError = getVisibleQuantityError(edit);
                            const errorId = `qty-error-${fieldId}`;
                            const available = item.availableQuantity ?? 0;
                            const isInStock = item.stockStatus === "IN_STOCK" && available > 0;
                            const maxStep = isInStock ? Math.min(MAX_LINE_QTY, available) : MAX_LINE_QTY;
                            const stockLabel =
                              item.stockStatus === "NOT_SET"
                                ? "Opening stock not set"
                                : item.stockStatus === "OUT_OF_STOCK" || available === 0
                                  ? "Out of stock"
                                  : `${available} ${item.unit} available`;

                            return (
                              <div
                                key={item.id}
                                className={`refill-card ${isSelected ? "refill-card--selected" : ""}`}
                              >
                                <div className="refill-card__info">
                                  <h3>{item.name}</h3>
                                  {item.description && <p className="muted-sm">{item.description}</p>}
                                  <p
                                    className={`pos-stock-note ${
                                      item.stockStatus === "NOT_SET"
                                        ? "pos-stock-note--warn"
                                        : item.stockStatus === "OUT_OF_STOCK" || available === 0
                                          ? "pos-stock-note--out"
                                          : ""
                                    }`}
                                  >
                                    {stockLabel}
                                  </p>
                                </div>

                                <div className="refill-card__footer">
                                  <div className="refill-card__bottom">
                                    <span className="refill-card__price">
                                      <strong>{formatCentavos(item.unitPriceCentavos)}</strong>
                                    </span>
                                    <QuantityStepper
                                      value={qty}
                                      edit={edit}
                                      onEditChange={(nextEdit) => setFieldQtyEdit(fieldId, nextEdit)}
                                      onCommitValidValue={(nextQty) => setMerchandiseQuantity(item, nextQty)}
                                      onStep={(delta) => {
                                        clearFieldQtyEdit(fieldId);
                                        setMerchandiseQuantity(item, qty + delta);
                                      }}
                                      groupLabel={`${item.name} quantity controls`}
                                      inputLabel={`${item.name} quantity`}
                                      decreaseLabel={`Decrease ${item.name}`}
                                      increaseLabel={`Increase ${item.name}`}
                                      disabled={!dayStatus?.canSell || preparingCheckout || (!isInStock && qty === 0)}
                                      decreaseDisabled={!dayStatus?.canSell || preparingCheckout || qty === 0}
                                      increaseDisabled={
                                        !dayStatus?.canSell || preparingCheckout || !isInStock || qty >= maxStep
                                      }
                                      allowRestingZero
                                      max={maxStep}
                                      errorId={errorId}
                                      inputRef={(el) => {
                                        if (el) qtyInputRefs.current.set(fieldId, el);
                                        else qtyInputRefs.current.delete(fieldId);
                                      }}
                                    />
                                  </div>
                                  {visibleError && (
                                    <p id={errorId} className="qty-stepper__error" role="alert">
                                      {visibleError}
                                    </p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </article>
                    ))}
                  </div>

                  <aside className="side-stack">
                    {lastSavedSale && (
                      <TemporaryNotice
                        occurrenceId={lastSavedSale.id}
                        duration="detailed"
                        className="callout callout--success"
                        role="status"
                        closeLabel="Close sale confirmation"
                        onDismiss={() => setLastSavedSale(null)}
                      >
                        <p className="callout__title">Sale {lastSavedSale.data.reference} saved successfully</p>
                        <p className="callout__body">
                          {formatCentavos(lastSavedSale.data.cashReceivedCentavos)} received for{" "}
                          {formatCentavos(lastSavedSale.data.totalCentavos)} total. Return{" "}
                          <strong>{formatCentavos(lastSavedSale.data.changeCentavos)}</strong> change,{" "}
                          {formatSavedSaleHandover(lastSavedSale.data)}
                        </p>
                        <div className="callout__actions">
                          <button
                            type="button"
                            className="button button--ghost button--sm"
                            onMouseDown={(event) => {
                              if (hasInvalidLineEdits) event.preventDefault();
                            }}
                            onClick={() => {
                              setHistorySettlementFocusRef(null);
                              setHistoryFocusRef(lastSavedSale.data.reference);
                              switchPosTab("history");
                            }}
                          >
                            View in History
                          </button>
                        </div>
                      </TemporaryNotice>
                    )}

                    <article className="card detail-card" aria-label="Current sale summary">
                      <div className="detail-card__header">
                        <h2>Current sale</h2>
                        <span className="pill pill--scheduled">
                          {formatCartCountPill(cartTotals.totalContainers, cartTotals.totalMerchandiseQty)}
                        </span>
                      </div>

                      {lines.length === 0 ? (
                        <p className="muted">No items selected. Choose a refill or product to start the sale.</p>
                      ) : (
                        <ul className="pos-summary-lines">
                          {lines.map((line) => (
                            <li key={line.id} className="pos-summary-line">
                              <div className="pos-summary-line__meta">
                                <strong>{line.displayName}</strong>
                                <span className="muted-sm">
                                  {line.quantity} × {formatCentavos(line.unitPriceCentavos)}
                                  {line.kind === "STANDARD" ||
                                  line.kind === "CUSTOM" ||
                                  (line.kind === "CONTAINER_PACKAGE" && line.unitVolumeLiters > 0)
                                    ? ` · ${formatLiters(line.unitVolumeLiters * line.quantity)}`
                                    : ""}
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
                          onMouseDown={(event) => {
                            if (hasInvalidLineEdits) event.preventDefault();
                          }}
                          onClick={() => void handleProceedToCash()}
                        >
                          {preparingCheckout ? "Preparing checkout…" : "Review checkout"}
                        </button>
                        {lines.length > 0 && (
                          <button
                            type="button"
                            className="button button--ghost button--block"
                            disabled={preparingCheckout}
                            onMouseDown={(event) => {
                              if (hasInvalidLineEdits) event.preventDefault();
                            }}
                            onClick={() => {
                              setLines([]);
                              clearAllQtyEdits();
                              setSaleError(null);
                              setTimeout(() => {
                                if (
                                  document.activeElement instanceof HTMLInputElement &&
                                  document.activeElement.classList.contains("qty-stepper__value")
                                ) {
                                  document.activeElement.blur();
                                }
                              }, 0);
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
                    {preparedCheckout?.status !== "PAYMENT_PENDING" ? (
                      <article className="card pos-cash-card">
                        <div className="detail-card__header">
                          <h2>Review checkout</h2>
                          <div className="summary-pills">
                            <span className="pill pill--neutral">Unpaid draft</span>
                            <span className="pill pill--neutral mono-ref">{preparedCheckout?.reference}</span>
                          </div>
                        </div>

                        {draftHasMissingGripo ? (
                          <div className="callout callout--warning">
                            <p className="callout__title">Faucet choice required before payment</p>
                            <p className="callout__body">
                              This unpaid draft was created before Push-Type / Twist-Type gripo selection was
                              required. Return to selection to choose the faucet type for each container package.
                            </p>
                          </div>
                        ) : (
                          <div className="callout callout--info">
                            <p className="callout__title">Verify the order before taking cash</p>
                            <p className="callout__body">
                              Check the refills and total with the customer first. Click Start cash payment before
                              accepting cash.
                            </p>
                          </div>
                        )}

                        {saleError && (
                          <TemporaryNotice
                            occurrenceId={saleError.id}
                            duration="brief"
                            className="alert alert--error"
                            role="alert"
                            closeLabel="Close checkout error"
                            onDismiss={() => setSaleError(null)}
                          >
                            {saleError.data}
                          </TemporaryNotice>
                        )}

                        <div className="pos-summary-actions">
                          <button
                            type="button"
                            className={`button ${draftHasMissingGripo ? "button--ghost" : "button--primary"} button--block`}
                            disabled={startingPayment || cancellingDraft || draftHasMissingGripo}
                            onClick={() => void handleBeginPayment()}
                          >
                            {startingPayment
                              ? "Starting cash payment…"
                              : `Start cash payment · ${formatCentavos(reviewTotalCentavos)}`}
                          </button>
                          <button
                            type="button"
                            className={`button ${draftHasMissingGripo ? "button--primary" : "button--ghost"} button--block`}
                            disabled={startingPayment || cancellingDraft}
                            onClick={() => void handleBackToSelection()}
                          >
                            {draftHasMissingGripo
                              ? cancellingDraft
                                ? "Returning to selection…"
                                : "Return to select faucet type"
                              : cancellingDraft
                                ? "Returning to refills…"
                                : "Back to refill selection"}
                          </button>
                        </div>
                      </article>
                    ) : (
                      <article className="card pos-cash-card">
                        <div className="detail-card__header">
                          <h2>Review &amp; receive cash</h2>
                          <div className="summary-pills">
                            <span className="pill pill--scheduled">Cash payment started</span>
                            <span className="pill pill--neutral mono-ref">{preparedCheckout.reference}</span>
                          </div>
                        </div>

                        {pendingRecoveries.some((r) => r.reference !== preparedCheckout.reference) &&
                          !activeConfirming && (
                            <div className="callout callout--warning" role="status">
                              <p className="callout__title">Another recovery is pending on this device</p>
                              <p className="callout__body">
                                Finish or cancel this cash payment ({preparedCheckout.reference}), then return to resolve
                                any earlier pending reference.
                              </p>
                            </div>
                          )}

                        <div className="callout callout--info">
                          <p className="callout__title">Count the cash before confirming</p>
                          <p className="callout__body">
                            Confirm only after receiving payment from the customer. Refill containers after the sale is
                            saved.
                          </p>
                        </div>

                        {saleError && (
                          <TemporaryNotice
                            occurrenceId={saleError.id}
                            duration="brief"
                            className="alert alert--error"
                            role="alert"
                            closeLabel="Close checkout error"
                            onDismiss={() => setSaleError(null)}
                          >
                            {saleError.data}
                          </TemporaryNotice>
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
                              disabled={confirmingSale || cancellingDraft}
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
                            disabled={confirmingSale || cancellingDraft}
                            onClick={() => setCashInput((reviewTotalCentavos / 100).toFixed(2))}
                          >
                            Exact amount
                          </button>
                          {[50, 100, 200, 500, 1000].map((peso) => (
                            <button
                              key={peso}
                              type="button"
                              className="button button--ghost button--sm"
                              disabled={confirmingSale || cancellingDraft}
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

                          <div className="cancel-unpaid-box">
                            <label className="checkbox-field">
                              <input
                                type="checkbox"
                                checked={confirmNoCashChecked}
                                disabled={confirmingSale || cancellingDraft}
                                onChange={(event) => setConfirmNoCashChecked(event.target.checked)}
                              />
                              <span>Confirm no cash was received from the customer</span>
                            </label>
                            <button
                              type="button"
                              className="button button--ghost button--block"
                              disabled={!confirmNoCashChecked || confirmingSale || cancellingDraft}
                              onClick={() => void handleCancelPaymentPending()}
                            >
                              {cancellingDraft ? "Cancelling unpaid checkout…" : "Cancel unpaid checkout"}
                            </button>
                          </div>
                        </div>
                      </article>
                    )}
                  </div>

                  <aside className="side-stack">
                    <article className="card detail-card" aria-label="Prepared checkout summary">
                      <div className="detail-card__header">
                        <h2>Current sale</h2>
                        <span className="pill pill--scheduled">
                          {formatCartCountPill(
                            preparedCheckout?.totalContainers ?? cartTotals.totalContainers,
                            (preparedCheckout?.items ?? [])
                              .filter(
                                (item) =>
                                  item.kind === "MERCHANDISE" || item.kind === "CONTAINER_PACKAGE",
                              )
                              .reduce((sum, item) => sum + item.quantity, 0) ||
                              (preparedCheckout ? 0 : cartTotals.totalMerchandiseQty),
                          )}
                        </span>
                      </div>

                      <ul className="pos-summary-lines">
                        {(preparedCheckout?.items ?? []).map((item) => (
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
                        {preparedCheckout?.status === "PAYMENT_PENDING" && (
                          <>
                            <div className="detail-list__row">
                              <dt>Cash received</dt>
                              <dd>{parsedCashCentavos !== null ? formatCentavos(parsedCashCentavos) : "—"}</dd>
                            </div>
                            <div className="detail-list__row">
                              <dt>Change</dt>
                              <dd>
                                {cashSummary.changeCentavos !== null
                                  ? formatCentavos(cashSummary.changeCentavos)
                                  : "—"}
                              </dd>
                            </div>
                          </>
                        )}
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
          onClick={closeCustomizeModal}
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

              <div className="customize-qty-group">
                <div className="customize-qty-row">
                  <span className="customize-qty-row__label">Quantity (containers)</span>
                  <QuantityStepper
                    value={customQty}
                    edit={customQtyEdit}
                    onEditChange={(nextEdit) => {
                      setCustomQtyEdit(nextEdit);
                      if (!nextEdit?.showError) {
                        setCustomError(null);
                      }
                    }}
                    onCommitValidValue={(nextQty) => {
                      setCustomQty(nextQty);
                      setCustomError(null);
                    }}
                    onStep={(delta) => {
                      setCustomQtyEdit(null);
                      setCustomError(null);
                      setCustomQty((q) => Math.max(1, Math.min(MAX_LINE_QTY, q + delta)));
                    }}
                    groupLabel="Custom refill quantity controls"
                    inputLabel="Custom refill quantity"
                    decreaseLabel="Decrease custom quantity"
                    increaseLabel="Increase custom quantity"
                    disabled={!dayStatus?.canSell || preparingCheckout}
                    decreaseDisabled={customQty <= 1}
                    increaseDisabled={customQty >= MAX_LINE_QTY}
                    errorId="qty-error-customize"
                    inputRef={(el) => {
                      customQtyInputRef.current = el;
                    }}
                  />
                </div>
                {visibleCustomQtyError && (
                  <p id="qty-error-customize" className="qty-stepper__error" role="alert">
                    {visibleCustomQtyError}
                  </p>
                )}
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
                <button
                  type="button"
                  className="button button--ghost"
                  onMouseDown={(event) => {
                    if (isQuantityEditInvalid(customQtyEdit)) event.preventDefault();
                  }}
                  onClick={closeCustomizeModal}
                >
                  Discard
                </button>
                <button
                  type="submit"
                  className="button button--primary"
                  onMouseDown={(event) => {
                    if (isQuantityEditInvalid(customQtyEdit)) event.preventDefault();
                  }}
                >
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
                  {endDayGuard.blockingEntries.map((entry) => {
                    const serverMatch = dayStatus.unresolvedCheckouts.find(
                      (c) => c.reference === entry.reference,
                    );
                    const localMatch = pendingRecoveries.find(
                      (r) => r.reference === entry.reference,
                    );
                    const canSettleBlocking =
                      user.role === "OWNER" &&
                      entry.source !== "local-confirming" &&
                      Boolean(
                        serverMatch &&
                        serverMatch.businessDate < dayStatus.todayDate &&
                        isPriorDaySettleableComposition(serverMatch.items) &&
                        (serverMatch.status === "REVIEW_REQUIRED" ||
                          serverMatch.status === "PAYMENT_PENDING"),
                      );
                    return (
                      <li key={entry.reference} className="conflict-list__item">
                        <span>
                          <span className="mono-ref">{entry.reference}</span> — {entry.label}
                          {serverMatch
                            ? ` (${serverMatch.businessDate} · ${formatCentavos(serverMatch.totalCentavos)})`
                            : ""}
                        </span>
                        {canSettleBlocking && serverMatch && (
                          <button
                            type="button"
                            className="button button--primary button--sm"
                            onClick={() =>
                              openPriorDaySettleForCheckout(
                                serverMatch,
                                localMatch?.cashReceivedCentavos,
                              )
                            }
                          >
                            Review &amp; settle
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {!hasBlockingUnresolved && clearableDrafts.length > 0 && (
              <div className="callout callout--warning" role="status">
                <p className="callout__title">Unpaid checkout draft(s) open</p>
                <ul className="conflict-list">
                  {clearableDrafts.map((draft) => (
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
              <TemporaryNotice
                occurrenceId={endDayError.id}
                duration="brief"
                className="alert alert--error"
                role="alert"
                closeLabel="Close End Day error"
                onDismiss={() => setEndDayError(null)}
              >
                {endDayError.data}
              </TemporaryNotice>
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

      {settlementTarget && dayStatus && (
        <PriorDaySettlementModal
          checkout={settlementTarget.checkout}
          todayDate={dayStatus.todayDate}
          localCashReceivedCentavos={settlementTarget.localCashReceivedCentavos}
          onClose={() => setSettlementTarget(null)}
          onSettled={(settlement) => void handlePriorDaySettled(settlement)}
          onAlreadySaved={(reference, sale) => handlePriorDayAlreadySaved(reference, sale)}
        />
      )}
    </AppShell>
  );
}
