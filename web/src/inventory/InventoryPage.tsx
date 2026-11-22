import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { createRequestTracker } from "../calendar/calendarView";
import { AppShell, useModulesData } from "../ChooseModule";
import {
  type ContainerShape,
  formatQuantityLabel,
  formatRecordedAtManila,
  type InventoryItemsResponse,
  type InventoryItemView,
  type InventoryPermissions,
  parseOpeningQuantityInput,
} from "./inventoryView";

function isInventoryItemView(value: unknown): value is InventoryItemView {
  return Boolean(value && typeof value === "object" && "shape" in value && "status" in value);
}

export function InventoryPage() {
  const { data: modulesData } = useModulesData();
  const [items, setItems] = useState<InventoryItemView[]>([]);
  const [permissions, setPermissions] = useState<InventoryPermissions | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [inputs, setInputs] = useState<Record<ContainerShape, string>>({ ROUND: "", SLIM: "" });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ContainerShape, string>>>({});
  const [submittingShape, setSubmittingShape] = useState<ContainerShape | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const loadTrackerRef = useRef(createRequestTracker());
  const inputRefs = useRef<Partial<Record<ContainerShape, HTMLInputElement | null>>>({});

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Inventory — Hydrop Deepo";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const loadItems = useCallback(async (options: { preserveNotice?: boolean } = {}) => {
    const requestId = loadTrackerRef.current.next();
    setLoading(true);
    setLoadError(null);
    if (!options.preserveNotice) {
      setSaveNotice(null);
    }
    try {
      const response = await api<InventoryItemsResponse>("/api/inventory/items");
      if (!loadTrackerRef.current.isCurrent(requestId)) return;
      setItems(response.items);
      setPermissions(response.permissions);
    } catch (err) {
      if (!loadTrackerRef.current.isCurrent(requestId)) return;
      setLoadError(err instanceof ApiError ? err.message : "Could not load inventory stock.");
    } finally {
      if (loadTrackerRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  async function handleOpeningSubmit(event: FormEvent, item: InventoryItemView) {
    event.preventDefault();
    if (submittingShape !== null || !permissions?.canInitializeOpeningStock) return;

    const shape = item.shape;
    const parsed = parseOpeningQuantityInput(inputs[shape]);
    if (!parsed.ok) {
      setFieldErrors((prev) => ({ ...prev, [shape]: parsed.message }));
      inputRefs.current[shape]?.focus();
      return;
    }

    setSubmittingShape(shape);
    setFieldErrors((prev) => ({ ...prev, [shape]: undefined }));
    setSaveNotice(null);

    try {
      const response = await api<{ item: InventoryItemView }>(
        `/api/inventory/items/${encodeURIComponent(shape)}/opening-stock`,
        {
          method: "POST",
          body: { quantity: parsed.quantity },
        },
      );
      setItems((prev) => prev.map((entry) => (entry.shape === shape ? response.item : entry)));
      setInputs((prev) => ({ ...prev, [shape]: "" }));
      setSaveNotice(
        `Saved opening count for ${response.item.name}: ${formatQuantityLabel(
          response.item.currentQuantity,
          response.item.unit,
        )}.`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "OPENING_STOCK_ALREADY_SET") {
        const existingItem = err.details?.item;
        if (isInventoryItemView(existingItem)) {
          setItems((prev) => prev.map((entry) => (entry.shape === shape ? existingItem : entry)));
        } else {
          void loadItems({ preserveNotice: true });
        }
        setFieldErrors((prev) => ({ ...prev, [shape]: err.message }));
      } else {
        setFieldErrors((prev) => ({
          ...prev,
          [shape]: err instanceof ApiError ? err.message : "Could not save opening count. Please try again.",
        }));
      }
    } finally {
      setSubmittingShape(null);
    }
  }

  const canInitialize = permissions?.canInitializeOpeningStock ?? false;
  const hasUninitialized = items.some((item) => item.status === "NOT_SET");

  return (
    <AppShell activeKey="inventory" sectionName="Inventory" pageLabel="Inventory" modulesData={modulesData}>
      <section className="page-header page-header--split">
        <div>
          <p className="eyebrow">INVENTORY</p>
          <h1>Container Opening Stock</h1>
          <p className="page-subtitle">
            Round and Slim merchandise containers in whole containers. Counts carry across business days.
          </p>
        </div>
        <div className="page-header__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void loadItems()}
            disabled={loading || submittingShape !== null}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </section>

      {permissions && !canInitialize && (
        <div className="callout callout--info" role="status">
          <p className="callout__title">View-only access</p>
          <p className="callout__body">
            Both Owner and Cashier can view Round and Slim stock counts. Only the Owner can record the initial
            physical count for each container shape.
          </p>
        </div>
      )}

      {permissions && canInitialize && hasUninitialized && (
        <div className="callout callout--info">
          <p className="callout__title">Record actual opening counts once per shape</p>
          <p className="callout__body">
            Count station-owned Round and Slim containers separately. Enter 0 when none are in stock. Once saved, the
            opening count cannot be overwritten.
          </p>
        </div>
      )}

      {saveNotice && (
        <div className="callout callout--success" role="status">
          <p className="callout__title">Opening count saved</p>
          <p className="callout__body">{saveNotice}</p>
        </div>
      )}

      {loadError && (
        <div className="alert alert--error" role="alert">
          <span>{loadError}</span>{" "}
          <button type="button" className="button button--ghost button--sm" onClick={() => void loadItems()}>
            Retry
          </button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="card">
          <p className="muted" role="status">
            Loading container stock…
          </p>
        </div>
      ) : (
        <section className="inventory-grid" aria-label="Container stock items">
          {items.map((item) => {
            const isNotSet = item.status === "NOT_SET" || item.currentQuantity === null;
            const isZero = !isNotSet && item.currentQuantity === 0;
            const formError = fieldErrors[item.shape];
            const isSubmitting = submittingShape === item.shape;
            const inputId = `opening-count-${item.shape.toLowerCase()}`;
            const hintId = `${inputId}-hint`;

            return (
              <article key={item.code} className="card inventory-card" aria-labelledby={`heading-${item.code}`}>
                <div className="inventory-card__header">
                  <div>
                    <h2 id={`heading-${item.code}`}>{item.name}</h2>
                    <p className="muted-sm">Unit: whole {item.unit}</p>
                  </div>
                  <span className={`pill ${isNotSet ? "pill--warning" : "pill--completed"}`}>
                    {isNotSet ? "Not Set" : "Initialized"}
                  </span>
                </div>

                <div className={`inventory-balance ${isNotSet ? "inventory-balance--unset" : ""}`}>
                  <span className="inventory-balance__label">Current balance</span>
                  {isNotSet ? (
                    <>
                      <strong className="inventory-balance__value inventory-balance__value--unset">Not Set</strong>
                      <span className="muted-sm">No opening physical count has been recorded yet.</span>
                    </>
                  ) : (
                    <>
                      <div className="inventory-balance__row">
                        <strong className="inventory-balance__value">{item.currentQuantity}</strong>
                        <span className="inventory-balance__unit">
                          {item.currentQuantity === 1 ? "container" : item.unit}
                        </span>
                      </div>
                      <span className="muted-sm">
                        {isZero
                          ? "Explicit zero confirmed by Owner."
                          : "Starting physical count recorded for this shape."}
                      </span>
                    </>
                  )}
                </div>

                {!isNotSet && item.openingStock ? (
                  <>
                    <dl className="detail-list">
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
                    </dl>
                    <p className="muted-sm">Opening count is preserved once recorded and cannot be overwritten.</p>
                  </>
                ) : canInitialize ? (
                  <form className="inventory-form" onSubmit={(event) => void handleOpeningSubmit(event, item)} noValidate>
                    {formError && (
                      <div className="alert alert--error" role="alert">
                        {formError}
                      </div>
                    )}

                    <label className="field" htmlFor={inputId}>
                      <span>Opening count ({item.unit}) *</span>
                      <input
                        id={inputId}
                        ref={(el) => {
                          inputRefs.current[item.shape] = el;
                        }}
                        name={`openingQuantity-${item.shape}`}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        autoComplete="off"
                        placeholder="0"
                        value={inputs[item.shape]}
                        aria-describedby={hintId}
                        disabled={submittingShape !== null}
                        onChange={(e) => {
                          const value = e.target.value;
                          setInputs((prev) => ({ ...prev, [item.shape]: value }));
                          setFieldErrors((prev) => ({ ...prev, [item.shape]: undefined }));
                        }}
                      />
                      <small id={hintId}>Enter the actual physical count. Enter 0 if none are in stock.</small>
                    </label>

                    <button
                      type="submit"
                      className="button button--primary button--block"
                      disabled={submittingShape !== null}
                    >
                      {isSubmitting ? "Saving opening count…" : `Save ${item.name} Opening Count`}
                    </button>
                  </form>
                ) : (
                  <p className="inventory-readonly-note">
                    Waiting for the Owner to record the initial physical count for {item.name}.
                  </p>
                )}
              </article>
            );
          })}
        </section>
      )}
    </AppShell>
  );
}
