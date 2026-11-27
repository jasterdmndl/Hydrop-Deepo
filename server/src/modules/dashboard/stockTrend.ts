import {
  type ContainerShape,
  type InventoryCategory,
  quantitiesEqual,
  toScaledQuantity,
} from "../inventory/inventory.js";

/**
 * Pure Stock Trend chain verification and deterministic tie ordering
 * for Dashboard Stocks (DEC-089).
 */

export type StockTrendHistoryState = "NOT_SET" | "COMPLETE" | "INCOMPLETE";
export type StockTrendMovementType =
  | "OPENING_COUNT"
  | "POS_SALE"
  | "PRIOR_DAY_SETTLEMENT"
  | "PHYSICAL_COUNT_RECONCILIATION"
  | "SALE_ACTION_DEDUCTION"
  | "SALE_ACTION_RESTORATION"
  | "STOCK_RECEIVED"
  | "STOCK_USED";

export interface StockTrendItemSummary {
  id: string;
  code: string;
  name: string;
  category: InventoryCategory;
  shape: ContainerShape | null;
  unit: string;
  showInPos: boolean;
  lowStockLevel: number | null;
  status: "NOT_SET" | "INITIALIZED";
  currentQuantity: number | null;
}

export interface StockTrendOpeningInput {
  quantity: number;
  unit: string;
  recordedBy: string;
  recordedAt: string;
  recordedAtKey?: string;
}

export interface StockTrendMovementInput {
  id: string;
  movementType:
    | "POS_SALE"
    | "PRIOR_DAY_SETTLEMENT"
    | "PHYSICAL_COUNT_RECONCILIATION"
    | "SALE_ACTION_DEDUCTION"
    | "SALE_ACTION_RESTORATION"
    | "STOCK_RECEIVED"
    | "STOCK_USED";
  quantityDelta: number;
  balanceBefore: number;
  balanceAfter: number;
  unit: string;
  posReference: string | null;
  note: string | null;
  actor: string;
  recordedAt: string;
  recordedAtKey?: string;
}

export interface StockTrendPoint {
  pointKind: "OPENING" | "MOVEMENT";
  movementId: string | null;
  movementType: StockTrendMovementType;
  recordedAt: string;
  quantityDelta: number;
  balanceBefore: number | null;
  balanceAfter: number;
  unit: string;
  reference: string | null;
  note: string | null;
  actor: string;
}

export interface DashboardStockTrendResponse {
  item: StockTrendItemSummary;
  historyState: StockTrendHistoryState;
  historyMessage: string | null;
  openingStock: StockTrendOpeningInput | null;
  points: StockTrendPoint[];
}

function resolveUniqueChainForTimestampGroup(
  group: StockTrendMovementInput[],
  startBalance: number,
): StockTrendMovementInput[] | null {
  if (group.length === 1) {
    const single = group[0]!;
    return quantitiesEqual(single.balanceBefore, startBalance) ? [single] : null;
  }

  // Explore chain orderings for same-timestamp movements; abort as soon as 2+ distinct orderings exist.
  const used = new Array<boolean>(group.length).fill(false);
  const currentPath: StockTrendMovementInput[] = [];
  let foundOrder: StockTrendMovementInput[] | null = null;
  let validCount = 0;

  function dfs(runningBalance: number): void {
    if (validCount >= 2) return;
    if (currentPath.length === group.length) {
      validCount += 1;
      if (validCount === 1) {
        foundOrder = [...currentPath];
      }
      return;
    }

    for (let i = 0; i < group.length; i += 1) {
      if (used[i]) continue;
      const candidate = group[i]!;
      if (!quantitiesEqual(candidate.balanceBefore, runningBalance)) continue;
      used[i] = true;
      currentPath.push(candidate);
      dfs(candidate.balanceAfter);
      currentPath.pop();
      used[i] = false;
      if (validCount >= 2) return;
    }
  }

  dfs(startBalance);
  return validCount === 1 ? foundOrder : null;
}

function compareTimestamps(
  a: { recordedAt: string; recordedAtKey?: string },
  b: { recordedAt: string; recordedAtKey?: string },
): number {
  if (a.recordedAtKey && b.recordedAtKey) {
    if (a.recordedAtKey < b.recordedAtKey) return -1;
    if (a.recordedAtKey > b.recordedAtKey) return 1;
    return 0;
  }
  return Date.parse(a.recordedAt) - Date.parse(b.recordedAt);
}

