import type { Queryable } from "../../db/database.js";
import { formatManilaIso, type ItemKind, type WaterType } from "../pos/sales.js";
import type {
  BusinessDayRecord,
  DailySalesAggregate,
  DashboardPriorDaySettlement,
  SaleItemAggregate,
} from "./salesReport.js";

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

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === "string") {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
  return [];
}

/** Read-only PostgreSQL queries for the Dashboard v1 Sales report. */
export const dashboardRepository = {
  async loadSalesInputs(
    db: Queryable,
    input: {
      from: string;
      to: string;
      todayDate: string;
      cutoffDate: Date;
    },
  ): Promise<{
    businessDays: BusinessDayRecord[];
    salesByDate: DailySalesAggregate[];
    itemAggregates: SaleItemAggregate[];
    priorDaySettlements: DashboardPriorDaySettlement[];
  }> {
    const params = [input.from, input.to, input.todayDate, input.cutoffDate];

    // Single SQL statement guarantees all report reads share one PostgreSQL MVCC snapshot.
    const { rows } = await db.query<{
      businessDays: unknown;
      salesByDate: unknown;
      itemAggregates: unknown;
      priorDaySettlements: unknown;
    }>(
      `WITH business_days AS (
         SELECT to_char(business_date, 'YYYY-MM-DD') AS "businessDate",
                CASE
                  WHEN closed_at IS NOT NULL AND closed_at <= $4::timestamptz
                    THEN to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                  ELSE NULL
                END AS "closedAt"
           FROM pos_business_days
          WHERE business_date >= $1::date
            AND business_date <= $2::date
            AND (business_date < $3::date OR started_at <= $4::timestamptz)
       ),
       active_sales AS (
         SELECT id, business_date, total_centavos
           FROM pos_sales
          WHERE status = 'ACTIVE'
            AND business_date >= $1::date
            AND business_date <= $2::date
            AND (business_date < $3::date OR created_at <= $4::timestamptz)
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
                COALESCE(SUM(i.quantity), 0)::bigint AS "quantity",
                COALESCE(SUM(i.line_volume_ml), 0)::bigint AS "volumeMl",
                COALESCE(SUM(i.line_total_centavos), 0)::bigint AS "salesCentavos"
           FROM pos_sale_items i
           JOIN active_sales s ON s.id = i.sale_id
          GROUP BY i.item_kind, i.water_type
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
            AND (p.settlement_date < $3::date OR p.settled_at <= $4::timestamptz)
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
              ) AS "priorDaySettlements"`,
      params,
    );

    const row = rows[0];
    const businessDays = parseJsonArray<RawBusinessDayJson>(row?.businessDays);
    const salesByDate = parseJsonArray<RawDailySalesJson>(row?.salesByDate);
    const itemAggregates = parseJsonArray<RawItemAggregateJson>(row?.itemAggregates);
    const settlements = parseJsonArray<RawSettlementJson>(row?.priorDaySettlements);

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
    };
  },
};
