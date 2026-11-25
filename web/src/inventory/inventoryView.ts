/** Pure formatting, grouping, reconciliation, and input helpers for Inventory. */

export type ContainerShape = "ROUND" | "SLIM";
export type InventoryCategory = "CONTAINER" | "MERCHANDISE";
export type PosSection = string;
export type FaucetReportingType = "PUSH_TYPE" | "TWIST_TYPE";
export type OpeningStockStatus = "NOT_SET" | "INITIALIZED";
export type InventoryCategoryFilter = string;
export type StockStatusTone = "unset" | "out" | "in";
export type InventoryLoadPhase = "initial-loading" | "initial-error" | "ready" | "refresh-error";

export interface StockStatusMeta {
  tone: StockStatusTone;
  label: "Not Set" | "No Stock" | "In Stock";
}

export interface OpeningStockRecord {
  quantity: number;
  unit: string;
  recordedBy: string;
  recordedAt: string;
}

export interface PosSectionView {
  code: string;
  name: string;
  isBuiltIn: boolean;
  sortOrder: number;
  createdBy?: string | null;
  createdAt?: string;
}

export interface StockReconciliationView {
  id: string;
  itemId: string;
  balanceBefore: number;
  physicalCount: number;
  quantityDelta: number;
  balanceAfter: number;
  unit: string;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

export interface InventoryItemView {
  id?: string;
  code: string;
  name: string;
  category: InventoryCategory;
  shape: ContainerShape | null;
  description?: string | null;
  unit: string;
  unitPriceCentavos?: number | null;
  showInPos?: boolean;
  posSection?: PosSection | null;
  lowStockLevel?: number | null;
  faucetReportingType?: FaucetReportingType | null;
  status: OpeningStockStatus;
  currentQuantity: number | null;
  stockRevision?: number;
  openingStock: OpeningStockRecord | null;
  latestReconciliation?: StockReconciliationView | null;
  archivedAt?: string | null;
  archivedBy?: string | null;
  createdBy?: string | null;
  createdAt?: string;
}

export interface InventoryPermissions {
  canView: boolean;
  canInitializeOpeningStock: boolean;
  canCreateProduct?: boolean;
}

export interface InventoryItemsResponse {
  permissions: InventoryPermissions;
  items: InventoryItemView[];
  posSections?: PosSectionView[];
}

export const DEFAULT_POS_SECTIONS: readonly PosSectionView[] = [
  { code: "CONTAINERS", name: "Containers", isBuiltIn: true, sortOrder: 10 },
  { code: "TAKIP_ACCESSORIES", name: "Takip Types / Accessories", isBuiltIn: true, sortOrder: 20 },
  { code: "CHANGE_OF_GRIPO", name: "Change of Gripo", isBuiltIn: true, sortOrder: 30 },
];

export const MAX_OPENING_QUANTITY = 1_000_000;
export const MAX_UNIT_PRICE_CENTAVOS = 10_000_000;

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function parseOpeningQuantityInput(
  raw: string,
  unit = "containers",
): { ok: true; quantity: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  const unitNoun = unit === "containers" ? "container" : unit;
  if (!trimmed) {
    return { ok: false, message: `Enter the actual ${unitNoun} count (0 or more).` };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: `Enter a whole number of ${unit} (0 or more).` };
  }
  const quantity = Number(trimmed);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > MAX_OPENING_QUANTITY) {
    return { ok: false, message: "Enter a whole number from 0 to 1,000,000." };
  }
  return { ok: true, quantity };
}

export function parsePhysicalCountInput(
  raw: string,
  unit = "containers",
): { ok: true; quantity: number } | { ok: false; message: string } {
  return parseOpeningQuantityInput(raw, unit);
}

export function parseLowStockLevelInput(
  raw: string,
  unit = "units",
): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: `Enter a positive whole number of ${unit} (1 or more), or leave blank to clear.`,
    };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OPENING_QUANTITY) {
    return {
      ok: false,
      message: `Enter a whole number from 1 to ${MAX_OPENING_QUANTITY.toLocaleString("en-US")}, or leave blank to clear.`,
    };
  }
  return { ok: true, value };
}

export function formatFaucetReportingTypeLabel(
  faucetType: FaucetReportingType | null | undefined,
): string {
  switch (faucetType) {
    case "PUSH_TYPE":
      return "Push-Type Faucet";
    case "TWIST_TYPE":
      return "Twist-Type Faucet";
    default:
      return "Not classified";
  }
}