export function buildDashboardStockTrend(input: {
  item: StockTrendItemSummary;
  openingStock: StockTrendOpeningInput | null;
  movements: StockTrendMovementInput[];
}): DashboardStockTrendResponse {
  const { item, openingStock, movements } = input;
  const publicOpeningStock = openingStock
    ? {
      quantity: openingStock.quantity,
      unit: openingStock.unit,
      recordedBy: openingStock.recordedBy,
      recordedAt: openingStock.recordedAt,
    }
    : null;

  if (!openingStock && item.currentQuantity === null && movements.length === 0) {
    return {
      item,
      historyState: "NOT_SET",
      historyMessage: "Opening count has not been recorded yet.",
      openingStock: null,
      points: [],
    };
  }

  if (!openingStock || item.currentQuantity === null) {
    return {
      item,
      historyState: "INCOMPLETE",
      historyMessage:
        "Stock history is incomplete because the opening count or current balance record is missing.",
      openingStock: publicOpeningStock,
      points: [],
    };
  }

  if (openingStock.unit !== item.unit) {
    return {
      item,
      historyState: "INCOMPLETE",
      historyMessage:
        "Stock history is incomplete because the opening count unit does not match the item unit.",
      openingStock: publicOpeningStock,
      points: [],
    };
  }

  for (const m of movements) {
    if (
      m.unit !== item.unit ||
      toScaledQuantity(m.balanceBefore) + toScaledQuantity(m.quantityDelta) !==
        toScaledQuantity(m.balanceAfter)
    ) {
      return {
        item,
        historyState: "INCOMPLETE",
        historyMessage:
          "Stock history is incomplete because a saved stock movement does not reconcile with its unit or change.",
        openingStock: publicOpeningStock,
        points: [],
      };
    }
      if (compareTimestamps(m, openingStock) < 0) {
        return {
          item,
          historyState: "INCOMPLETE",
          historyMessage:
            "Stock history is incomplete because a movement was recorded before the opening count.",
          openingStock: publicOpeningStock,
          points: [],
        };
      }
    }

    // Group movements by exact timestamp (preserving sub-second precision) in ascending order.
    const sortedByTime = [...movements].sort((a, b) => {
      const diff = compareTimestamps(a, b);
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    });

    const groups: StockTrendMovementInput[][] = [];
    for (const m of sortedByTime) {
      const lastGroup = groups[groups.length - 1];
        if (lastGroup && compareTimestamps(lastGroup[0]!, m) === 0) {
          lastGroup.push(m);
        } else {
          groups.push([m]);
        }
      }

      let runningBalance = openingStock.quantity;
      const orderedMovements: StockTrendMovementInput[] = [];

      for (const group of groups) {
        const resolved = resolveUniqueChainForTimestampGroup(group, runningBalance);
        if (!resolved) {
          return {
            item,
            historyState: "INCOMPLETE",
            historyMessage:
              "Stock history is incomplete or ambiguous and cannot be reconciled into a single balance sequence.",
            openingStock: publicOpeningStock,
            points: [],
          };
        }
        orderedMovements.push(...resolved);
        runningBalance = resolved[resolved.length - 1]!.balanceAfter;
      }

      if (!quantitiesEqual(runningBalance, item.currentQuantity)) {
        return {
          item,
          historyState: "INCOMPLETE",
          historyMessage:
            "Stock history is incomplete because saved movements do not reach the current Inventory balance.",
          openingStock: publicOpeningStock,
          points: [],
        };
      }

      const points: StockTrendPoint[] = [
        {
          pointKind: "OPENING",
          movementId: null,
          movementType: "OPENING_COUNT",
          recordedAt: openingStock.recordedAt,
          quantityDelta: 0,
          balanceBefore: null,
          balanceAfter: openingStock.quantity,
          unit: item.unit,
          reference: null,
          note: null,
          actor: openingStock.recordedBy,
        },
        ...orderedMovements.map((m) => ({
          pointKind: "MOVEMENT" as const,
          movementId: m.id,
          movementType: m.movementType,
          recordedAt: m.recordedAt,
          quantityDelta: m.quantityDelta,
          balanceBefore: m.balanceBefore,
          balanceAfter: m.balanceAfter,
          unit: m.unit,
          reference: m.posReference,
          note: m.note,
          actor: m.actor,
        })),
      ];

      return {
        item,
        historyState: "COMPLETE",
        historyMessage: null,
        openingStock: publicOpeningStock,
        points,
      };
    }
