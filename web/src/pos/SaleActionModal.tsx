import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import {
  type CatalogRefill,
  type ContainerPackageCode,
  type ContainerShape,
  type FaucetReportingType,
  formatCentavos,
  formatIncludedGripoLabel,
  formatLiters,
  formatManilaTimestamp,
  type IncludedGripoType,
  parsePesoInputToCentavos,
  type PosContainerPackageItem,
  type PosMerchandiseItem,
  type QuoteLineItem,
  type SaleActionCountCoverage,
  type SaleActionLookupResponse,
  type SaleActionRequestView,
  type SaleActionStockDispositionInput,
  type SaleView,
  type WaterType,
} from "./posRecovery";
import {
  deriveSaleActionControlFlags,
  formatSaleActionCashExchange,
  formatSaleActionStockItemSummary,
  INITIAL_CUSTOM_LITERS_INPUT,
  INITIAL_CUSTOM_PRICE_INPUT,
  validateNewCustomLine,
} from "./saleActionView";

export interface SaleActionModalProps {
  mode: "PREPARE_VOID" | "PREPARE_CORRECT" | "RECOVER_ACTION";
  sale?: SaleView | null;
  initialActionReference?: string | null;
  onClose: () => void;
  onCompleted: (result: {
    action: SaleActionRequestView;
    originalSale: SaleView;
    replacementSale: SaleView | null;
  }) => void;
  onCancelledNoCash: (result: {
    action: SaleActionRequestView;
    originalSale: SaleView;
  }) => void;
}

interface EditableCorrectionLine {
  key: string;
  kind: "STANDARD" | "CUSTOM" | "MERCHANDISE" | "CONTAINER_PACKAGE";
  waterType: WaterType | null;
  productId: string | null;
  stockUnit: string | null;
  packageCode: ContainerPackageCode | null;
  includedGripo: IncludedGripoType | null;
  faucetReportingType: FaucetReportingType | null;
  originalLineIndex: number | null;
  originalQuantity: number;
  displayLabel: string;
  unitVolumeLiters: number;
  unitPriceCentavos: number;
  quantity: number;
}

interface StockDispositionDraft {
  exchangedQuantity: number;
  eligibleReturnedQuantity: number;
  heldQuantity: number;
  notReturnedQuantity: number;
  holdReason: string;
  countCoverage?: SaleActionCountCoverage;
  uncoveredReturnedQuantity: number;
  coveredByCountQuantity: number;
  unclearCoverageQuantity: number;
}

interface InterveningCountPromptItem {
  productId: string;
  productName: string;
  unit: string;
  returningQuantity: number;
  reconciliationId: string;
  recordedAt: string;
  physicalCount: number;
}

const CONTAINER_PACKAGE_FALLBACKS: ReadonlyArray<{
  packageCode: ContainerPackageCode;
  shape: ContainerShape;
  name: string;
  waterType: WaterType | null;
  unitVolumeLiters: number;
  unitPriceCentavos: number;
}> = [
    { packageCode: "ROUND_EMPTY", shape: "ROUND", name: "Empty Round Container", waterType: null, unitVolumeLiters: 0, unitPriceCentavos: 17500 },
    { packageCode: "ROUND_PURIFIED", shape: "ROUND", name: "Round Container (Purified · 25 L)", waterType: "PURIFIED", unitVolumeLiters: 25, unitPriceCentavos: 20000 },
    { packageCode: "ROUND_ALKALINE", shape: "ROUND", name: "Round Container (Alkaline · 25 L)", waterType: "ALKALINE", unitVolumeLiters: 25, unitPriceCentavos: 21000 },
    { packageCode: "SLIM_EMPTY", shape: "SLIM", name: "Empty Slim Container", waterType: null, unitVolumeLiters: 0, unitPriceCentavos: 20000 },
    { packageCode: "SLIM_PURIFIED", shape: "SLIM", name: "Slim Container (Purified · 25 L)", waterType: "PURIFIED", unitVolumeLiters: 25, unitPriceCentavos: 20000 },
    { packageCode: "SLIM_ALKALINE", shape: "SLIM", name: "Slim Container (Alkaline · 25 L)", waterType: "ALKALINE", unitVolumeLiters: 25, unitPriceCentavos: 21000 },
  ];

function shapeFromPackageCode(code: ContainerPackageCode): ContainerShape {
  return code.startsWith("SLIM") ? "SLIM" : "ROUND";
}

function generateActionKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `act-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function initialCorrectionLines(sale: SaleView | null | undefined): EditableCorrectionLine[] {
  if (!sale) return [];
  return sale.items.map((item, idx) => ({
    key: `${item.kind}-${item.lineIndex}-${idx}`,
    kind: item.kind,
    waterType: item.waterType,
    productId: item.productId ?? null,
    stockUnit: item.stockUnit ?? null,
    packageCode:
      item.kind === "CONTAINER_PACKAGE"
        ? (item.catalogCode as ContainerPackageCode | null)
        : null,
    includedGripo: item.includedGripo ?? null,
    faucetReportingType: item.faucetReportingType ?? null,
    originalLineIndex: item.lineIndex,
    originalQuantity: item.quantity,
    displayLabel: item.displayLabel,
    unitVolumeLiters: item.unitVolumeLiters,
    unitPriceCentavos: item.unitPriceCentavos,
    quantity: item.quantity,
  }));
}

export function SaleActionModal({
  mode,
  sale,
  initialActionReference,
  onClose,
  onCompleted,
  onCancelledNoCash,
}: SaleActionModalProps) {
  const [catalogRefills, setCatalogRefills] = useState<CatalogRefill[]>([]);
  const [catalogMerchandise, setCatalogMerchandise] = useState<PosMerchandiseItem[]>([]);
  const [catalogContainers, setCatalogContainers] = useState<PosContainerPackageItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(mode === "PREPARE_CORRECT");
  const [reason, setReason] = useState("");
  const [correctionLines, setCorrectionLines] = useState<EditableCorrectionLine[]>(() =>
    initialCorrectionLines(sale),
  );
  const [stockDispositions, setStockDispositions] = useState<Record<string, StockDispositionDraft>>({});
  const [interveningPromptItems, setInterveningPromptItems] = useState<
    Record<string, InterveningCountPromptItem>
  >({});
  const [confirmInterveningItems, setConfirmInterveningItems] = useState<
    Record<string, InterveningCountPromptItem>
  >({});
  const [confirmCoverageDrafts, setConfirmCoverageDrafts] = useState<
    Record<
      string,
      {
        countCoverage?: SaleActionCountCoverage;
        uncoveredReturnedQuantity: number;
        coveredByCountQuantity: number;
        unclearCoverageQuantity: number;
      }
    >
  >({});
  const [customWaterType, setCustomWaterType] = useState<WaterType>("PURIFIED");
  const [customLitersInput, setCustomLitersInput] = useState(INITIAL_CUSTOM_LITERS_INPUT);
  const [customPriceInput, setCustomPriceInput] = useState(INITIAL_CUSTOM_PRICE_INPUT);
  const [prepareKey, setPrepareKey] = useState<string>(() => generateActionKey());
  const [preparing, setPreparing] = useState(false);

  const [lookup, setLookup] = useState<SaleActionLookupResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [statusUncertain, setStatusUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [cashConfirmed, setCashConfirmed] = useState(false);
  const [cashTenderInput, setCashTenderInput] = useState("");
  const [cancelNoCashConfirmed, setCancelNoCashConfirmed] = useState(false);
  const [cancelNote, setCancelNote] = useState("");

  const loadActionStatus = useCallback(async (actionReference: string) => {
    setChecking(true);
    setError(null);
    try {
      const res = await api<SaleActionLookupResponse>(
        `/api/pos/sale-actions/${encodeURIComponent(actionReference)}`,
      );
      setLookup(res);
      setStatusUncertain(false);
      setStatusMessage(
        res.action.status === "COMPLETED"
          ? "Saved sale action found on server. Review the committed result below."
          : res.action.status === "CANCELLED_NO_CASH"
            ? "This pending action was already cancelled with no cash exchanged."
            : "Pending sale action verified on server.",
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not check sale action status.",
      );
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (mode === "RECOVER_ACTION" && initialActionReference) {
      void loadActionStatus(initialActionReference);
    }
  }, [mode, initialActionReference, loadActionStatus]);

  useEffect(() => {
    if (mode !== "PREPARE_CORRECT") return;
    let active = true;
    setCatalogLoading(true);
    api<{
      items: CatalogRefill[];
      merchandise?: PosMerchandiseItem[];
      containerPackages?: PosContainerPackageItem[];
    }>("/api/pos/catalog")
      .then((res) => {
        if (!active) return;
        setCatalogRefills(res.items);
        setCatalogMerchandise(res.merchandise ?? []);
        setCatalogContainers(res.containerPackages ?? []);
      })
      .catch(() => {
        // Non-fatal if original lines are already populated
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mode]);

  const stockPlanPreviewRows = useMemo(() => {
    if (!sale) return [];
    const metaById = new Map<
      string,
      {
        name: string;
        unit: string;
        originalQuantity: number;
        correctedQuantity: number;
        originalFilledQuantity: number;
        correctedFilledQuantity: number;
      }
    >();
    for (const item of sale.items) {
      if ((item.kind !== "MERCHANDISE" && item.kind !== "CONTAINER_PACKAGE") || !item.productId) {
        continue;
      }
      const isFilled = item.kind === "CONTAINER_PACKAGE" && item.waterType !== null;
      const prev = metaById.get(item.productId);
      metaById.set(item.productId, {
        name: prev?.name ?? item.displayLabel,
        unit: prev?.unit ?? item.stockUnit ?? "pcs",
        originalQuantity: (prev?.originalQuantity ?? 0) + item.quantity,
        correctedQuantity: 0,
        originalFilledQuantity: (prev?.originalFilledQuantity ?? 0) + (isFilled ? item.quantity : 0),
        correctedFilledQuantity: 0,
      });
    }
    if (mode === "PREPARE_CORRECT") {
      for (const line of correctionLines) {
        if ((line.kind !== "MERCHANDISE" && line.kind !== "CONTAINER_PACKAGE") || !line.productId) {
          continue;
        }
        const isFilled = line.kind === "CONTAINER_PACKAGE" && line.waterType !== null;
        const prev = metaById.get(line.productId);
        metaById.set(line.productId, {
          name: prev?.name ?? line.displayLabel,
          unit: prev?.unit ?? line.stockUnit ?? "pcs",
          originalQuantity: prev?.originalQuantity ?? 0,
          correctedQuantity: (prev?.correctedQuantity ?? 0) + line.quantity,
          originalFilledQuantity: prev?.originalFilledQuantity ?? 0,
          correctedFilledQuantity:
            (prev?.correctedFilledQuantity ?? 0) + (isFilled ? line.quantity : 0),
        });
      }
    }
    return Array.from(metaById.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([productId, meta]) => {
        const retainedBase = Math.min(meta.originalQuantity, meta.correctedQuantity);
        const draft = stockDispositions[productId];
        const exchangedQuantity = Math.min(retainedBase, Math.max(0, draft?.exchangedQuantity ?? 0));
        const retainedQuantity = retainedBase - exchangedQuantity;
        const returningQuantity = meta.originalQuantity - retainedQuantity;
        const keptFilled = Math.min(
          meta.originalFilledQuantity,
          retainedQuantity,
          meta.correctedFilledQuantity,
        );
        const returningFilledQuantity = Math.max(0, meta.originalFilledQuantity - keptFilled);
        const maxEligibleReturn = Math.max(0, returningQuantity - returningFilledQuantity);
        const eligibleReturnedQuantity = Math.min(
          maxEligibleReturn,
          Math.max(0, draft?.eligibleReturnedQuantity ?? 0),
        );
        const heldQuantity = Math.min(returningQuantity, Math.max(0, draft?.heldQuantity ?? 0));
        const notReturnedQuantity = Math.min(
          returningQuantity,
          Math.max(0, draft?.notReturnedQuantity ?? 0),
        );
        const assignedQuantity = eligibleReturnedQuantity + heldQuantity + notReturnedQuantity;
        const unassignedQuantity = returningQuantity - assignedQuantity;
        const addedQuantity =
          Math.max(0, meta.correctedQuantity - meta.originalQuantity) + exchangedQuantity;
        return {
          productId,
          ...meta,
          retainedBase,
          exchangedQuantity,
          retainedQuantity,
          returningQuantity,
          returningFilledQuantity,
          maxEligibleReturn,
          eligibleReturnedQuantity,
          heldQuantity,
          notReturnedQuantity,
          assignedQuantity,
          unassignedQuantity,
          addedQuantity,
          holdReason: draft?.holdReason ?? "",
          countCoverage: draft?.countCoverage,
          uncoveredReturnedQuantity: draft?.uncoveredReturnedQuantity ?? 0,
          coveredByCountQuantity: draft?.coveredByCountQuantity ?? 0,
          unclearCoverageQuantity: draft?.unclearCoverageQuantity ?? 0,
        };
      });
  }, [sale, mode, correctionLines, stockDispositions]);

  const correctedPreviewTotal = useMemo(() => {
    const merchCatalogById = new Map(catalogMerchandise.map((m) => [m.id, m]));
    return correctionLines.reduce((sum, line) => {
      if (line.kind === "MERCHANDISE" && line.originalLineIndex !== null && line.productId) {
        const retainedQty = Math.min(line.quantity, line.originalQuantity);
        const addedQty = Math.max(0, line.quantity - retainedQty);
        const livePrice = merchCatalogById.get(line.productId)?.unitPriceCentavos ?? line.unitPriceCentavos;
        return sum + retainedQty * line.unitPriceCentavos + addedQty * livePrice;
      }
      return sum + line.unitPriceCentavos * line.quantity;
    }, 0);
  }, [correctionLines, catalogMerchandise]);

  const previewDifferenceCentavos =
    sale && mode === "PREPARE_VOID"
      ? -sale.totalCentavos
      : sale
        ? correctedPreviewTotal - sale.totalCentavos
        : 0;

  function addStandardLine(refill: CatalogRefill) {
    setCorrectionLines((prev) => {
      const existing = prev.find(
        (line) => line.kind === "STANDARD" && line.waterType === refill.waterType,
      );
      if (existing) {
        return prev.map((line) =>
          line.key === existing.key ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...prev,
        {
          key: `STD-${refill.waterType}-${Date.now()}`,
          kind: "STANDARD",
          waterType: refill.waterType,
          productId: null,
          stockUnit: null,
          packageCode: null,
          includedGripo: null,
          faucetReportingType: null,
          originalLineIndex: null,
          originalQuantity: 0,
          displayLabel: refill.displayName,
          unitVolumeLiters: refill.unitVolumeMl / 1000,
          unitPriceCentavos: refill.unitPriceCentavos,
          quantity: 1,
        },
      ];
    });
    setPrepareKey(generateActionKey());
  }

  function addMerchandiseLine(product: PosMerchandiseItem) {
    setCorrectionLines((prev) => {
      const existingNew = prev.find(
        (line) =>
          line.kind === "MERCHANDISE" &&
          line.productId === product.id &&
          line.originalLineIndex === null,
      );
      if (existingNew) {
        return prev.map((line) =>
          line.key === existingNew.key ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...prev,
        {
          key: `MERCH-${product.id}-${Date.now()}-${prev.length}`,
          kind: "MERCHANDISE",
          waterType: null,
          productId: product.id,
          stockUnit: product.unit,
          packageCode: null,
          includedGripo: null,
          faucetReportingType: product.faucetReportingType ?? null,
          originalLineIndex: null,
          originalQuantity: 0,
          displayLabel: product.name,
          unitVolumeLiters: 0,
          unitPriceCentavos: product.unitPriceCentavos,
          quantity: 1,
        },
      ];
    });
    setPrepareKey(generateActionKey());
  }

  function addContainerPackageLine(pkg: PosContainerPackageItem) {
    const gripo: IncludedGripoType = "PUSH_TYPE";
    setCorrectionLines((prev) => {
      const existing = prev.find(
        (line) =>
          line.kind === "CONTAINER_PACKAGE" &&
          line.packageCode === pkg.packageCode &&
          line.includedGripo === gripo,
      );
      if (existing) {
        return prev.map((line) =>
          line.key === existing.key ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...prev,
        {
          key: `PKG-${pkg.packageCode}-${Date.now()}`,
          kind: "CONTAINER_PACKAGE",
          waterType: pkg.waterType,
          productId: pkg.productId,
          stockUnit: pkg.unit,
          packageCode: pkg.packageCode,
          includedGripo: gripo,
          faucetReportingType: null,
          originalLineIndex: null,
          originalQuantity: 0,
          displayLabel: `${pkg.name} · ${formatIncludedGripoLabel(gripo)}`,
          unitVolumeLiters: pkg.unitVolumeLiters,
          unitPriceCentavos: pkg.unitPriceCentavos,
          quantity: 1,
        },
      ];
    });
    setPrepareKey(generateActionKey());
  }

  function addCustomLine() {
    const validated = validateNewCustomLine(customLitersInput, customPriceInput);
    if (!validated.ok) {
      setError(validated.message);
      return;
    }
    const { unitVolumeLiters: liters, unitPriceCentavos: priceCentavos } = validated;
    setError(null);
    setCorrectionLines((prev) => [
      ...prev,
      {
        key: `CUS-${Date.now()}-${prev.length}`,
        kind: "CUSTOM",
        waterType: customWaterType,
        productId: null,
        stockUnit: null,
        packageCode: null,
        includedGripo: null,
        faucetReportingType: null,
        originalLineIndex: null,
        originalQuantity: 0,
        displayLabel: `${customWaterType === "PURIFIED" ? "Purified" : "Alkaline"} custom · ${formatLiters(liters)}`,
        unitVolumeLiters: liters,
        unitPriceCentavos: priceCentavos,
        quantity: 1,
      },
    ]);
    setCustomLitersInput(INITIAL_CUSTOM_LITERS_INPUT);
    setCustomPriceInput(INITIAL_CUSTOM_PRICE_INPUT);
    setPrepareKey(generateActionKey());
  }

  async function handlePrepareAction() {
    if (!sale) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("Enter a factual reason for this sale action.");
      return;
    }
    if (mode === "PREPARE_CORRECT" && correctionLines.length === 0) {
      setError("Keep or add at least one item for a sale correction.");
      return;
    }

    const dispositionsPayload: SaleActionStockDispositionInput[] = [];
    for (const row of stockPlanPreviewRows) {
      if (row.returningQuantity > 0 && row.unassignedQuantity !== 0) {
        setError(
          `Confirm physical return disposition for ${row.name}: eligible returned (${row.eligibleReturnedQuantity}), held (${row.heldQuantity}), and not returned (${row.notReturnedQuantity}) must equal ${row.returningQuantity}.`,
        );
        return;
      }
      if (row.heldQuantity > 0 && !row.holdReason.trim()) {
        setError(`Enter a hold or damage reason for ${row.name}.`);
        return;
      }
      const promptItem = interveningPromptItems[row.productId];
      if (promptItem && row.eligibleReturnedQuantity > 0 && !row.countCoverage) {
        setError(`Choose how the intervening physical count relates to ${row.name}.`);
        return;
      }
      if (
        row.countCoverage === "PARTIAL" &&
        row.uncoveredReturnedQuantity + row.coveredByCountQuantity + row.unclearCoverageQuantity !==
        row.eligibleReturnedQuantity
      ) {
        setError(
          `Partial count coverage for ${row.name} must sum to ${row.eligibleReturnedQuantity} ${row.unit}.`,
        );
        return;
      }
      if (
        row.exchangedQuantity > 0 ||
        row.returningQuantity > 0 ||
        row.countCoverage !== undefined
      ) {
        dispositionsPayload.push({
          productId: row.productId,
          ...(row.exchangedQuantity > 0 ? { exchangedQuantity: row.exchangedQuantity } : {}),
          ...(row.returningQuantity > 0
            ? {
              eligibleReturnedQuantity: row.eligibleReturnedQuantity,
              heldQuantity: row.heldQuantity,
              notReturnedQuantity: row.notReturnedQuantity,
              ...(row.heldQuantity > 0 ? { holdReason: row.holdReason.trim() } : {}),
            }
            : {}),
          ...(row.countCoverage ? { countCoverage: row.countCoverage } : {}),
          ...(row.countCoverage === "PARTIAL"
            ? {
              uncoveredReturnedQuantity: row.uncoveredReturnedQuantity,
              coveredByCountQuantity: row.coveredByCountQuantity,
              unclearCoverageQuantity: row.unclearCoverageQuantity,
            }
            : {}),
        });
      }
    }

    setPreparing(true);
    setError(null);
    setStatusMessage(null);
    try {
      const payload =
        mode === "PREPARE_VOID"
          ? {
            actionType: "VOID" as const,
            reason: trimmedReason,
            prepareKey,
            ...(dispositionsPayload.length > 0 ? { stockDispositions: dispositionsPayload } : {}),
          }
          : {
            actionType: "CORRECT" as const,
            reason: trimmedReason,
            prepareKey,
            items: correctionLines.map((line) => {
              if (line.kind === "STANDARD") {
                return {
                  kind: "STANDARD" as const,
                  waterType: line.waterType ?? "PURIFIED",
                  quantity: line.quantity,
                };
              }
              if (line.kind === "MERCHANDISE") {
                return {
                  kind: "MERCHANDISE" as const,
                  productId: line.productId!,
                  quantity: line.quantity,
                  ...(line.originalLineIndex !== null
                    ? { originalLineIndex: line.originalLineIndex }
                    : {}),
                };
              }
              if (line.kind === "CONTAINER_PACKAGE") {
                return {
                  kind: "CONTAINER_PACKAGE" as const,
                  packageCode: line.packageCode!,
                  includedGripo: line.includedGripo ?? "PUSH_TYPE",
                  quantity: line.quantity,
                };
              }
              return {
                kind: "CUSTOM" as const,
                waterType: line.waterType ?? "PURIFIED",
                unitVolumeLiters: line.unitVolumeLiters,
                unitPriceCentavos: line.unitPriceCentavos,
                quantity: line.quantity,
              };
            }),
            ...(dispositionsPayload.length > 0 ? { stockDispositions: dispositionsPayload } : {}),
          };

      const res = await api<{ action: SaleActionRequestView; replayed: boolean }>(
        `/api/pos/sales/${encodeURIComponent(sale.reference)}/actions`,
        {
          method: "POST",
          body: payload,
        },
      );
      await loadActionStatus(res.action.reference);
    } catch (err) {
      if (err instanceof ApiError && err.code === "SALE_ACTION_ALREADY_PENDING") {
        const pendingAction = err.details?.action as SaleActionRequestView | undefined;
        if (pendingAction?.reference) {
          await loadActionStatus(pendingAction.reference);
          setStatusMessage("Loaded the existing unresolved action for this sale.");
          return;
        }
      }
      if (err instanceof ApiError && err.code === "INTERVENING_COUNT_REVIEW_REQUIRED") {
        const affected = (err.details?.affectedItems as InterveningCountPromptItem[] | undefined) ?? [];
        const nextMap: Record<string, InterveningCountPromptItem> = {};
        for (const item of affected) {
          nextMap[item.productId] = item;
        }
        setInterveningPromptItems(nextMap);
      }
      setError(err instanceof ApiError ? err.message : "Could not prepare sale action.");
    } finally {
      setPreparing(false);
    }
  }

  async function handleConfirmAction() {
    if (!lookup) return;
    const { action } = lookup;
    const body: {
      cashConfirmed?: boolean;
      cashTenderedCentavos?: number;
      stockDispositions?: SaleActionStockDispositionInput[];
    } = {};

    if (action.cashDirection === "REFUND") {
      if (!cashConfirmed) return;
      body.cashConfirmed = true;
    } else if (action.cashDirection === "COLLECT") {
      if (!cashConfirmed) return;
      const tender = parsePesoInputToCentavos(cashTenderInput);
      if (tender === null || tender < action.cashDifferenceCentavos) {
        setError("Cash tendered must be at least the additional amount due.");
        return;
      }
      body.cashConfirmed = true;
      body.cashTenderedCentavos = tender;
    }

    const pendingReviews = Object.values(confirmInterveningItems);
    if (pendingReviews.length > 0) {
      const confirmDispositions: SaleActionStockDispositionInput[] = [];
      for (const planItem of action.merchandisePlan.items ?? []) {
        if (planItem.returningFromSaleQuantity <= 0) continue;
        const prompt = confirmInterveningItems[planItem.productId];
        const covDraft = confirmCoverageDrafts[planItem.productId];
        const eligibleQty =
          planItem.eligibleReturnedQuantity ??
          planItem.restoredQuantity +
          planItem.countCoveredQuantity +
          planItem.unclearCoverageQuantity;
        if (prompt && eligibleQty > 0 && !covDraft?.countCoverage) {
          setError(`Confirm physical-count coverage for ${planItem.productName} before saving.`);
          return;
        }
        confirmDispositions.push({
          productId: planItem.productId,
          ...(planItem.exchangedQuantity > 0
            ? { exchangedQuantity: planItem.exchangedQuantity }
            : {}),
          eligibleReturnedQuantity: eligibleQty,
          heldQuantity: planItem.heldQuantity,
          notReturnedQuantity: planItem.notReturnedQuantity ?? 0,
          ...(planItem.heldQuantity > 0 && planItem.holdReason
            ? { holdReason: planItem.holdReason }
            : {}),
          ...(covDraft?.countCoverage ? { countCoverage: covDraft.countCoverage } : {}),
          ...(covDraft?.countCoverage === "PARTIAL"
            ? {
              uncoveredReturnedQuantity: covDraft.uncoveredReturnedQuantity,
              coveredByCountQuantity: covDraft.coveredByCountQuantity,
              unclearCoverageQuantity: covDraft.unclearCoverageQuantity,
            }
            : {}),
        });
      }
      body.stockDispositions = confirmDispositions;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{
        outcome: "COMPLETED";
        replayed: boolean;
        action: SaleActionRequestView;
        originalSale: SaleView;
        replacementSale: SaleView | null;
      }>(`/api/pos/sale-actions/${encodeURIComponent(action.reference)}/confirm`, {
        method: "POST",
        body,
      });
      onCompleted({
        action: res.action,
        originalSale: res.originalSale,
        replacementSale: res.replacementSale,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "INTERVENING_COUNT_REVIEW_REQUIRED") {
        const affected =
          (err.details?.affectedItems as InterveningCountPromptItem[] | undefined) ?? [];
        const nextMap: Record<string, InterveningCountPromptItem> = {};
        for (const item of affected) {
          nextMap[item.productId] = item;
        }
        setConfirmInterveningItems(nextMap);
        setStatusUncertain(false);
        setStatusMessage(null);
        setError(err.message);
        return;
      }
      setStatusUncertain(true);
      setStatusMessage(null);
      setError(err instanceof ApiError ? err.message : "Could not complete sale action.");
      await loadActionStatus(action.reference);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelActionNoCash() {
    if (!lookup || !cancelNoCashConfirmed) return;
    const { action } = lookup;
    setCancelling(true);
    setError(null);
    try {
      const res = await api<{
        outcome: "CANCELLED_NO_CASH";
        replayed: boolean;
        action: SaleActionRequestView;
        originalSale: SaleView;
      }>(`/api/pos/sale-actions/${encodeURIComponent(action.reference)}/cancel`, {
        method: "POST",
        body: {
          noCashExchangedConfirmed: true,
          ...(cancelNote.trim() ? { reason: cancelNote.trim() } : {}),
        },
      });
      onCancelledNoCash({
        action: res.action,
        originalSale: res.originalSale,
      });
    } catch (err) {
      setStatusUncertain(true);
      setStatusMessage(null);
      setError(err instanceof ApiError ? err.message : "Could not cancel pending action.");
      await loadActionStatus(action.reference);
    } finally {
      setCancelling(false);
    }
  }

  const busy = preparing || checking || submitting || cancelling;
  const activeAction = lookup?.action ?? null;
  const controlFlags = activeAction
    ? deriveSaleActionControlFlags({
      status: activeAction.status,
      canConfirm: lookup?.canConfirm ?? false,
      canCancelNoCash: lookup?.canCancelNoCash ?? false,
      statusUncertain,
    })
    : null;
  const customLineValidation = validateNewCustomLine(customLitersInput, customPriceInput);
  const parsedCollectTender = parsePesoInputToCentavos(cashTenderInput);
  const collectSufficient =
    activeAction &&
    activeAction.cashDirection === "COLLECT" &&
    parsedCollectTender !== null &&
    parsedCollectTender >= activeAction.cashDifferenceCentavos;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sale-action-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <div>
            <h2 id="sale-action-modal-title">
              {activeAction
                ? `${activeAction.actionType === "VOID" ? "Void Sale" : "Correct Sale"} · ${activeAction.reference}`
                : mode === "PREPARE_VOID"
                  ? `Void Sale · ${sale?.reference ?? ""}`
                  : mode === "PREPARE_CORRECT"
                    ? `Correct Sale · ${sale?.reference ?? ""}`
                    : `Recover Sale Action · ${initialActionReference ?? ""}`}
            </h2>
            <p className="muted-sm">
              {activeAction
                ? `Original sale ${activeAction.originalSaleReference} (${activeAction.originalBusinessDate})`
                : sale
                  ? `Saved on ${sale.businessDate} · ${sale.correctedFromSaleReference ? "Retained total" : "Original total"
                  } ${formatCentavos(sale.totalCentavos)}`
                  : "Checking saved action record"}
            </p>
          </div>
        </div>

        <div className="modal__body">
          {statusMessage && (
            <div className="callout callout--info" role="status">
              <p className="callout__body">{statusMessage}</p>
            </div>
          )}

          {error && (
            <div className="alert alert--error" role="alert">
              {error}
            </div>
          )}

          {!activeAction && mode !== "RECOVER_ACTION" && sale && (
            <>
              {sale.correctedFromSaleReference ? (
                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>Intermediate retained total</dt>
                    <dd>{formatCentavos(sale.totalCentavos)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Replaces sale</dt>
                    <dd className="mono-ref">{sale.correctedFromSaleReference}</dd>
                  </div>
                  {sale.cashEventChain && (
                    <>
                      <div className="detail-list__row">
                        <dt>
                          Original cash sale ({sale.cashEventChain.rootCashSale.reference})
                        </dt>
                        <dd>
                          {formatCentavos(sale.cashEventChain.rootCashSale.cashReceivedCentavos)}{" "}
                          tendered ·{" "}
                          {formatCentavos(sale.cashEventChain.rootCashSale.changeCentavos)} change
                        </dd>
                      </div>
                      {sale.cashEventChain.correctionEvents.map((ev) => (
                        <div key={ev.actionReference} className="detail-list__row">
                          <dt>Prior correction ({ev.actionReference})</dt>
                          <dd>{formatSaleActionCashExchange(ev)}</dd>
                        </div>
                      ))}
                    </>
                  )}
                </dl>
              ) : (
                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>Original total</dt>
                    <dd>{formatCentavos(sale.totalCentavos)}</dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>Original cash tendered / change</dt>
                    <dd>
                      {formatCentavos(sale.cashReceivedCentavos)} tendered ·{" "}
                      {formatCentavos(sale.changeCentavos)} change
                    </dd>
                  </div>
                </dl>
              )}

              {mode === "PREPARE_CORRECT" && (
                <div className="subview">
                  <div className="detail-card__header">
                    <h3>Corrected sale items</h3>
                    {catalogLoading && <span className="muted-sm">Loading catalog…</span>}
                  </div>
                  {(catalogRefills.length > 0 ||
                    catalogMerchandise.length > 0 ||
                    catalogContainers.length > 0) && (
                      <div className="callout__actions">
                        {catalogRefills.map((refill) => (
                          <button
                            key={refill.code}
                            type="button"
                            className="button button--ghost button--sm"
                            disabled={busy}
                            onClick={() => addStandardLine(refill)}
                          >
                            + {refill.displayName} ({formatCentavos(refill.unitPriceCentavos)})
                          </button>
                        ))}
                        {catalogContainers.map((pkg) => (
                          <button
                            key={pkg.packageCode}
                            type="button"
                            className="button button--ghost button--sm"
                            disabled={busy}
                            onClick={() => addContainerPackageLine(pkg)}
                          >
                            + {pkg.name} ({formatCentavos(pkg.unitPriceCentavos)})
                          </button>
                        ))}
                        {catalogMerchandise.map((prod) => (
                          <button
                            key={prod.id}
                            type="button"
                            className="button button--ghost button--sm"
                            disabled={busy}
                            onClick={() => addMerchandiseLine(prod)}
                          >
                            + {prod.name} ({formatCentavos(prod.unitPriceCentavos)})
                          </button>
                        ))}
                      </div>
                    )}

                  <ul className="pos-summary-lines">
                    {correctionLines.map((line) => (
                      <li key={line.key} className="pos-summary-line">
                        <div className="pos-summary-line__meta">
                          <strong>{line.displayLabel}</strong>
                          <span className="muted-sm">
                            {formatCentavos(line.unitPriceCentavos)}
                            {line.kind === "STANDARD" || line.kind === "CUSTOM"
                              ? ` · ${formatLiters(line.unitVolumeLiters)}`
                              : line.kind === "CONTAINER_PACKAGE"
                                ? ` · ${formatLiters(line.unitVolumeLiters)}`
                                : ` · per ${line.stockUnit ?? "pcs"}${line.faucetReportingType ? ` · ${line.faucetReportingType === "PUSH_TYPE" ? "Push-Type" : "Twist-Type"}` : ""}`}
                          </span>
                          {line.kind === "CONTAINER_PACKAGE" && line.packageCode && (
                            <div className="callout__actions">
                              <select
                                aria-label={`Package option for ${line.displayLabel}`}
                                value={line.packageCode}
                                disabled={busy}
                                onChange={(event) => {
                                  const nextCode = event.target.value as ContainerPackageCode;
                                  const pkgMeta =
                                    catalogContainers.find((c) => c.packageCode === nextCode) ??
                                    CONTAINER_PACKAGE_FALLBACKS.find((c) => c.packageCode === nextCode);
                                  if (!pkgMeta) return;
                                  const gripo = line.includedGripo ?? "PUSH_TYPE";
                                  setCorrectionLines((prev) =>
                                    prev.map((entry) =>
                                      entry.key === line.key
                                        ? {
                                          ...entry,
                                          packageCode: nextCode,
                                          waterType: pkgMeta.waterType,
                                          unitVolumeLiters: pkgMeta.unitVolumeLiters,
                                          unitPriceCentavos: pkgMeta.unitPriceCentavos,
                                          displayLabel: `${pkgMeta.name} · ${formatIncludedGripoLabel(gripo)}`,
                                        }
                                        : entry,
                                    ),
                                  );
                                  setPrepareKey(generateActionKey());
                                }}
                              >
                                {CONTAINER_PACKAGE_FALLBACKS.filter(
                                  (c) => c.shape === shapeFromPackageCode(line.packageCode!),
                                ).map((opt) => (
                                  <option key={opt.packageCode} value={opt.packageCode}>
                                    {opt.name} ({formatCentavos(opt.unitPriceCentavos)})
                                  </option>
                                ))}
                              </select>
                              <select
                                aria-label={`Included gripo for ${line.displayLabel}`}
                                value={line.includedGripo ?? "PUSH_TYPE"}
                                disabled={busy}
                                onChange={(event) => {
                                  const nextGripo = event.target.value as IncludedGripoType;
                                  const pkgMeta =
                                    catalogContainers.find((c) => c.packageCode === line.packageCode) ??
                                    CONTAINER_PACKAGE_FALLBACKS.find(
                                      (c) => c.packageCode === line.packageCode,
                                    );
                                  setCorrectionLines((prev) =>
                                    prev.map((entry) =>
                                      entry.key === line.key
                                        ? {
                                          ...entry,
                                          includedGripo: nextGripo,
                                          displayLabel: `${pkgMeta?.name ?? "Container"} · ${formatIncludedGripoLabel(nextGripo)}`,
                                        }
                                        : entry,
                                    ),
                                  );
                                  setPrepareKey(generateActionKey());
                                }}
                              >
                                <option value="PUSH_TYPE">Push-Type gripo</option>
                                <option value="TWIST_TYPE">Twist-Type gripo</option>
                              </select>
                            </div>
                          )}
                        </div>
                        <div className="callout__actions">
                          <input
                            type="number"
                            min={1}
                            max={500}
                            className="input"
                            aria-label={`Quantity for ${line.displayLabel}`}
                            value={line.quantity}
                            disabled={busy}
                            onChange={(event) => {
                              const nextQty = Math.max(1, Number(event.target.value) || 1);
                              setCorrectionLines((prev) =>
                                prev.map((entry) =>
                                  entry.key === line.key ? { ...entry, quantity: nextQty } : entry,
                                ),
                              );
                              setPrepareKey(generateActionKey());
                            }}
                          />
                          <button
                            type="button"
                            className="button button--ghost button--sm"
                            disabled={busy || correctionLines.length <= 1}
                            onClick={() => {
                              setCorrectionLines((prev) =>
                                prev.filter((entry) => entry.key !== line.key),
                              );
                              setPrepareKey(generateActionKey());
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>

                  <div className="pos-custom-row">
                    <select
                      aria-label="Custom refill water type"
                      value={customWaterType}
                      disabled={busy}
                      onChange={(event) => setCustomWaterType(event.target.value as WaterType)}
                    >
                      <option value="PURIFIED">Purified (Custom)</option>
                      <option value="ALKALINE">Alkaline (Custom)</option>
                    </select>
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      aria-label="Custom refill liters"
                      value={customLitersInput}
                      disabled={busy}
                      onChange={(event) => setCustomLitersInput(event.target.value)}
                      placeholder="Liters"
                    />
                    <input
                      type="text"
                      aria-label="Custom refill unit price"
                      value={customPriceInput}
                      disabled={busy}
                      onChange={(event) => setCustomPriceInput(event.target.value)}
                      placeholder="₱ Price"
                    />
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      disabled={busy || !customLineValidation.ok}
                      onClick={addCustomLine}
                    >
                      Add custom line
                    </button>
                  </div>
                </div>
              )}

              {stockPlanPreviewRows.length > 0 && (
                <div className="subview">
                  <div className="detail-card__header">
                    <h3>Linked inventory &amp; return stock effects</h3>
                  </div>
                  <ul className="pos-summary-lines">
                    {stockPlanPreviewRows.map((row) => {
                      const promptInfo = interveningPromptItems[row.productId];
                      const updateDraft = (patch: Partial<StockDispositionDraft>) => {
                        setStockDispositions((prev) => {
                          const existing = prev[row.productId] ?? {
                            exchangedQuantity: 0,
                            eligibleReturnedQuantity: 0,
                            heldQuantity: 0,
                            notReturnedQuantity: 0,
                            holdReason: "",
                            uncoveredReturnedQuantity: 0,
                            coveredByCountQuantity: 0,
                            unclearCoverageQuantity: 0,
                          };
                          return {
                            ...prev,
                            [row.productId]: { ...existing, ...patch },
                          };
                        });
                        setPrepareKey(generateActionKey());
                      };
                      return (
                        <li key={row.productId} className="pos-summary-line">
                          <div className="pos-summary-line__meta">
                            <strong>{row.name}</strong>
                            <span className="muted-sm">
                              Original {row.originalQuantity} {row.unit} · New{" "}
                              {row.correctedQuantity} {row.unit}
                              {row.retainedQuantity > 0
                                ? ` · ${row.retainedQuantity} ${row.unit} kept`
                                : ""}
                              {row.addedQuantity > 0
                                ? ` · -${row.addedQuantity} ${row.unit} deducted`
                                : ""}
                              {row.returningQuantity > 0
                                ? ` · ${row.returningQuantity} ${row.unit} to account for (${row.eligibleReturnedQuantity} returned / ${row.heldQuantity} damaged / ${row.notReturnedQuantity} not returned)`
                                : ""}
                            </span>
                            {row.retainedBase > 0 && (
                              <label className="field">
                                <span className="field__label">
                                  Physically exchanged units (0–{row.retainedBase})
                                </span>
                                <input
                                  type="number"
                                  min={0}
                                  max={row.retainedBase}
                                  className="input"
                                  value={row.exchangedQuantity}
                                  disabled={busy}
                                  onChange={(event) => {
                                    const val = Math.min(
                                      row.retainedBase,
                                      Math.max(0, Number(event.target.value) || 0),
                                    );
                                    updateDraft({ exchangedQuantity: val });
                                  }}
                                />
                              </label>
                            )}
                            {row.returningQuantity > 0 && (
                              <>
                                {row.returningFilledQuantity > 0 && (
                                  <p className="muted-sm">
                                    Includes {row.returningFilledQuantity} filled container{" "}
                                    {row.unit} (INV-014/015): filled units cannot be auto-restored
                                    as sellable empty containers — mark them damaged/held or not
                                    returned.
                                  </p>
                                )}
                                <label className="field">
                                  <span className="field__label">
                                    Verified good returned to shelf (0–{row.maxEligibleReturn})
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    max={row.maxEligibleReturn}
                                    className="input"
                                    value={row.eligibleReturnedQuantity}
                                    disabled={busy || row.maxEligibleReturn === 0}
                                    onChange={(event) => {
                                      const val = Math.min(
                                        row.maxEligibleReturn,
                                        Math.max(0, Number(event.target.value) || 0),
                                      );
                                      updateDraft({ eligibleReturnedQuantity: val });
                                    }}
                                  />
                                </label>
                                <label className="field">
                                  <span className="field__label">
                                    Damaged / excluded from sellable stock (0–{row.returningQuantity})
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    max={row.returningQuantity}
                                    className="input"
                                    value={row.heldQuantity}
                                    disabled={busy}
                                    onChange={(event) => {
                                      const val = Math.min(
                                        row.returningQuantity,
                                        Math.max(0, Number(event.target.value) || 0),
                                      );
                                      updateDraft({ heldQuantity: val });
                                    }}
                                  />
                                </label>
                                <label className="field">
                                  <span className="field__label">
                                    Not returned / left with customer (0–{row.returningQuantity})
                                  </span>
                                  <input
                                    type="number"
                                    min={0}
                                    max={row.returningQuantity}
                                    className="input"
                                    value={row.notReturnedQuantity}
                                    disabled={busy}
                                    onChange={(event) => {
                                      const val = Math.min(
                                        row.returningQuantity,
                                        Math.max(0, Number(event.target.value) || 0),
                                      );
                                      updateDraft({ notReturnedQuantity: val });
                                    }}
                                  />
                                </label>
                                {row.unassignedQuantity !== 0 && (
                                  <p className="muted-sm">
                                    Assign {row.unassignedQuantity > 0 ? row.unassignedQuantity : 0}{" "}
                                    more {row.unit} so returned + held + not returned equals{" "}
                                    {row.returningQuantity} {row.unit}.
                                  </p>
                                )}
                                {row.heldQuantity > 0 && (
                                  <label className="field">
                                    <span className="field__label">
                                      Damage / hold reason *
                                    </span>
                                    <input
                                      type="text"
                                      maxLength={240}
                                      className="input"
                                      placeholder="e.g. Cracked faucet valve, leak on return"
                                      value={row.holdReason}
                                      disabled={busy}
                                      onChange={(event) => {
                                        updateDraft({ holdReason: event.target.value });
                                      }}
                                    />
                                  </label>
                                )}
                                {promptInfo && row.eligibleReturnedQuantity > 0 && (
                                  <div className="callout callout--warning" role="alert">
                                    <p className="callout__title">
                                      Physical count recorded after sale
                                    </p>
                                    <p className="callout__body">
                                      {row.name} was physically counted (
                                      {promptInfo.physicalCount} {promptInfo.unit}) at{" "}
                                      {formatManilaTimestamp(promptInfo.recordedAt)} after this
                                      sale. How did that count treat these{" "}
                                      {row.eligibleReturnedQuantity} {row.unit}?
                                    </p>
                                    <label className="checkbox-field">
                                      <input
                                        type="radio"
                                        name={`cov-${row.productId}`}
                                        checked={row.countCoverage === "COVERED_BY_COUNT"}
                                        disabled={busy}
                                        onChange={() => updateDraft({ countCoverage: "COVERED_BY_COUNT" })}
                                      />
                                      <span>
                                        Already included in physical count (+0 restored)
                                      </span>
                                    </label>
                                    <label className="checkbox-field">
                                      <input
                                        type="radio"
                                        name={`cov-${row.productId}`}
                                        checked={row.countCoverage === "UNCOVERED"}
                                        disabled={busy}
                                        onChange={() => updateDraft({ countCoverage: "UNCOVERED" })}
                                      />
                                      <span>
                                        Verifiably missed / excluded by count (+{row.eligibleReturnedQuantity}{" "}
                                        restored)
                                      </span>
                                    </label>
                                    <label className="checkbox-field">
                                      <input
                                        type="radio"
                                        name={`cov-${row.productId}`}
                                        checked={row.countCoverage === "PARTIAL"}
                                        disabled={busy}
                                        onChange={() => updateDraft({ countCoverage: "PARTIAL" })}
                                      />
                                      <span>
                                        Partial (split covered, uncovered, and unclear units)
                                      </span>
                                    </label>
                                    <label className="checkbox-field">
                                      <input
                                        type="radio"
                                        name={`cov-${row.productId}`}
                                        checked={row.countCoverage === "UNCLEAR"}
                                        disabled={busy}
                                        onChange={() => updateDraft({ countCoverage: "UNCLEAR" })}
                                      />
                                      <span>
                                        Unclear — hold restoration and review via Inventory count
                                      </span>
                                    </label>
                                    {row.countCoverage === "PARTIAL" && (
                                      <div className="callout__actions">
                                        <label className="field">
                                          <span className="field__label">Uncovered (+restored)</span>
                                          <input
                                            type="number"
                                            min={0}
                                            max={row.eligibleReturnedQuantity}
                                            className="input"
                                            value={row.uncoveredReturnedQuantity}
                                            disabled={busy}
                                            onChange={(event) =>
                                              updateDraft({
                                                uncoveredReturnedQuantity: Math.max(
                                                  0,
                                                  Number(event.target.value) || 0,
                                                ),
                                              })
                                            }
                                          />
                                        </label>
                                        <label className="field">
                                          <span className="field__label">Covered (+0)</span>
                                          <input
                                            type="number"
                                            min={0}
                                            max={row.eligibleReturnedQuantity}
                                            className="input"
                                            value={row.coveredByCountQuantity}
                                            disabled={busy}
                                            onChange={(event) =>
                                              updateDraft({
                                                coveredByCountQuantity: Math.max(
                                                  0,
                                                  Number(event.target.value) || 0,
                                                ),
                                              })
                                            }
                                          />
                                        </label>
                                        <label className="field">
                                          <span className="field__label">Unclear (+review)</span>
                                          <input
                                            type="number"
                                            min={0}
                                            max={row.eligibleReturnedQuantity}
                                            className="input"
                                            value={row.unclearCoverageQuantity}
                                            disabled={busy}
                                            onChange={(event) =>
                                              updateDraft({
                                                unclearCoverageQuantity: Math.max(
                                                  0,
                                                  Number(event.target.value) || 0,
                                                ),
                                              })
                                            }
                                          />
                                        </label>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div className="callout callout--info">
                <p className="callout__title">Preview before cash exchange</p>
                <p className="callout__body">
                  {previewDifferenceCentavos < 0
                    ? `Corrected total: ${formatCentavos(mode === "PREPARE_VOID" ? 0 : correctedPreviewTotal)} · Refund due to customer: ${formatCentavos(-previewDifferenceCentavos)}.`
                    : previewDifferenceCentavos > 0
                      ? `Corrected total: ${formatCentavos(correctedPreviewTotal)} · Additional cash to collect: ${formatCentavos(previewDifferenceCentavos)}.`
                      : `Corrected total: ${formatCentavos(correctedPreviewTotal)} · Equal total, no cash exchange required.`}
                </p>
              </div>

              <label className="field">
                <span className="field__label">Reason for {mode === "PREPARE_VOID" ? "void" : "correction"}</span>
                <input
                  type="text"
                  className="input"
                  maxLength={240}
                  value={reason}
                  disabled={busy}
                  placeholder="Enter factual reason shown in History"
                  onChange={(event) => {
                    setReason(event.target.value);
                    setPrepareKey(generateActionKey());
                  }}
                />
              </label>
            </>
          )}

          {activeAction && (
            <>
              <dl className="detail-list">
                <div className="detail-list__row">
                  <dt>Action reference</dt>
                  <dd className="mono-ref">{activeAction.reference}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Action status</dt>
                  <dd>{activeAction.status}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>Reason</dt>
                  <dd>{activeAction.reason}</dd>
                </div>
                <div className="detail-list__row">
                  <dt>
                    {activeAction.originalSaleIsReplacement
                      ? "Intermediate retained total"
                      : "Original sale total"}
                  </dt>
                  <dd>{formatCentavos(activeAction.originalTotalCentavos)}</dd>
                </div>
                {!activeAction.originalSaleIsReplacement &&
                  activeAction.originalCashReceivedCentavos !== null &&
                  activeAction.originalChangeCentavos !== null && (
                    <div className="detail-list__row">
                      <dt>Original cash tendered / change</dt>
                      <dd>
                        {formatCentavos(activeAction.originalCashReceivedCentavos)} tendered ·{" "}
                        {formatCentavos(activeAction.originalChangeCentavos)} change
                      </dd>
                    </div>
                  )}
                {activeAction.originalSaleIsReplacement &&
                  lookup?.originalSale?.cashEventChain && (
                    <>
                      <div className="detail-list__row">
                        <dt>
                          Original cash sale (
                          {lookup.originalSale.cashEventChain.rootCashSale.reference})
                        </dt>
                        <dd>
                          {formatCentavos(
                            lookup.originalSale.cashEventChain.rootCashSale.cashReceivedCentavos,
                          )}{" "}
                          tendered ·{" "}
                          {formatCentavos(
                            lookup.originalSale.cashEventChain.rootCashSale.changeCentavos,
                          )}{" "}
                          change
                        </dd>
                      </div>
                      {lookup.originalSale.cashEventChain.correctionEvents.map((ev) => (
                        <div key={ev.actionReference} className="detail-list__row">
                          <dt>Prior correction ({ev.actionReference})</dt>
                          <dd>{formatSaleActionCashExchange(ev)}</dd>
                        </div>
                      ))}
                    </>
                  )}
                <div className="detail-list__row">
                  <dt>Corrected total</dt>
                  <dd>{formatCentavos(activeAction.correctedTotalCentavos)}</dd>
                </div>
                <div className="detail-list__row detail-list__row--total">
                  <dt>Cash effect</dt>
                  <dd>
                    {activeAction.cashDirection === "REFUND"
                      ? `Refund ${formatCentavos(-activeAction.cashDifferenceCentavos)} to customer`
                      : activeAction.cashDirection === "COLLECT"
                        ? `Collect ${formatCentavos(activeAction.cashDifferenceCentavos)} from customer`
                        : "₱0.00 (no cash exchange)"}
                  </dd>
                </div>
                {activeAction.replacementSaleReference && (
                  <div className="detail-list__row">
                    <dt>Replacement sale</dt>
                    <dd className="mono-ref">{activeAction.replacementSaleReference}</dd>
                  </div>
                )}
              </dl>

              {activeAction.merchandisePlan.hasMerchandise &&
                (activeAction.merchandisePlan.items?.length ?? 0) > 0 && (
                  <div className="subview">
                    <div className="detail-card__header">
                      <h3>Stock effects</h3>
                    </div>
                    <ul className="pos-action-log">
                      {activeAction.merchandisePlan.items!.map((item) => (
                        <li key={item.productId}>
                          <strong>{item.productName}:</strong>{" "}
                          {formatSaleActionStockItemSummary(item)}
                        </li>
                      ))}
                    </ul>
                    {activeAction.merchandisePlan.requiresInventoryReview && (
                      <div className="callout callout--warning" role="status">
                        <p className="callout__title">Inventory review required</p>
                        <p className="callout__body">
                          One or more returned items had unclear physical-count coverage and were
                          not restored automatically. Complete a physical-count reconciliation in
                          Inventory.
                        </p>
                      </div>
                    )}
                  </div>
                )}

              {controlFlags?.showUncertainWarning && (
                <div className="callout callout--warning" role="alert">
                  <p className="callout__title">Status uncertain — check before moving cash</p>
                  <p className="callout__body">
                    The previous request or status check did not finish cleanly. Click{" "}
                    <strong>Check status</strong> below to confirm whether the action already saved
                    before giving or taking cash again.
                  </p>
                </div>
              )}

              {(controlFlags?.showConfirmControls || controlFlags?.showCancelNoCashControls) && (
                <div className="subview">
                  {controlFlags.showConfirmControls &&
                    Object.keys(confirmInterveningItems).length > 0 && (
                      <div className="callout callout--warning" role="alert">
                        <p className="callout__title">
                          Verify stock coverage on this pending action before finishing
                        </p>
                        {Object.values(confirmInterveningItems).map((item) => {
                          const draft = confirmCoverageDrafts[item.productId] ?? {
                            uncoveredReturnedQuantity: 0,
                            coveredByCountQuantity: 0,
                            unclearCoverageQuantity: 0,
                          };
                          const setCov = (
                            patch: Partial<{
                              countCoverage: SaleActionCountCoverage;
                              uncoveredReturnedQuantity: number;
                              coveredByCountQuantity: number;
                              unclearCoverageQuantity: number;
                            }>,
                          ) => {
                            setConfirmCoverageDrafts((prev) => ({
                              ...prev,
                              [item.productId]: {
                                ...(prev[item.productId] ?? {
                                  uncoveredReturnedQuantity: 0,
                                  coveredByCountQuantity: 0,
                                  unclearCoverageQuantity: 0,
                                }),
                                ...patch,
                              },
                            }));
                          };
                          return (
                            <div key={item.productId} className="subview">
                              <p className="callout__body">
                                <strong>{item.productName}:</strong> physical count (
                                {item.physicalCount} {item.unit}) recorded at{" "}
                                {formatManilaTimestamp(item.recordedAt)}. How did it cover{" "}
                                {item.returningQuantity} {item.unit}?
                              </p>
                              <label className="checkbox-field">
                                <input
                                  type="radio"
                                  name={`conf-cov-${item.productId}`}
                                  checked={draft.countCoverage === "COVERED_BY_COUNT"}
                                  disabled={busy}
                                  onChange={() => setCov({ countCoverage: "COVERED_BY_COUNT" })}
                                />
                                <span>Already included in physical count (+0 restored)</span>
                              </label>
                              <label className="checkbox-field">
                                <input
                                  type="radio"
                                  name={`conf-cov-${item.productId}`}
                                  checked={draft.countCoverage === "UNCOVERED"}
                                  disabled={busy}
                                  onChange={() => setCov({ countCoverage: "UNCOVERED" })}
                                />
                                <span>
                                  Verifiably missed / excluded by count (+{item.returningQuantity}{" "}
                                  restored)
                                </span>
                              </label>
                              <label className="checkbox-field">
                                <input
                                  type="radio"
                                  name={`conf-cov-${item.productId}`}
                                  checked={draft.countCoverage === "UNCLEAR"}
                                  disabled={busy}
                                  onChange={() => setCov({ countCoverage: "UNCLEAR" })}
                                />
                                <span>Unclear — review in Inventory (+0 restored)</span>
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  {controlFlags.showConfirmControls && activeAction.cashDirection === "REFUND" && (
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={cashConfirmed}
                        disabled={busy}
                        onChange={(event) => setCashConfirmed(event.target.checked)}
                      />
                      <span>
                        Confirm cash refund of {formatCentavos(-activeAction.cashDifferenceCentavos)} was
                        handed back to the customer
                      </span>
                    </label>
                  )}

                  {controlFlags.showConfirmControls && activeAction.cashDirection === "COLLECT" && (
                    <>
                      <label className="field">
                        <span className="field__label">
                          Additional cash tendered (at least{" "}
                          {formatCentavos(activeAction.cashDifferenceCentavos)})
                        </span>
                        <input
                          type="text"
                          className="input"
                          inputMode="decimal"
                          value={cashTenderInput}
                          disabled={busy}
                          placeholder="0.00"
                          onChange={(event) => {
                            setCashTenderInput(event.target.value);
                            setCashConfirmed(false);
                          }}
                        />
                      </label>
                      {collectSufficient && parsedCollectTender !== null && (
                        <p className="muted-sm">
                          Change to give:{" "}
                          {formatCentavos(parsedCollectTender - activeAction.cashDifferenceCentavos)}
                        </p>
                      )}
                      <label className="checkbox-field">
                        <input
                          type="checkbox"
                          checked={cashConfirmed}
                          disabled={busy || !collectSufficient}
                          onChange={(event) => setCashConfirmed(event.target.checked)}
                        />
                        <span>Confirm additional payment was collected from the customer</span>
                      </label>
                    </>
                  )}

                  {controlFlags.showConfirmControls && activeAction.cashDirection === "NONE" && (
                    <p className="muted-sm">
                      No cash needs to change hands. Confirm to void {activeAction.originalSaleReference}{" "}
                      and save the Active replacement on {activeAction.originalBusinessDate}.
                    </p>
                  )}

                  {!controlFlags.showConfirmControls && controlFlags.showCancelNoCashControls && (
                    <p className="muted-sm">
                      This unsaved zero-cash correction crossed Manila midnight and can no longer be
                      confirmed. Cancel it below with no cash exchanged so the day can close.
                    </p>
                  )}

                  {controlFlags.showCancelNoCashControls && (
                    <div className="cancel-unpaid-box">
                      <label className="checkbox-field">
                        <input
                          type="checkbox"
                          checked={cancelNoCashConfirmed}
                          disabled={busy}
                          onChange={(event) => setCancelNoCashConfirmed(event.target.checked)}
                        />
                        <span>
                          Cancel attempt instead — confirm no cash changed hands (original sale stays
                          Active)
                        </span>
                      </label>
                      {cancelNoCashConfirmed && (
                        <input
                          type="text"
                          className="input"
                          maxLength={240}
                          value={cancelNote}
                          disabled={busy}
                          placeholder="Optional cancellation note"
                          onChange={(event) => setCancelNote(event.target.value)}
                        />
                      )}
                      <button
                        type="button"
                        className="button button--ghost button--block"
                        disabled={!cancelNoCashConfirmed || busy}
                        onClick={() => void handleCancelActionNoCash()}
                      >
                        {cancelling
                          ? "Cancelling pending action…"
                          : "Cancel action (no cash changed hands)"}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {activeAction.status === "COMPLETED" && (
                <div className="callout callout--success">
                  <p className="callout__title">Action saved</p>
                  <p className="callout__body">
                    Completed by {activeAction.completedBy} on{" "}
                    {activeAction.completedAt ? formatManilaTimestamp(activeAction.completedAt) : ""}.
                    {activeAction.replacementSaleReference
                      ? ` Active replacement: ${activeAction.replacementSaleReference}.`
                      : ""}
                  </p>
                </div>
              )}

              {activeAction.status === "CANCELLED_NO_CASH" && (
                <div className="callout callout--neutral">
                  <p className="callout__title">Pending action cancelled (no cash)</p>
                  <p className="callout__body">
                    Cancelled by {activeAction.cancelledBy} on{" "}
                    {activeAction.cancelledAt ? formatManilaTimestamp(activeAction.cancelledAt) : ""}.{" "}
                    Original sale {activeAction.originalSaleReference} remains Active.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal__footer">
          <button type="button" className="button button--ghost" disabled={busy} onClick={onClose}>
            {activeAction?.status === "COMPLETED" || activeAction?.status === "CANCELLED_NO_CASH"
              ? "Close"
              : "Back"}
          </button>

          {!activeAction && mode !== "RECOVER_ACTION" && (
            <button
              type="button"
              className="button button--primary"
              disabled={busy || !reason.trim()}
              onClick={() => void handlePrepareAction()}
            >
              {preparing ? "Preparing durable reference…" : "Prepare action reference & preview"}
            </button>
          )}

          {activeAction && (
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              onClick={() => void loadActionStatus(activeAction.reference)}
            >
              {checking ? "Checking status…" : "Check status"}
            </button>
          )}

          {activeAction && controlFlags?.showConfirmControls && (
            <button
              type="button"
              className="button button--primary"
              disabled={
                busy ||
                (activeAction.cashDirection === "REFUND" && !cashConfirmed) ||
                (activeAction.cashDirection === "COLLECT" && (!collectSufficient || !cashConfirmed))
              }
              onClick={() => void handleConfirmAction()}
            >
              {submitting
                ? "Saving action…"
                : activeAction.cashDirection === "REFUND"
                  ? "Confirm refund & save"
                  : activeAction.cashDirection === "COLLECT"
                    ? "Confirm collection & save"
                    : "Save zero-cash correction"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
