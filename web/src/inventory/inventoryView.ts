/** Pure formatting and input helpers for Inventory Round and Slim opening stock. */

export type ContainerShape = "ROUND" | "SLIM";
export type OpeningStockStatus = "NOT_SET" | "INITIALIZED";

export interface OpeningStockRecord {
  quantity: number;
  unit: string;
  recordedBy: string;
  recordedAt: string;
}

export interface InventoryItemView {
  code: string;
  name: string;
  category: "CONTAINER";
  shape: ContainerShape;
  unit: string;
  status: OpeningStockStatus;
  currentQuantity: number | null;
  openingStock: OpeningStockRecord | null;
}

export interface InventoryPermissions {
  canView: boolean;
  canInitializeOpeningStock: boolean;
}

export interface InventoryItemsResponse {
  permissions: InventoryPermissions;
  items: InventoryItemView[];
}

export const MAX_OPENING_QUANTITY = 1_000_000;

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function parseOpeningQuantityInput(
  raw: string,
): { ok: true; quantity: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: "Enter the actual container count (0 or more)." };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "Enter a whole number of containers (0 or more)." };
  }
  const quantity = Number(trimmed);
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > MAX_OPENING_QUANTITY) {
    return { ok: false, message: "Enter a whole number from 0 to 1,000,000." };
  }
  return { ok: true, quantity };
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