export function computeReconciliationPreview(
  currentQuantity: number,
  physicalCount: number,
): {
  before: number;
  physicalCount: number;
  delta: number;
  after: number;
} {
  return {
    before: currentQuantity,
    physicalCount,
    delta: physicalCount - currentQuantity,
    after: physicalCount,
  };
}

export function formatSignedDelta(delta: number, unit: string): string {
  if (delta === 0) {
    return `0 ${unit === "containers" ? "containers" : unit} (Verified match)`;
  }
  const absLabel = formatQuantityLabel(Math.abs(delta), unit);
  return delta > 0 ? `+${absLabel}` : `−${absLabel}`;
}

export function parsePesoPriceToCentavos(raw: string): number | null {
  const cleaned = raw.trim().replace(/^[₱\s]+/, "").replace(/,/g, "");
  if (!cleaned) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const pesos = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const total = pesos * 100 + cents;
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_UNIT_PRICE_CENTAVOS) {
    return null;
  }
  return total;
}

export function formatCentavosInputValue(centavos: number): string {
  const abs = Math.abs(Math.trunc(centavos));
  const pesos = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${pesos}.${String(remainder).padStart(2, "0")}`;
}

export function formatPesoCentavos(centavos: number): string {
  const truncated = Math.trunc(centavos);
  const abs = Math.abs(truncated);
  const pesos = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `₱${pesos.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

export function formatQuantityLabel(quantity: number | null, unit: string): string {
  if (quantity === null) {
    return "Not Set";
  }
  const unitLabel = quantity === 1 && unit === "containers" ? "container" : unit;
  return `${quantity} ${unitLabel}`;
}

export function formatRecordedAtManila(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  const shifted = new Date(ms + MANILA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = SHORT_MONTHS[shifted.getUTCMonth()]!;
  const day = shifted.getUTCDate();
  const hour24 = shifted.getUTCHours();
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${month} ${day}, ${year} · ${hour12}:${minute} ${period}`;
}

export function formatAlreadySetNotice(
  itemName: string,
  attemptedQuantity: number,
  unit: string,
  existingItem: InventoryItemView | null,
  fallbackMessage: string,
): string {
  if (existingItem?.openingStock) {
    return `Your entry of ${formatQuantityLabel(attemptedQuantity, unit)} was not saved. Opening stock for ${itemName} is already set to ${formatQuantityLabel(existingItem.openingStock.quantity, existingItem.openingStock.unit)} (recorded by ${existingItem.openingStock.recordedBy}).`;
  }
  return fallbackMessage;
}

export function getStockStatusMeta(item: InventoryItemView): StockStatusMeta {
  if (item.status === "NOT_SET" || item.currentQuantity === null) {
    return { tone: "unset", label: "Not Set" };
  }
  if (item.currentQuantity === 0) {
    return { tone: "out", label: "No Stock" };
  }
  return { tone: "in", label: "In Stock" };
}

export function getInventorySummaryCounts(items: InventoryItemView[]): {
  total: number;
  notSet: number;
  noStock: number;
  inStock: number;
} {
  let notSet = 0;
  let noStock = 0;
  let inStock = 0;

  for (const item of items) {
    const { tone } = getStockStatusMeta(item);
    if (tone === "unset") {
      notSet += 1;
    } else if (tone === "out") {
      noStock += 1;
    } else {
      inStock += 1;
    }
  }

  return {
    total: items.length,
    notSet,
    noStock,
    inStock,
  };
}

export function getContainerSubtitle(shape: ContainerShape): string {
  return shape === "ROUND" ? "Round water container" : "Slim water container";
}

export function getContainerPackageSummary(shape: ContainerShape): string {
  return shape === "ROUND"
    ? "POS packages: Empty ₱175 · Purified 25 L ₱200 · Alkaline 25 L ₱210"
    : "POS packages: Empty ₱200 · Purified 25 L ₱200 · Alkaline 25 L ₱210";
}

export function getPosSectionLabel(
  section: PosSection | null | undefined,
  posSections: readonly PosSectionView[] = DEFAULT_POS_SECTIONS,
): string {
  if (!section) return "Other Products";
  const matched = posSections.find((s) => s.code === section);
  if (matched) return matched.name;
  switch (section) {
    case "CHANGE_OF_GRIPO":
      return "Change of Gripo";
    case "TAKIP_ACCESSORIES":
      return "Takip Types / Accessories";
    case "CONTAINERS":
      return "Containers";
    default:
      return "Other Products";
  }
}

export function getInventoryItemGroup(
  item: InventoryItemView,
  posSections: readonly PosSectionView[] = DEFAULT_POS_SECTIONS,
): string {
  if (item.category === "CONTAINER") {
    return "CONTAINER";
  }
  if (item.posSection && item.posSection !== "CONTAINERS") {
    const known =
      posSections.some((s) => s.code === item.posSection) ||
      item.posSection === "TAKIP_ACCESSORIES" ||
      item.posSection === "CHANGE_OF_GRIPO";
    if (known) {
      return item.posSection;
    }
  }
  return "OTHER";
}

export interface InventoryGroupBucket {
  key: string;
  title: string;
  metaPrefix: string;
  items: InventoryItemView[];
}

export function groupInventoryItems(
  items: InventoryItemView[],
  filter: InventoryCategoryFilter,
  posSections: readonly PosSectionView[] = DEFAULT_POS_SECTIONS,
): InventoryGroupBucket[] {
  const filtered = filterInventoryItems(items, filter, posSections);
  const buckets = new Map<string, InventoryItemView[]>();
  for (const item of filtered) {
    const key = getInventoryItemGroup(item, posSections);
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }

  const orderedSections = [...posSections]
    .filter((s) => s.code !== "CONTAINERS")
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

  const result: InventoryGroupBucket[] = [];

  const containerItems = buckets.get("CONTAINER");
  if (containerItems && containerItems.length > 0) {
    result.push({
      key: "CONTAINER",
      title: "Containers",
      metaPrefix: "Whole containers",
      items: containerItems,
    });
  }

  for (const section of orderedSections) {
    const groupItems = buckets.get(section.code);
    if (!groupItems || groupItems.length === 0) continue;
    result.push({
      key: section.code,
      title: section.name,
      metaPrefix: section.isBuiltIn ? "Standalone merchandise" : "Custom POS section",
      items: groupItems,
    });
  }

  const otherItems = buckets.get("OTHER");
  if (otherItems && otherItems.length > 0) {
    result.push({
      key: "OTHER",
      title: "Other Products",
      metaPrefix: "Unassigned POS section",
      items: otherItems,
    });
  }

  return result;
}

export function filterInventoryItems(
  items: InventoryItemView[],
  filter: InventoryCategoryFilter,
  posSections: readonly PosSectionView[] = DEFAULT_POS_SECTIONS,
): InventoryItemView[] {
  if (filter === "ALL") {
    return items;
  }
  return items.filter((item) => getInventoryItemGroup(item, posSections) === filter);
}

export function getInventoryLoadPhase(state: {
  hasLoaded: boolean;
  loading: boolean;
  loadError: string | null;
}): InventoryLoadPhase {
  if (!state.hasLoaded) {
    return state.loadError ? "initial-error" : "initial-loading";
  }
  if (state.loadError && !state.loading) {
    return "refresh-error";
  }
  return "ready";
}

export function getOpeningSubmitLabel(
  target: ContainerShape | InventoryItemView,
  isSubmitting: boolean,
): string {
  if (isSubmitting) {
    return "Saving opening count…";
  }
  if (typeof target === "string") {
    return target === "ROUND" ? "Save Round Opening Count" : "Save Slim Opening Count";
  }
  if (target.shape === "ROUND") {
    return "Save Round Opening Count";
  }
  if (target.shape === "SLIM") {
    return "Save Slim Opening Count";
  }
  return "Save Opening Count";
}

function getItemMergeKey(item: InventoryItemView): string {
  return item.id ?? item.shape ?? item.code;
}

export function mergeRefreshedInventoryItems(
  currentItems: InventoryItemView[],
  fetchedItems: InventoryItemView[],
): InventoryItemView[] {
  const currentByKey = new Map<string, InventoryItemView>(
    currentItems.map((item) => [getItemMergeKey(item), item]),
  );

  return fetchedItems.map((fetched) => {
    const existing = currentByKey.get(getItemMergeKey(fetched));
    if (
      existing &&
      existing.status === "INITIALIZED" &&
      existing.openingStock !== null &&
      (fetched.status === "NOT_SET" || fetched.openingStock === null)
    ) {
      return existing;
    }
    if (
      existing &&
      typeof existing.stockRevision === "number" &&
      typeof fetched.stockRevision === "number" &&
      fetched.stockRevision < existing.stockRevision
    ) {
      return existing;
    }
    return fetched;
  });
}
