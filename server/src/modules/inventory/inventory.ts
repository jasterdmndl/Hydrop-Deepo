import type { Role } from "../auth/policy.js";

/**
 * Inventory domain rules and validation for Round/Slim containers,
 * Owner-created merchandise products, reusable POS sections, archiving,
 * and INV-009 physical-count reconciliation (DEC-065, DEC-068–070, DEC-073, DEC-074).
 */
export type ContainerShape = "ROUND" | "SLIM";
export type InventoryCategory = "CONTAINER" | "MERCHANDISE";
export type PosSection = string;
export type FaucetReportingType = "PUSH_TYPE" | "TWIST_TYPE";

export const CONTAINER_SHAPES: readonly ContainerShape[] = ["ROUND", "SLIM"] as const;
export const FAUCET_REPORTING_TYPES: readonly FaucetReportingType[] = ["PUSH_TYPE", "TWIST_TYPE"] as const;
export const BUILT_IN_POS_SECTIONS = {
  CONTAINERS: "CONTAINERS",
  TAKIP_ACCESSORIES: "TAKIP_ACCESSORIES",
  CHANGE_OF_GRIPO: "CHANGE_OF_GRIPO",
} as const;

export const MAX_OPENING_QUANTITY = 1_000_000;
export const MAX_UNIT_PRICE_CENTAVOS = 10_000_000;
export const MAX_PRODUCT_NAME_LENGTH = 80;
export const MAX_PRODUCT_DESCRIPTION_LENGTH = 160;
export const MAX_STOCK_UNIT_LENGTH = 30;
export const MAX_POS_SECTION_NAME_LENGTH = 60;
export const MAX_POS_SECTION_CODE_LENGTH = 64;
export const MAX_RECONCILIATION_REASON_LENGTH = 240;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InventoryPermissions {
  canView: boolean;
  /** Only the Owner can record the initial physical count per item (INV-005). */
  canInitializeOpeningStock: boolean;
  /** Only the Owner can manage Inventory products, POS visibility, sections, archiving, and stock corrections. */
  canCreateProduct: boolean;
}

export function inventoryPermissions(role: Role): InventoryPermissions {
  return {
    canView: true,
    canInitializeOpeningStock: role === "OWNER",
    canCreateProduct: role === "OWNER",
  };
}

export type OpeningStockStatus = "NOT_SET" | "INITIALIZED";

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
  createdBy: string | null;
  createdAt: string;
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
  id: string;
  code: string;
  name: string;
  category: InventoryCategory;
  shape: ContainerShape | null;
  description: string | null;
  unit: string;
  unitPriceCentavos: number | null;
  showInPos: boolean;
  posSection: PosSection | null;
  lowStockLevel: number | null;
  faucetReportingType: FaucetReportingType | null;
  status: OpeningStockStatus;
  currentQuantity: number | null;
  stockRevision: number;
  openingStock: OpeningStockRecord | null;
  latestReconciliation: StockReconciliationView | null;
  archivedAt: string | null;
  archivedBy: string | null;
  createdBy: string | null;
  createdAt: string;
}

export function parseContainerShape(raw: unknown): ContainerShape | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toUpperCase();
  if (normalized === "ROUND" || normalized === "SLIM") {
    return normalized;
  }
  return null;
}

export function isUuid(raw: unknown): raw is string {
  return typeof raw === "string" && UUID_REGEX.test(raw.trim());
}

export function parseOpeningQuantity(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  if (!Number.isInteger(raw)) return null;
  if (raw < 0 || raw > MAX_OPENING_QUANTITY) return null;
  return raw;
}

export function parsePhysicalCount(raw: unknown): number | null {
  return parseOpeningQuantity(raw);
}

export function parseProductName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_PRODUCT_NAME_LENGTH) return null;
  return trimmed;
}

export function parseProductDescription(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return { ok: true, value: null };
  }
  if (trimmed.length > MAX_PRODUCT_DESCRIPTION_LENGTH) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

export function parseStockUnit(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_STOCK_UNIT_LENGTH) return null;
  return trimmed;
}

export function parseUnitPriceCentavos(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  if (!Number.isInteger(raw)) return null;
  if (raw < 1 || raw > MAX_UNIT_PRICE_CENTAVOS) return null;
  return raw;
}

export function parsePosSectionName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_POS_SECTION_NAME_LENGTH) return null;
  return trimmed;
}

export function parsePosSectionCode(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed || trimmed.length > MAX_POS_SECTION_CODE_LENGTH) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

export function parseReconciliationReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_RECONCILIATION_REASON_LENGTH) return null;
  return trimmed;
}

export function parseLowStockLevel(
  raw: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return { ok: false };
  }
  if (raw < 1 || raw > MAX_OPENING_QUANTITY) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

export function parseFaucetReportingType(
  raw: unknown,
): { ok: true; value: FaucetReportingType | null } | { ok: false } {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const normalized = raw.trim().toUpperCase();
  if (normalized === "PUSH_TYPE" || normalized === "TWIST_TYPE") {
    return { ok: true, value: normalized };
  }
  return { ok: false };
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
