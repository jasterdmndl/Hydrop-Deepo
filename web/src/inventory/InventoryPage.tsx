import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useSignedInUser } from "../auth/AuthContext";
import { createRequestTracker } from "../calendar/calendarView";
import { AppShell, useModulesData } from "../ChooseModule";
import {
  nextNoticeId,
  type NoticeDuration,
  type NoticeEnvelope,
  wrapNotice,
} from "../notifications/noticeTiming";
import { TemporaryNotice } from "../notifications/TemporaryNotice";
import {
  computeReconciliationPreview,
  type ContainerShape,
  DEFAULT_POS_SECTIONS,
  type FaucetReportingType,
  filterInventoryItems,
  formatAlreadySetNotice,
  formatCentavosInputValue,
  formatFaucetReportingTypeLabel,
  formatPesoCentavos,
  formatQuantityLabel,
  formatQuantityNumber,
  formatRecordedAtManila,
  formatSignedDelta,
  getContainerPackageSummary,
  getContainerSubtitle,
  getInventoryItemGroup,
  getInventoryItemKey,
  getInventoryLoadPhase,
  getInventorySummaryCounts,
  getOpeningSubmitLabel,
  getPosSectionLabel,
  getStockStatusMeta,
  getTodayManilaDateString,
  groupInventoryItems,
  type InventoryCategoryFilter,
  type InventoryItemsResponse,
  type InventoryItemView,
  type InventoryPermissions,
  isUncertainSubmissionError,
  isValidInventoryItemPayload,
  isValidSavedMovementItemPayload,
  isValidStockMovementPayload,
  loadPendingMovementAttempts,
  matchesPendingMovementAttempt,
  mergeRefreshedInventoryItems,
  parseLowStockLevelInput,
  parseMovementQuantityInput,
  parseOpeningQuantityInput,
  parsePesoPriceToCentavos,
  parsePhysicalCountInput,
  type PendingStockMovementAttempt,
  type PosSectionView,
  QUANTITY_SCALE,
  removePendingMovementAttempt,
  requestPendingMovementCancel,
  requestPendingMovementStatus,
  savePendingMovementAttempts,
  type StockMovementView,
  type StockReconciliationView,
  upsertPendingMovementAttempt,
} from "./inventoryView";

function isInventoryItemView(value: unknown): value is InventoryItemView {
  return isValidInventoryItemPayload(value);
}

function getItemKey(item: InventoryItemView): string {
  return getInventoryItemKey(item);
}

function generateClientKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface PosSectionPickerProps {
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (nextCode: string) => void;
  sections: PosSectionView[];
  allowBlank?: boolean;
  disabled?: boolean;
  helperText?: string;
  onSectionCreated: (section: PosSectionView) => void;
}

