import type { Queryable } from "../../db/database.js";
import type { ContainerShape, InventoryCategory } from "../inventory/inventory.js";
import type { OpeningStockTarget } from "../inventory/repository.js";
import {
  type FaucetReportingType,
  formatManilaIso,
  type ItemKind,
  type PosSection,
  type WaterType,
} from "../pos/sales.js";
import type {
  BusinessDayRecord,
  DailySalesAggregate,
  DashboardPriorDaySettlement,
  SaleItemAggregate,
} from "./salesReport.js";
import type {
  StockTrendItemSummary,
  StockTrendMovementInput,
  StockTrendOpeningInput,
} from "./stockTrend.js";

interface RawBusinessDayJson {
  businessDate: string;
  closedAt: string | null;
}

interface RawDailySalesJson {
  businessDate: string;
  salesCentavos: number | string;
  transactions: number | string;
}

interface RawItemAggregateJson {
  itemKind: ItemKind;
  waterType: WaterType | null;
  catalogCode: string | null;
  faucetReportingType: FaucetReportingType | "NONE" | null;
  posSection: PosSection | null;
  displayLabel: string;
  quantity: number | string;
  volumeMl: number | string;
  salesCentavos: number | string;
}

interface RawSettlementJson {
  checkoutReference: string;
  originalBusinessDate: string;
  settlementDate: string;
  netAmountKeptCentavos: number | string;
  settledBy: string;
  settledAt: string;
  note: string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function normalizeUtcIsoMicroseconds(raw: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(raw.trim());
  if (!match) {
    return toDate(raw).toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
  }
  const micros = (match[2] ?? "").padEnd(6, "0");
  return `${match[1]}.${micros}Z`;
}

function formatManilaIsoPreservingPrecision(utcIsoUs: string): string {
  const normalized = normalizeUtcIsoMicroseconds(utcIsoUs);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(normalized);
  if (!match) {
    return formatManilaIso(toDate(utcIsoUs));
  }
  const baseManila = formatManilaIso(new Date(`${match[1]}Z`));
  const micros = match[2]!;
  if (micros === "000000") {
    return baseManila;
  }
  const frac = micros.slice(3) === "000" ? micros.slice(0, 3) : micros;
  return `${baseManila.slice(0, 19)}.${frac}+08:00`;
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === "string") {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
  return [];
}

/** Read-only PostgreSQL queries for the final Dashboard Sales report and Stock trend. */
export const dashboardRepository = {
  async loadSalesInputs(
    db: Queryable,
    input: {
      from: string;
      to: string;
      isPartialEndDay: boolean;
      cutoffDate: Date;
      requestNow: Date;
      comparisonFrom: string | null;
      comparisonTo: string | null;
      comparisonIsPartialEndDay: boolean;
      comparisonCutoffDate: Date | null;
    },
  ): Promise<{
    businessDays: BusinessDayRecord[];
    salesByDate: DailySalesAggregate[];
    itemAggregates: SaleItemAggregate[];
    priorDaySettlements: DashboardPriorDaySettlement[];
    previousBusinessDays: BusinessDayRecord[];
    previousTotalSalesCentavos: number;
  }> {
    const hasComparison =
      input.comparisonFrom !== null &&
      input.comparisonTo !== null &&
      input.comparisonCutoffDate !== null;
    const compFrom = input.comparisonFrom ?? "1900-01-01";
    const compTo = input.comparisonTo ?? "1900-01-01";
    const compCutoff = input.comparisonCutoffDate ?? input.cutoffDate;

    const params = [
      input.from,
      input.to,
      input.isPartialEndDay,
      input.cutoffDate,
      hasComparison,
      compFrom,
      compTo,
      input.comparisonIsPartialEndDay,
      compCutoff,
      input.requestNow,
    ];

    // Single SQL statement guarantees current period, comparison period, and breakdowns share one MVCC snapshot.
    const { rows } = await db.query<{
      businessDays: unknown;
      salesByDate: unknown;
      itemAggregates: unknown;
      priorDaySettlements: unknown;
      previousBusinessDays: unknown;
      previousTotalSalesCentavos: number | string;
    }>(
      `WITH RECURSIVE sale_origin AS (
         SELECT s.id AS active_sale_id,
                s.business_date,
                s.total_centavos,
                s.id AS walk_id,
                s.corrected_from_sale_id,
                s.created_at AS origin_created_at
           FROM pos_sales s
          WHERE s.status = 'ACTIVE'
            AND (
              (s.business_date >= $1::date AND s.business_date <= $2::date)
              OR ($5::boolean AND s.business_date >= $6::date AND s.business_date <= $7::date)
            )
         UNION ALL
         SELECT so.active_sale_id,
                so.business_date,
                so.total_centavos,
                parent.id AS walk_id,
                parent.corrected_from_sale_id,
                parent.created_at AS origin_created_at
           FROM sale_origin so
           JOIN pos_sales parent ON parent.id = so.corrected_from_sale_id
       ),
       active_sales_with_origin AS (
         SELECT active_sale_id AS id,
                business_date,
                total_centavos,
                origin_created_at
           FROM sale_origin
          WHERE corrected_from_sale_id IS NULL
       ),
       business_days AS (
         SELECT to_char(business_date, 'YYYY-MM-DD') AS "businessDate",
                CASE
                  WHEN closed_at IS NOT NULL AND closed_at <= $10::timestamptz
                    THEN to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                  ELSE NULL
                END AS "closedAt"
           FROM pos_business_days
          WHERE business_date >= $1::date
            AND business_date <= $2::date
            AND (NOT $3::boolean OR business_date < $2::date OR started_at <= $4::timestamptz)
       ),
       active_sales AS (
         SELECT id, business_date, total_centavos
           FROM active_sales_with_origin
          WHERE business_date >= $1::date
            AND business_date <= $2::date
            AND (NOT $3::boolean OR business_date < $2::date OR origin_created_at <= $4::timestamptz)
       ),
       sales_by_date AS (
         SELECT to_char(business_date, 'YYYY-MM-DD') AS "businessDate",
                COALESCE(SUM(total_centavos), 0)::bigint AS "salesCentavos",
                COUNT(*)::integer AS "transactions"
           FROM active_sales
          GROUP BY business_date
       ),
       item_aggregates AS (
         SELECT i.item_kind AS "itemKind",
                i.water_type AS "waterType",
                i.catalog_code AS "catalogCode",
                i.faucet_reporting_type AS "faucetReportingType",
                i.pos_section AS "posSection",
                i.display_label AS "displayLabel",
                COALESCE(SUM(i.quantity), 0)::bigint AS "quantity",
                COALESCE(SUM(i.line_volume_ml), 0)::bigint AS "volumeMl",
                COALESCE(SUM(i.line_total_centavos), 0)::bigint AS "salesCentavos"
           FROM pos_sale_items i
           JOIN active_sales s ON s.id = i.sale_id
          GROUP BY i.item_kind,
                   i.water_type,
                   i.catalog_code,
                   i.faucet_reporting_type,
                   i.pos_section,
                   i.display_label
       ),
       prior_day_settlements AS (
         SELECT p.checkout_reference AS "checkoutReference",
                to_char(p.original_business_date, 'YYYY-MM-DD') AS "originalBusinessDate",
                to_char(p.settlement_date, 'YYYY-MM-DD') AS "settlementDate",
                p.net_amount_kept_centavos AS "netAmountKeptCentavos",
                settler.username AS "settledBy",
                to_char(p.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "settledAt",
                p.settled_at AS "settledAtSort",
                p.note
           FROM pos_prior_day_settlements p
           JOIN app_users settler ON settler.id = p.settled_by_user_id
          WHERE p.settlement_date >= $1::date
            AND p.settlement_date <= $2::date
            AND (NOT $3::boolean OR p.settlement_date < $2::date OR p.settled_at <= $4::timestamptz)
       ),
       previous_business_days AS (
         SELECT to_char(business_date, 'YYYY-MM-DD') AS "businessDate",
                CASE
                  WHEN closed_at IS NOT NULL AND closed_at <= $9::timestamptz
                    THEN to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                  ELSE NULL
                END AS "closedAt"
           FROM pos_business_days
          WHERE $5::boolean
            AND business_date >= $6::date
            AND business_date <= $7::date
            AND (NOT $8::boolean OR business_date < $7::date OR started_at <= $9::timestamptz)
       ),
       previous_active_sales AS (
         SELECT COALESCE(SUM(total_centavos), 0)::bigint AS "salesCentavos"
           FROM active_sales_with_origin
          WHERE $5::boolean
            AND business_date >= $6::date
            AND business_date <= $7::date
            AND (NOT $8::boolean OR business_date < $7::date OR origin_created_at <= $9::timestamptz)
       )
       SELECT COALESCE(
                (
                  SELECT json_agg(row_to_json(bd) ORDER BY bd."businessDate" ASC)
                    FROM business_days bd
                ),
                '[]'::json
              ) AS "businessDays",
              COALESCE(
                (
                  SELECT json_agg(row_to_json(sd) ORDER BY sd."businessDate" ASC)
                    FROM sales_by_date sd
                ),
                '[]'::json
              ) AS "salesByDate",
              COALESCE(
                (
                  SELECT json_agg(row_to_json(ia))
                    FROM item_aggregates ia
                ),
                '[]'::json
              ) AS "itemAggregates",
              COALESCE(
                (
                  SELECT json_agg(
                    json_build_object(
                      'checkoutReference', ps."checkoutReference",
                      'originalBusinessDate', ps."originalBusinessDate",
                      'settlementDate', ps."settlementDate",
                      'netAmountKeptCentavos', ps."netAmountKeptCentavos",
                      'settledBy', ps."settledBy",
                      'settledAt', ps."settledAt",
                      'note', ps.note
                    )
                    ORDER BY ps."settlementDate" DESC, ps."settledAtSort" DESC, ps."checkoutReference" DESC
                  )
                    FROM prior_day_settlements ps
                ),
                '[]'::json
              ) AS "priorDaySettlements",
              COALESCE(
                (
                  SELECT json_agg(row_to_json(pbd) ORDER BY pbd."businessDate" ASC)
                    FROM previous_business_days pbd
                ),
                '[]'::json
              ) AS "previousBusinessDays",
              (SELECT "salesCentavos" FROM previous_active_sales) AS "previousTotalSalesCentavos"`,
      params,
    );

    const row = rows[0];
    const businessDays = parseJsonArray<RawBusinessDayJson>(row?.businessDays);
    const salesByDate = parseJsonArray<RawDailySalesJson>(row?.salesByDate);
    const itemAggregates = parseJsonArray<RawItemAggregateJson>(row?.itemAggregates);
    const settlements = parseJsonArray<RawSettlementJson>(row?.priorDaySettlements);
    const previousBusinessDays = parseJsonArray<RawBusinessDayJson>(row?.previousBusinessDays);

    return {
      businessDays: businessDays.map((bd) => ({
        businessDate: bd.businessDate,
        closedAt: bd.closedAt ? formatManilaIso(toDate(bd.closedAt)) : null,
      })),
      salesByDate: salesByDate.map((sd) => ({
        businessDate: sd.businessDate,
        salesCentavos: Number(sd.salesCentavos),
        transactions: Number(sd.transactions),
      })),
      itemAggregates: itemAggregates.map((ia) => ({
        itemKind: ia.itemKind,
        waterType: ia.waterType,
        catalogCode: ia.catalogCode ?? null,
        faucetReportingType: ia.faucetReportingType ?? null,
        posSection: ia.posSection ?? null,
        displayLabel: ia.displayLabel ?? "",
        quantity: Number(ia.quantity),
        volumeMl: Number(ia.volumeMl),
        salesCentavos: Number(ia.salesCentavos),
      })),
      priorDaySettlements: settlements.map((ps) => ({
        checkoutReference: ps.checkoutReference,
        originalBusinessDate: ps.originalBusinessDate,
        settlementDate: ps.settlementDate,
        netAmountKeptCentavos: Number(ps.netAmountKeptCentavos),
        settledBy: ps.settledBy,
        settledAt: formatManilaIso(toDate(ps.settledAt)),
        note: ps.note ?? null,
      })),
      previousBusinessDays: previousBusinessDays.map((bd) => ({
        businessDate: bd.businessDate,
        closedAt: bd.closedAt ? formatManilaIso(toDate(bd.closedAt)) : null,
      })),
      previousTotalSalesCentavos: Number(row?.previousTotalSalesCentavos ?? 0),
    };
  },

  async loadStockTrendInputs(
    db: Queryable,
    target: OpeningStockTarget,
  ): Promise<{
    item: StockTrendItemSummary;
    openingStock: StockTrendOpeningInput | null;
    movements: StockTrendMovementInput[];
  } | null> {
    const whereSql =
      target.kind === "shape"
        ? `i.category = 'CONTAINER' AND i.container_shape = $1 AND i.archived_at IS NULL`
        : `i.id = $1 AND i.archived_at IS NULL`;
    const whereParam = target.kind === "shape" ? target.shape : target.id;

    // Single SQL query reads active item, opening count, and movements from one snapshot.
    const { rows } = await db.query<{
      item: {
        id: string;
        code: string;
        name: string;
        category: InventoryCategory;
        shape: ContainerShape | null;
        unit: string;
        showInPos: boolean;
        lowStockLevel: number | string | null;
        currentQuantity: number | string | null;
      } | null;
      openingStock: {
        quantity: number | string;
        unit: string;
        recordedBy: string;
        recordedAt: string;
      } | null;
      movements: unknown;
    }>(
      `WITH target_item AS (
         SELECT i.id,
                i.code,
                i.name,
                i.category,
                i.container_shape AS "shape",
                i.unit,
                i.show_in_pos AS "showInPos",
                i.low_stock_level AS "lowStockLevel",
                i.current_quantity AS "currentQuantity"
           FROM inventory_items i
          WHERE ${whereSql}
          LIMIT 1
       ),
       opening_row AS (
         SELECT oc.quantity,
                oc.unit,
                u.username AS "recordedBy",
                to_char(oc.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt"
           FROM inventory_opening_counts oc
           JOIN target_item ti ON ti.id = oc.item_id
           JOIN app_users u ON u.id = oc.recorded_by_user_id
       ),
       movement_rows AS (
         SELECT m.id,
                m.movement_type AS "movementType",
                m.quantity_delta AS "quantityDelta",
                m.balance_before AS "balanceBefore",
                m.balance_after AS "balanceAfter",
                m.unit,
                m.pos_reference AS "posReference",
                m.note,
                u.username AS "actor",
                to_char(
                  COALESCE(m.balance_applied_at, m.recorded_at) AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) AS "recordedAt",
                COALESCE(m.balance_applied_at, m.recorded_at) AS "recordedAtSort"
           FROM inventory_stock_movements m
           JOIN target_item ti ON ti.id = m.item_id
           JOIN app_users u ON u.id = m.actor_user_id
          WHERE m.quantity_delta <> 0
            AND m.entry_status = 'APPLIED'
       )
       SELECT (SELECT row_to_json(ti) FROM target_item ti) AS item,
              (SELECT row_to_json(op) FROM opening_row op) AS "openingStock",
              COALESCE(
                (
                  SELECT json_agg(
                    json_build_object(
                      'id', mr.id,
                      'movementType', mr."movementType",
                      'quantityDelta', mr."quantityDelta",
                      'balanceBefore', mr."balanceBefore",
                      'balanceAfter', mr."balanceAfter",
                      'unit', mr.unit,
                      'posReference', mr."posReference",
                      'note', mr.note,
                      'actor', mr.actor,
                      'recordedAt', mr."recordedAt"
                    )
                    ORDER BY mr."recordedAtSort" ASC, mr.id ASC
                  )
                  FROM movement_rows mr
                ),
                '[]'::json
              ) AS movements`,
      [whereParam],
    );

    const row = rows[0];
    if (!row || !row.item) {
      return null;
    }

    const rawItem = row.item;
    const opening = row.openingStock
      ? {
        quantity: Number(row.openingStock.quantity),
        unit: row.openingStock.unit,
        recordedBy: row.openingStock.recordedBy,
        recordedAt: formatManilaIsoPreservingPrecision(row.openingStock.recordedAt),
        recordedAtKey: normalizeUtcIsoMicroseconds(row.openingStock.recordedAt),
      }
      : null;

    const currentQuantity =
      rawItem.currentQuantity === null || rawItem.currentQuantity === undefined
        ? null
        : Number(rawItem.currentQuantity);

    const rawMovements = parseJsonArray<{
      id: string;
      movementType:
        | "POS_SALE"
        | "PRIOR_DAY_SETTLEMENT"
        | "PHYSICAL_COUNT_RECONCILIATION"
        | "SALE_ACTION_DEDUCTION"
        | "SALE_ACTION_RESTORATION"
        | "STOCK_RECEIVED"
        | "STOCK_USED";
      quantityDelta: number | string;
      balanceBefore: number | string;
      balanceAfter: number | string;
      unit: string;
      posReference: string | null;
      note: string | null;
      actor: string;
      recordedAt: string;
    }>(row.movements);

    return {
      item: {
        id: rawItem.id,
        code: rawItem.code,
        name: rawItem.name,
        category: rawItem.category,
        shape: rawItem.shape ?? null,
        unit: rawItem.unit,
        showInPos: Boolean(rawItem.showInPos),
        lowStockLevel:
          rawItem.lowStockLevel === null || rawItem.lowStockLevel === undefined
            ? null
            : Number(rawItem.lowStockLevel),
        status: opening ? "INITIALIZED" : "NOT_SET",
        currentQuantity: opening ? currentQuantity : null,
      },
      openingStock: opening,
      movements: rawMovements.map((m) => ({
        id: m.id,
        movementType: m.movementType,
        quantityDelta: Number(m.quantityDelta),
        balanceBefore: Number(m.balanceBefore),
        balanceAfter: Number(m.balanceAfter),
        unit: m.unit,
        posReference: m.posReference ?? null,
        note: m.note ?? null,
        actor: m.actor,
        recordedAt: formatManilaIsoPreservingPrecision(m.recordedAt),
        recordedAtKey: normalizeUtcIsoMicroseconds(m.recordedAt),
      })),
    };
  },
};
