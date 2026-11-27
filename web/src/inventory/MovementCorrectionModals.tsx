import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import {
  computeCancelMovementPreview,
  computeQuantityCorrectionPreview,
  computeReceiptItemCorrectionPreview,
  type InventoryItemView,
  type MovementCorrectionView,
  type MovementCoverageMode,
  parseMovementQuantityInput,
  type PendingCorrectionReviewView,
  QUANTITY_SCALE,
  type StockMovementView,
  type StockReconciliationView,
  formatQuantityLabel,
  formatRecordedAtManila,
  formatSignedDelta,
  getInventoryItemKey,
} from "./inventoryView";

export type MovementCorrectionModalState =
  | {
      kind: "QUANTITY";
      item: InventoryItemView;
      movement: StockMovementView;
    }
  | {
      kind: "CANCEL";
      item: InventoryItemView;
      movement: StockMovementView;
    }
  | {
      kind: "RECEIPT_ITEM";
      item: InventoryItemView;
      movement: StockMovementView;
    }
  | {
      kind: "METADATA";
      item: InventoryItemView;
      movement: StockMovementView;
    }
  | {
      kind: "RESOLVE_CORRECTION";
      review: PendingCorrectionReviewView;
    };

interface CoverageInputState {
  mode: MovementCoverageMode;
  coveredQtyInput: string;
  countSource: string;
  reviewNote: string;
}

interface CountsState {
  loading: boolean;
  error: string | null;
  reconciliations: StockReconciliationView[];
  openingCountCoversDate: boolean;
}

const EMPTY_COUNTS: CountsState = {
  loading: false,
  error: null,
  reconciliations: [],
  openingCountCoversDate: false,
};

function defaultCoverageInput(): CoverageInputState {
  return {
    mode: "NONE",
    coveredQtyInput: "",
    countSource: "",
    reviewNote: "",
  };
}

function generateCorrectionRequestKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `corr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildCoveragePayload(
  state: CoverageInputState,
  counts: CountsState,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    coverageMode: state.mode,
    expectedLatestReconciliationId: counts.reconciliations[0]?.id ?? null,
    expectedOpeningCountCoversDate: counts.openingCountCoversDate,
  };
  if (state.mode === "FULL" || state.mode === "PARTIAL") {
    if (state.countSource === "OPENING") {
      payload.coveredByOpeningCount = true;
    } else if (state.countSource) {
      payload.supportingReconciliationId = state.countSource;
    }
  }
  if (state.mode === "PARTIAL") {
    payload.coveredQuantity = Number(state.coveredQtyInput.trim());
  }
  const trimmedNote = state.reviewNote.trim().replace(/\s+/g, " ");
  if (trimmedNote) {
    payload.reviewNote = trimmedNote;
  }
  return payload;
}

function validateCoverageInput(
  state: CoverageInputState,
  counts: CountsState,
  maxMagnitude: number,
  unit: string,
  allowDecimal: boolean,
): string | null {
  const hasCounts = counts.reconciliations.length > 0 || counts.openingCountCoversDate;
  if ((state.mode === "FULL" || state.mode === "PARTIAL") && (!hasCounts || !state.countSource)) {
    return "Select the supporting physical count or opening count.";
  }
  if (state.mode === "PARTIAL") {
    const parsed = parseMovementQuantityInput(state.coveredQtyInput, unit, allowDecimal);
    if (!parsed.ok) return parsed.message;
    if (
      Math.round(parsed.quantity * QUANTITY_SCALE) >=
      Math.round(maxMagnitude * QUANTITY_SCALE)
    ) {
      return "Covered quantity must be strictly less than the full difference. Choose Full Coverage instead.";
    }
  }
  return null;
}

function sameApplicableCounts(a: CountsState, b: CountsState): boolean {
  if (a.openingCountCoversDate !== b.openingCountCoversDate) return false;
  if (a.reconciliations.length !== b.reconciliations.length) return false;
  const aIds = a.reconciliations.map((r) => r.id).sort();
  const bIds = b.reconciliations.map((r) => r.id).sort();
  return aIds.every((id, i) => id === bIds[i]);
}

function CorrectionCoverageSelector({
  title,
  item,
  counts,
  value,
  allowUnclear,
  disabled,
  onChange,
  onReconcileFirst,
}: {
  title: string;
  item: InventoryItemView;
  counts: CountsState;
  value: CoverageInputState;
  allowUnclear: boolean;
  disabled: boolean;
  onChange: (next: CoverageInputState) => void;
  onReconcileFirst?: (item: InventoryItemView) => void;
}) {
  const hasCounts = counts.reconciliations.length > 0 || counts.openingCountCoversDate;

  return (
    <fieldset className="scope-fieldset">
      <legend>{title}</legend>
      {counts.loading ? (
        <p className="muted-sm">Loading physical counts on or after this date…</p>
      ) : counts.error ? (
        <div className="alert alert--error" role="alert">
          {counts.error}
        </div>
      ) : hasCounts ? (
        <div className="callout callout--warning" role="status">
          <p className="callout__title">Applicable counts recorded on or after this date</p>
          <ul className="conflict-list">
            {counts.reconciliations.map((rec) => (
              <li key={rec.id}>
                <strong>{formatQuantityLabel(rec.physicalCount, rec.unit)}</strong> (
                {formatSignedDelta(rec.quantityDelta, rec.unit)}) on{" "}
                {formatRecordedAtManila(rec.recordedAt)} by {rec.recordedBy} — {rec.reason}
              </li>
            ))}
            {counts.openingCountCoversDate && item.openingStock && (
              <li>
                <strong>
                  Opening count:{" "}
                  {formatQuantityLabel(item.openingStock.quantity, item.openingStock.unit)}
                </strong>{" "}
                on {formatRecordedAtManila(item.openingStock.recordedAt)} by{" "}
                {item.openingStock.recordedBy}
              </li>
            )}
          </ul>
          {onReconcileFirst && (
            <div className="inventory-card-reconcile-row">
              <button
                type="button"
                className="button button--ghost button--sm"
                disabled={disabled}
                onClick={() => onReconcileFirst(item)}
              >
                Count / Reconcile {item.name} first (INV-009)
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="muted-sm">
          No physical count has been recorded for {item.name} on or after this entry date.
        </p>
      )}

      <div className="inventory-coverage-options">
        <label className="checkbox-field">
          <input
            type="radio"
            checked={value.mode === "NONE"}
            disabled={disabled}
            onChange={() =>
              onChange({ ...value, mode: "NONE", coveredQtyInput: "", countSource: "" })
            }
          />
          <span>No count covered this difference — apply full change now</span>
        </label>
        <label className="checkbox-field">
          <input
            type="radio"
            checked={value.mode === "FULL"}
            disabled={disabled || !hasCounts}
            onChange={() =>
              onChange({
                ...value,
                mode: "FULL",
                coveredQtyInput: "",
                countSource:
                  value.countSource ||
                  counts.reconciliations[0]?.id ||
                  (counts.openingCountCoversDate ? "OPENING" : ""),
              })
            }
          />
          <span>A count already covered the full difference — save history with 0 change</span>
        </label>
        <label className="checkbox-field">
          <input
            type="radio"
            checked={value.mode === "PARTIAL"}
            disabled={disabled || !hasCounts}
            onChange={() =>
              onChange({
                ...value,
                mode: "PARTIAL",
                countSource:
                  value.countSource ||
                  counts.reconciliations[0]?.id ||
                  (counts.openingCountCoversDate ? "OPENING" : ""),
              })
            }
          />
          <span>A count covered part of this difference — apply only the rest</span>
        </label>
        {allowUnclear && (
          <label className="checkbox-field">
            <input
              type="radio"
              checked={value.mode === "UNCLEAR"}
              disabled={disabled}
              onChange={() =>
                onChange({ ...value, mode: "UNCLEAR", coveredQtyInput: "", countSource: "" })
              }
            />
            <span>Unclear / verify first — keep pending with 0 stock change</span>
          </label>
        )}
      </div>

      {(value.mode === "FULL" || value.mode === "PARTIAL") && hasCounts && (
        <label className="field">
          <span>Supporting count *</span>
          <select
            disabled={disabled}
            value={value.countSource}
            onChange={(e) => onChange({ ...value, countSource: e.target.value })}
          >
            <option value="">Choose count</option>
            {counts.reconciliations.map((rec) => (
              <option key={rec.id} value={rec.id}>
                Counted {formatQuantityLabel(rec.physicalCount, rec.unit)} (
                {formatRecordedAtManila(rec.recordedAt)}) — {rec.reason}
              </option>
            ))}
            {counts.openingCountCoversDate && item.openingStock && (
              <option value="OPENING">
                Opening count (
                {formatQuantityLabel(item.openingStock.quantity, item.openingStock.unit)})
              </option>
            )}
          </select>
        </label>
      )}

      {value.mode === "PARTIAL" && (
        <label className="field">
          <span>Quantity already covered by that count ({item.unit}) *</span>
          <input
            type="text"
            inputMode={item.allowDecimalQuantity ? "decimal" : "numeric"}
            autoComplete="off"
            disabled={disabled}
            placeholder="0"
            value={value.coveredQtyInput}
            onChange={(e) => onChange({ ...value, coveredQtyInput: e.target.value })}
          />
        </label>
      )}
    </fieldset>
  );
}

export function PendingCorrectionReviewsBanner({
  reviews,
  busy,
  onResolveClick,
  onViewHistoryClick,
}: {
  reviews: PendingCorrectionReviewView[];
  busy: boolean;
  onResolveClick: (review: PendingCorrectionReviewView) => void;
  onViewHistoryClick: (item: InventoryItemView) => void;
}) {
  if (reviews.length === 0) return null;
  return (
    <section className="callout callout--warning" aria-label="Pending correction reviews">
      <p className="callout__title">Pending correction reviews ({reviews.length})</p>
      <p className="callout__body">
        Review and confirm physical-count coverage before applying these pending corrections or
        cancellations. Pending items leave stock and Dashboard Trend unchanged.
      </p>
      <ul className="conflict-list">
        {reviews.map((rev) => (
          <li key={rev.correction.id}>
            <strong>{rev.correction.correctionKind.replace("_", " ")}</strong> ·{" "}
            {rev.primaryItem.name}
            {rev.secondaryItem ? ` → ${rev.secondaryItem.name}` : ""} · Reason: “
            {rev.correction.reason}” · Recorded {formatRecordedAtManila(rev.correction.createdAt)}{" "}
            by {rev.correction.createdBy}
            <div className="inventory-card-reconcile-row">
              <button
                type="button"
                className="button button--primary button--sm"
                disabled={busy}
                onClick={() => onResolveClick(rev)}
              >
                Review &amp; Resolve Correction
              </button>
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() => onViewHistoryClick(rev.primaryItem)}
              >
                Item history
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MovementCorrectionAuditList({
  corrections,
}: {
  corrections: MovementCorrectionView[];
}) {
  if (corrections.length === 0) return null;
  return (
    <ul className="conflict-list">
      {corrections.map((corr) => (
        <li key={corr.id}>
          <strong>
            {corr.correctionKind === "QUANTITY"
              ? `Quantity corrected: ${formatQuantityLabel(corr.previousQuantity, corr.primaryItemUnit)} → ${formatQuantityLabel(corr.newQuantity, corr.primaryItemUnit)}`
              : corr.correctionKind === "CANCEL"
                ? `Entry cancelled (was ${formatQuantityLabel(corr.previousQuantity, corr.primaryItemUnit)})`
                : corr.correctionKind === "RECEIPT_ITEM"
                  ? `Receipt item corrected: ${corr.previousItemName ?? corr.primaryItemName} (${corr.previousUnit ?? corr.primaryItemUnit}) → ${corr.newItemName ?? corr.secondaryItemName ?? "New item"} (${corr.newUnit ?? corr.secondaryItemUnit ?? ""})`
                  : `Entry date/note updated`}
          </strong>{" "}
          · [{corr.status === "PENDING_REVIEW" ? "Pending Owner Review" : "Applied"}] · By{" "}
          {corr.createdBy} ({formatRecordedAtManila(corr.createdAt)}) · Reason: {corr.reason}
          {corr.correctionKind === "METADATA" &&
            corr.previousEffectiveDate !== corr.newEffectiveDate && (
              <span>
                {" "}
                · Date: {corr.previousEffectiveDate} → {corr.newEffectiveDate}
              </span>
            )}
          {corr.correctionKind === "METADATA" && corr.previousNote !== corr.newNote && (
            <span>
              {" "}
              · Note: “{corr.previousNote ?? "—"}” → “{corr.newNote ?? "—"}”
            </span>
          )}
          {corr.status === "APPLIED" && (
            <span>
              {" "}
              · Stock effect ({corr.primaryItemName}):{" "}
              {corr.primaryAppliedDelta === 0
                ? "0"
                : formatSignedDelta(corr.primaryAppliedDelta, corr.primaryItemUnit)}
              {corr.primarySupportingReconciliation
                ? ` (count ${formatQuantityLabel(
                    corr.primarySupportingReconciliation.physicalCount,
                    corr.primarySupportingReconciliation.unit,
                  )})`
                : ""}
              {corr.secondaryItemName
                ? ` · ${corr.secondaryItemName}: ${
                    corr.secondaryAppliedDelta === 0
                      ? "0"
                      : formatSignedDelta(
                          corr.secondaryAppliedDelta,
                          corr.secondaryItemUnit ?? "",
                        )
                  }${
                    corr.secondarySupportingReconciliation
                      ? ` (count ${formatQuantityLabel(
                          corr.secondarySupportingReconciliation.physicalCount,
                          corr.secondarySupportingReconciliation.unit,
                        )})`
                      : ""
                  }`
                : ""}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MovementCorrectionDialog({
  modal,
  items,
  todayManila,
  onClose,
  onReconcileItem,
  onRecordWrongSupplyUsage,
  onSuccess,
}: {
  modal: MovementCorrectionModalState;
  items: InventoryItemView[];
  todayManila: string;
  onClose: () => void;
  onReconcileItem: (item: InventoryItemView) => void;
  onRecordWrongSupplyUsage: (suggestedDate: string | null) => void;
  onSuccess: (payload: {
    primaryItem: InventoryItemView;
    secondaryItem: InventoryItemView | null;
    movement: StockMovementView;
    correction: MovementCorrectionView;
    title: string;
    body: string;
  }) => void;
}) {
  const initialPrimaryItem =
    modal.kind === "RESOLVE_CORRECTION" ? modal.review.primaryItem : modal.item;
  const initialMovement =
    modal.kind === "RESOLVE_CORRECTION" ? modal.review.movement : modal.movement;

  const [primaryItemState, setPrimaryItemState] = useState<InventoryItemView>(initialPrimaryItem);
  const [secondaryItemState, setSecondaryItemState] = useState<InventoryItemView | null>(
    modal.kind === "RESOLVE_CORRECTION" ? modal.review.secondaryItem : null,
  );
  const [movementState, setMovementState] = useState<StockMovementView>(initialMovement);

  const currentQtyValue =
    movementState.currentQuantityValue ??
    movementState.enteredQuantity ??
    movementState.quantity;
  const entryEffectiveDate =
    movementState.currentEffectiveDate ??
    movementState.effectiveDate ??
    todayManila;
  const entryNote = movementState.currentNote ?? movementState.note ?? "";

  const [qtyInput, setQtyInput] = useState(String(currentQtyValue));
  const [reasonInput, setReasonInput] = useState("");
  const [selectedNewItemKey, setSelectedNewItemKey] = useState("");
  const [metaDateInput, setMetaDateInput] = useState(entryEffectiveDate);
  const [metaNoteInput, setMetaNoteInput] = useState(entryNote);

  const [primaryCov, setPrimaryCov] = useState<CoverageInputState>(defaultCoverageInput);
  const [secondaryCov, setSecondaryCov] = useState<CoverageInputState>(defaultCoverageInput);
  const [diffUnitPrimaryRecId, setDiffUnitPrimaryRecId] = useState("");
  const [diffUnitSecondaryRecId, setDiffUnitSecondaryRecId] = useState("");

  const [primaryCounts, setPrimaryCounts] = useState<CountsState>(() =>
    modal.kind === "RESOLVE_CORRECTION"
      ? {
          loading: false,
          error: null,
          reconciliations: modal.review.primaryApplicableReconciliations,
          openingCountCoversDate: modal.review.primaryOpeningCountCoversDate,
        }
      : EMPTY_COUNTS,
  );
  const [oldDateCounts, setOldDateCounts] = useState<CountsState>(EMPTY_COUNTS);
  const [secondaryCounts, setSecondaryCounts] = useState<CountsState>(() =>
    modal.kind === "RESOLVE_CORRECTION"
      ? {
          loading: false,
          error: null,
          reconciliations: modal.review.secondaryApplicableReconciliations,
          openingCountCoversDate: modal.review.secondaryOpeningCountCoversDate,
        }
      : EMPTY_COUNTS,
  );

  const [requestKey, setRequestKey] = useState(generateCorrectionRequestKey);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [wrongSupplyCancelledDate, setWrongSupplyCancelledDate] = useState<string | null>(null);

  const loadCountsFor = useCallback(
    async (
      targetItem: InventoryItemView,
      sinceDate: string,
      setter: (next: CountsState) => void,
    ) => {
      const endpointKey = targetItem.shape ?? targetItem.id ?? targetItem.code;
      setter({ loading: true, error: null, reconciliations: [], openingCountCoversDate: false });
      try {
        const res = await api<{
          reconciliations: StockReconciliationView[];
          openingCountCoversDate: boolean;
        }>(
          `/api/inventory/items/${encodeURIComponent(endpointKey)}/reconciliations?sinceDate=${encodeURIComponent(sinceDate)}`,
        );
        setter({
          loading: false,
          error: null,
          reconciliations: res.reconciliations,
          openingCountCoversDate: res.openingCountCoversDate,
        });
      } catch (err) {
        setter({
          loading: false,
          error: err instanceof ApiError ? err.message : "Could not load physical counts.",
          reconciliations: [],
          openingCountCoversDate: false,
        });
      }
    },
    [],
  );

  useEffect(() => {
    if (modal.kind === "RESOLVE_CORRECTION") return;
    if (modal.kind === "CANCEL" && movementState.entryStatus === "PENDING_REVIEW") return;
    const sinceDate = modal.kind === "METADATA" ? metaDateInput : entryEffectiveDate;
    if (!sinceDate) return;
    void loadCountsFor(primaryItemState, sinceDate, setPrimaryCounts);
    if (modal.kind === "METADATA") {
      void loadCountsFor(primaryItemState, entryEffectiveDate, setOldDateCounts);
    }
  }, [modal.kind, primaryItemState, entryEffectiveDate, metaDateInput, movementState.entryStatus, loadCountsFor]);

  const destinationItem =
    modal.kind === "RECEIPT_ITEM"
      ? (items.find((i) => (i.shape ?? i.id ?? i.code) === selectedNewItemKey) ?? null)
      : secondaryItemState;

  useEffect(() => {
    if (modal.kind === "RECEIPT_ITEM" && destinationItem) {
      void loadCountsFor(destinationItem, entryEffectiveDate, setSecondaryCounts);
    }
  }, [modal.kind, destinationItem, entryEffectiveDate, loadCountsFor]);

  const eligibleReceiptTargets = items.filter(
    (candidate) =>
      candidate.status === "INITIALIZED" &&
      !candidate.archivedAt &&
      getInventoryItemKey(candidate) !== getInventoryItemKey(primaryItemState),
  );

  const parsedNewQty =
    modal.kind === "QUANTITY"
      ? parseMovementQuantityInput(
          qtyInput,
          primaryItemState.unit,
          Boolean(primaryItemState.allowDecimalQuantity),
        )
      : null;
  const parsedCovPrimary =
    primaryCov.mode === "PARTIAL"
      ? parseMovementQuantityInput(
          primaryCov.coveredQtyInput,
          primaryItemState.unit,
          Boolean(primaryItemState.allowDecimalQuantity),
        )
      : null;
  const parsedCovSecondary =
    secondaryCov.mode === "PARTIAL" && destinationItem
      ? parseMovementQuantityInput(
          secondaryCov.coveredQtyInput,
          destinationItem.unit,
          Boolean(destinationItem.allowDecimalQuantity),
        )
      : null;

  const qtyPreview =
    modal.kind === "QUANTITY" &&
    parsedNewQty?.ok &&
    (movementState.movementType === "STOCK_RECEIVED" ||
      movementState.movementType === "STOCK_USED")
      ? computeQuantityCorrectionPreview({
          movementType: movementState.movementType,
          previousQuantity: currentQtyValue,
          newQuantity: parsedNewQty.quantity,
          currentBalance: primaryItemState.currentQuantity,
          category: primaryItemState.category,
          coverageMode: primaryCov.mode,
          coveredQuantity: parsedCovPrimary?.ok ? parsedCovPrimary.quantity : undefined,
        })
      : null;

  const cancelPreview =
    modal.kind === "CANCEL" &&
    (movementState.movementType === "STOCK_RECEIVED" ||
      movementState.movementType === "STOCK_USED")
      ? computeCancelMovementPreview({
          movementType: movementState.movementType,
          entryStatus: movementState.entryStatus ?? "APPLIED",
          latestQuantity: currentQtyValue,
          currentBalance: primaryItemState.currentQuantity,
          category: primaryItemState.category,
          coverageMode: primaryCov.mode,
          coveredQuantity: parsedCovPrimary?.ok ? parsedCovPrimary.quantity : undefined,
        })
      : null;

  const receiptItemPreview =
    modal.kind === "RECEIPT_ITEM" && destinationItem
      ? computeReceiptItemCorrectionPreview({
          quantity: currentQtyValue,
          wrongItem: primaryItemState,
          correctItem: destinationItem,
          wrongCoverageMode: primaryCov.mode,
          wrongCoveredQuantity: parsedCovPrimary?.ok ? parsedCovPrimary.quantity : undefined,
          correctCoverageMode: secondaryCov.mode,
          correctCoveredQuantity: parsedCovSecondary?.ok ? parsedCovSecondary.quantity : undefined,
        })
      : null;

  const dateCrossedCounts =
    modal.kind === "METADATA" &&
    metaDateInput !== entryEffectiveDate &&
    !sameApplicableCounts(oldDateCounts, primaryCounts);

  function handleStaleApiError(err: ApiError): boolean {
    if (err.code === "STALE_REVIEW_CONTEXT") {
      const pItem = (err.details?.primaryItem ?? err.details?.item) as
        | InventoryItemView
        | undefined;
      const sItem = err.details?.secondaryItem as InventoryItemView | undefined;
      const pRecs = (err.details?.primaryApplicableReconciliations ??
        err.details?.applicableReconciliations) as StockReconciliationView[] | undefined;
      const pOpen = (err.details?.primaryOpeningCountCoversDate ??
        err.details?.openingCountCoversDate) as boolean | undefined;
      const sRecs = err.details?.secondaryApplicableReconciliations as
        | StockReconciliationView[]
        | undefined;
      const sOpen = err.details?.secondaryOpeningCountCoversDate as boolean | undefined;
      if (pItem) setPrimaryItemState(pItem);
      if (sItem) setSecondaryItemState(sItem);
      if (pRecs) {
        setPrimaryCounts({
          loading: false,
          error: null,
          reconciliations: pRecs,
          openingCountCoversDate: Boolean(pOpen),
        });
      }
      if (sRecs) {
        setSecondaryCounts({
          loading: false,
          error: null,
          reconciliations: sRecs,
          openingCountCoversDate: Boolean(sOpen),
        });
      }
      setPrimaryCov(defaultCoverageInput());
      setSecondaryCov(defaultCoverageInput());
      setRequestKey(generateCorrectionRequestKey());
      setStaleNotice(err.message);
      setError(null);
      return true;
    }
    if (err.code === "STALE_STOCK_BALANCE" || err.code === "STALE_MOVEMENT") {
      const pItem = (err.details?.primaryItem ?? err.details?.item) as
        | InventoryItemView
        | undefined;
      const sItem = err.details?.secondaryItem as InventoryItemView | undefined;
      const mov = err.details?.movement as StockMovementView | undefined;
      if (pItem) setPrimaryItemState(pItem);
      if (sItem) setSecondaryItemState(sItem);
      if (mov) setMovementState(mov);
      setRequestKey(generateCorrectionRequestKey());
      setStaleNotice(err.message);
      setError(null);
      return true;
    }
    return false;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setStaleNotice(null);

    try {
      setSubmitting(true);

      if (modal.kind === "QUANTITY") {
        if (!parsedNewQty?.ok) {
          setError(parsedNewQty ? parsedNewQty.message : "Enter a valid quantity.");
          return;
        }
        const trimmedReason = reasonInput.trim().replace(/\s+/g, " ");
        if (!trimmedReason) {
          setError("Enter a factual reason for this correction.");
          return;
        }
        const rawMag = Math.abs(parsedNewQty.quantity - currentQtyValue);
        const covErr = validateCoverageInput(
          primaryCov,
          primaryCounts,
          rawMag,
          primaryItemState.unit,
          Boolean(primaryItemState.allowDecimalQuantity),
        );
        if (covErr) {
          setError(covErr);
          return;
        }
        const res = await api<{
          primaryItem: InventoryItemView;
          secondaryItem: InventoryItemView | null;
          movement: StockMovementView;
          correction: MovementCorrectionView;
        }>(`/api/inventory/movements/${encodeURIComponent(movementState.id)}/correct-quantity`, {
          method: "POST",
          body: {
            newQuantity: parsedNewQty.quantity,
            reason: trimmedReason,
            expectedCorrectionVersion: movementState.correctionVersion ?? 0,
            expectedRevision: primaryItemState.stockRevision ?? 0,
            expectedCurrentQuantity: primaryItemState.currentQuantity ?? 0,
            requestKey,
            ...buildCoveragePayload(primaryCov, primaryCounts),
          },
        });
        onSuccess({
          ...res,
          title:
            res.correction.status === "PENDING_REVIEW"
              ? "Quantity correction saved for review"
              : "Quantity corrected",
          body:
            res.correction.status === "PENDING_REVIEW"
              ? `Saved pending correction for ${res.primaryItem.name} with 0 stock change until count coverage is confirmed.`
              : `Updated ${res.primaryItem.name} entry to ${formatQuantityLabel(res.correction.newQuantity, res.primaryItem.unit)}. Balance: ${formatQuantityLabel(res.primaryItem.currentQuantity, res.primaryItem.unit)}.`,
        });
        return;
      }

      if (modal.kind === "CANCEL") {
        const trimmedReason = reasonInput.trim().replace(/\s+/g, " ");
        if (!trimmedReason) {
          setError("Enter a factual reason for cancelling this entry.");
          return;
        }
        if (movementState.entryStatus !== "PENDING_REVIEW") {
          const covErr = validateCoverageInput(
            primaryCov,
            primaryCounts,
            currentQtyValue,
            primaryItemState.unit,
            Boolean(primaryItemState.allowDecimalQuantity),
          );
          if (covErr) {
            setError(covErr);
            return;
          }
        }
        const res = await api<{
          primaryItem: InventoryItemView;
          secondaryItem: InventoryItemView | null;
          movement: StockMovementView;
          correction: MovementCorrectionView;
        }>(`/api/inventory/movements/${encodeURIComponent(movementState.id)}/cancel`, {
          method: "POST",
          body: {
            reason: trimmedReason,
            expectedCorrectionVersion: movementState.correctionVersion ?? 0,
            expectedRevision: primaryItemState.stockRevision ?? 0,
            expectedCurrentQuantity: primaryItemState.currentQuantity ?? 0,
            requestKey,
            ...buildCoveragePayload(primaryCov, primaryCounts),
          },
        });
        if (
          movementState.movementType === "STOCK_USED" &&
          res.correction.status === "APPLIED"
        ) {
          setWrongSupplyCancelledDate(entryEffectiveDate);
        }
        onSuccess({
          ...res,
          title:
            res.correction.status === "PENDING_REVIEW"
              ? "Cancellation saved for review"
              : "Entry cancelled",
          body: `Cancelled ${primaryItemState.name} entry. Current balance: ${formatQuantityLabel(res.primaryItem.currentQuantity, res.primaryItem.unit)}.`,
        });
        return;
      }

      if (modal.kind === "RECEIPT_ITEM") {
        if (!destinationItem || !receiptItemPreview) {
          setError("Choose a valid destination Inventory item.");
          return;
        }
        const trimmedReason = reasonInput.trim().replace(/\s+/g, " ");
        if (!trimmedReason) {
          setError("Enter a factual reason for switching the receipt item.");
          return;
        }
        const destKey = destinationItem.shape ?? destinationItem.id ?? destinationItem.code;
        const body: Record<string, unknown> = {
          newItemKey: destKey,
          reason: trimmedReason,
          expectedCorrectionVersion: movementState.correctionVersion ?? 0,
          expectedPrimaryRevision: primaryItemState.stockRevision ?? 0,
          expectedPrimaryQuantity: primaryItemState.currentQuantity ?? 0,
          expectedSecondaryRevision: destinationItem.stockRevision ?? 0,
          expectedSecondaryQuantity: destinationItem.currentQuantity ?? 0,
          requestKey,
        };
        if (receiptItemPreview.kind === "DIFFERENT_UNITS") {
          if (!diffUnitPrimaryRecId || !diffUnitSecondaryRecId) {
            setError(
              "Count and reconcile both items in their own units first, then select both supporting counts.",
            );
            return;
          }
          body.differentUnitReconciliation = {
            primarySupportingReconciliationId: diffUnitPrimaryRecId,
            secondarySupportingReconciliationId: diffUnitSecondaryRecId,
          };
        } else {
          const pErr = validateCoverageInput(
            primaryCov,
            primaryCounts,
            currentQtyValue,
            primaryItemState.unit,
            Boolean(primaryItemState.allowDecimalQuantity),
          );
          if (pErr) {
            setError(`${primaryItemState.name}: ${pErr}`);
            return;
          }
          const sErr = validateCoverageInput(
            secondaryCov,
            secondaryCounts,
            currentQtyValue,
            destinationItem.unit,
            Boolean(destinationItem.allowDecimalQuantity),
          );
          if (sErr) {
            setError(`${destinationItem.name}: ${sErr}`);
            return;
          }
          body.primaryCoverage = buildCoveragePayload(primaryCov, primaryCounts);
          body.secondaryCoverage = buildCoveragePayload(secondaryCov, secondaryCounts);
        }
        const res = await api<{
          primaryItem: InventoryItemView;
          secondaryItem: InventoryItemView | null;
          movement: StockMovementView;
          correction: MovementCorrectionView;
        }>(`/api/inventory/movements/${encodeURIComponent(movementState.id)}/correct-item`, {
          method: "POST",
          body,
        });
        onSuccess({
          ...res,
          title:
            res.correction.status === "PENDING_REVIEW"
              ? "Receipt item correction pending review"
              : "Receipt item corrected",
          body: `Updated receipt from ${res.primaryItem.name} to ${res.secondaryItem?.name ?? destinationItem.name}.`,
        });
        return;
      }

      if (modal.kind === "METADATA") {
        const trimmedReason = reasonInput.trim().replace(/\s+/g, " ");
        if (!trimmedReason) {
          setError("Enter a factual reason for this correction.");
          return;
        }
        const trimmedNote = metaNoteInput.trim().replace(/\s+/g, " ");
        if (movementState.movementType === "STOCK_USED" && !trimmedNote) {
          setError("Enter a short purpose note for Stock Used (1 to 240 characters).");
          return;
        }
        if (metaDateInput === entryEffectiveDate && trimmedNote === entryNote) {
          setError("Change the actual date or note/purpose before saving.");
          return;
        }
        if (dateCrossedCounts) {
          const covErr = validateCoverageInput(
            primaryCov,
            primaryCounts,
            currentQtyValue,
            primaryItemState.unit,
            Boolean(primaryItemState.allowDecimalQuantity),
          );
          if (covErr) {
            setError(covErr);
            return;
          }
        }
        const body: Record<string, unknown> = {
          effectiveDate: metaDateInput,
          note: trimmedNote || null,
          reason: trimmedReason,
          expectedCorrectionVersion: movementState.correctionVersion ?? 0,
          expectedRevision: primaryItemState.stockRevision ?? 0,
          expectedCurrentQuantity: primaryItemState.currentQuantity ?? 0,
          requestKey,
          ...(dateCrossedCounts ? buildCoveragePayload(primaryCov, primaryCounts) : {}),
        };
        const res = await api<{
          primaryItem: InventoryItemView;
          secondaryItem: InventoryItemView | null;
          movement: StockMovementView;
          correction: MovementCorrectionView;
        }>(`/api/inventory/movements/${encodeURIComponent(movementState.id)}/correct-metadata`, {
          method: "POST",
          body,
        });
        onSuccess({
          ...res,
          title:
            res.correction.status === "PENDING_REVIEW"
              ? "Date correction pending count review"
              : "Date / note corrected",
          body:
            res.correction.status === "PENDING_REVIEW"
              ? "Because the corrected date crosses a physical count, it stays pending with 0 stock change until reviewed."
              : `Updated ${res.primaryItem.name} entry details.`,
        });
        return;
      }

      if (modal.kind === "RESOLVE_CORRECTION") {
        const corr = modal.review.correction;
        const pErr = validateCoverageInput(
          primaryCov,
          primaryCounts,
          Math.abs(corr.primaryRawDelta) || currentQtyValue,
          primaryItemState.unit,
          Boolean(primaryItemState.allowDecimalQuantity),
        );
        if (pErr) {
          setError(pErr);
          return;
        }
        const body: Record<string, unknown> = {
          expectedPrimaryRevision: primaryItemState.stockRevision ?? 0,
          expectedPrimaryQuantity: primaryItemState.currentQuantity ?? 0,
          requestKey,
          primaryCoverage: buildCoveragePayload(primaryCov, primaryCounts),
        };
        if (secondaryItemState) {
          const sErr = validateCoverageInput(
            secondaryCov,
            secondaryCounts,
            Math.abs(corr.secondaryRawDelta) || currentQtyValue,
            secondaryItemState.unit,
            Boolean(secondaryItemState.allowDecimalQuantity),
          );
          if (sErr) {
            setError(`${secondaryItemState.name}: ${sErr}`);
            return;
          }
          body.expectedSecondaryRevision = secondaryItemState.stockRevision ?? 0;
          body.expectedSecondaryQuantity = secondaryItemState.currentQuantity ?? 0;
          body.secondaryCoverage = buildCoveragePayload(secondaryCov, secondaryCounts);
        }
        const res = await api<{
          primaryItem: InventoryItemView;
          secondaryItem: InventoryItemView | null;
          movement: StockMovementView;
          correction: MovementCorrectionView;
        }>(`/api/inventory/movement-corrections/${encodeURIComponent(corr.id)}/resolve`, {
          method: "POST",
          body,
        });
        onSuccess({
          ...res,
          title: "Pending correction resolved",
          body: `Applied correction for ${res.primaryItem.name}. Current balance: ${formatQuantityLabel(res.primaryItem.currentQuantity, res.primaryItem.unit)}.`,
        });
      }
    } catch (err) {
      if (err instanceof ApiError && handleStaleApiError(err)) {
        return;
      }
      setError(err instanceof ApiError ? err.message : "Could not save correction. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal modal--wide" role="dialog" aria-modal="true">
        <div className="detail-card__header">
          <div>
            <h2>
              {modal.kind === "QUANTITY"
                ? `Correct Quantity · ${primaryItemState.name}`
                : modal.kind === "CANCEL"
                  ? `Cancel Entry · ${primaryItemState.name}`
                  : modal.kind === "RECEIPT_ITEM"
                    ? `Switch Receipt Item · ${primaryItemState.name}`
                    : modal.kind === "METADATA"
                      ? `Edit Date / Note · ${primaryItemState.name}`
                      : `Review Pending Correction · ${primaryItemState.name}`}
            </h2>
            <p className="muted-sm">
              Original: {formatQuantityLabel(movementState.quantity, movementState.unit)} on{" "}
              {movementState.effectiveDate ?? entryEffectiveDate} · Current:{" "}
              {formatQuantityLabel(currentQtyValue, primaryItemState.unit)} (actual date{" "}
              {entryEffectiveDate})
            </p>
          </div>
        </div>

        {staleNotice && (
          <div className="callout callout--warning" role="alert">
            <p className="callout__title">Stock balance or counts changed</p>
            <p className="callout__body">{staleNotice}</p>
          </div>
        )}

        {wrongSupplyCancelledDate && (
          <div className="callout callout--success" role="status">
            <p className="callout__title">Wrong-supply entry cancelled</p>
            <p className="callout__body">
              To record usage against the correct supply, open Stock Used on that supply with
              actual date {wrongSupplyCancelledDate}.
            </p>
            <div className="inventory-card-reconcile-row">
              <button
                type="button"
                className="button button--primary button--sm"
                onClick={() => onRecordWrongSupplyUsage(wrongSupplyCancelledDate)}
              >
                Choose correct supply &amp; record Stock Used
              </button>
            </div>
          </div>
        )}

        <form className="subview" onSubmit={(e) => void handleSubmit(e)} noValidate>
          {modal.kind === "QUANTITY" && (
            <label className="field">
              <span>New quantity ({primaryItemState.unit}) *</span>
              <input
                type="text"
                inputMode={primaryItemState.allowDecimalQuantity ? "decimal" : "numeric"}
                disabled={submitting}
                value={qtyInput}
                onChange={(e) => {
                  setQtyInput(e.target.value);
                  setRequestKey(generateCorrectionRequestKey());
                }}
              />
            </label>
          )}

          {modal.kind === "RECEIPT_ITEM" && (
            <label className="field">
              <span>Correct Inventory item *</span>
              <select
                disabled={submitting}
                value={selectedNewItemKey}
                onChange={(e) => {
                  setSelectedNewItemKey(e.target.value);
                  setPrimaryCov(defaultCoverageInput());
                  setSecondaryCov(defaultCoverageInput());
                  setDiffUnitPrimaryRecId("");
                  setDiffUnitSecondaryRecId("");
                  setRequestKey(generateCorrectionRequestKey());
                }}
              >
                <option value="">Choose correct item</option>
                {eligibleReceiptTargets.map((candidate) => (
                  <option key={getInventoryItemKey(candidate)} value={getInventoryItemKey(candidate)}>
                    {candidate.name} ({candidate.unit} · current{" "}
                    {formatQuantityLabel(candidate.currentQuantity, candidate.unit)})
                  </option>
                ))}
              </select>
            </label>
          )}

          {modal.kind === "METADATA" && (
            <>
              <label className="field">
                <span>Actual date *</span>
                <input
                  type="date"
                  max={todayManila}
                  disabled={submitting}
                  value={metaDateInput}
                  onChange={(e) => {
                    setMetaDateInput(e.target.value);
                    setPrimaryCov(defaultCoverageInput());
                    setRequestKey(generateCorrectionRequestKey());
                  }}
                />
              </label>
              <label className="field">
                <span>
                  {movementState.movementType === "STOCK_USED" ? "Purpose *" : "Delivery note"}
                </span>
                <input
                  type="text"
                  maxLength={240}
                  disabled={submitting}
                  value={metaNoteInput}
                  onChange={(e) => {
                    setMetaNoteInput(e.target.value);
                    setRequestKey(generateCorrectionRequestKey());
                  }}
                />
              </label>
              {!dateCrossedCounts && (
                <p className="muted-sm">
                  No change to applicable physical counts — saves history with 0 stock change.
                </p>
              )}
            </>
          )}

          {modal.kind !== "RESOLVE_CORRECTION" && (
            <label className="field">
              <span>Reason for correction / cancellation *</span>
              <input
                type="text"
                maxLength={240}
                disabled={submitting}
                placeholder="Required factual reason"
                value={reasonInput}
                onChange={(e) => {
                  setReasonInput(e.target.value);
                  setRequestKey(generateCorrectionRequestKey());
                }}
              />
            </label>
          )}

          {(modal.kind === "QUANTITY" ||
            (modal.kind === "CANCEL" && movementState.entryStatus !== "PENDING_REVIEW") ||
            (modal.kind === "METADATA" && dateCrossedCounts) ||
            modal.kind === "RESOLVE_CORRECTION") && (
            <CorrectionCoverageSelector
              title={`Count coverage · ${primaryItemState.name}`}
              item={primaryItemState}
              counts={primaryCounts}
              value={primaryCov}
              allowUnclear={modal.kind !== "RESOLVE_CORRECTION"}
              disabled={submitting}
              onChange={(next) => {
                setPrimaryCov(next);
                setRequestKey(generateCorrectionRequestKey());
              }}
              onReconcileFirst={onReconcileItem}
            />
          )}

          {modal.kind === "RECEIPT_ITEM" && destinationItem && receiptItemPreview?.kind === "SAME_UNIT" && (
            <>
              <CorrectionCoverageSelector
                title={`1. Wrong item (${primaryItemState.name}, removing ${formatQuantityLabel(currentQtyValue, primaryItemState.unit)})`}
                item={primaryItemState}
                counts={primaryCounts}
                value={primaryCov}
                allowUnclear={true}
                disabled={submitting}
                onChange={(next) => {
                  setPrimaryCov(next);
                  setRequestKey(generateCorrectionRequestKey());
                }}
                onReconcileFirst={onReconcileItem}
              />
              <CorrectionCoverageSelector
                title={`2. Correct item (${destinationItem.name}, adding ${formatQuantityLabel(currentQtyValue, destinationItem.unit)})`}
                item={destinationItem}
                counts={secondaryCounts}
                value={secondaryCov}
                allowUnclear={true}
                disabled={submitting}
                onChange={(next) => {
                  setSecondaryCov(next);
                  setRequestKey(generateCorrectionRequestKey());
                }}
                onReconcileFirst={onReconcileItem}
              />
            </>
          )}

          {modal.kind === "RECEIPT_ITEM" &&
            destinationItem &&
            receiptItemPreview?.kind === "DIFFERENT_UNITS" && (
              <div className="callout callout--warning" role="status">
                <p className="callout__title">Different stock units ({receiptItemPreview.wrongUnit} vs {receiptItemPreview.correctUnit})</p>
                <p className="callout__body">
                  Count and reconcile both items in their own units first (INV-036), then select
                  both supporting physical counts to save the receipt correction with zero further
                  stock change.
                </p>
                <div className="inventory-card-reconcile-row">
                  <button
                    type="button"
                    className="button button--ghost button--sm"
                    onClick={() => onReconcileItem(primaryItemState)}
                  >
                    Reconcile {primaryItemState.name} ({primaryItemState.unit})
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--sm"
                    onClick={() => onReconcileItem(destinationItem)}
                  >
                    Reconcile {destinationItem.name} ({destinationItem.unit})
                  </button>
                </div>
                <label className="field">
                  <span>{primaryItemState.name} reconciliation *</span>
                  <select
                    value={diffUnitPrimaryRecId}
                    onChange={(e) => setDiffUnitPrimaryRecId(e.target.value)}
                  >
                    <option value="">Choose physical count</option>
                    {primaryCounts.reconciliations.map((rec) => (
                      <option key={rec.id} value={rec.id}>
                        Counted {formatQuantityLabel(rec.physicalCount, rec.unit)} (
                        {formatRecordedAtManila(rec.recordedAt)}) — {rec.reason}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{destinationItem.name} reconciliation *</span>
                  <select
                    value={diffUnitSecondaryRecId}
                    onChange={(e) => setDiffUnitSecondaryRecId(e.target.value)}
                  >
                    <option value="">Choose physical count</option>
                    {secondaryCounts.reconciliations.map((rec) => (
                      <option key={rec.id} value={rec.id}>
                        Counted {formatQuantityLabel(rec.physicalCount, rec.unit)} (
                        {formatRecordedAtManila(rec.recordedAt)}) — {rec.reason}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

          {modal.kind === "RESOLVE_CORRECTION" && secondaryItemState && (
            <CorrectionCoverageSelector
              title={`Count coverage · ${secondaryItemState.name}`}
              item={secondaryItemState}
              counts={secondaryCounts}
              value={secondaryCov}
              allowUnclear={false}
              disabled={submitting}
              onChange={(next) => {
                setSecondaryCov(next);
                setRequestKey(generateCorrectionRequestKey());
              }}
              onReconcileFirst={onReconcileItem}
            />
          )}

          {(qtyPreview || cancelPreview || (receiptItemPreview && receiptItemPreview.kind === "SAME_UNIT")) && (
            <div className="preview-protected">
              {(qtyPreview || cancelPreview) && (() => {
                const pv = qtyPreview ?? cancelPreview!;
                return (
                  <dl className="detail-list">
                    <div className="detail-list__row">
                      <dt>Outstanding stock effect</dt>
                      <dd>
                        <strong>
                          {pv.pendingReview
                            ? "Pending Review (0 stock change now)"
                            : pv.appliedDelta === 0
                              ? `0 ${primaryItemState.unit} (history only)`
                              : formatSignedDelta(pv.appliedDelta, primaryItemState.unit)}
                        </strong>
                      </dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>Projected balance</dt>
                      <dd>{formatQuantityLabel(pv.projectedBalance, primaryItemState.unit)}</dd>
                    </div>
                  </dl>
                );
              })()}
              {receiptItemPreview?.kind === "SAME_UNIT" && destinationItem && (
                <dl className="detail-list">
                  <div className="detail-list__row">
                    <dt>{primaryItemState.name} effect</dt>
                    <dd>
                      {receiptItemPreview.pendingReview
                        ? "Pending Review (0 now)"
                        : `${formatSignedDelta(receiptItemPreview.wrongSide.appliedDelta, primaryItemState.unit)} → ${formatQuantityLabel(receiptItemPreview.wrongSide.projectedBalance, primaryItemState.unit)}`}
                    </dd>
                  </div>
                  <div className="detail-list__row">
                    <dt>{destinationItem.name} effect</dt>
                    <dd>
                      {receiptItemPreview.pendingReview
                        ? "Pending Review (0 now)"
                        : `${formatSignedDelta(receiptItemPreview.correctSide.appliedDelta, destinationItem.unit)} → ${formatQuantityLabel(receiptItemPreview.correctSide.projectedBalance, destinationItem.unit)}`}
                    </dd>
                  </div>
                </dl>
              )}
              {((qtyPreview ?? cancelPreview)?.requiresCountBeforeNegative ||
                (receiptItemPreview?.kind === "SAME_UNIT" &&
                  receiptItemPreview.requiresCountBeforeNegative)) && (
                <div className="alert alert--error" role="alert">
                  This change would make {primaryItemState.name} negative. Count and reconcile{" "}
                  {primaryItemState.name} first (INV-009).
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="alert alert--error" role="alert">
              {error}
            </div>
          )}

          <div className="modal__actions">
            <button
              type="button"
              className="button button--ghost"
              disabled={submitting}
              onClick={onClose}
            >
              Close
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={submitting}
            >
              {submitting ? "Saving…" : "Confirm"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