function PosSectionPicker({
  label,
  ariaLabel,
  value,
  onChange,
  sections,
  allowBlank = false,
  disabled = false,
  helperText,
  onSectionCreated,
}: PosSectionPickerProps) {
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const newSectionInputRef = useRef<HTMLInputElement | null>(null);

  const merchandiseSections = useMemo(
    () =>
      [...sections]
        .filter((s) => s.code !== "CONTAINERS")
        .sort((a, b) => {
          if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        }),
    [sections],
  );

  async function handleSaveSection() {
    if (creating || disabled) return;
    const trimmed = newSectionName.trim().replace(/\s+/g, " ");
    if (!trimmed || trimmed.length > 60) {
      setCreateError("Enter a section name (1 to 60 characters).");
      newSectionInputRef.current?.focus();
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      const response = await api<{ section: PosSectionView }>("/api/inventory/pos-sections", {
        method: "POST",
        body: { name: trimmed },
      });
      onSectionCreated(response.section);
      onChange(response.section.code);
      setNewSectionName("");
      setCreatingOpen(false);
    } catch (err) {
      setCreateError(
        err instanceof ApiError ? err.message : "Could not create POS section. Please try again.",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="inventory-section-field">
      <div className="inventory-section-field__header">
        <span>{label}</span>
        {!creatingOpen && (
          <button
            type="button"
            className="button button--ghost button--sm"
            disabled={disabled}
            onClick={() => {
              setCreateError(null);
              setCreatingOpen(true);
              setTimeout(() => newSectionInputRef.current?.focus(), 0);
            }}
          >
            + Create section
          </button>
        )}
      </div>

      <select
        aria-label={ariaLabel}
        disabled={disabled || creating}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {allowBlank && <option value="">Select POS section…</option>}
        {merchandiseSections.map((section) => (
          <option key={section.code} value={section.code}>
            {section.name}
          </option>
        ))}
      </select>

      {creatingOpen && (
        <div className="inventory-create-section-box">
          <label className="field">
            <span>New POS section name</span>
            <input
              ref={newSectionInputRef}
              type="text"
              maxLength={60}
              placeholder="e.g. Cleaning Supplies"
              disabled={creating || disabled}
              value={newSectionName}
              onChange={(e) => {
                setNewSectionName(e.target.value);
                setCreateError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveSection();
                } else if (e.key === "Escape" && !creating) {
                  e.preventDefault();
                  e.stopPropagation();
                  setCreatingOpen(false);
                  setCreateError(null);
                }
              }}
            />
          </label>
          {createError && (
            <div className="alert alert--error inventory-card-alert" role="alert">
              {createError}
            </div>
          )}
          <div className="inventory-section-picker__actions">
            <button
              type="button"
              className="button button--primary button--sm"
              disabled={creating || disabled}
              onClick={() => void handleSaveSection()}
            >
              {creating ? "Creating…" : "Save section"}
            </button>
            <button
              type="button"
              className="button button--ghost button--sm"
              disabled={creating}
              onClick={() => {
                setCreatingOpen(false);
                setNewSectionName("");
                setCreateError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {helperText && <small>{helperText}</small>}
    </div>
  );
}

export function InventoryPage() {
  const signedInUser = useSignedInUser();
  const { data: modulesData } = useModulesData();
  const [items, setItems] = useState<InventoryItemView[]>([]);
  const [posSections, setPosSections] = useState<PosSectionView[]>([...DEFAULT_POS_SECTIONS]);
  const [permissions, setPermissions] = useState<InventoryPermissions | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<InventoryCategoryFilter>("ALL");

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [conflictNotices, setConflictNotices] = useState<
    Record<string, NoticeEnvelope<string> | undefined>
  >({});
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<{
    id: number;
    duration: NoticeDuration;
    title: string;
    body: string;
  } | null>(null);

  const [addProductOpen, setAddProductOpen] = useState(false);
  const [productCategory, setProductCategory] = useState<"MERCHANDISE" | "OPERATING_SUPPLY">(
    "MERCHANDISE",
  );
  const [productName, setProductName] = useState("");
  const [productDescription, setProductDescription] = useState("");
  const [productUnit, setProductUnit] = useState("pcs");
  const [productAllowDecimal, setProductAllowDecimal] = useState(false);
  const [productUnitConfirmed, setProductUnitConfirmed] = useState(false);
  const [productPriceInput, setProductPriceInput] = useState("");
  const [productShowInPos, setProductShowInPos] = useState(false);
  const [productPosSection, setProductPosSection] = useState<string>("");
  const [productLowStockInput, setProductLowStockInput] = useState("");
  const [productFaucetType, setProductFaucetType] = useState<"" | FaucetReportingType>("");
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [addProductError, setAddProductError] = useState<string | null>(null);

  const [editProductItem, setEditProductItem] = useState<InventoryItemView | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriceInput, setEditPriceInput] = useState("");
  const [editShowInPos, setEditShowInPos] = useState(false);
  const [editPosSection, setEditPosSection] = useState("");
  const [editLowStockInput, setEditLowStockInput] = useState("");
  const [editFaucetType, setEditFaucetType] = useState<"" | FaucetReportingType>("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [editContainerAlertItem, setEditContainerAlertItem] = useState<InventoryItemView | null>(null);
  const [containerLowStockInput, setContainerLowStockInput] = useState("");
  const [savingContainerAlert, setSavingContainerAlert] = useState(false);
  const [containerAlertError, setContainerAlertError] = useState<string | null>(null);

  const [archiveItem, setArchiveItem] = useState<InventoryItemView | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<NoticeEnvelope<string> | null>(null);

  const [reconcileItem, setReconcileItem] = useState<InventoryItemView | null>(null);
  const [reconcileCountInput, setReconcileCountInput] = useState("");
  const [reconcileReasonInput, setReconcileReasonInput] = useState("");
  const [reconcileRequestKey, setReconcileRequestKey] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconcileStaleNotice, setReconcileStaleNotice] = useState<string | null>(null);
  const [reconcileNeedsFreshCount, setReconcileNeedsFreshCount] = useState(false);

  const [receiveItem, setReceiveItem] = useState<InventoryItemView | null>(null);
  const [receiveQtyInput, setReceiveQtyInput] = useState("");
  const [receiveNoteInput, setReceiveNoteInput] = useState("");
  const [receiveEffectiveDate, setReceiveEffectiveDate] = useState("");
  const [receiveRequestKey, setReceiveRequestKey] = useState("");
  const [receiving, setReceiving] = useState(false);
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [receiveStaleNotice, setReceiveStaleNotice] = useState<string | null>(null);

  const [useItem, setUseItem] = useState<InventoryItemView | null>(null);
  const [useQtyInput, setUseQtyInput] = useState("");
  const [usePurposeInput, setUsePurposeInput] = useState("");
  const [useEffectiveDate, setUseEffectiveDate] = useState("");
  const [useRequestKey, setUseRequestKey] = useState("");
  const [recordingUse, setRecordingUse] = useState(false);
  const [useError, setUseError] = useState<string | null>(null);
  const [useStaleNotice, setUseStaleNotice] = useState<string | null>(null);

  const [pendingAttempts, setPendingAttempts] = useState<PendingStockMovementAttempt[]>(() =>
    loadPendingMovementAttempts(signedInUser.username),
  );
  const [checkingPendingKey, setCheckingPendingKey] = useState<string | null>(null);
  const [pendingBannerFeedback, setPendingBannerFeedback] = useState<{
    tone: "warning" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    setPendingAttempts(loadPendingMovementAttempts(signedInUser.username));
  }, [signedInUser.username]);

  const updatePendingAttempts = useCallback(
    (updater: (prev: PendingStockMovementAttempt[]) => PendingStockMovementAttempt[]) => {
      setPendingAttempts((prev) => {
        const next = updater(prev);
        savePendingMovementAttempts(signedInUser.username, next);
        return next;
      });
    },
    [signedInUser.username],
  );

  const findPendingAttempt = useCallback(
    (movementType: "STOCK_RECEIVED" | "STOCK_USED", itemKey: string) =>
      pendingAttempts.find(
        (entry) => entry.movementType === movementType && entry.itemKey === itemKey,
      ),
    [pendingAttempts],
  );

  const [togglingItemKey, setTogglingItemKey] = useState<string | null>(null);
  const [sectionPickerItemId, setSectionPickerItemId] = useState<string | null>(null);
  const [sectionPickerValue, setSectionPickerValue] = useState<string>("CHANGE_OF_GRIPO");
  const [cardActionError, setCardActionError] = useState<
    Record<string, NoticeEnvelope<string> | undefined>
  >({});

  const loadTrackerRef = useRef(createRequestTracker());
  const loadingRef = useRef(true);
  const submittingRef = useRef(false);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const addNameInputRef = useRef<HTMLInputElement | null>(null);
  const editNameInputRef = useRef<HTMLInputElement | null>(null);
  const containerAlertInputRef = useRef<HTMLInputElement | null>(null);
  const reconcileCountInputRef = useRef<HTMLInputElement | null>(null);
  const receiveQtyInputRef = useRef<HTMLInputElement | null>(null);
  const useQtyInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Inventory — Hydrop Deepo";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const handleSectionCreated = useCallback((section: PosSectionView) => {
    setPosSections((prev) =>
      prev.some((s) => s.code === section.code) ? prev : [...prev, section],
    );
  }, []);

  const loadItems = useCallback(async (
    options: { preserveNotice?: boolean; force?: boolean } = {},
  ): Promise<InventoryItemView[] | null> => {
    if (!options.force && submittingRef.current) return null;
    const requestId = loadTrackerRef.current.next();
    loadingRef.current = true;
    setLoading(true);
    setLoadError(null);
    if (!options.preserveNotice) {
      setSaveNotice(null);
      setConflictNotices({});
    }
    try {
      const response = await api<InventoryItemsResponse>("/api/inventory/items");
      if (!loadTrackerRef.current.isCurrent(requestId)) return null;
      setItems((prev) => mergeRefreshedInventoryItems(prev, response.items));
      if (Array.isArray(response.posSections) && response.posSections.length > 0) {
        setPosSections(response.posSections);
      }
      setPermissions(response.permissions);
      setHasLoaded(true);
      return response.items;
    } catch (err) {
      if (!loadTrackerRef.current.isCurrent(requestId)) return null;
      setLoadError(err instanceof ApiError ? err.message : "Could not load inventory stock.");
      return null;
    } finally {
      if (loadTrackerRef.current.isCurrent(requestId)) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (
      !addProductOpen &&
      !editProductItem &&
      !editContainerAlertItem &&
      !archiveItem &&
      !reconcileItem &&
      !receiveItem &&
      !useItem
    ) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (addProductOpen && !creatingProduct) setAddProductOpen(false);
      if (editProductItem && !savingEdit) setEditProductItem(null);
      if (editContainerAlertItem && !savingContainerAlert) setEditContainerAlertItem(null);
      if (archiveItem && !archiving) setArchiveItem(null);
      if (reconcileItem && !reconciling) setReconcileItem(null);
      if (receiveItem && !receiving && checkingPendingKey === null) setReceiveItem(null);
      if (useItem && !recordingUse && checkingPendingKey === null) setUseItem(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    addProductOpen,
    creatingProduct,
    editProductItem,
    savingEdit,
    editContainerAlertItem,
    savingContainerAlert,
    archiveItem,
    archiving,
    reconcileItem,
    reconciling,
    receiveItem,
    receiving,
    useItem,
    recordingUse,
    checkingPendingKey,
  ]);

  function openAddProductModal() {
    setProductCategory("MERCHANDISE");
    setProductName("");
    setProductDescription("");
    setProductUnit("pcs");
    setProductAllowDecimal(false);
    setProductUnitConfirmed(false);
    setProductPriceInput("");
    setProductShowInPos(false);
    setProductPosSection("");
    setProductLowStockInput("");
    setProductFaucetType("");
    setAddProductError(null);
    setAddProductOpen(true);
    setTimeout(() => addNameInputRef.current?.focus(), 0);
  }

  function openEditProductModal(item: InventoryItemView) {
    if (!item.id || (item.category !== "MERCHANDISE" && item.category !== "OPERATING_SUPPLY")) return;
    setEditProductItem(item);
    setEditName(item.name);
    setEditDescription(item.description ?? "");
    setEditPriceInput(
      item.unitPriceCentavos != null ? formatCentavosInputValue(item.unitPriceCentavos) : "",
    );
    setEditShowInPos(Boolean(item.showInPos));
    setEditPosSection(item.posSection ?? "");
    setEditLowStockInput(item.lowStockLevel != null ? String(item.lowStockLevel) : "");
    setEditFaucetType(item.faucetReportingType ?? "");
    setEditError(null);
    setTimeout(() => editNameInputRef.current?.focus(), 0);
  }

  function openContainerAlertModal(item: InventoryItemView) {
    if (item.category !== "CONTAINER" || !item.shape) return;
    setEditContainerAlertItem(item);
    setContainerLowStockInput(item.lowStockLevel != null ? String(item.lowStockLevel) : "");
    setContainerAlertError(null);
    setTimeout(() => containerAlertInputRef.current?.focus(), 0);
  }

  function openArchiveModal(item: InventoryItemView) {
    if (!item.id || (item.category !== "MERCHANDISE" && item.category !== "OPERATING_SUPPLY")) return;
    setArchiveItem(item);
    setArchiveError(null);
  }

  function openReconcileModal(item: InventoryItemView) {
    if (item.status !== "INITIALIZED" || item.currentQuantity === null) return;
    setReconcileItem(item);
    setReconcileCountInput(item.currentQuantity >= 0 ? String(item.currentQuantity) : "0");
    setReconcileReasonInput("");
    setReconcileRequestKey(generateClientKey());
    setReconcileError(null);
    setReconcileStaleNotice(null);
    setReconcileNeedsFreshCount(false);
    setTimeout(() => reconcileCountInputRef.current?.focus(), 0);
  }

  function openReceiveModal(item: InventoryItemView) {
    if (item.status !== "INITIALIZED" || item.currentQuantity === null) return;
    const itemKey = getItemKey(item);
    const pending = findPendingAttempt("STOCK_RECEIVED", itemKey);
    setReceiveItem(item);
    setReceiveQtyInput(pending ? pending.quantityInput : "");
    setReceiveNoteInput(pending ? pending.noteOrPurposeInput : "");
    setReceiveEffectiveDate(pending ? pending.effectiveDate : getTodayManilaDateString());
    setReceiveRequestKey(pending ? pending.requestKey : generateClientKey());
    setReceiveError(null);
    setReceiveStaleNotice(null);
    setTimeout(() => receiveQtyInputRef.current?.focus(), 0);
  }

  function openUseModal(item: InventoryItemView) {
    if (item.status !== "INITIALIZED" || item.currentQuantity === null || item.category !== "OPERATING_SUPPLY") {
      return;
    }
    const itemKey = getItemKey(item);
    const pending = findPendingAttempt("STOCK_USED", itemKey);
    setUseItem(item);
    setUseQtyInput(pending ? pending.quantityInput : "");
    setUsePurposeInput(pending ? pending.noteOrPurposeInput : "");
    setUseEffectiveDate(pending ? pending.effectiveDate : getTodayManilaDateString());
    setUseRequestKey(pending ? pending.requestKey : generateClientKey());
    setUseError(null);
    setUseStaleNotice(null);
    setTimeout(() => useQtyInputRef.current?.focus(), 0);
  }

  async function handleCreateProduct(event: FormEvent) {
    event.preventDefault();
    if (creatingProduct || !permissions?.canCreateProduct) return;

    const isSupply = productCategory === "OPERATING_SUPPLY";
    const allowDecimal = isSupply ? productAllowDecimal : false;
    const trimmedName = productName.trim().replace(/\s+/g, " ");
    const trimmedDesc = productDescription.trim().replace(/\s+/g, " ");
    const trimmedUnit = productUnit.trim().replace(/\s+/g, " ");
    const parsedPriceCentavos = isSupply ? null : parsePesoPriceToCentavos(productPriceInput);
    const parsedLowStock = parseLowStockLevelInput(
      productLowStockInput,
      trimmedUnit || "units",
      allowDecimal,
    );

    if (!trimmedName || trimmedName.length > 80) {
      setAddProductError("Enter a product name (1 to 80 characters).");
      return;
    }
    if (trimmedDesc.length > 160) {
      setAddProductError("Short description must be 160 characters or fewer.");
      return;
    }
    if (!trimmedUnit || trimmedUnit.length > 30) {
      setAddProductError("Enter the stock unit (e.g. pcs).");
      return;
    }
    if (!productUnitConfirmed) {
      setAddProductError("Confirm the stock recording unit before saving.");
      return;
    }
    if (!isSupply && parsedPriceCentavos === null) {
      setAddProductError("Enter a valid positive selling price in pesos (e.g. 40.00).");
      return;
    }
    if (!parsedLowStock.ok) {
      setAddProductError(parsedLowStock.message);
      return;
    }
    if (!isSupply && productShowInPos && !productPosSection) {
      setAddProductError("Choose a POS section when Show in POS is checked.");
      return;
    }

    setCreatingProduct(true);
    setAddProductError(null);
    setSaveNotice(null);
    loadTrackerRef.current.next();

    try {
      const payload = isSupply
        ? {
            category: "OPERATING_SUPPLY",
            name: trimmedName,
            description: trimmedDesc || null,
            unit: trimmedUnit,
            allowDecimalQuantity: allowDecimal,
            unitConfirmed: true,
            lowStockLevel: parsedLowStock.value,
          }
        : {
            category: "MERCHANDISE",
            name: trimmedName,
            description: trimmedDesc || null,
            unit: trimmedUnit,
            allowDecimalQuantity: false,
            unitConfirmed: true,
            unitPriceCentavos: parsedPriceCentavos,
            showInPos: productShowInPos,
            posSection: productPosSection || null,
            lowStockLevel: parsedLowStock.value,
            faucetReportingType: productFaucetType || null,
          };

      const response = await api<{ item: InventoryItemView }>("/api/inventory/products", {
        method: "POST",
        body: payload,
      });
      loadTrackerRef.current.next();
      setItems((prev) => [...prev, response.item]);
      setAddProductOpen(false);
      setSaveNotice({
        id: nextNoticeId(),
        duration: "detailed",
        title: isSupply ? "Operating supply saved" : "Product saved",
        body: isSupply
          ? `${response.item.name} (${response.item.unit}) was added as an operating supply with opening stock Not Set.`
          : `${response.item.name} (${formatPesoCentavos(response.item.unitPriceCentavos ?? parsedPriceCentavos ?? 0)}) was added as ${response.item.showInPos ? "Shown in POS" : "Hidden from POS"} with opening stock Not Set.`,
      });
    } catch (err) {
      setAddProductError(
        err instanceof ApiError ? err.message : "Could not save product. Please try again.",
      );
    } finally {
      setCreatingProduct(false);
    }
  }

  async function handleSaveProductEdit(event: FormEvent) {
    event.preventDefault();
    if (!editProductItem?.id || savingEdit || !permissions?.canCreateProduct) return;

    const isSupply = editProductItem.category === "OPERATING_SUPPLY";
    const allowDecimal = Boolean(editProductItem.allowDecimalQuantity);
    const trimmedName = editName.trim().replace(/\s+/g, " ");
    const trimmedDesc = editDescription.trim().replace(/\s+/g, " ");
    const parsedPriceCentavos = isSupply ? null : parsePesoPriceToCentavos(editPriceInput);
    const parsedLowStock = parseLowStockLevelInput(
      editLowStockInput,
      editProductItem.unit,
      allowDecimal,
    );

    if (!trimmedName || trimmedName.length > 80) {
      setEditError("Enter a product name (1 to 80 characters).");
      return;
    }
    if (trimmedDesc.length > 160) {
      setEditError("Short description must be 160 characters or fewer.");
      return;
    }
    if (!isSupply && parsedPriceCentavos === null) {
      setEditError("Enter a valid positive selling price in pesos (e.g. 40.00).");
      return;
    }
    if (!parsedLowStock.ok) {
      setEditError(parsedLowStock.message);
      return;
    }
    if (!isSupply && editShowInPos && !editPosSection) {
      setEditError("Choose a POS section when Show in POS is checked.");
      return;
    }

    setSavingEdit(true);
    setEditError(null);
    setSaveNotice(null);
    loadTrackerRef.current.next();

    try {
      const payload = isSupply
        ? {
            name: trimmedName,
            description: trimmedDesc || null,
            lowStockLevel: parsedLowStock.value,
          }
        : {
            name: trimmedName,
            description: trimmedDesc || null,
            unitPriceCentavos: parsedPriceCentavos,
            showInPos: editShowInPos,
            posSection: editPosSection || null,
            lowStockLevel: parsedLowStock.value,
            faucetReportingType: editFaucetType || null,
          };

      const response = await api<{ item: InventoryItemView }>(
        `/api/inventory/products/${encodeURIComponent(editProductItem.id)}`,
        {
          method: "PATCH",
          body: payload,
        },
      );
      loadTrackerRef.current.next();
      setItems((prev) =>
        prev.map((entry) =>
          getItemKey(entry) === getItemKey(response.item) ? response.item : entry,
        ),
      );
      setEditProductItem(null);
      setSaveNotice({
        id: nextNoticeId(),
        duration: "detailed",
        title: isSupply ? "Operating supply updated" : "Product details updated",
        body: isSupply
          ? `${response.item.name} (${response.item.unit}) details were saved.`
          : `${response.item.name} (${formatPesoCentavos(response.item.unitPriceCentavos ?? parsedPriceCentavos ?? 0)}) was saved. Future POS checkouts will use these details while existing sales keep their original snapshots.`,
      });
    } catch (err) {
      setEditError(
        err instanceof ApiError ? err.message : "Could not update product details. Please try again.",
      );
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleSaveContainerAlert(event: FormEvent) {
    event.preventDefault();
    if (!editContainerAlertItem?.shape || savingContainerAlert || !permissions?.canCreateProduct) return;

    const parsedLowStock = parseLowStockLevelInput(
      containerLowStockInput,
      editContainerAlertItem.unit,
    );
    if (!parsedLowStock.ok) {
      setContainerAlertError(parsedLowStock.message);
      containerAlertInputRef.current?.focus();
      return;
    }

    setSavingContainerAlert(true);
    setContainerAlertError(null);
    setSaveNotice(null);
    loadTrackerRef.current.next();

    try {
      const response = await api<{ item: InventoryItemView }>(
        `/api/inventory/containers/${encodeURIComponent(editContainerAlertItem.shape)}`,
        {
          method: "PATCH",
          body: { lowStockLevel: parsedLowStock.value },
        },
      );
      loadTrackerRef.current.next();
      setItems((prev) =>
        prev.map((entry) =>
          getItemKey(entry) === getItemKey(response.item) ? response.item : entry,
        ),
      );
      setEditContainerAlertItem(null);
      setSaveNotice({
        id: nextNoticeId(),
        duration: "brief",
        title:
          response.item.lowStockLevel != null
            ? "Low stock alert saved"
            : "Low stock alert cleared",
        body:
          response.item.lowStockLevel != null
            ? `${response.item.name} will show a Low Stock alert in Dashboard when balance is 1 to ${formatQuantityLabel(response.item.lowStockLevel, response.item.unit)}.`
            : `${response.item.name} no longer has a Low Stock alert level.`,
      });
    } catch (err) {
      setContainerAlertError(
        err instanceof ApiError ? err.message : "Could not save Low Stock alert level.",
      );
    } finally {
      setSavingContainerAlert(false);
    }
  }

  async function handleConfirmArchive() {
    if (!archiveItem?.id || archiving || !permissions?.canCreateProduct) return;

    setArchiving(true);
    setArchiveError(null);
    setSaveNotice(null);
    loadTrackerRef.current.next();

    try {
      const response = await api<{ item: InventoryItemView }>(
        `/api/inventory/products/${encodeURIComponent(archiveItem.id)}/archive`,
        {
          method: "POST",
          body: {},
        },
      );
      loadTrackerRef.current.next();
      setItems((prev) => prev.filter((entry) => getItemKey(entry) !== getItemKey(response.item)));
      setArchiveItem(null);
      setSaveNotice({
        id: nextNoticeId(),
        duration: "detailed",
        title: "Product archived",
        body: `${response.item.name} left active Inventory and new POS sales. Its ${formatQuantityLabel(response.item.currentQuantity, response.item.unit)} balance, opening count, and past sales remain preserved.`,
      });
    } catch (err) {
      setArchiveError(
        wrapNotice(
          err instanceof ApiError ? err.message : "Could not archive product. Please try again.",
        ),
      );
    } finally {
      setArchiving(false);
    }
  }

  async function handleToggleContainerVisibility(shape: ContainerShape, nextShowInPos: boolean) {
    if (togglingItemKey !== null || !permissions?.canCreateProduct) return;
    const item = items.find((entry) => entry.category === "CONTAINER" && entry.shape === shape);
    if (!item) return;
    const itemKey = getItemKey(item);

    setTogglingItemKey(itemKey);
    setCardActionError((prev) => ({ ...prev, [itemKey]: undefined }));
    setSaveNotice(null);
    loadTrackerRef.current.next();

    try {
      const response = await api<{ item: InventoryItemView }>(
        `/api/inventory/containers/${encodeURIComponent(shape)}`,
        {
          method: "PATCH",
          body: { showInPos: nextShowInPos },
        },
      );
      loadTrackerRef.current.next();
      setItems((prev) =>
        prev.map((entry) =>
          getItemKey(entry) === getItemKey(response.item) ? response.item : entry,
        ),
      );
      setSaveNotice({
        id: nextNoticeId(),
        duration: "brief",
        title: response.item.showInPos
          ? `${response.item.name} shown in POS`
          : `${response.item.name} hidden from POS`,
        body: response.item.showInPos
          ? `${response.item.name} package options are now shown under Containers in POS using its shared ${formatQuantityLabel(response.item.currentQuantity, response.item.unit)} balance.`
          : `${response.item.name} package options are now hidden from new POS sales.`,
      });
    } catch (err) {
      setCardActionError((prev) => ({
        ...prev,
        [itemKey]: wrapNotice(
          err instanceof ApiError ? err.message : "Could not update POS visibility.",
        ),
      }));
    } finally {
      setTogglingItemKey(null);
    }
  }

  async function handleToggleShowInPos(
    item: InventoryItemView,
    nextShowInPos: boolean,
    explicitSection?: string,
  ) {
    if (!item.id || togglingItemKey !== null || !permissions?.canCreateProduct) return;
    const itemKey = getItemKey(item);
    if (nextShowInPos && !item.posSection && !explicitSection) {
      setSectionPickerItemId(item.id);
      setSectionPickerValue("CHANGE_OF_GRIPO");
      setCardActionError((prev) => ({ ...prev, [itemKey]: undefined }));
      return;
    }

    setTogglingItemKey(itemKey);
    setCardActionError((prev) => ({ ...prev, [itemKey]: undefined }));
    setSaveNotice(null);
    loadTrackerRef.current.next();

    try {
      const response = await api<{ item: InventoryItemView }>(
        `/api/inventory/products/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          body: {
            showInPos: nextShowInPos,
            ...(explicitSection ? { posSection: explicitSection } : {}),
          },
        },
      );
      loadTrackerRef.current.next();
      setItems((prev) =>
        prev.map((entry) => (getItemKey(entry) === getItemKey(response.item) ? response.item : entry)),
      );
      setSectionPickerItemId(null);
      setSaveNotice({
        id: nextNoticeId(),
        duration: "brief",
        title: response.item.showInPos ? "Product shown in POS" : "Product hidden from POS",
        body: `${response.item.name} is now ${response.item.showInPos ? "visible in Point of Sale" : "hidden from Point of Sale"}.`,
      });
    } catch (err) {
      setCardActionError((prev) => ({
        ...prev,
        [itemKey]: wrapNotice(
          err instanceof ApiError ? err.message : "Could not update POS visibility.",
        ),
      }));
    } finally {
      setTogglingItemKey(null);
    }
  }

  async function handleConfirmReconciliation(event: FormEvent) {
    event.preventDefault();
    if (
      !reconcileItem ||
      reconcileItem.currentQuantity === null ||
      reconciling ||
      !permissions?.canInitializeOpeningStock
    ) {
      return;
    }

    if (reconcileNeedsFreshCount) {
      setReconcileError("Enter a fresh physical count after reviewing the updated balance.");
      reconcileCountInputRef.current?.focus();
      return;
    }

    const parsedCount = parsePhysicalCountInput(
      reconcileCountInput,
      reconcileItem.unit,
      Boolean(reconcileItem.allowDecimalQuantity),
    );
    if (!parsedCount.ok) {
      setReconcileError(parsedCount.message);
      reconcileCountInputRef.current?.focus();
      return;
    }

    const trimmedReason = reconcileReasonInput.trim().replace(/\s+/g, " ");
    if (!trimmedReason || trimmedReason.length > 240) {
      setReconcileError("Enter a factual reason for this physical count (1 to 240 characters).");
      return;
    }

    const endpointKey = reconcileItem.shape ?? reconcileItem.id ?? reconcileItem.code;
    setReconciling(true);
    setReconcileError(null);
    setReconcileStaleNotice(null);
    setSaveNotice(null);
    loadTrackerRef.current.next();

    try {
      const response = await api<{
        item: InventoryItemView;
        reconciliation: StockReconciliationView;
      }>(`/api/inventory/items/${encodeURIComponent(endpointKey)}/reconciliations`, {
        method: "POST",
        body: {
          physicalCount: parsedCount.quantity,
          reason: trimmedReason,
          expectedRevision: reconcileItem.stockRevision ?? 0,
          expectedCurrentQuantity: reconcileItem.currentQuantity,
          requestKey: reconcileRequestKey,
        },
      });
      loadTrackerRef.current.next();
      setItems((prev) =>
        prev.map((entry) =>
          getItemKey(entry) === getItemKey(response.item) ? response.item : entry,
        ),
      );
      setReconcileItem(null);
      setReconcileNeedsFreshCount(false);
      setSaveNotice({
        id: nextNoticeId(),
        duration: "detailed",
        title:
          response.reconciliation.quantityDelta === 0
            ? "Physical count verified"
            : "Stock count corrected",
        body:
          response.reconciliation.quantityDelta === 0
            ? `${response.item.name} verified at ${formatQuantityLabel(response.item.currentQuantity, response.item.unit)}. Original opening count remains preserved.`
            : `${response.item.name} updated from ${formatQuantityLabel(response.reconciliation.balanceBefore, response.reconciliation.unit)} to ${formatQuantityLabel(response.reconciliation.balanceAfter, response.reconciliation.unit)} (${formatSignedDelta(response.reconciliation.quantityDelta, response.reconciliation.unit)}). Original opening count remains preserved.`,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "STALE_STOCK_COUNT") {
        const latestItem = isInventoryItemView(err.details?.item) ? err.details.item : null;
        if (latestItem) {
          loadTrackerRef.current.next();
          setItems((prev) =>
            prev.map((entry) => (getItemKey(entry) === getItemKey(latestItem) ? latestItem : entry)),
          );
          setReconcileItem(latestItem);
        }
        setReconcileRequestKey(generateClientKey());
        setReconcileCountInput("");
        setReconcileNeedsFreshCount(true);
        setReconcileStaleNotice(err.message);
        setTimeout(() => reconcileCountInputRef.current?.focus(), 0);
      } else if (err instanceof ApiError && err.code === "ACTIVE_PAYMENT_COMMITMENT") {
        const latestItem = isInventoryItemView(err.details?.item) ? err.details.item : null;
        if (latestItem) {
          loadTrackerRef.current.next();
          setItems((prev) =>
            prev.map((entry) => (getItemKey(entry) === getItemKey(latestItem) ? latestItem : entry)),
          );
          setReconcileItem(latestItem);
        }
        setReconcileError(err.message);
      } else {
        setReconcileError(
          err instanceof ApiError
            ? err.message
            : "Could not save physical count correction. Please try again.",
        );
      }
    } finally {
      setReconciling(false);
    }
  }

  function recoverSavedPendingMovement(
    attempt: PendingStockMovementAttempt,
    response: { item: InventoryItemView; movement: StockMovementView },
  ): boolean {
    if (
      !isValidSavedMovementItemPayload(response.item) ||
      !isValidStockMovementPayload(response.movement) ||
      !matchesPendingMovementAttempt(attempt, response.item, response.movement)
    ) {
      return false;
    }
    loadTrackerRef.current.next();
    updatePendingAttempts((prev) =>
      removePendingMovementAttempt(prev, attempt.movementType, attempt.itemKey),
    );
    setPendingBannerFeedback(null);
    setItems((prev) =>
      prev.map((entry) =>
        getItemKey(entry) === getItemKey(response.item) ? response.item : entry,
      ),
    );
    if (
      attempt.movementType === "STOCK_RECEIVED" &&
      receiveItem &&
      getItemKey(receiveItem) === attempt.itemKey
    ) {
      setReceiveItem(null);
    }
    if (
      attempt.movementType === "STOCK_USED" &&
      useItem &&
      getItemKey(useItem) === attempt.itemKey
    ) {
      setUseItem(null);
    }
    setSaveNotice({
      id: nextNoticeId(),
      duration: "detailed",
      title:
        attempt.movementType === "STOCK_RECEIVED"
          ? "Saved Stock Received recovered"
          : "Saved Stock Used recovered",
      body: `${attempt.itemName} (${formatQuantityLabel(response.movement.quantity, response.movement.unit)} on ${response.movement.effectiveDate ?? attempt.effectiveDate}) was already saved. Current balance: ${formatQuantityLabel(response.item.currentQuantity, response.item.unit)}.`,
    });
    return true;
  }

  async function finalizeCancelledPendingMovement(attempt: PendingStockMovementAttempt) {
    updatePendingAttempts((prev) =>
      removePendingMovementAttempt(prev, attempt.movementType, attempt.itemKey),
    );
    setPendingBannerFeedback(null);
    const refreshedItems = await loadItems({ preserveNotice: true, force: true });
    const updatedTarget = refreshedItems?.find(
      (entry) => getItemKey(entry) === attempt.itemKey,
    );
    const modalNotice = `Earlier ${attempt.movementType === "STOCK_RECEIVED" ? "Stock Received" : "Stock Used"} submission was cancelled on the server. Review the refreshed stock balance before submitting a new entry.`;
    if (attempt.movementType === "STOCK_RECEIVED") {
      if (updatedTarget) {
        setReceiveItem((prev) =>
          prev && getItemKey(prev) === attempt.itemKey ? updatedTarget : prev,
        );
      }
      setReceiveRequestKey(generateClientKey());
      setReceiveStaleNotice(modalNotice);
    } else {
      if (updatedTarget) {
        setUseItem((prev) =>
          prev && getItemKey(prev) === attempt.itemKey ? updatedTarget : prev,
        );
      }
      setUseRequestKey(generateClientKey());
      setUseStaleNotice(modalNotice);
    }
    setSaveNotice({
      id: nextNoticeId(),
      duration: "detailed",
      title: "Earlier submission cancelled",
      body: `Cancelled the unresolved ${attempt.movementType === "STOCK_RECEIVED" ? "Stock Received" : "Stock Used"} reference for ${attempt.itemName} so it cannot save late. You can now enter a fresh submission.`,
    });
  }

  async function handleCheckPendingAttemptStatus(attempt: PendingStockMovementAttempt) {
    if (checkingPendingKey !== null || receiving || recordingUse) return;
    setCheckingPendingKey(attempt.requestKey);
    setReceiveError(null);
    setUseError(null);
    setSaveNotice(null);
    setPendingBannerFeedback(null);
    loadTrackerRef.current.next();

    try {
      const result = await requestPendingMovementStatus(attempt);

      if (result.kind === "SAVED" && recoverSavedPendingMovement(attempt, result)) {
        return;
      } else if (result.kind === "CANCELLED") {
        await finalizeCancelledPendingMovement(attempt);
      } else if (result.kind === "NOT_FOUND") {
        const inconclusiveMsg = `Earlier ${attempt.movementType === "STOCK_RECEIVED" ? "Stock Received" : "Stock Used"} submission for ${attempt.itemName} is not recorded on the server yet and may still be in flight. Keep this reference to Retry Same Submission, or Cancel earlier attempt before starting a new entry.`;
        setPendingBannerFeedback({ tone: "warning", message: inconclusiveMsg });
        if (
          attempt.movementType === "STOCK_RECEIVED" &&
          receiveItem &&
          getItemKey(receiveItem) === attempt.itemKey
        ) {
          setReceiveError(inconclusiveMsg);
        } else if (
          attempt.movementType === "STOCK_USED" &&
          useItem &&
          getItemKey(useItem) === attempt.itemKey
        ) {
          setUseError(inconclusiveMsg);
        }
      } else {
        const unexpectedMsg = `Could not verify the server's status response for ${attempt.itemName} because required fields were missing or did not match the preserved submission. The original submission reference was kept—run Check status again or Retry Same Submission.`;
        setPendingBannerFeedback({ tone: "error", message: unexpectedMsg });
        if (
          attempt.movementType === "STOCK_RECEIVED" &&
          receiveItem &&
          getItemKey(receiveItem) === attempt.itemKey
        ) {
          setReceiveError(unexpectedMsg);
        } else if (
          attempt.movementType === "STOCK_USED" &&
          useItem &&
          getItemKey(useItem) === attempt.itemKey
        ) {
          setUseError(unexpectedMsg);
        }
      }
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : "Could not verify submission status. Check connection and try again.";
      setPendingBannerFeedback({ tone: "error", message: msg });
      if (attempt.movementType === "STOCK_RECEIVED") {
        setReceiveError(msg);
      } else {
        setUseError(msg);
      }
    } finally {
      setCheckingPendingKey(null);
    }
  }

  async function handleCancelPendingAttempt(attempt: PendingStockMovementAttempt) {
    if (checkingPendingKey !== null || receiving || recordingUse) return;
    const targetItem = items.find((entry) => getItemKey(entry) === attempt.itemKey);
    const endpointItemKey = targetItem
      ? (targetItem.shape ?? targetItem.id ?? targetItem.code)
      : attempt.itemKey;
    setCheckingPendingKey(attempt.requestKey);
    setReceiveError(null);
    setUseError(null);
    setSaveNotice(null);
    setPendingBannerFeedback(null);
    loadTrackerRef.current.next();

    try {
      const result = await requestPendingMovementCancel(attempt, endpointItemKey);

      if (result.kind === "SAVED" && recoverSavedPendingMovement(attempt, result)) {
        return;
      } else if (result.kind === "CANCELLED") {
        await finalizeCancelledPendingMovement(attempt);
      } else {
        const unexpectedMsg = `Could not verify the server's cancellation response for ${attempt.itemName} because required fields were missing or did not match the preserved submission. The original submission reference was kept—run Check status or Retry Same Submission before entering a new one.`;
        setPendingBannerFeedback({ tone: "error", message: unexpectedMsg });
        if (
          attempt.movementType === "STOCK_RECEIVED" &&
          receiveItem &&
          getItemKey(receiveItem) === attempt.itemKey
        ) {
          setReceiveError(unexpectedMsg);
        } else if (
          attempt.movementType === "STOCK_USED" &&
          useItem &&
          getItemKey(useItem) === attempt.itemKey
        ) {
          setUseError(unexpectedMsg);
        }
      }
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : "Could not cancel the earlier submission. Check connection and try again.";
      setPendingBannerFeedback({ tone: "error", message: msg });
      if (attempt.movementType === "STOCK_RECEIVED") {
        setReceiveError(msg);
      } else {
        setUseError(msg);
      }
    } finally {
      setCheckingPendingKey(null);
    }
  }

  async function handleConfirmReceiving(event: FormEvent) {
    event.preventDefault();
    if (
      !receiveItem ||
      receiveItem.currentQuantity === null ||
      receiving ||
      checkingPendingKey !== null ||
      !(permissions?.canRecordReceiving ?? permissions?.canInitializeOpeningStock)
    ) {
      return;
    }

    const itemKey = getItemKey(receiveItem);
    const pendingAttempt = findPendingAttempt("STOCK_RECEIVED", itemKey);
    const submittedQtyInput = pendingAttempt ? pendingAttempt.quantityInput : receiveQtyInput;
    const submittedNoteInput = pendingAttempt ? pendingAttempt.noteOrPurposeInput : receiveNoteInput;
    const submittedEffectiveDate = pendingAttempt
      ? pendingAttempt.effectiveDate
      : receiveEffectiveDate || getTodayManilaDateString();
    const submittedRequestKey = pendingAttempt ? pendingAttempt.requestKey : receiveRequestKey;
    const submittedRevision = pendingAttempt
      ? pendingAttempt.expectedRevision
      : (receiveItem.stockRevision ?? 0);
    const submittedCurrentQuantity = pendingAttempt
      ? pendingAttempt.expectedCurrentQuantity
      : receiveItem.currentQuantity;

    const parsedQty = parseMovementQuantityInput(
      submittedQtyInput,
      receiveItem.unit,
      Boolean(receiveItem.allowDecimalQuantity),
    );
    if (!parsedQty.ok) {
      setReceiveError(parsedQty.message);
      receiveQtyInputRef.current?.focus();
      return;
    }

    const trimmedNote = submittedNoteInput.trim().replace(/\s+/g, " ");
    if (trimmedNote.length > 240) {
      setReceiveError("Delivery note must be 240 characters or fewer.");
      return;
    }

    const attemptRecord: PendingStockMovementAttempt = {
      movementType: "STOCK_RECEIVED",
      itemKey,
      itemName: receiveItem.name,
      unit: receiveItem.unit,
      quantityInput: submittedQtyInput,
      noteOrPurposeInput: submittedNoteInput,
      effectiveDate: submittedEffectiveDate,
      requestKey: submittedRequestKey,
      expectedRevision: submittedRevision,
      expectedCurrentQuantity: submittedCurrentQuantity,
    };
    // Persist before sending so reload or lost response mid-flight preserves payload, date, and requestKey.
    updatePendingAttempts((prev) => upsertPendingMovementAttempt(prev, attemptRecord));

    const endpointKey = receiveItem.shape ?? receiveItem.id ?? receiveItem.code;
    setReceiving(true);
    setReceiveError(null);
    setReceiveStaleNotice(null);
    setSaveNotice(null);
    loadTrackerRef.current.next();

    try {
      const response = await api<{
        item: InventoryItemView;
        movement: StockMovementView;
        replayed?: boolean;
      }>(`/api/inventory/items/${encodeURIComponent(endpointKey)}/receiving`, {
        method: "POST",
        body: {
          quantity: parsedQty.quantity,
          effectiveDate: submittedEffectiveDate,
          note: trimmedNote || null,
          expectedRevision: submittedRevision,
          expectedCurrentQuantity: submittedCurrentQuantity,
          requestKey: submittedRequestKey,
        },
      });
      if (
        !isValidSavedMovementItemPayload(response?.item) ||
        !isValidStockMovementPayload(response?.movement) ||
        !matchesPendingMovementAttempt(attemptRecord, response.item, response.movement)
      ) {
        throw new Error("Could not read the server's Stock Received confirmation response.");
      }
      loadTrackerRef.current.next();
      updatePendingAttempts((prev) =>
        removePendingMovementAttempt(prev, "STOCK_RECEIVED", itemKey),
      );
      setItems((prev) =>
        prev.map((entry) =>
          getItemKey(entry) === getItemKey(response.item) ? response.item : entry,
        ),
      );
      setReceiveItem(null);
      setSaveNotice({
        id: nextNoticeId(),
        duration: "detailed",
        title: response.replayed ? "Stock received already saved" : "Stock received recorded",
        body: `${response.replayed ? "Recovered earlier submission: " : ""}Added ${formatQuantityLabel(response.movement.quantity, response.movement.unit)} to ${response.item.name}. Current balance: ${formatQuantityLabel(response.item.currentQuantity, response.item.unit)}.`,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "STALE_STOCK_BALANCE") {
        updatePendingAttempts((prev) =>
          removePendingMovementAttempt(prev, "STOCK_RECEIVED", itemKey),
        );
        const latestItem = isInventoryItemView(err.details?.item) ? err.details.item : null;
        if (latestItem) {
          loadTrackerRef.current.next();
          setItems((prev) =>
            prev.map((entry) => (getItemKey(entry) === getItemKey(latestItem) ? latestItem : entry)),
          );
          setReceiveItem(latestItem);
        }
        setReceiveRequestKey(generateClientKey());
        setReceiveStaleNotice(err.message);
      } else if (err instanceof ApiError && err.code === "REQUEST_KEY_CANCELLED") {
        updatePendingAttempts((prev) =>
          removePendingMovementAttempt(prev, "STOCK_RECEIVED", itemKey),
        );
        setPendingBannerFeedback(null);
        const refreshed = await loadItems({ preserveNotice: true, force: true });
        const updatedTarget = refreshed?.find((entry) => getItemKey(entry) === itemKey);
        if (updatedTarget) {
          setReceiveItem(updatedTarget);
        }
        setReceiveRequestKey(generateClientKey());
        setReceiveError(err.message);
      } else if (
        (err instanceof ApiError && err.status === 401) ||
        isUncertainSubmissionError(err)
      ) {
        setReceiveError(
          `${err instanceof ApiError ? err.message : "Could not confirm whether Stock Received saved."} Retry this exact submission or run Check status before entering a new one.`,
        );
      } else {
        updatePendingAttempts((prev) =>
          removePendingMovementAttempt(prev, "STOCK_RECEIVED", itemKey),
        );
        setReceiveError(
          err instanceof ApiError
            ? err.message
            : "Could not record Stock Received. Please try again.",
        );
      }
    } finally {
      setReceiving(false);
    }
  }

  async function handleConfirmUsage(event: FormEvent) {
    event.preventDefault();
    if (!useItem || useItem.currentQuantity === null || recordingUse || checkingPendingKey !== null) {
      return;
    }

    const itemKey = getItemKey(useItem);
    const pendingAttempt = findPendingAttempt("STOCK_USED", itemKey);
    const submittedQtyInput = pendingAttempt ? pendingAttempt.quantityInput : useQtyInput;
    const submittedPurposeInput = pendingAttempt ? pendingAttempt.noteOrPurposeInput : usePurposeInput;
    const submittedEffectiveDate = pendingAttempt
      ? pendingAttempt.effectiveDate
      : useEffectiveDate || getTodayManilaDateString();
    const submittedRequestKey = pendingAttempt ? pendingAttempt.requestKey : useRequestKey;
    const submittedRevision = pendingAttempt
      ? pendingAttempt.expectedRevision
      : (useItem.stockRevision ?? 0);
    const submittedCurrentQuantity = pendingAttempt
      ? pendingAttempt.expectedCurrentQuantity
      : useItem.currentQuantity;

    const parsedQty = parseMovementQuantityInput(
      submittedQtyInput,
      useItem.unit,
      Boolean(useItem.allowDecimalQuantity),
    );
    if (!parsedQty.ok) {
      setUseError(parsedQty.message);
      useQtyInputRef.current?.focus();
      return;
    }

    const trimmedPurpose = submittedPurposeInput.trim().replace(/\s+/g, " ");
    if (!trimmedPurpose || trimmedPurpose.length > 240) {
      setUseError("Enter a short purpose note (1 to 240 characters).");
      return;
    }

    const attemptRecord: PendingStockMovementAttempt = {
      movementType: "STOCK_USED",
      itemKey,
      itemName: useItem.name,
      unit: useItem.unit,
      quantityInput: submittedQtyInput,
      noteOrPurposeInput: submittedPurposeInput,
      effectiveDate: submittedEffectiveDate,
      requestKey: submittedRequestKey,
      expectedRevision: submittedRevision,
      expectedCurrentQuantity: submittedCurrentQuantity,
    };
    // Persist before sending so reload or lost response mid-flight preserves payload, date, and requestKey.
    updatePendingAttempts((prev) => upsertPendingMovementAttempt(prev, attemptRecord));

    const endpointKey = useItem.shape ?? useItem.id ?? useItem.code;
    setRecordingUse(true);
    setUseError(null);
    setUseStaleNotice(null);
    setSaveNotice(null);
    loadTrackerRef.current.next();

    try {
      const response = await api<{
        item: InventoryItemView;
        movement: StockMovementView;
        replayed?: boolean;
      }>(`/api/inventory/items/${encodeURIComponent(endpointKey)}/usage`, {
        method: "POST",
        body: {
          quantity: parsedQty.quantity,
          effectiveDate: submittedEffectiveDate,
          purpose: trimmedPurpose,
          expectedRevision: submittedRevision,
          expectedCurrentQuantity: submittedCurrentQuantity,
          requestKey: submittedRequestKey,
        },
      });
      if (
        !isValidSavedMovementItemPayload(response?.item) ||
        !isValidStockMovementPayload(response?.movement) ||
        !matchesPendingMovementAttempt(attemptRecord, response.item, response.movement)
      ) {
        throw new Error("Could not read the server's Stock Used confirmation response.");
      }
      loadTrackerRef.current.next();
      updatePendingAttempts((prev) => removePendingMovementAttempt(prev, "STOCK_USED", itemKey));
      setItems((prev) =>
        prev.map((entry) =>
          getItemKey(entry) === getItemKey(response.item) ? response.item : entry,
        ),
      );
      setUseItem(null);
      const flagged = Boolean(response.item.needsReconciliation);
      setSaveNotice({
        id: nextNoticeId(),
        duration: "detailed",
        title: response.replayed
          ? "Stock used already saved"
          : flagged
            ? "Stock used recorded · Reconciliation needed"
            : "Stock used recorded",
        body: flagged
          ? `${response.replayed ? "Recovered earlier submission: " : ""}Recorded ${formatQuantityLabel(response.movement.quantity, response.movement.unit)} used for ${response.item.name}. Balance is now ${formatQuantityLabel(response.item.currentQuantity, response.item.unit)} and flagged for Owner physical-count reconciliation.`
          : `${response.replayed ? "Recovered earlier submission: " : ""}Deducted ${formatQuantityLabel(response.movement.quantity, response.movement.unit)} from ${response.item.name}. Current balance: ${formatQuantityLabel(response.item.currentQuantity, response.item.unit)}.`,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "STALE_STOCK_BALANCE") {
        updatePendingAttempts((prev) => removePendingMovementAttempt(prev, "STOCK_USED", itemKey));
        const latestItem = isInventoryItemView(err.details?.item) ? err.details.item : null;
        if (latestItem) {
          loadTrackerRef.current.next();
          setItems((prev) =>
            prev.map((entry) => (getItemKey(entry) === getItemKey(latestItem) ? latestItem : entry)),
          );
          setUseItem(latestItem);
        }
        setUseRequestKey(generateClientKey());
        setUseStaleNotice(err.message);
      } else if (err instanceof ApiError && err.code === "REQUEST_KEY_CANCELLED") {
        updatePendingAttempts((prev) => removePendingMovementAttempt(prev, "STOCK_USED", itemKey));
        setPendingBannerFeedback(null);
        const refreshed = await loadItems({ preserveNotice: true, force: true });
        const updatedTarget = refreshed?.find((entry) => getItemKey(entry) === itemKey);
        if (updatedTarget) {
          setUseItem(updatedTarget);
        }
        setUseRequestKey(generateClientKey());
        setUseError(err.message);
      } else if (
        (err instanceof ApiError && err.status === 401) ||
        isUncertainSubmissionError(err)
      ) {
        setUseError(
          `${err instanceof ApiError ? err.message : "Could not confirm whether Stock Used saved."} Retry this exact submission or run Check status before entering a new one.`,
        );
      } else {
        updatePendingAttempts((prev) => removePendingMovementAttempt(prev, "STOCK_USED", itemKey));
        setUseError(
          err instanceof ApiError ? err.message : "Could not record Stock Used. Please try again.",
        );
      }
    } finally {
      setRecordingUse(false);
    }
  }

  async function handleOpeningSubmit(event: FormEvent, item: InventoryItemView) {
    event.preventDefault();
    if (
      loadingRef.current ||
      loading ||
      submittingRef.current ||
      submittingKey !== null ||
      !permissions?.canInitializeOpeningStock
    ) {
      return;
    }

    const itemKey = getItemKey(item);
    const parsed = parseOpeningQuantityInput(
      inputs[itemKey] ?? "",
      item.unit,
      Boolean(item.allowDecimalQuantity),
    );
    if (!parsed.ok) {
      setFieldErrors((prev) => ({ ...prev, [itemKey]: parsed.message }));
      inputRefs.current[itemKey]?.focus();
      return;
    }

    const endpointKey = item.shape ?? item.id ?? item.code;
    submittingRef.current = true;
    setSubmittingKey(itemKey);
    loadTrackerRef.current.next();
    setFieldErrors((prev) => ({ ...prev, [itemKey]: undefined }));
    setConflictNotices((prev) => ({ ...prev, [itemKey]: undefined }));
    setSaveNotice(null);

    try {
      const response = await api<{ item: InventoryItemView }>(
        `/api/inventory/items/${encodeURIComponent(endpointKey)}/opening-stock`,
        {
          method: "POST",
          body: { quantity: parsed.quantity },
        },
      );
      loadTrackerRef.current.next();
      setItems((prev) =>
        prev.map((entry) => (getItemKey(entry) === itemKey ? response.item : entry)),
      );
      setInputs((prev) => ({ ...prev, [itemKey]: "" }));
      setSaveNotice({
        id: nextNoticeId(),
        duration: "brief",
        title: "Opening count saved",
        body: `Saved opening count for ${response.item.name}: ${formatQuantityLabel(
          response.item.currentQuantity,
          response.item.unit,
        )}.`,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "OPENING_STOCK_ALREADY_SET") {
        const existingItem = isInventoryItemView(err.details?.item) ? err.details.item : null;
        if (existingItem) {
          loadTrackerRef.current.next();
          setItems((prev) =>
            prev.map((entry) => (getItemKey(entry) === itemKey ? existingItem : entry)),
          );
        } else {
          void loadItems({ preserveNotice: true, force: true });
        }
        setInputs((prev) => ({ ...prev, [itemKey]: "" }));
        setFieldErrors((prev) => ({ ...prev, [itemKey]: undefined }));
        setConflictNotices((prev) => ({
          ...prev,
          [itemKey]: wrapNotice(
            formatAlreadySetNotice(item.name, parsed.quantity, item.unit, existingItem, err.message),
          ),
        }));
      } else {
        setFieldErrors((prev) => ({
          ...prev,
          [itemKey]: err instanceof ApiError ? err.message : "Could not save opening count. Please try again.",
        }));
      }
    } finally {
      submittingRef.current = false;
      setSubmittingKey(null);
    }
  }

  const loadPhase = getInventoryLoadPhase({ hasLoaded, loading, loadError });
  const isRefreshError = loadPhase === "refresh-error";
  const canInitialize = permissions?.canInitializeOpeningStock ?? false;
  const canCreateProduct = permissions?.canCreateProduct ?? false;
  const canRecordReceiving = permissions?.canRecordReceiving ?? canInitialize;
  const canRecordUsage = permissions?.canRecordUsage ?? true;
  const hasUninitialized = items.some((item) => item.status === "NOT_SET");
  const hasOtherItems = items.some((item) => getInventoryItemGroup(item, posSections) === "OTHER");
  const hasOperatingSupplies = items.some((item) => item.category === "OPERATING_SUPPLY");
  const summary = getInventorySummaryCounts(items);
  const discrepancyCount = items.filter(
    (item) => item.needsReconciliation || (item.currentQuantity !== null && item.currentQuantity < 0),
  ).length;
  const filteredItems = filterInventoryItems(items, activeFilter, posSections);
  const groupedSections = groupInventoryItems(items, activeFilter, posSections);

  const merchandiseSectionsForFilter = useMemo(
    () =>
      [...posSections]
        .filter((s) => s.code !== "CONTAINERS")
        .sort((a, b) => {
          if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        }),
    [posSections],
  );

  const reconcileParsedCount = reconcileItem
    ? parsePhysicalCountInput(
        reconcileCountInput,
        reconcileItem.unit,
        Boolean(reconcileItem.allowDecimalQuantity),
      )
    : null;
  const reconcilePreview =
    reconcileItem &&
    reconcileItem.currentQuantity !== null &&
    reconcileParsedCount?.ok
      ? computeReconciliationPreview(reconcileItem.currentQuantity, reconcileParsedCount.quantity)
      : null;

  const receiveParsedQty = receiveItem
    ? parseMovementQuantityInput(
        receiveQtyInput,
        receiveItem.unit,
        Boolean(receiveItem.allowDecimalQuantity),
      )
    : null;
  const receivePreviewAfter =
    receiveItem && receiveItem.currentQuantity !== null && receiveParsedQty?.ok
      ? (Math.round(receiveItem.currentQuantity * QUANTITY_SCALE) +
          Math.round(receiveParsedQty.quantity * QUANTITY_SCALE)) /
        QUANTITY_SCALE
      : null;

  const useParsedQty = useItem
    ? parseMovementQuantityInput(
        useQtyInput,
        useItem.unit,
        Boolean(useItem.allowDecimalQuantity),
      )
    : null;
  const usePreviewAfter =
    useItem && useItem.currentQuantity !== null && useParsedQty?.ok
      ? (Math.round(useItem.currentQuantity * QUANTITY_SCALE) -
          Math.round(useParsedQty.quantity * QUANTITY_SCALE)) /
        QUANTITY_SCALE
      : null;

  const refreshLabel =
    loadPhase === "initial-loading" ? "Loading…" : hasLoaded && loading ? "Refreshing…" : "Refresh";

  return (
    <AppShell activeKey="inventory" sectionName="Inventory" pageLabel="Inventory" modulesData={modulesData}>
      <div className="inventory-top">
        <section className="page-header page-header--split">
          <div>
            <h1>Inventory</h1>
            <p className="page-subtitle">Manage your supplies, merchandise pricing, and stock levels</p>
          </div>
          <div className="page-header__actions">
            {canCreateProduct && (
              <button
                type="button"
                className="button button--primary"
                onClick={openAddProductModal}
                disabled={loading || submittingKey !== null}
              >
                + Add Product
              </button>
            )}
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void loadItems()}
              disabled={loading || submittingKey !== null}
            >
              {refreshLabel}
            </button>
          </div>
        </section>

        {hasLoaded && (
          <div className="inventory-toolbar">
            <div className="inventory-filters" role="group" aria-label="Inventory category filters">
              <button
                type="button"
                className={`inventory-filter-pill${activeFilter === "ALL" ? " inventory-filter-pill--active" : ""}`}
                aria-pressed={activeFilter === "ALL"}
                onClick={() => setActiveFilter("ALL")}
              >
                All items
              </button>
              <button
                type="button"
                className={`inventory-filter-pill${activeFilter === "CONTAINER" ? " inventory-filter-pill--active" : ""}`}
                aria-pressed={activeFilter === "CONTAINER"}
                onClick={() => setActiveFilter("CONTAINER")}
              >
                Containers
              </button>
              {merchandiseSectionsForFilter.map((section) => (
                <button
                  key={section.code}
                  type="button"
                  className={`inventory-filter-pill${activeFilter === section.code ? " inventory-filter-pill--active" : ""}`}
                  aria-pressed={activeFilter === section.code}
                  onClick={() => setActiveFilter(section.code)}
                >
                  {section.name}
                </button>
              ))}
              {hasOtherItems && (
                <button
                  type="button"
                  className={`inventory-filter-pill${activeFilter === "OTHER" ? " inventory-filter-pill--active" : ""}`}
                  aria-pressed={activeFilter === "OTHER"}
                  onClick={() => setActiveFilter("OTHER")}
                >
                  Other Products
                </button>
              )}
              {hasOperatingSupplies && (
                <button
                  type="button"
                  className={`inventory-filter-pill${activeFilter === "OPERATING_SUPPLY" ? " inventory-filter-pill--active" : ""}`}
                  aria-pressed={activeFilter === "OPERATING_SUPPLY"}
                  onClick={() => setActiveFilter("OPERATING_SUPPLY")}
                >
                  Operating Supplies
                </button>
              )}
            </div>

            <div
              className="inventory-status-legend"
              aria-label={isRefreshError ? "Last loaded stock status summary" : "Stock status summary"}
            >
              <span className="inventory-status-pill inventory-status-pill--unset">{summary.notSet} Not Set</span>
              <span className="inventory-status-pill inventory-status-pill--out">{summary.noStock} No Stock</span>
              <span className="inventory-status-pill inventory-status-pill--in">{summary.inStock} In Stock</span>
              {discrepancyCount > 0 && (
                <span className="inventory-status-pill inventory-status-pill--discrepancy">
                  {discrepancyCount} Needs Reconciliation
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {saveNotice && (
        <TemporaryNotice
          occurrenceId={saveNotice.id}
          duration={saveNotice.duration}
          className="callout callout--success"
          role="status"
          closeLabel="Close inventory notice"
          onDismiss={() => setSaveNotice(null)}
        >
          <p className="callout__title">{saveNotice.title}</p>
          <p className="callout__body">{saveNotice.body}</p>
        </TemporaryNotice>
      )}

      {pendingAttempts.length > 0 && (
        <div className="callout callout--warning" role="status">
          <p className="callout__title">Unresolved stock submissions need status check</p>
          <p className="callout__body">
            Check the server status before recording another entry so a saved submission is not repeated.
          </p>
          {pendingBannerFeedback && (
            <div
              className={
                pendingBannerFeedback.tone === "error"
                  ? "alert alert--error"
                  : "callout callout--warning"
              }
              role={pendingBannerFeedback.tone === "error" ? "alert" : "status"}
            >
              {pendingBannerFeedback.message}
            </div>
          )}
          <ul className="conflict-list">
            {pendingAttempts.map((attempt) => {
              const targetItem = items.find((entry) => getItemKey(entry) === attempt.itemKey);
              const isChecking = checkingPendingKey === attempt.requestKey;
              return (
                <li key={`${attempt.movementType}-${attempt.itemKey}`}>
                  <strong>
                    {attempt.movementType === "STOCK_RECEIVED" ? "Stock Received" : "Stock Used"}
                  </strong>{" "}
                  · {attempt.itemName} ({attempt.quantityInput} {attempt.unit} on {attempt.effectiveDate})
                  <div className="inventory-card-reconcile-row">
                    {targetItem && (
                      <button
                        type="button"
                        className="button button--ghost button--sm"
                        disabled={checkingPendingKey !== null}
                        onClick={() =>
                          attempt.movementType === "STOCK_RECEIVED"
                            ? openReceiveModal(targetItem)
                            : openUseModal(targetItem)
                        }
                      >
                        Resume
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button--primary button--sm"
                      disabled={checkingPendingKey !== null}
                      onClick={() => void handleCheckPendingAttemptStatus(attempt)}
                    >
                      {isChecking ? "Checking…" : "Check status"}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      disabled={checkingPendingKey !== null}
                      onClick={() => void handleCancelPendingAttempt(attempt)}
                    >
                      Cancel earlier attempt
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {items.some((item) => (item.pendingStockReviews?.length ?? 0) > 0) && (
        <div className="callout callout--warning" role="status">
          <p className="callout__title">Sale-return stock reviews awaiting physical count</p>
          <p className="callout__body">
            One or more voided or corrected sales had unclear physical-count coverage. Reconcile
            the flagged product below with a physical count (INV-009) to confirm actual on-hand
            stock.
          </p>
        </div>
      )}

      {loadError && (
        <div className="alert alert--error inventory-load-alert" role="alert">
          <div className="inventory-load-alert__copy">
            <strong>{loadError}</strong>
            <span className="inventory-load-alert__detail">
              {hasLoaded
                ? "Showing the last loaded stock values below. Retry to fetch current counts."
                : "Stock totals and inventory items will appear once Inventory loads."}
            </span>
          </div>
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={() => void loadItems()}
            disabled={loading || submittingKey !== null}
          >
            Retry
          </button>
        </div>
      )}

      {loadPhase === "initial-loading" && (
        <section className="inventory-state-card" role="status" aria-live="polite">
          <p className="inventory-state-card__title">Loading inventory stock…</p>
          <p className="muted-sm">Fetching containers, merchandise products, and opening counts.</p>
        </section>
      )}

      {hasLoaded && (
        <section
          className={`inventory-board${isRefreshError ? " inventory-board--stale" : ""}`}
          aria-label="Inventory stock board"
          aria-busy={loading}
        >
          {isRefreshError && (
            <div className="inventory-stale-banner" role="status">
              <strong>Last loaded values</strong>
              <span>Refresh failed — counts shown below may be out of date until Inventory refreshes.</span>
            </div>
          )}

          {filteredItems.length === 0 ? (
            <div className="inventory-empty-group">
              <p className="muted-sm">No inventory products in this category yet.</p>
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={() => setActiveFilter("ALL")}
              >
                Show all items
              </button>
            </div>
          ) : (
            groupedSections.map((group) => (
              <div key={group.key} className="inventory-group">
                <div className="inventory-group__header">
                  <h2>{group.title}</h2>
                  <span className="inventory-group__meta">
                    {group.metaPrefix} · {group.items.length} {group.items.length === 1 ? "item" : "items"}
                  </span>
                </div>

                <div className="inventory-item-grid">
                  {group.items.map((item) => {
                    const itemKey = getItemKey(item);
                    const statusMeta = getStockStatusMeta(item);
                    const isNotSet = statusMeta.tone === "unset";
                    const isZero = statusMeta.tone === "out";
                    const isContainer = item.category === "CONTAINER";
                    const isMerchandise = item.category === "MERCHANDISE";
                    const isSupply = item.category === "OPERATING_SUPPLY";
                    const isNegativeBalance = item.currentQuantity !== null && item.currentQuantity < 0;
                    const formError = fieldErrors[itemKey];
                    const conflictNotice = conflictNotices[itemKey];
                    const actionError = cardActionError[itemKey];
                    const isSubmitting = submittingKey === itemKey;
                    const isToggling = togglingItemKey === itemKey;
                    const isPickingSection = Boolean(item.id && sectionPickerItemId === item.id);
                    const inputId = `opening-count-${itemKey.toLowerCase()}`;
                    const hintId = `${inputId}-hint`;
                    const subtitle = item.shape
                      ? getContainerSubtitle(item.shape)
                      : item.description ??
                        (isSupply
                          ? `Operating supply (${item.unit}${item.allowDecimalQuantity ? ", measured decimals" : ", whole units"})`
                          : `Standalone merchandise (${item.unit})`);

                    return (
                      <article key={itemKey} className="inventory-item-card" aria-labelledby={`heading-${itemKey}`}>
                        <div className="inventory-item-card__head">
                          <div className="inventory-item-card__title-row">
                            <h3 id={`heading-${itemKey}`}>{item.name}</h3>
                            {isMerchandise && item.unitPriceCentavos != null && (
                              <span className="inventory-item-card__price">
                                {formatPesoCentavos(item.unitPriceCentavos)}
                              </span>
                            )}
                          </div>
                          <p className="inventory-item-card__subtitle">{subtitle}</p>
                          {isContainer && item.shape && (
                            <p className="inventory-item-card__packages">
                              {getContainerPackageSummary(item.shape)}
                            </p>
                          )}
                          {isMerchandise && item.posSection && (
                            <p className="inventory-item-card__section-tag">
                              POS section: {getPosSectionLabel(item.posSection, posSections)}
                            </p>
                          )}
                          {(item.lowStockLevel != null ||
                            (isMerchandise && item.faucetReportingType != null)) && (
                            <p className="inventory-item-card__section-tag">
                              {item.lowStockLevel != null
                                ? `Low stock alert: ≤ ${formatQuantityLabel(item.lowStockLevel, item.unit)}`
                                : null}
                              {item.lowStockLevel != null &&
                              isMerchandise &&
                              item.faucetReportingType != null
                                ? " · "
                                : null}
                              {isMerchandise && item.faucetReportingType != null
                                ? `Faucet type: ${formatFaucetReportingTypeLabel(item.faucetReportingType)}`
                                : null}
                            </p>
                          )}
                        </div>

                        <div className="inventory-item-card__pos-row">
                          <span
                            className={`inventory-pos-badge ${
                              isSupply
                                ? "inventory-pos-badge--hidden"
                                : item.showInPos
                                  ? "inventory-pos-badge--shown"
                                  : "inventory-pos-badge--hidden"
                            }`}
                          >
                            {isSupply
                              ? "Station Operating Supply"
                              : item.showInPos
                                ? "Shown in POS"
                                : "Hidden from POS"}
                          </span>

                          {canCreateProduct && (
                            <div className="inventory-item-card__actions">
                              {isContainer && item.shape && (
                                <>
                                  <button
                                    type="button"
                                    className="button button--ghost button--sm"
                                    disabled={isToggling || submittingKey !== null}
                                    onClick={() =>
                                      void handleToggleContainerVisibility(item.shape!, !item.showInPos)
                                    }
                                  >
                                    {isToggling
                                      ? "Updating…"
                                      : item.showInPos
                                        ? "Hide from POS"
                                        : "Show in POS"}
                                  </button>
                                  <button
                                    type="button"
                                    className="button button--ghost button--sm"
                                    disabled={isToggling || submittingKey !== null}
                                    onClick={() => openContainerAlertModal(item)}
                                  >
                                    Low stock alert
                                  </button>
                                </>
                              )}

                              {isMerchandise && item.id && (
                                <>
                                  <button
                                    type="button"
                                    className="button button--ghost button--sm"
                                    disabled={isToggling || submittingKey !== null}
                                    onClick={() => void handleToggleShowInPos(item, !item.showInPos)}
                                  >
                                    {isToggling
                                      ? "Updating…"
                                      : item.showInPos
                                        ? "Hide from POS"
                                        : "Show in POS"}
                                  </button>
                                  <button
                                    type="button"
                                    className="button button--ghost button--sm"
                                    disabled={isToggling || submittingKey !== null}
                                    onClick={() => openEditProductModal(item)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="button button--ghost button--sm"
                                    disabled={isToggling || submittingKey !== null}
                                    onClick={() => openArchiveModal(item)}
                                  >
                                    Archive
                                  </button>
                                </>
                              )}

                              {isSupply && item.id && (
                                <>
                                  <button
                                    type="button"
                                    className="button button--ghost button--sm"
                                    disabled={isToggling || submittingKey !== null}
                                    onClick={() => openEditProductModal(item)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="button button--ghost button--sm"
                                    disabled={isToggling || submittingKey !== null}
                                    onClick={() => openArchiveModal(item)}
                                  >
                                    Archive
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>

                        {isPickingSection && item.id && (
                          <div className="inventory-section-picker">
                            <PosSectionPicker
                              label="Choose POS section"
                              ariaLabel={`POS section for ${item.name}`}
                              value={sectionPickerValue}
                              onChange={setSectionPickerValue}
                              sections={posSections}
                              disabled={isToggling}
                              onSectionCreated={handleSectionCreated}
                            />
                            <div className="inventory-section-picker__actions">
                              <button
                                type="button"
                                className="button button--primary button--sm"
                                disabled={isToggling || !sectionPickerValue}
                                onClick={() => void handleToggleShowInPos(item, true, sectionPickerValue)}
                              >
                                Confirm Show in POS
                              </button>
                              <button
                                type="button"
                                className="button button--ghost button--sm"
                                disabled={isToggling}
                                onClick={() => setSectionPickerItemId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {actionError && (
                          <TemporaryNotice
                            occurrenceId={actionError.id}
                            duration="brief"
                            className="alert alert--error inventory-card-alert"
                            role="alert"
                            closeLabel={`Close ${item.name} action error`}
                            onDismiss={() =>
                              setCardActionError((prev) => ({ ...prev, [itemKey]: undefined }))
                            }
                          >
                            {actionError.data}
                          </TemporaryNotice>
                        )}

                        <div className="inventory-item-card__metric-row">
                          <strong
                            className={`inventory-item-card__qty${
                              isNotSet
                                ? " inventory-item-card__qty--unset"
                                : isNegativeBalance
                                  ? " inventory-item-card__qty--negative"
                                  : ""
                            }`}
                          >
                            {isNotSet ? "Not Set" : formatQuantityLabel(item.currentQuantity, item.unit)}
                          </strong>
                          <span className={`inventory-status-pill inventory-status-pill--${statusMeta.tone}`}>
                            {statusMeta.label}
                          </span>
                        </div>

                        {conflictNotice && (
                          <TemporaryNotice
                            occurrenceId={conflictNotice.id}
                            duration="detailed"
                            className="alert alert--error inventory-card-alert"
                            role="alert"
                            closeLabel={`Close ${item.name} conflict notice`}
                            onDismiss={() =>
                              setConflictNotices((prev) => ({ ...prev, [itemKey]: undefined }))
                            }
                          >
                            {conflictNotice.data}
                          </TemporaryNotice>
                        )}

                        <div className="inventory-item-card__body">
                          {!isNotSet && item.openingStock ? (
                            <>
                              <dl className="detail-list inventory-detail-list">
                                <div className="detail-list__row">
                                  <dt>Opening count</dt>
                                  <dd>{formatQuantityLabel(item.openingStock.quantity, item.openingStock.unit)}</dd>
                                </div>
                                <div className="detail-list__row">
                                  <dt>Recorded by</dt>
                                  <dd>{item.openingStock.recordedBy}</dd>
                                </div>
                                <div className="detail-list__row">
                                  <dt>Recorded at</dt>
                                  <dd>{formatRecordedAtManila(item.openingStock.recordedAt)}</dd>
                                </div>
                                {item.availableQuantity !== undefined &&
                                  item.availableQuantity !== null &&
                                  (item.activeHolds ?? []).some((h) => h.reducesAvailability) && (
                                    <div className="detail-list__row">
                                      <dt>Available to sell</dt>
                                      <dd>
                                        {formatQuantityLabel(item.availableQuantity, item.unit)} (
                                        {formatQuantityLabel(
                                          (item.activeHolds ?? [])
                                            .filter((h) => h.reducesAvailability)
                                            .reduce((sum, h) => sum + h.quantity, 0),
                                          item.unit,
                                        )}{" "}
                                        held pre-sale)
                                      </dd>
                                    </div>
                                  )}
                                {item.latestReconciliation && (
                                  <div className="detail-list__row">
                                    <dt>Last physical count</dt>
                                    <dd>
                                      {formatQuantityLabel(
                                        item.latestReconciliation.physicalCount,
                                        item.latestReconciliation.unit,
                                      )}{" "}
                                      ({formatSignedDelta(
                                        item.latestReconciliation.quantityDelta,
                                        item.latestReconciliation.unit,
                                      )}
                                      ) · {item.latestReconciliation.recordedBy}
                                    </dd>
                                  </div>
                                )}
                              </dl>
                              {item.activeHolds && item.activeHolds.length > 0 && (
                                <div className="callout callout--warning" role="status">
                                  <p className="callout__title">Held / unavailable units</p>
                                  <ul className="conflict-list">
                                    {item.activeHolds.map((hold) => (
                                      <li key={hold.id}>
                                        <strong>
                                          {formatQuantityLabel(hold.quantity, hold.unit)}
                                        </strong>{" "}
                                        · <span className="mono-ref">{hold.posReference}</span> —{" "}
                                        {hold.reason}{" "}
                                        <span className="muted-sm">
                                          (
                                          {hold.reducesAvailability
                                            ? "held from available stock"
                                            : "post-sale damaged/held exclusion — already outside sellable stock"}
                                          )
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {item.pendingStockReviews && item.pendingStockReviews.length > 0 && (
                                <div className="callout callout--warning" role="status">
                                  <p className="callout__title">
                                    Physical count reconciliation needed (INV-009)
                                  </p>
                                  <ul className="conflict-list">
                                    {item.pendingStockReviews.map((review) => (
                                      <li key={review.saleActionReference}>
                                        <span className="mono-ref">
                                          {review.saleActionReference}
                                        </span>{" "}
                                        ({review.actionType} {review.originalSaleReference}):{" "}
                                        <strong>
                                          {formatQuantityLabel(
                                            review.unclearQuantity,
                                            review.unit,
                                          )}
                                        </strong>{" "}
                                        not automatically restored due to unclear count coverage. Run
                                        Correct / count stock to reconcile.
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {item.needsReconciliation && (
                                <div className="callout callout--warning" role="status">
                                  <p className="callout__title">Discrepancy flagged for Owner count</p>
                                  <p className="callout__body">
                                    Recorded usage exceeded system stock. Receiving stock does not clear this flag;
                                    run Correct stock with an actual physical count (INV-009) to reconcile.
                                  </p>
                                </div>
                              )}
                              {item.latestReconciliation && (
                                <p className="inventory-card-footnote">
                                  Last count reason: {item.latestReconciliation.reason} (
                                  {formatRecordedAtManila(item.latestReconciliation.recordedAt)})
                                </p>
                              )}
                              <p className="inventory-card-footnote">
                                {isZero
                                  ? "Explicit zero confirmed · Opening count is preserved."
                                  : "Opening count is preserved and cannot be overwritten."}
                              </p>
                              {(canRecordReceiving || (isSupply && canRecordUsage) || canInitialize) && (
                                <div className="inventory-card-reconcile-row">
                                  {canRecordReceiving && (
                                    <button
                                      type="button"
                                      className="button button--ghost button--sm"
                                      disabled={loading || submittingKey !== null}
                                      onClick={() => openReceiveModal(item)}
                                    >
                                      Stock Received
                                    </button>
                                  )}
                                  {isSupply && canRecordUsage && (
                                    <button
                                      type="button"
                                      className="button button--ghost button--sm"
                                      disabled={loading || submittingKey !== null}
                                      onClick={() => openUseModal(item)}
                                    >
                                      Stock Used
                                    </button>
                                  )}
                                  {canInitialize && (
                                    <button
                                      type="button"
                                      className="button button--ghost button--sm"
                                      disabled={loading || submittingKey !== null}
                                      onClick={() => openReconcileModal(item)}
                                    >
                                      Correct stock
                                    </button>
                                  )}
                                </div>
                              )}
                            </>
                          ) : canInitialize ? (
                            <form
                              className="inventory-form"
                              onSubmit={(event) => void handleOpeningSubmit(event, item)}
                              noValidate
                            >
                              {formError && (
                                <div className="alert alert--error inventory-card-alert" role="alert">
                                  {formError}
                                </div>
                              )}

                              <label className="field" htmlFor={inputId}>
                                <span>Opening count ({item.unit}) *</span>
                                <input
                                  id={inputId}
                                  ref={(el) => {
                                    inputRefs.current[itemKey] = el;
                                  }}
                                  name={`openingQuantity-${itemKey}`}
                                  type="text"
                                  inputMode={item.allowDecimalQuantity ? "decimal" : "numeric"}
                                  pattern={item.allowDecimalQuantity ? undefined : "[0-9]*"}
                                  autoComplete="off"
                                  placeholder="0"
                                  value={inputs[itemKey] ?? ""}
                                  aria-describedby={hintId}
                                  disabled={loading || submittingKey !== null}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setInputs((prev) => ({ ...prev, [itemKey]: value }));
                                    setFieldErrors((prev) => ({ ...prev, [itemKey]: undefined }));
                                  }}
                                />
                                <small id={hintId}>
                                  Enter actual physical count (0 if none
                                  {item.allowDecimalQuantity ? ", up to 4 decimals" : ""}).
                                </small>
                              </label>

                              <button
                                type="submit"
                                className="button button--primary button--block"
                                disabled={loading || submittingKey !== null}
                              >
                                {getOpeningSubmitLabel(item, isSubmitting)}
                              </button>
                            </form>
                          ) : (
                            <p className="inventory-readonly-note">Waiting for Owner to record the opening count.</p>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            ))
          )}

          {permissions && !canInitialize && (
            <div className="inventory-board-note" role="status">
              <span className="inventory-board-note__title">Employee Inventory access</span>
              <span>
                Employee can view stock counts and record Stock Used for initialized operating supplies. Only the
                Owner can add or edit products, manage POS visibility, record Stock Received, archive items,
                record initial opening counts, or reconcile physical stock counts.
              </span>
            </div>
          )}

          {permissions && canInitialize && hasUninitialized && (
            <div className="inventory-board-note">
              <span className="inventory-board-note__title">Record actual opening counts once per item</span>
              <span>
                Count each item separately in its confirmed stock unit. Enter 0 when none are in stock. Items stay Not
                Set until their opening count is recorded.
              </span>
            </div>
          )}
        </section>
      )}

      {addProductOpen && canCreateProduct && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-product-title"
          >
            <div className="detail-card__header">
              <div>
                <h2 id="add-product-title">Add Product</h2>
                <p className="muted-sm">
                  {productCategory === "OPERATING_SUPPLY"
                    ? "Create an operating supply in its single confirmed stock unit."
                    : "Create standalone merchandise in Inventory and choose whether to show it in POS."}
                </p>
              </div>
            </div>

            <form className="subview" onSubmit={(event) => void handleCreateProduct(event)} noValidate>
              <label className="field">
                <span>Item type *</span>
                <select
                  aria-label="Item type"
                  disabled={creatingProduct}
                  value={productCategory}
                  onChange={(e) => {
                    const nextCategory = e.target.value as "MERCHANDISE" | "OPERATING_SUPPLY";
                    setProductCategory(nextCategory);
                    if (nextCategory === "MERCHANDISE") {
                      setProductAllowDecimal(false);
                    }
                    setAddProductError(null);
                  }}
                >
                  <option value="MERCHANDISE">Merchandise (sold in POS)</option>
                  <option value="OPERATING_SUPPLY">Operating Supply (station use only)</option>
                </select>
              </label>

              <label className="field">
                <span>{productCategory === "OPERATING_SUPPLY" ? "Supply name *" : "Product name *"}</span>
                <input
                  ref={addNameInputRef}
                  type="text"
                  maxLength={80}
                  placeholder={
                    productCategory === "OPERATING_SUPPLY"
                      ? "e.g. Dishwashing Liquid"
                      : "e.g. Push-Type Faucet"
                  }
                  disabled={creatingProduct}
                  value={productName}
                  onChange={(e) => {
                    setProductName(e.target.value);
                    setAddProductError(null);
                  }}
                />
              </label>

              <label className="field">
                <span>Short description (optional)</span>
                <input
                  type="text"
                  maxLength={160}
                  placeholder={
                    productCategory === "OPERATING_SUPPLY"
                      ? "e.g. Used for sanitizing containers"
                      : "e.g. Press to dispense water"
                  }
                  disabled={creatingProduct}
                  value={productDescription}
                  onChange={(e) => {
                    setProductDescription(e.target.value);
                    setAddProductError(null);
                  }}
                />
                {productCategory === "MERCHANDISE" && (
                  <small>Shown on the POS product card when entered.</small>
                )}
              </label>

              <div className="field-row">
                <label className="field">
                  <span>Stock unit *</span>
                  <input
                    type="text"
                    maxLength={30}
                    placeholder={productCategory === "OPERATING_SUPPLY" ? "e.g. L, kg, pcs" : "e.g. pcs"}
                    disabled={creatingProduct}
                    value={productUnit}
                    onChange={(e) => {
                      setProductUnit(e.target.value);
                      setAddProductError(null);
                    }}
                  />
                  <small>Enter deliveries and counts in this same unit (no pack conversion).</small>
                </label>

                {productCategory === "MERCHANDISE" ? (
                  <label className="field">
                    <span>Selling price (₱) *</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="e.g. 40.00"
                      disabled={creatingProduct}
                      value={productPriceInput}
                      onChange={(e) => {
                        setProductPriceInput(e.target.value);
                        setAddProductError(null);
                      }}
                    />
                  </label>
                ) : (
                  <label className="field">
                    <span>Low stock alert level (optional)</span>
                    <input
                      type="text"
                      inputMode={productAllowDecimal ? "decimal" : "numeric"}
                      pattern={productAllowDecimal ? undefined : "[0-9]*"}
                      placeholder="Leave blank for no alert"
                      disabled={creatingProduct}
                      value={productLowStockInput}
                      onChange={(e) => {
                        setProductLowStockInput(e.target.value);
                        setAddProductError(null);
                      }}
                    />
                    <small>Alerts in Dashboard when positive stock is at or below this level.</small>
                  </label>
                )}
              </div>

              {productCategory === "OPERATING_SUPPLY" && (
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={productAllowDecimal}
                    disabled={creatingProduct}
                    onChange={(e) => {
                      setProductAllowDecimal(e.target.checked);
                      setAddProductError(null);
                    }}
                  />
                  <span>Allow decimal quantities (e.g. 1.25 L or 0.5 kg)</span>
                </label>
              )}

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={productUnitConfirmed}
                  disabled={creatingProduct}
                  onChange={(e) => {
                    setProductUnitConfirmed(e.target.checked);
                    setAddProductError(null);
                  }}
                />
                <span>Confirm stock recording unit ({productUnit.trim() || "unit"}) *</span>
              </label>

              {productCategory === "MERCHANDISE" && (
                <>
                  <div className="inventory-pos-visibility-box">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={productShowInPos}
                        disabled={creatingProduct}
                        onChange={(e) => {
                          setProductShowInPos(e.target.checked);
                          setAddProductError(null);
                        }}
                      />
                      <span>Show in POS</span>
                    </label>

                    <PosSectionPicker
                      label={`POS section ${productShowInPos ? "*" : "(optional while hidden)"}`}
                      ariaLabel="POS section"
                      value={productPosSection}
                      onChange={(nextCode) => {
                        setProductPosSection(nextCode);
                        setAddProductError(null);
                      }}
                      sections={posSections}
                      allowBlank
                      disabled={creatingProduct}
                      helperText="Controls which POS group displays this card when Show in POS is enabled. Opening physical stock is recorded separately after saving."
                      onSectionCreated={handleSectionCreated}
                    />
                  </div>

                  <div className="field-row">
                    <label className="field">
                      <span>Low stock alert level (optional)</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="Leave blank for no alert"
                        disabled={creatingProduct}
                        value={productLowStockInput}
                        onChange={(e) => {
                          setProductLowStockInput(e.target.value);
                          setAddProductError(null);
                        }}
                      />
                      <small>Alerts in Dashboard when positive stock is at or below this count.</small>
                    </label>

                    <label className="field">
                      <span>Faucet reporting type (optional)</span>
                      <select
                        aria-label="Faucet reporting type"
                        disabled={creatingProduct}
                        value={productFaucetType}
                        onChange={(e) => {
                          setProductFaucetType(e.target.value as "" | FaucetReportingType);
                          setAddProductError(null);
                        }}
                      >
                        <option value="">Not classified</option>
                        <option value="PUSH_TYPE">Push-Type Faucet</option>
                        <option value="TWIST_TYPE">Twist-Type Faucet</option>
                      </select>
                      <small>Set only for standalone Push-Type or Twist-Type faucets.</small>
                    </label>
                  </div>
                </>
              )}

              {addProductError && (
                <div className="alert alert--error" role="alert">
                  {addProductError}
                </div>
              )}

              <div className="modal__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={creatingProduct}
                  onClick={() => setAddProductOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="button button--primary" disabled={creatingProduct}>
                  {creatingProduct
                    ? "Saving…"
                    : productCategory === "OPERATING_SUPPLY"
                      ? "Save Operating Supply"
                      : "Save Product"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editProductItem && canCreateProduct && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-product-title"
          >
            <div className="detail-card__header">
              <div>
                <h2 id="edit-product-title">
                  {editProductItem.category === "OPERATING_SUPPLY"
                    ? "Edit Operating Supply"
                    : "Edit Product"}
                </h2>
                <p className="muted-sm">
                  {editProductItem.category === "OPERATING_SUPPLY"
                    ? `Update details for ${editProductItem.name}. To change its stock unit, archive this item and add a replacement with a new physical count.`
                    : `Update details for ${editProductItem.name}. Future POS sales use the updated details while saved sales keep their original snapshots.`}
                </p>
              </div>
            </div>

            <form className="subview" onSubmit={(event) => void handleSaveProductEdit(event)} noValidate>
              <label className="field">
                <span>
                  {editProductItem.category === "OPERATING_SUPPLY"
                    ? "Supply name *"
                    : "Product name *"}
                </span>
                <input
                  ref={editNameInputRef}
                  type="text"
                  maxLength={80}
                  disabled={savingEdit}
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value);
                    setEditError(null);
                  }}
                />
              </label>

              <label className="field">
                <span>Short description (optional)</span>
                <input
                  type="text"
                  maxLength={160}
                  disabled={savingEdit}
                  value={editDescription}
                  onChange={(e) => {
                    setEditDescription(e.target.value);
                    setEditError(null);
                  }}
                />
              </label>

              <div className="field-row">
                <div className="field">
                  <span>Confirmed stock unit</span>
                  <div className="inventory-readonly-note">
                    <strong>{editProductItem.unit}</strong>{" "}
                    {editProductItem.allowDecimalQuantity ? "(decimals allowed)" : "(whole units)"} — archive and
                    add a replacement to change unit
                  </div>
                </div>

                {editProductItem.category === "MERCHANDISE" ? (
                  <label className="field">
                    <span>Selling price (₱) *</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      disabled={savingEdit}
                      value={editPriceInput}
                      onChange={(e) => {
                        setEditPriceInput(e.target.value);
                        setEditError(null);
                      }}
                    />
                  </label>
                ) : (
                  <label className="field">
                    <span>Low stock alert level (optional)</span>
                    <input
                      type="text"
                      inputMode={editProductItem.allowDecimalQuantity ? "decimal" : "numeric"}
                      pattern={editProductItem.allowDecimalQuantity ? undefined : "[0-9]*"}
                      placeholder="Leave blank to clear"
                      disabled={savingEdit}
                      value={editLowStockInput}
                      onChange={(e) => {
                        setEditLowStockInput(e.target.value);
                        setEditError(null);
                      }}
                    />
                    <small>Positive quantity in {editProductItem.unit}. Leave blank to remove alert.</small>
                  </label>
                )}
              </div>

              {editProductItem.category === "MERCHANDISE" && (
                <>
                  <div className="inventory-pos-visibility-box">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={editShowInPos}
                        disabled={savingEdit}
                        onChange={(e) => {
                          setEditShowInPos(e.target.checked);
                          setEditError(null);
                        }}
                      />
                      <span>Show in POS</span>
                    </label>

                    <PosSectionPicker
                      label={`POS section ${editShowInPos ? "*" : "(optional while hidden)"}`}
                      ariaLabel="Edit POS section"
                      value={editPosSection}
                      onChange={(nextCode) => {
                        setEditPosSection(nextCode);
                        setEditError(null);
                      }}
                      sections={posSections}
                      allowBlank
                      disabled={savingEdit}
                      onSectionCreated={handleSectionCreated}
                    />
                  </div>

                  <div className="field-row">
                    <label className="field">
                      <span>Low stock alert level (optional)</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="Leave blank to clear"
                        disabled={savingEdit}
                        value={editLowStockInput}
                        onChange={(e) => {
                          setEditLowStockInput(e.target.value);
                          setEditError(null);
                        }}
                      />
                      <small>Positive count in {editProductItem.unit}. Leave blank to remove alert.</small>
                    </label>

                    <label className="field">
                      <span>Faucet reporting type (optional)</span>
                      <select
                        aria-label="Edit faucet reporting type"
                        disabled={savingEdit}
                        value={editFaucetType}
                        onChange={(e) => {
                          setEditFaucetType(e.target.value as "" | FaucetReportingType);
                          setEditError(null);
                        }}
                      >
                        <option value="">Not classified</option>
                        <option value="PUSH_TYPE">Push-Type Faucet</option>
                        <option value="TWIST_TYPE">Twist-Type Faucet</option>
                      </select>
                      <small>Future POS sales snapshot this setting; saved sales stay unchanged.</small>
                    </label>
                  </div>
                </>
              )}

              {editError && (
                <div className="alert alert--error" role="alert">
                  {editError}
                </div>
              )}

              <div className="modal__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={savingEdit}
                  onClick={() => setEditProductItem(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="button button--primary" disabled={savingEdit}>
                  {savingEdit ? "Saving changes…" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editContainerAlertItem && canCreateProduct && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="container-alert-title"
          >
            <h2 id="container-alert-title">Low stock alert · {editContainerAlertItem.name}</h2>
            <p className="muted-sm">
              Alert in Dashboard Stocks when positive balance is at or below this count (in{" "}
              {editContainerAlertItem.unit}). Saving this setting does not change stock counts or
              movements.
            </p>

            <form className="subview" onSubmit={(event) => void handleSaveContainerAlert(event)} noValidate>
              <label className="field">
                <span>Low stock alert level ({editContainerAlertItem.unit})</span>
                <input
                  ref={containerAlertInputRef}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="Leave blank to clear"
                  disabled={savingContainerAlert}
                  value={containerLowStockInput}
                  onChange={(e) => {
                    setContainerLowStockInput(e.target.value);
                    setContainerAlertError(null);
                  }}
                />
                <small>Enter a positive whole number (1 or more), or leave blank to clear.</small>
              </label>

              {containerAlertError && (
                <div className="alert alert--error" role="alert">
                  {containerAlertError}
                </div>
              )}

              <div className="modal__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={savingContainerAlert}
                  onClick={() => setEditContainerAlertItem(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="button button--primary" disabled={savingContainerAlert}>
                  {savingContainerAlert ? "Saving…" : "Save Alert Level"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {archiveItem && canCreateProduct && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="archive-product-title"
          >
            <h2 id="archive-product-title">Archive {archiveItem.name}?</h2>
            <p className="muted-sm">
              Archiving removes <strong>{archiveItem.name}</strong> from active Inventory
              {archiveItem.category === "MERCHANDISE" ? " and blocks new POS sales" : ""}. Its current balance (
              {formatQuantityLabel(archiveItem.currentQuantity, archiveItem.unit)}), opening count, stock
              movements, and history stay intact in its original unit so you can set up a replacement item if
              needed.
            </p>

            {archiveError && (
              <TemporaryNotice
                occurrenceId={archiveError.id}
                duration="brief"
                className="alert alert--error"
                role="alert"
                closeLabel="Close archive error"
                onDismiss={() => setArchiveError(null)}
              >
                {archiveError.data}
              </TemporaryNotice>
            )}

            <div className="modal__actions">
              <button
                type="button"
                className="button button--ghost"
                disabled={archiving}
                onClick={() => setArchiveItem(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={archiving}
                onClick={() => void handleConfirmArchive()}
              >
                {archiving ? "Archiving…" : "Confirm Archive"}
              </button>
            </div>
          </div>
        </div>
      )}

      {reconcileItem && canInitialize && reconcileItem.currentQuantity !== null && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reconcile-stock-title"
          >
            <div className="detail-card__header">
              <div>
                <h2 id="reconcile-stock-title">Correct stock · {reconcileItem.name}</h2>
                <p className="muted-sm">
                  Physical-count reconciliation (INV-009). Pause sales or movements for this item while counting.
                  Original opening count remains preserved in history.
                </p>
              </div>
            </div>

            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Current recorded balance</dt>
                <dd>
                  <strong>{formatQuantityLabel(reconcileItem.currentQuantity, reconcileItem.unit)}</strong>
                </dd>
              </div>
              {reconcileItem.openingStock && (
                <div className="detail-list__row">
                  <dt>Original opening count</dt>
                  <dd>
                    {formatQuantityLabel(
                      reconcileItem.openingStock.quantity,
                      reconcileItem.openingStock.unit,
                    )}{" "}
                    · {reconcileItem.openingStock.recordedBy} (
                    {formatRecordedAtManila(reconcileItem.openingStock.recordedAt)})
                  </dd>
                </div>
              )}
            </dl>

            {reconcileStaleNotice && (
              <div className="callout callout--warning" role="alert">
                <p className="callout__title">Stock changed during counting — recount required</p>
                <p className="callout__body">{reconcileStaleNotice}</p>
              </div>
            )}

            <form className="subview" onSubmit={(event) => void handleConfirmReconciliation(event)} noValidate>
              <label className="field">
                <span>Actual physical count ({reconcileItem.unit}) *</span>
                <input
                  ref={reconcileCountInputRef}
                  type="text"
                  inputMode={reconcileItem.allowDecimalQuantity ? "decimal" : "numeric"}
                  pattern={reconcileItem.allowDecimalQuantity ? undefined : "[0-9]*"}
                  autoComplete="off"
                  placeholder="0"
                  disabled={reconciling}
                  value={reconcileCountInput}
                  onChange={(e) => {
                    const nextValue = e.target.value;
                    setReconcileCountInput(nextValue);
                    setReconcileError(null);
                    setReconcileRequestKey(generateClientKey());
                    if (reconcileNeedsFreshCount && nextValue.trim() !== "") {
                      setReconcileNeedsFreshCount(false);
                      setReconcileStaleNotice(null);
                    }
                  }}
                />
                <small>
                  Count usable station-owned stock (0 or more
                  {reconcileItem.allowDecimalQuantity ? ", up to 4 decimals" : ""}).
                  {reconcileItem.needsReconciliation
                    ? " Confirming clears this item's discrepancy flag."
                    : ""}
                </small>
              </label>

              <label className="field">
                <span>Factual reason *</span>
                <input
                  type="text"
                  maxLength={240}
                  placeholder="e.g. Physical shelf recount — initial miscount"
                  disabled={reconciling}
                  value={reconcileReasonInput}
                  onChange={(e) => {
                    setReconcileReasonInput(e.target.value);
                    setReconcileError(null);
                    setReconcileRequestKey(generateClientKey());
                  }}
                />
              </label>

              {reconcilePreview && (
                <div className="inventory-reconcile-preview" role="status">
                  <dl className="detail-list inventory-detail-list">
                    <div className="detail-list__row">
                      <dt>Recorded before</dt>
                      <dd>{formatQuantityLabel(reconcilePreview.before, reconcileItem.unit)}</dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>Physical count</dt>
                      <dd>{formatQuantityLabel(reconcilePreview.physicalCount, reconcileItem.unit)}</dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>Calculated difference</dt>
                      <dd>
                        <strong>{formatSignedDelta(reconcilePreview.delta, reconcileItem.unit)}</strong>
                      </dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>Resulting balance</dt>
                      <dd>
                        <strong>{formatQuantityLabel(reconcilePreview.after, reconcileItem.unit)}</strong>
                      </dd>
                    </div>
                  </dl>
                </div>
              )}

              {reconcileError && (
                <div className="alert alert--error" role="alert">
                  {reconcileError}
                </div>
              )}

              <div className="modal__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={reconciling}
                  onClick={() => setReconcileItem(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={reconciling || reconcileNeedsFreshCount}
                >
                  {reconciling
                    ? "Saving…"
                    : reconcilePreview?.delta === 0
                      ? "Confirm Verification"
                      : "Confirm Stock Correction"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {receiveItem && canRecordReceiving && receiveItem.currentQuantity !== null && (() => {
        const receiveKey = getItemKey(receiveItem);
        const pendingReceive = findPendingAttempt("STOCK_RECEIVED", receiveKey);
        const lockedByPending = Boolean(pendingReceive);
        const isCheckingReceive = Boolean(
          pendingReceive && checkingPendingKey === pendingReceive.requestKey,
        );
        return (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="receive-stock-title"
          >
            <div className="detail-card__header">
              <div>
                <h2 id="receive-stock-title">Stock Received · {receiveItem.name}</h2>
                <p className="muted-sm">
                  Add delivered stock in {receiveItem.unit}. Delivery date is locked to this session&apos;s
                  Asia/Manila date; late-date coverage review is added in Task 2.
                </p>
              </div>
            </div>

            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Current balance</dt>
                <dd>
                  <strong>{formatQuantityLabel(receiveItem.currentQuantity, receiveItem.unit)}</strong>
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Delivery date (Asia/Manila)</dt>
                <dd>{receiveEffectiveDate || getTodayManilaDateString()}</dd>
              </div>
            </dl>

            {receiveStaleNotice && (
              <div className="callout callout--warning" role="alert">
                <p className="callout__title">Stock balance changed before saving</p>
                <p className="callout__body">{receiveStaleNotice}</p>
              </div>
            )}

            {lockedByPending && (
              <div className="callout callout--warning" role="status">
                <p className="callout__title">Uncertain submission preserved</p>
                <p className="callout__body">
                  Retrying keeps the exact quantity, note, date ({pendingReceive?.effectiveDate}), and
                  request reference so a completed save will not add stock twice.
                </p>
              </div>
            )}

            <form className="subview" onSubmit={(event) => void handleConfirmReceiving(event)} noValidate>
              <label className="field">
                <span>Quantity received ({receiveItem.unit}) *</span>
                <input
                  ref={receiveQtyInputRef}
                  type="text"
                  inputMode={receiveItem.allowDecimalQuantity ? "decimal" : "numeric"}
                  pattern={receiveItem.allowDecimalQuantity ? undefined : "[0-9]*"}
                  autoComplete="off"
                  placeholder={receiveItem.allowDecimalQuantity ? "e.g. 2.5" : "e.g. 10"}
                  disabled={receiving || lockedByPending}
                  value={receiveQtyInput}
                  onChange={(e) => {
                    setReceiveQtyInput(e.target.value);
                    setReceiveError(null);
                    setReceiveStaleNotice(null);
                    setReceiveRequestKey(generateClientKey());
                  }}
                />
                <small>
                  Enter the delivered quantity in {receiveItem.unit}
                  {receiveItem.allowDecimalQuantity ? " (up to 4 decimals)" : " (whole number)"}.
                </small>
              </label>

              <label className="field">
                <span>Note (optional)</span>
                <input
                  type="text"
                  maxLength={240}
                  placeholder="e.g. Supplier delivery invoice #104"
                  disabled={receiving || lockedByPending}
                  value={receiveNoteInput}
                  onChange={(e) => {
                    setReceiveNoteInput(e.target.value);
                    setReceiveError(null);
                    setReceiveStaleNotice(null);
                    setReceiveRequestKey(generateClientKey());
                  }}
                />
              </label>

              {receivePreviewAfter !== null && receiveParsedQty?.ok && (
                <div className="inventory-reconcile-preview" role="status">
                  <dl className="detail-list inventory-detail-list">
                    <div className="detail-list__row">
                      <dt>Current balance</dt>
                      <dd>{formatQuantityLabel(receiveItem.currentQuantity, receiveItem.unit)}</dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>Adding</dt>
                      <dd>
                        <strong>{formatSignedDelta(receiveParsedQty.quantity, receiveItem.unit)}</strong>
                      </dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>New balance</dt>
                      <dd>
                        <strong>{formatQuantityLabel(receivePreviewAfter, receiveItem.unit)}</strong>
                      </dd>
                    </div>
                  </dl>
                </div>
              )}

              {receiveError && (
                <div className="alert alert--error" role="alert">
                  {receiveError}
                </div>
              )}

              <div className="modal__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={receiving || isCheckingReceive}
                  onClick={() => setReceiveItem(null)}
                >
                  Cancel
                </button>
                {lockedByPending && pendingReceive && (
                  <>
                    <button
                      type="button"
                      className="button button--ghost"
                      disabled={receiving || checkingPendingKey !== null}
                      onClick={() => void handleCheckPendingAttemptStatus(pendingReceive)}
                    >
                      {isCheckingReceive ? "Checking status…" : "Check status"}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      disabled={receiving || checkingPendingKey !== null}
                      onClick={() => void handleCancelPendingAttempt(pendingReceive)}
                    >
                      Cancel earlier attempt
                    </button>
                  </>
                )}
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={receiving || isCheckingReceive}
                >
                  {receiving
                    ? "Saving…"
                    : lockedByPending
                      ? "Retry Same Submission"
                      : "Confirm Stock Received"}
                </button>
              </div>
            </form>
          </div>
        </div>
        );
      })()}

      {useItem && canRecordUsage && useItem.currentQuantity !== null && (() => {
        const useKey = getItemKey(useItem);
        const pendingUse = findPendingAttempt("STOCK_USED", useKey);
        const lockedByPending = Boolean(pendingUse);
        const isCheckingUse = Boolean(
          pendingUse && checkingPendingKey === pendingUse.requestKey,
        );
        return (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="use-stock-title"
          >
            <div className="detail-card__header">
              <div>
                <h2 id="use-stock-title">Stock Used · {useItem.name}</h2>
                <p className="muted-sm">
                  Record operating supply used today (Asia/Manila). Completing a Calendar activity does not
                  deduct stock automatically.
                </p>
              </div>
            </div>

            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>Current balance</dt>
                <dd>
                  <strong>{formatQuantityLabel(useItem.currentQuantity, useItem.unit)}</strong>
                </dd>
              </div>
              <div className="detail-list__row">
                <dt>Use date (Asia/Manila)</dt>
                <dd>{useEffectiveDate || getTodayManilaDateString()}</dd>
              </div>
            </dl>

            {useStaleNotice && (
              <div className="callout callout--warning" role="alert">
                <p className="callout__title">Stock balance changed before saving</p>
                <p className="callout__body">{useStaleNotice}</p>
              </div>
            )}

            {lockedByPending && (
              <div className="callout callout--warning" role="status">
                <p className="callout__title">Uncertain submission preserved</p>
                <p className="callout__body">
                  Retrying keeps the exact quantity, purpose, date ({pendingUse?.effectiveDate}), and
                  request reference so a completed save will not deduct stock twice.
                </p>
              </div>
            )}

            <form className="subview" onSubmit={(event) => void handleConfirmUsage(event)} noValidate>
              <label className="field">
                <span>Quantity used ({useItem.unit}) *</span>
                <input
                  ref={useQtyInputRef}
                  type="text"
                  inputMode={useItem.allowDecimalQuantity ? "decimal" : "numeric"}
                  pattern={useItem.allowDecimalQuantity ? undefined : "[0-9]*"}
                  autoComplete="off"
                  placeholder={useItem.allowDecimalQuantity ? "e.g. 1.5" : "e.g. 1"}
                  disabled={recordingUse || lockedByPending}
                  value={useQtyInput}
                  onChange={(e) => {
                    setUseQtyInput(e.target.value);
                    setUseError(null);
                    setUseStaleNotice(null);
                    setUseRequestKey(generateClientKey());
                  }}
                />
                <small>
                  Enter the actual amount used in {useItem.unit}
                  {useItem.allowDecimalQuantity ? " (up to 4 decimals)" : " (whole number)"}.
                </small>
              </label>

              <label className="field">
                <span>Purpose *</span>
                <input
                  type="text"
                  maxLength={240}
                  placeholder="e.g. Container washing and station sanitation"
                  disabled={recordingUse || lockedByPending}
                  value={usePurposeInput}
                  onChange={(e) => {
                    setUsePurposeInput(e.target.value);
                    setUseError(null);
                    setUseStaleNotice(null);
                    setUseRequestKey(generateClientKey());
                  }}
                />
              </label>

              {usePreviewAfter !== null && useParsedQty?.ok && (
                <div className="inventory-reconcile-preview" role="status">
                  <dl className="detail-list inventory-detail-list">
                    <div className="detail-list__row">
                      <dt>Current balance</dt>
                      <dd>{formatQuantityLabel(useItem.currentQuantity, useItem.unit)}</dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>Deducting</dt>
                      <dd>
                        <strong>{formatSignedDelta(-useParsedQty.quantity, useItem.unit)}</strong>
                      </dd>
                    </div>
                    <div className="detail-list__row">
                      <dt>New balance</dt>
                      <dd>
                        <strong>{formatQuantityLabel(usePreviewAfter, useItem.unit)}</strong>
                      </dd>
                    </div>
                  </dl>
                </div>
              )}

              {usePreviewAfter !== null && usePreviewAfter < 0 && (
                <div className="callout callout--warning" role="status">
                  <p className="callout__title">Balance will go below zero</p>
                  <p className="callout__body">
                    Actual usage will still be saved and {useItem.name} will be flagged for Owner
                    physical-count reconciliation (INV-008/009).
                  </p>
                </div>
              )}

              {useError && (
                <div className="alert alert--error" role="alert">
                  {useError}
                </div>
              )}

              <div className="modal__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={recordingUse || isCheckingUse}
                  onClick={() => setUseItem(null)}
                >
                  Cancel
                </button>
                {lockedByPending && pendingUse && (
                  <>
                    <button
                      type="button"
                      className="button button--ghost"
                      disabled={recordingUse || checkingPendingKey !== null}
                      onClick={() => void handleCheckPendingAttemptStatus(pendingUse)}
                    >
                      {isCheckingUse ? "Checking status…" : "Check status"}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      disabled={recordingUse || checkingPendingKey !== null}
                      onClick={() => void handleCancelPendingAttempt(pendingUse)}
                    >
                      Cancel earlier attempt
                    </button>
                  </>
                )}
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={recordingUse || isCheckingUse}
                >
                  {recordingUse
                    ? "Saving…"
                    : lockedByPending
                      ? "Retry Same Submission"
                      : "Confirm Stock Used"}
                </button>
              </div>
            </form>
          </div>
        </div>
        );
      })()}
    </AppShell>
  );
}
