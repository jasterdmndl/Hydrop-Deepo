import type { Role } from "../auth/policy.js";

/**
 * Inventory domain rules and validation for Round and Slim container
 * opening stock (DEC-065, INV-003, INV-005).
 */
export type ContainerShape = "ROUND" | "SLIM";

export const CONTAINER_SHAPES: readonly ContainerShape[] = ["ROUND", "SLIM"] as const;

export const MAX_OPENING_QUANTITY = 1_000_000;

export interface InventoryPermissions {
  canView: boolean;
  /** Only the Owner can record the initial physical count per shape (INV-005). */
  canInitializeOpeningStock: boolean;
}

export function inventoryPermissions(role: Role): InventoryPermissions {
  return {
    canView: true,
    canInitializeOpeningStock: role === "OWNER",
  };
}

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

export function parseContainerShape(raw: unknown): ContainerShape | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toUpperCase();
  if (normalized === "ROUND" || normalized === "SLIM") {
    return normalized;
  }
  return null;
}

export function parseOpeningQuantity(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  if (!Number.isInteger(raw)) return null;
  if (raw < 0 || raw > MAX_OPENING_QUANTITY) return null;
  return raw;
}

// Asia/Manila is fixed UTC+08:00 with no daylight saving transitions.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatManilaIso(date: Date): string {
  const shifted = new Date(date.getTime() + MANILA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hour = pad2(shifted.getUTCHours());
  const minute = pad2(shifted.getUTCMinutes());
  const second = pad2(shifted.getUTCSeconds());
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}
