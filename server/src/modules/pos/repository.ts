import type { Queryable } from "../../db/database.js";
import {
  aggregateMerchandiseDemand,
  type CheckoutStatus,
  type CheckoutView,
  type CatalogRefill,
  CONTAINER_PACKAGE_DEFINITIONS,
  type ContainerShape,
  type DaySummaryView,
  type DayView,
  type FaucetReportingType,
  formatManilaIso,
  formatSaleReference,
  type IncludedGripoType,
  type ItemKind,
  mlToLiters,
  type PosContainerPackageItem,
  type PosMerchandiseItem,
  type PosSection,
  type PosSectionInfo,
  type PriorDaySettlementView,
  type QuoteLineItem,
  type SaleActionView,
  type SaleStatus,
  type SaleView,
  type WaterType,
} from "./sales.js";

export interface CatalogDbRow {
  code: string;
  waterType: WaterType;
  displayName: string;
  unitVolumeMl: number | string;
  unitPriceCentavos: number | string;
}

export interface MerchandiseCatalogDbRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unit: string;
  unitPriceCentavos: number | string;
  posSection: PosSection;
  faucetReportingType: FaucetReportingType | null;
  currentQuantity: number | string | null;
  activeCommitted: number | string;
}

export interface LockedMerchandiseItem {
  id: string;
  code: string;
  name: string;
  category: "CONTAINER" | "MERCHANDISE";
  containerShape: ContainerShape | null;
  description: string | null;
  unit: string;
  unitPriceCentavos: number | null;
  showInPos: boolean;
  posSection: PosSection | null;
  faucetReportingType: FaucetReportingType | null;
  currentQuantity: number | null;
  archivedAt: string | null;
  otherActiveCommitted: number;
}

export interface DayDbRow {
  id: string;
  businessDate: string;
  startedByUserId: string;
  startedByUsername: string;
  startedAt: Date | string;
  startRequestKey: string | null;
  closedByUserId: string | null;
  closedByUsername: string | null;
  closedAt: Date | string | null;
  closeRequestKey: string | null;
  closedTotalSalesCentavos: number | string | null;
  closedValidTxCount: number | string | null;
  closedPurifiedQty: number | string | null;
  closedAlkalineQty: number | string | null;
  closedPurifiedVolumeMl: number | string | null;
  closedAlkalineVolumeMl: number | string | null;
  closedVoidedCount: number | string | null;
  closedVoidedTotalCentavos: number | string | null;
  nextReferenceSeq: number | string;
}

export interface CheckoutDbRow {
  id: string;
  reference: string;
  prepareKey: string | null;
  businessDayId: string;
  businessDate: string;
  createdByUserId: string;
  createdByUsername: string;
  status: CheckoutStatus;
  quoteSnapshot: unknown;
  quoteHash: string;
  totalCentavos: number | string;
  totalContainers: number | string;
  totalVolumeMl: number | string;
  cashReceivedCentavos: number | string | null;
  changeCentavos: number | string | null;
  paymentStartedAt: Date | string | null;
  paymentRecordedAt: Date | string | null;
  resolutionReason: string | null;
  cancellationOrigin: "EXPLICIT_OPERATOR" | "AUTO_END_DAY" | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  dayClosedAt: Date | string | null;
}

interface SaleDbRow {
  id: string;
  reference: string;
  checkoutId: string;
  checkoutReference: string;
  businessDayId: string;
  businessDate: string;
  status: SaleStatus;
  totalCentavos: number | string;
  cashReceivedCentavos: number | string;
  changeCentavos: number | string;
  totalContainers: number | string;
  totalVolumeMl: number | string;
  createdByUserId: string;
  createdByUsername: string;
  createdAt: Date | string;
}

interface SaleItemDbRow {
  saleId: string;
  lineIndex: number | string;
  itemKind: ItemKind;
  catalogCode: string | null;
  waterType: WaterType | null;
  productId: string | null;
  stockUnit: string | null;
  posSection: PosSection | null;
  includedGripo: IncludedGripoType | null;
  faucetReportingType: FaucetReportingType | "NONE" | null;
  displayLabel: string;
  unitVolumeMl: number | string;
  unitPriceCentavos: number | string;
  quantity: number | string;
  lineTotalCentavos: number | string;
  lineVolumeMl: number | string;
}

interface SaleActionDbRow {
  saleId: string;
  action: "SALE_SAVED" | "SALE_VOIDED";
  actorUsername: string;
  note: string | null;
  recordedAt: Date | string;
}

interface PriorDaySettlementDbRow {
  id: string;
  checkoutId: string;
  checkoutReference: string;
  originalBusinessDayId: string;
  originalBusinessDate: string;
  settlementDate: string;
  outcome: "PAID_AND_DELIVERED";
  netAmountKeptCentavos: number | string;
  cashReceivedCentavos: number | string | null;
  changeCentavos: number | string | null;
  totalContainers: number | string;
  totalVolumeMl: number | string;
  itemsSnapshot: unknown;
  originalActorUsername: string;
  originalPaymentStartedAt: Date | string | null;
  originalPaymentRecordedAt: Date | string | null;
  paymentKeptConfirmed: boolean;
  refillDeliveredConfirmed: boolean;
  settledByUsername: string;
  settledAt: Date | string;
  note: string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function parseQuoteSnapshot(raw: unknown): QuoteLineItem[] {
  if (typeof raw === "string") {
    return JSON.parse(raw) as QuoteLineItem[];
  }
  return (Array.isArray(raw) ? raw : []) as QuoteLineItem[];
}

export function toCatalogRefill(row: CatalogDbRow): CatalogRefill {
  const unitVolumeMl = Number(row.unitVolumeMl);
  return {
    code: row.code,
    waterType: row.waterType,
    displayName: row.displayName,
    unitVolumeMl,
    unitVolumeLiters: mlToLiters(unitVolumeMl),
    unitPriceCentavos: Number(row.unitPriceCentavos),
  };
}

export function toPosMerchandiseItem(row: MerchandiseCatalogDbRow): PosMerchandiseItem {
  const currentQuantity = row.currentQuantity === null ? null : Number(row.currentQuantity);
  const activeCommitted = Number(row.activeCommitted ?? 0);
  const availableQuantity =
    currentQuantity === null ? null : Math.max(0, currentQuantity - activeCommitted);
  const stockStatus =
    currentQuantity === null
      ? "NOT_SET"
      : availableQuantity === 0
        ? "OUT_OF_STOCK"
        : "IN_STOCK";
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    unit: row.unit,
    unitPriceCentavos: Number(row.unitPriceCentavos),
    posSection: row.posSection,
    stockStatus,
    currentQuantity,
    availableQuantity,
  };
}

export function toClosedDayView(row: DayDbRow): DayView {
  const purifiedVolumeMl = Number(row.closedPurifiedVolumeMl ?? 0);
  const alkalineVolumeMl = Number(row.closedAlkalineVolumeMl ?? 0);
  const totalVolumeMl = purifiedVolumeMl + alkalineVolumeMl;
  return {
    businessDate: row.businessDate,
    startedBy: row.startedByUsername,
    startedAt: formatManilaIso(toDate(row.startedAt)),
    closedBy: row.closedByUsername,
    closedAt: row.closedAt ? formatManilaIso(toDate(row.closedAt)) : null,
    summary: {
      businessDate: row.businessDate,
      totalSalesCentavos: Number(row.closedTotalSalesCentavos ?? 0),
      validTransactionCount: Number(row.closedValidTxCount ?? 0),
      purifiedQuantity: Number(row.closedPurifiedQty ?? 0),
      alkalineQuantity: Number(row.closedAlkalineQty ?? 0),
      purifiedVolumeMl,
      alkalineVolumeMl,
      totalVolumeMl,
      totalVolumeLiters: mlToLiters(totalVolumeMl),
      voidedCount: Number(row.closedVoidedCount ?? 0),
      voidedTotalCentavos: Number(row.closedVoidedTotalCentavos ?? 0),
    },
  };
}

export function toDayViewWithSummary(row: DayDbRow, summary: DaySummaryView): DayView {
  if (row.closedAt !== null) {
    return toClosedDayView(row);
  }
  return {
    businessDate: row.businessDate,
    startedBy: row.startedByUsername,
    startedAt: formatManilaIso(toDate(row.startedAt)),
    closedBy: null,
    closedAt: null,
    summary,
  };
}

export function toCheckoutView(row: CheckoutDbRow): CheckoutView {
  const totalVolumeMl = Number(row.totalVolumeMl);
  return {
    reference: row.reference,
    businessDate: row.businessDate,
    status: row.status,
    createdBy: row.createdByUsername,
    createdAt: formatManilaIso(toDate(row.createdAt)),
    updatedAt: formatManilaIso(toDate(row.updatedAt)),
    totalCentavos: Number(row.totalCentavos),
    totalContainers: Number(row.totalContainers),
    totalVolumeMl,
    totalVolumeLiters: mlToLiters(totalVolumeMl),
    cashReceivedCentavos: row.cashReceivedCentavos === null ? null : Number(row.cashReceivedCentavos),
    changeCentavos: row.changeCentavos === null ? null : Number(row.changeCentavos),
    paymentStartedAt: row.paymentStartedAt ? formatManilaIso(toDate(row.paymentStartedAt)) : null,
    paymentRecordedAt: row.paymentRecordedAt ? formatManilaIso(toDate(row.paymentRecordedAt)) : null,
    resolutionReason: row.resolutionReason,
    items: parseQuoteSnapshot(row.quoteSnapshot),
  };
}

export function toPriorDaySettlementView(row: PriorDaySettlementDbRow): PriorDaySettlementView {
  const totalVolumeMl = Number(row.totalVolumeMl);
  return {
    checkoutReference: row.checkoutReference,
    originalBusinessDate: row.originalBusinessDate,
    settlementDate: row.settlementDate,
    outcome: row.outcome,
    netAmountKeptCentavos: Number(row.netAmountKeptCentavos),
    cashReceivedCentavos: row.cashReceivedCentavos === null ? null : Number(row.cashReceivedCentavos),
    changeCentavos: row.changeCentavos === null ? null : Number(row.changeCentavos),
    totalContainers: Number(row.totalContainers),
    totalVolumeMl,
    totalVolumeLiters: mlToLiters(totalVolumeMl),
    items: parseQuoteSnapshot(row.itemsSnapshot),
    originalActor: row.originalActorUsername,
    originalPaymentStartedAt: row.originalPaymentStartedAt
      ? formatManilaIso(toDate(row.originalPaymentStartedAt))
      : null,
    originalPaymentRecordedAt: row.originalPaymentRecordedAt
      ? formatManilaIso(toDate(row.originalPaymentRecordedAt))
      : null,
    paymentKeptConfirmed: true,
    refillDeliveredConfirmed: true,
    settledBy: row.settledByUsername,
    settledAt: formatManilaIso(toDate(row.settledAt)),
    note: row.note,
  };
}

const DAY_SELECT = `
  SELECT d.id,
         to_char(d.business_date, 'YYYY-MM-DD') AS "businessDate",
         d.started_by_user_id AS "startedByUserId",
         starter.username AS "startedByUsername",
         d.started_at AS "startedAt",
         d.start_request_key AS "startRequestKey",
         d.closed_by_user_id AS "closedByUserId",
         closer.username AS "closedByUsername",
         d.closed_at AS "closedAt",
         d.close_request_key AS "closeRequestKey",
         d.closed_total_sales_centavos AS "closedTotalSalesCentavos",
         d.closed_valid_tx_count AS "closedValidTxCount",
         d.closed_purified_qty AS "closedPurifiedQty",
         d.closed_alkaline_qty AS "closedAlkalineQty",
         d.closed_purified_volume_ml AS "closedPurifiedVolumeMl",
         d.closed_alkaline_volume_ml AS "closedAlkalineVolumeMl",
         d.closed_voided_count AS "closedVoidedCount",
         d.closed_voided_total_centavos AS "closedVoidedTotalCentavos",
         d.next_reference_seq AS "nextReferenceSeq"
    FROM pos_business_days d
    JOIN app_users starter ON starter.id = d.started_by_user_id
    LEFT JOIN app_users closer ON closer.id = d.closed_by_user_id`;

const CHECKOUT_SELECT = `
  SELECT c.id,
         c.reference,
         c.prepare_key AS "prepareKey",
         c.business_day_id AS "businessDayId",
         to_char(c.business_date, 'YYYY-MM-DD') AS "businessDate",
         c.created_by_user_id AS "createdByUserId",
         creator.username AS "createdByUsername",
         c.status,
         c.quote_snapshot AS "quoteSnapshot",
         c.quote_hash AS "quoteHash",
         c.total_centavos AS "totalCentavos",
         c.total_containers AS "totalContainers",
         c.total_volume_ml AS "totalVolumeMl",
         c.cash_received_centavos AS "cashReceivedCentavos",
         c.change_centavos AS "changeCentavos",
         c.payment_started_at AS "paymentStartedAt",
         c.payment_recorded_at AS "paymentRecordedAt",
         c.resolution_reason AS "resolutionReason",
         c.cancellation_origin AS "cancellationOrigin",
         c.created_at AS "createdAt",
         c.updated_at AS "updatedAt",
         d.closed_at AS "dayClosedAt"
    FROM pos_checkouts c
    JOIN app_users creator ON creator.id = c.created_by_user_id
    JOIN pos_business_days d ON d.id = c.business_day_id`;

const SALE_SELECT = `
  SELECT s.id,
         s.reference,
         s.checkout_id AS "checkoutId",
         c.reference AS "checkoutReference",
         s.business_day_id AS "businessDayId",
         to_char(s.business_date, 'YYYY-MM-DD') AS "businessDate",
         s.status,
         s.total_centavos AS "totalCentavos",
         s.cash_received_centavos AS "cashReceivedCentavos",
         s.change_centavos AS "changeCentavos",
         s.total_containers AS "totalContainers",
         s.total_volume_ml AS "totalVolumeMl",
         s.created_by_user_id AS "createdByUserId",
         creator.username AS "createdByUsername",
         s.created_at AS "createdAt"
    FROM pos_sales s
    JOIN pos_checkouts c ON c.id = s.checkout_id
    JOIN app_users creator ON creator.id = s.created_by_user_id`;

const SETTLEMENT_SELECT = `
  SELECT p.id,
         p.checkout_id AS "checkoutId",
         p.checkout_reference AS "checkoutReference",
         p.original_business_day_id AS "originalBusinessDayId",
         to_char(p.original_business_date, 'YYYY-MM-DD') AS "originalBusinessDate",
         to_char(p.settlement_date, 'YYYY-MM-DD') AS "settlementDate",
         p.outcome,
         p.net_amount_kept_centavos AS "netAmountKeptCentavos",
         p.cash_received_centavos AS "cashReceivedCentavos",
         p.change_centavos AS "changeCentavos",
         p.total_containers AS "totalContainers",
         p.total_volume_ml AS "totalVolumeMl",
         p.items_snapshot AS "itemsSnapshot",
         orig.username AS "originalActorUsername",
         p.original_payment_started_at AS "originalPaymentStartedAt",
         p.original_payment_recorded_at AS "originalPaymentRecordedAt",
         p.payment_kept_confirmed AS "paymentKeptConfirmed",
         p.refill_delivered_confirmed AS "refillDeliveredConfirmed",
         settler.username AS "settledByUsername",
         p.settled_at AS "settledAt",
         p.note
    FROM pos_prior_day_settlements p
    JOIN app_users orig ON orig.id = p.original_actor_user_id
    JOIN app_users settler ON settler.id = p.settled_by_user_id`;

async function loadPriorDaySettlements(
  db: Queryable,
  whereAndOrderSql: string,
  params: unknown[],
): Promise<PriorDaySettlementView[]> {
  const { rows } = await db.query<PriorDaySettlementDbRow>(
    `${SETTLEMENT_SELECT} ${whereAndOrderSql}`,
    params,
  );
  return rows.map(toPriorDaySettlementView);
}

async function loadSaleViews(
  db: Queryable,
  whereAndOrderSql: string,
  params: unknown[],
): Promise<SaleView[]> {
  const { rows: saleRows } = await db.query<SaleDbRow>(`${SALE_SELECT} ${whereAndOrderSql}`, params);
  if (saleRows.length === 0) return [];

  const saleIds = saleRows.map((row) => row.id);
  const [{ rows: itemRows }, { rows: actionRows }] = await Promise.all([
    db.query<SaleItemDbRow>(
      `SELECT sale_id AS "saleId",
              line_index AS "lineIndex",
              item_kind AS "itemKind",
              catalog_code AS "catalogCode",
              water_type AS "waterType",
              inventory_item_id AS "productId",
              stock_unit AS "stockUnit",
              pos_section AS "posSection",
              included_gripo AS "includedGripo",
              faucet_reporting_type AS "faucetReportingType",
              display_label AS "displayLabel",
              unit_volume_ml AS "unitVolumeMl",
              unit_price_centavos AS "unitPriceCentavos",
              quantity,
              line_total_centavos AS "lineTotalCentavos",
              line_volume_ml AS "lineVolumeMl"
         FROM pos_sale_items
        WHERE sale_id = ANY($1::uuid[])
        ORDER BY sale_id, line_index ASC`,
      [saleIds],
    ),
    db.query<SaleActionDbRow>(
      `SELECT a.sale_id AS "saleId",
              a.action,
              u.username AS "actorUsername",
              a.note,
              a.recorded_at AS "recordedAt"
         FROM pos_sale_actions a
         JOIN app_users u ON u.id = a.actor_user_id
        WHERE a.sale_id = ANY($1::uuid[])
        ORDER BY a.recorded_at ASC, a.id ASC`,
      [saleIds],
    ),
  ]);

  const itemsBySale = new Map<string, QuoteLineItem[]>();
  for (const row of itemRows) {
    const unitVolumeMl = Number(row.unitVolumeMl);
    const lineVolumeMl = Number(row.lineVolumeMl);
    const item: QuoteLineItem = {
      lineIndex: Number(row.lineIndex),
      kind: row.itemKind,
      catalogCode: row.catalogCode,
      waterType: row.waterType,
      ...(row.itemKind === "MERCHANDISE" || row.itemKind === "CONTAINER_PACKAGE"
        ? {
            productId: row.productId,
            stockUnit: row.stockUnit,
            posSection: row.posSection,
            ...(row.itemKind === "MERCHANDISE" &&
            (row.faucetReportingType === "PUSH_TYPE" || row.faucetReportingType === "TWIST_TYPE")
              ? { faucetReportingType: row.faucetReportingType }
              : {}),
            ...(row.itemKind === "CONTAINER_PACKAGE"
              ? { includedGripo: row.includedGripo }
              : {}),
          }
        : {}),
      displayLabel: row.displayLabel,
      unitVolumeMl,
      unitVolumeLiters: mlToLiters(unitVolumeMl),
      unitPriceCentavos: Number(row.unitPriceCentavos),
      quantity: Number(row.quantity),
      lineTotalCentavos: Number(row.lineTotalCentavos),
      lineVolumeMl,
      lineVolumeLiters: mlToLiters(lineVolumeMl),
    };
    const bucket = itemsBySale.get(row.saleId);
    if (bucket) {
      bucket.push(item);
    } else {
      itemsBySale.set(row.saleId, [item]);
    }
  }

  const actionsBySale = new Map<string, SaleActionView[]>();
  for (const row of actionRows) {
    const action: SaleActionView = {
      action: row.action,
      actor: row.actorUsername,
      note: row.note,
      recordedAt: formatManilaIso(toDate(row.recordedAt)),
    };
    const bucket = actionsBySale.get(row.saleId);
    if (bucket) {
      bucket.push(action);
    } else {
      actionsBySale.set(row.saleId, [action]);
    }
  }

  return saleRows.map((row) => {
    const totalVolumeMl = Number(row.totalVolumeMl);
    return {
      reference: row.reference,
      checkoutReference: row.checkoutReference,
      businessDate: row.businessDate,
      status: row.status,
      totalCentavos: Number(row.totalCentavos),
      cashReceivedCentavos: Number(row.cashReceivedCentavos),
      changeCentavos: Number(row.changeCentavos),
      totalContainers: Number(row.totalContainers),
      totalVolumeMl,
      totalVolumeLiters: mlToLiters(totalVolumeMl),
      createdBy: row.createdByUsername,
      createdAt: formatManilaIso(toDate(row.createdAt)),
      items: itemsBySale.get(row.id) ?? [],
      actionHistory: actionsBySale.get(row.id) ?? [],
    };
  });
}

/** PostgreSQL persistence adapter for POS station days, checkouts, and sales. */
export const posRepository = {
  async listActiveCatalog(db: Queryable): Promise<CatalogRefill[]> {
    const { rows } = await db.query<CatalogDbRow>(
      `SELECT code,
              water_type AS "waterType",
              display_name AS "displayName",
              unit_volume_ml AS "unitVolumeMl",
              unit_price_centavos AS "unitPriceCentavos"
         FROM pos_refill_catalog
        WHERE active = true
        ORDER BY CASE water_type WHEN 'PURIFIED' THEN 1 ELSE 2 END, code ASC`,
    );
    return rows.map(toCatalogRefill);
  },

  async listPosSections(db: Queryable): Promise<PosSectionInfo[]> {
    const { rows } = await db.query<{
      code: string;
      name: string;
      isBuiltIn: boolean;
      sortOrder: number | string;
    }>(
      `SELECT code,
              name,
              is_built_in AS "isBuiltIn",
              sort_order AS "sortOrder"
         FROM inventory_pos_sections
        ORDER BY sort_order ASC, LOWER(name) ASC, created_at ASC`,
    );
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      isBuiltIn: Boolean(row.isBuiltIn),
      sortOrder: Number(row.sortOrder),
    }));
  },

  async listVisiblePosContainerPackages(db: Queryable): Promise<PosContainerPackageItem[]> {
    const { rows } = await db.query<{
      id: string;
      containerShape: ContainerShape;
      unit: string;
      currentQuantity: number | string | null;
      activeCommitted: number | string;
    }>(
      `SELECT i.id,
              i.container_shape AS "containerShape",
              i.unit,
              i.current_quantity AS "currentQuantity",
              COALESCE(c.committed_qty, 0) AS "activeCommitted"
         FROM inventory_items i
         LEFT JOIN (
           SELECT item_id, SUM(quantity)::integer AS committed_qty
             FROM pos_checkout_stock_commitments
            WHERE status = 'ACTIVE'
            GROUP BY item_id
         ) c ON c.item_id = i.id
        WHERE i.category = 'CONTAINER'
          AND i.show_in_pos = true
          AND i.archived_at IS NULL
        ORDER BY CASE i.container_shape WHEN 'ROUND' THEN 1 WHEN 'SLIM' THEN 2 ELSE 3 END`,
    );

    const byShape = new Map<
      ContainerShape,
      {
        id: string;
        unit: string;
        currentQuantity: number | null;
        availableQuantity: number | null;
        stockStatus: "NOT_SET" | "OUT_OF_STOCK" | "IN_STOCK";
      }
    >();

    for (const row of rows) {
      const currentQuantity = row.currentQuantity === null ? null : Number(row.currentQuantity);
      const activeCommitted = Number(row.activeCommitted ?? 0);
      const availableQuantity =
        currentQuantity === null ? null : Math.max(0, currentQuantity - activeCommitted);
      const stockStatus =
        currentQuantity === null
          ? "NOT_SET"
          : availableQuantity === 0
            ? "OUT_OF_STOCK"
            : "IN_STOCK";
      byShape.set(row.containerShape, {
        id: row.id,
        unit: row.unit,
        currentQuantity,
        availableQuantity,
        stockStatus,
      });
    }

    const packages: PosContainerPackageItem[] = [];
    for (const def of CONTAINER_PACKAGE_DEFINITIONS) {
      const container = byShape.get(def.shape);
      if (!container) continue;
      packages.push({
        packageCode: def.packageCode,
        shape: def.shape,
        productId: container.id,
        name: def.name,
        description: def.description,
        unit: container.unit,
        waterType: def.waterType,
        unitVolumeMl: def.unitVolumeMl,
        unitVolumeLiters: def.unitVolumeLiters,
        unitPriceCentavos: def.unitPriceCentavos,
        posSection: "CONTAINERS",
        stockStatus: container.stockStatus,
        currentQuantity: container.currentQuantity,
        availableQuantity: container.availableQuantity,
      });
    }
    return packages;
  },

  async listVisiblePosMerchandise(db: Queryable): Promise<PosMerchandiseItem[]> {
    const { rows } = await db.query<MerchandiseCatalogDbRow>(
      `SELECT i.id,
              i.code,
              i.name,
              i.description,
              i.unit,
              i.unit_price_centavos AS "unitPriceCentavos",
              i.pos_section AS "posSection",
              i.faucet_reporting_type AS "faucetReportingType",
              i.current_quantity AS "currentQuantity",
              COALESCE(c.committed_qty, 0) AS "activeCommitted"
         FROM inventory_items i
         LEFT JOIN inventory_pos_sections s ON s.code = i.pos_section
         LEFT JOIN (
           SELECT item_id, SUM(quantity)::integer AS committed_qty
             FROM pos_checkout_stock_commitments
            WHERE status = 'ACTIVE'
            GROUP BY item_id
         ) c ON c.item_id = i.id
        WHERE i.category = 'MERCHANDISE'
          AND i.show_in_pos = true
          AND i.archived_at IS NULL
        ORDER BY COALESCE(s.sort_order, 100) ASC,
                 LOWER(COALESCE(s.name, '')) ASC,
                 LOWER(i.name) ASC,
                 i.created_at ASC`,
    );
    return rows.map(toPosMerchandiseItem);
  },

  async lockMerchandiseItemsForUpdate(
    tx: Queryable,
    productIds: string[],
    excludeCheckoutId?: string,
  ): Promise<Map<string, LockedMerchandiseItem>> {
    const uniqueSorted = Array.from(new Set(productIds)).sort();
    const map = new Map<string, LockedMerchandiseItem>();
    if (uniqueSorted.length === 0) return map;

    const { rows } = await tx.query<{
      id: string;
      code: string;
      name: string;
      category: "CONTAINER" | "MERCHANDISE";
      containerShape: ContainerShape | null;
      description: string | null;
      unit: string;
      unitPriceCentavos: number | string | null;
      showInPos: boolean;
      posSection: PosSection | null;
      faucetReportingType: FaucetReportingType | null;
      currentQuantity: number | string | null;
      archivedAt: Date | string | null;
    }>(
      `SELECT id,
              code,
              name,
              category,
              container_shape AS "containerShape",
              description,
              unit,
              unit_price_centavos AS "unitPriceCentavos",
              show_in_pos AS "showInPos",
              pos_section AS "posSection",
              faucet_reporting_type AS "faucetReportingType",
              current_quantity AS "currentQuantity",
              archived_at AS "archivedAt"
         FROM inventory_items
        WHERE id = ANY($1::uuid[])
        ORDER BY id ASC
        FOR UPDATE`,
      [uniqueSorted],
    );

    const committedRes = excludeCheckoutId
      ? await tx.query<{ itemId: string; committedQty: number | string }>(
          `SELECT item_id AS "itemId", SUM(quantity)::integer AS "committedQty"
             FROM pos_checkout_stock_commitments
            WHERE item_id = ANY($1::uuid[])
              AND status = 'ACTIVE'
              AND checkout_id <> $2
            GROUP BY item_id`,
          [uniqueSorted, excludeCheckoutId],
        )
      : await tx.query<{ itemId: string; committedQty: number | string }>(
          `SELECT item_id AS "itemId", SUM(quantity)::integer AS "committedQty"
             FROM pos_checkout_stock_commitments
            WHERE item_id = ANY($1::uuid[])
              AND status = 'ACTIVE'
            GROUP BY item_id`,
          [uniqueSorted],
        );

    const committedByItem = new Map<string, number>();
    for (const c of committedRes.rows) {
      committedByItem.set(c.itemId, Number(c.committedQty));
    }

    for (const row of rows) {
      if (row.category === "MERCHANDISE" && row.unitPriceCentavos === null) continue;
      map.set(row.id, {
        id: row.id,
        code: row.code,
        name: row.name,
        category: row.category,
        containerShape: row.containerShape,
        description: row.description ?? null,
        unit: row.unit,
        unitPriceCentavos: row.unitPriceCentavos === null ? null : Number(row.unitPriceCentavos),
        showInPos: Boolean(row.showInPos),
        posSection: row.posSection ?? null,
        faucetReportingType: row.faucetReportingType ?? null,
        currentQuantity: row.currentQuantity === null ? null : Number(row.currentQuantity),
        archivedAt: row.archivedAt ? formatManilaIso(toDate(row.archivedAt)) : null,
        otherActiveCommitted: committedByItem.get(row.id) ?? 0,
      });
    }
    return map;
  },

  async lockPublishedContainerShapesForUpdate(
    tx: Queryable,
    shapes: ContainerShape[],
  ): Promise<Map<ContainerShape, LockedMerchandiseItem>> {
    const uniqueSorted = Array.from(new Set(shapes)).sort();
    const byShape = new Map<ContainerShape, LockedMerchandiseItem>();
    if (uniqueSorted.length === 0) return byShape;

    const { rows } = await tx.query<{ id: string }>(
      `SELECT id
         FROM inventory_items
        WHERE category = 'CONTAINER'
          AND container_shape = ANY($1::text[])
        ORDER BY id ASC`,
      [uniqueSorted],
    );
    const byId = await this.lockMerchandiseItemsForUpdate(
      tx,
      rows.map((r) => r.id),
    );
    for (const item of byId.values()) {
      if (item.containerShape) {
        byShape.set(item.containerShape, item);
      }
    }
    return byShape;
  },

  async upsertActiveCommitments(
    tx: Queryable,
    checkoutId: string,
    demandMap: ReadonlyMap<string, number>,
    now: Date,
  ): Promise<void> {
    for (const [itemId, qty] of demandMap.entries()) {
      await tx.query(
        `INSERT INTO pos_checkout_stock_commitments
           (checkout_id, item_id, quantity, status, created_at, resolved_at)
         VALUES ($1, $2, $3, 'ACTIVE', $4, NULL)
         ON CONFLICT (checkout_id, item_id)
         DO UPDATE SET quantity = EXCLUDED.quantity,
                       status = 'ACTIVE',
                       resolved_at = NULL`,
        [checkoutId, itemId, qty, now],
      );
    }
  },

  async releaseCommitmentsForCheckout(
    tx: Queryable,
    checkoutId: string,
    now: Date,
  ): Promise<void> {
    await tx.query(
      `UPDATE pos_checkout_stock_commitments
          SET status = 'RELEASED',
              resolved_at = $2
        WHERE checkout_id = $1 AND status = 'ACTIVE'`,
      [checkoutId, now],
    );
  },

  async lockDaysTable(tx: Queryable): Promise<void> {
    await tx.query("LOCK TABLE pos_business_days IN SHARE ROW EXCLUSIVE MODE");
  },

  async findOpenDay(db: Queryable): Promise<DayDbRow | undefined> {
    const { rows } = await db.query<DayDbRow>(`${DAY_SELECT} WHERE d.closed_at IS NULL LIMIT 1`);
    return rows[0];
  },

  async lockOpenDay(tx: Queryable): Promise<DayDbRow | undefined> {
    const { rows: lockRows } = await tx.query<{ id: string }>(
      `SELECT id FROM pos_business_days WHERE closed_at IS NULL FOR UPDATE`,
    );
    const id = lockRows[0]?.id;
    if (!id) return undefined;
    const { rows } = await tx.query<DayDbRow>(`${DAY_SELECT} WHERE d.id = $1`, [id]);
    return rows[0];
  },

  async findDayByDate(db: Queryable, businessDate: string): Promise<DayDbRow | undefined> {
    const { rows } = await db.query<DayDbRow>(
      `${DAY_SELECT} WHERE d.business_date = $1::date`,
      [businessDate],
    );
    return rows[0];
  },

  async lockDayById(tx: Queryable, dayId: string): Promise<DayDbRow | undefined> {
    await tx.query(`SELECT id FROM pos_business_days WHERE id = $1 FOR UPDATE`, [dayId]);
    const { rows } = await tx.query<DayDbRow>(`${DAY_SELECT} WHERE d.id = $1`, [dayId]);
    return rows[0];
  },

  async findDayByStartKey(db: Queryable, startRequestKey: string): Promise<DayDbRow | undefined> {
    const { rows } = await db.query<DayDbRow>(
      `${DAY_SELECT} WHERE d.start_request_key = $1`,
      [startRequestKey],
    );
    return rows[0];
  },

  async findDayByCloseKey(db: Queryable, closeRequestKey: string): Promise<DayDbRow | undefined> {
    const { rows } = await db.query<DayDbRow>(
      `${DAY_SELECT} WHERE d.close_request_key = $1`,
      [closeRequestKey],
    );
    return rows[0];
  },

  async insertOpenDay(
    tx: Queryable,
    input: {
      businessDate: string;
      startedByUserId: string;
      startedAt: Date;
      startRequestKey: string | null;
    },
  ): Promise<DayDbRow> {
    const { rows: inserted } = await tx.query<{ id: string }>(
      `INSERT INTO pos_business_days (business_date, started_by_user_id, started_at, start_request_key)
       VALUES ($1::date, $2, $3, $4)
       RETURNING id`,
      [input.businessDate, input.startedByUserId, input.startedAt, input.startRequestKey],
    );
    const { rows } = await tx.query<DayDbRow>(`${DAY_SELECT} WHERE d.id = $1`, [inserted[0]!.id]);
    return rows[0]!;
  },

  async allocateNextReference(tx: Queryable, dayId: string, businessDate: string): Promise<string> {
    const { rows: seqRows } = await tx.query<{ nextReferenceSeq: number | string }>(
      `SELECT next_reference_seq AS "nextReferenceSeq" FROM pos_business_days WHERE id = $1 FOR UPDATE`,
      [dayId],
    );
    let seq = Number(seqRows[0]!.nextReferenceSeq) + 1;
    while (true) {
      const candidate = formatSaleReference(businessDate, seq);
      const { rows: existsRows } = await tx.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM pos_checkouts WHERE reference = $1
           UNION ALL
           SELECT 1 FROM pos_sales WHERE reference = $1
         ) AS exists`,
        [candidate],
      );
      if (!existsRows[0]?.exists) {
        await tx.query(`UPDATE pos_business_days SET next_reference_seq = $2 WHERE id = $1`, [
          dayId,
          seq,
        ]);
        return candidate;
      }
      seq += 1;
    }
  },

  async computeLiveDaySummary(
    db: Queryable,
    dayId: string,
    businessDate: string,
  ): Promise<DaySummaryView> {
    const [{ rows: salesAgg }, { rows: itemAgg }] = await Promise.all([
      db.query<{
        totalSalesCentavos: number | string;
        validTransactionCount: number | string;
        voidedCount: number | string;
        voidedTotalCentavos: number | string;
      }>(
        `SELECT COALESCE(SUM(CASE WHEN s.status = 'ACTIVE' THEN s.total_centavos ELSE 0 END), 0) AS "totalSalesCentavos",
                COUNT(CASE WHEN s.status = 'ACTIVE' THEN 1 END) AS "validTransactionCount",
                COUNT(CASE WHEN s.status = 'VOIDED' THEN 1 END) AS "voidedCount",
                COALESCE(SUM(CASE WHEN s.status = 'VOIDED' THEN s.total_centavos ELSE 0 END), 0) AS "voidedTotalCentavos"
           FROM pos_sales s
          WHERE s.business_day_id = $1`,
        [dayId],
      ),
      db.query<{
        purifiedQuantity: number | string;
        alkalineQuantity: number | string;
        purifiedVolumeMl: number | string;
        alkalineVolumeMl: number | string;
      }>(
        `SELECT COALESCE(SUM(CASE WHEN s.status = 'ACTIVE' AND i.water_type = 'PURIFIED' THEN i.quantity ELSE 0 END), 0) AS "purifiedQuantity",
                COALESCE(SUM(CASE WHEN s.status = 'ACTIVE' AND i.water_type = 'ALKALINE' THEN i.quantity ELSE 0 END), 0) AS "alkalineQuantity",
                COALESCE(SUM(CASE WHEN s.status = 'ACTIVE' AND i.water_type = 'PURIFIED' THEN i.line_volume_ml ELSE 0 END), 0) AS "purifiedVolumeMl",
                COALESCE(SUM(CASE WHEN s.status = 'ACTIVE' AND i.water_type = 'ALKALINE' THEN i.line_volume_ml ELSE 0 END), 0) AS "alkalineVolumeMl"
           FROM pos_sale_items i
           JOIN pos_sales s ON s.id = i.sale_id
          WHERE s.business_day_id = $1`,
        [dayId],
      ),
    ]);

    const s = salesAgg[0]!;
    const i = itemAgg[0]!;
    const purifiedVolumeMl = Number(i.purifiedVolumeMl);
    const alkalineVolumeMl = Number(i.alkalineVolumeMl);
    const totalVolumeMl = purifiedVolumeMl + alkalineVolumeMl;

    return {
      businessDate,
      totalSalesCentavos: Number(s.totalSalesCentavos),
      validTransactionCount: Number(s.validTransactionCount),
      purifiedQuantity: Number(i.purifiedQuantity),
      alkalineQuantity: Number(i.alkalineQuantity),
      purifiedVolumeMl,
      alkalineVolumeMl,
      totalVolumeMl,
      totalVolumeLiters: mlToLiters(totalVolumeMl),
      voidedCount: Number(s.voidedCount),
      voidedTotalCentavos: Number(s.voidedTotalCentavos),
    };
  },

  async closeDay(
    tx: Queryable,
    input: {
      dayId: string;
      closedByUserId: string;
      closedAt: Date;
      closeRequestKey: string | null;
      summary: DaySummaryView;
    },
  ): Promise<DayDbRow> {
    await tx.query(
      `UPDATE pos_business_days
          SET closed_by_user_id = $2,
              closed_at = $3,
              close_request_key = $4,
              closed_total_sales_centavos = $5,
              closed_valid_tx_count = $6,
              closed_purified_qty = $7,
              closed_alkaline_qty = $8,
              closed_purified_volume_ml = $9,
              closed_alkaline_volume_ml = $10,
              closed_voided_count = $11,
              closed_voided_total_centavos = $12
        WHERE id = $1`,
      [
        input.dayId,
        input.closedByUserId,
        input.closedAt,
        input.closeRequestKey,
        input.summary.totalSalesCentavos,
        input.summary.validTransactionCount,
        input.summary.purifiedQuantity,
        input.summary.alkalineQuantity,
        input.summary.purifiedVolumeMl,
        input.summary.alkalineVolumeMl,
        input.summary.voidedCount,
        input.summary.voidedTotalCentavos,
      ],
    );
    const { rows } = await tx.query<DayDbRow>(`${DAY_SELECT} WHERE d.id = $1`, [input.dayId]);
    return rows[0]!;
  },

  async findCheckoutByPrepareKey(db: Queryable, prepareKey: string): Promise<CheckoutDbRow | undefined> {
    const { rows } = await db.query<CheckoutDbRow>(
      `${CHECKOUT_SELECT} WHERE c.prepare_key = $1`,
      [prepareKey],
    );
    return rows[0];
  },

  async findCheckoutByReference(db: Queryable, reference: string): Promise<CheckoutDbRow | undefined> {
    const { rows } = await db.query<CheckoutDbRow>(
      `${CHECKOUT_SELECT} WHERE c.reference = $1`,
      [reference],
    );
    return rows[0];
  },

  async lockCheckoutByReference(tx: Queryable, reference: string): Promise<CheckoutDbRow | undefined> {
    const { rows: lockRows } = await tx.query<{ id: string }>(
      `SELECT id FROM pos_checkouts WHERE reference = $1 FOR UPDATE`,
      [reference],
    );
    const id = lockRows[0]?.id;
    if (!id) return undefined;
    const { rows } = await tx.query<CheckoutDbRow>(`${CHECKOUT_SELECT} WHERE c.id = $1`, [id]);
    return rows[0];
  },

  async listNonTerminalCheckoutsForDay(db: Queryable, dayId: string): Promise<CheckoutDbRow[]> {
    const { rows } = await db.query<CheckoutDbRow>(
      `${CHECKOUT_SELECT}
        WHERE c.business_day_id = $1 AND c.status IN ('DRAFT', 'PAYMENT_PENDING', 'REVIEW_REQUIRED')
        ORDER BY c.created_at ASC, c.reference ASC`,
      [dayId],
    );
    return rows;
  },

  async lockNonTerminalCheckoutsForDay(tx: Queryable, dayId: string): Promise<CheckoutDbRow[]> {
    await tx.query(
      `SELECT id FROM pos_checkouts
        WHERE business_day_id = $1 AND status IN ('DRAFT', 'PAYMENT_PENDING', 'REVIEW_REQUIRED')
        FOR UPDATE`,
      [dayId],
    );
    return this.listNonTerminalCheckoutsForDay(tx, dayId);
  },

  async listClosedPriorDayReviewCheckouts(
    db: Queryable,
    todayDate: string,
  ): Promise<CheckoutDbRow[]> {
    const { rows } = await db.query<CheckoutDbRow>(
      `${CHECKOUT_SELECT}
        WHERE d.closed_at IS NOT NULL
          AND c.business_date < $1::date
          AND c.status IN ('PAYMENT_PENDING', 'REVIEW_REQUIRED')
        ORDER BY c.business_date DESC, c.created_at ASC, c.reference ASC`,
      [todayDate],
    );
    return rows;
  },

  async insertCheckout(
    tx: Queryable,
    input: {
      reference: string;
      prepareKey: string | null;
      businessDayId: string;
      businessDate: string;
      createdByUserId: string;
      items: QuoteLineItem[];
      quoteHash: string;
      totalCentavos: number;
      totalContainers: number;
      totalVolumeMl: number;
      now: Date;
    },
  ): Promise<CheckoutDbRow> {
    await tx.query(
      `INSERT INTO pos_checkouts (
         reference, prepare_key, business_day_id, business_date, created_by_user_id,
         status, quote_snapshot, quote_hash, total_centavos, total_containers, total_volume_ml,
         created_at, updated_at
       )
       VALUES ($1, $2, $3, $4::date, $5, 'DRAFT', $6::jsonb, $7, $8, $9, $10, $11, $11)`,
      [
        input.reference,
        input.prepareKey,
        input.businessDayId,
        input.businessDate,
        input.createdByUserId,
        JSON.stringify(input.items),
        input.quoteHash,
        input.totalCentavos,
        input.totalContainers,
        input.totalVolumeMl,
        input.now,
      ],
    );
    return (await this.findCheckoutByReference(tx, input.reference))!;
  },

  async markCheckoutReviewRequired(
    tx: Queryable,
    input: {
      checkoutId: string;
      reference: string;
      reason: string;
      cashReceivedCentavos: number;
      changeCentavos: number;
      now: Date;
    },
  ): Promise<CheckoutDbRow> {
    await tx.query(
      `UPDATE pos_checkouts
          SET status = 'REVIEW_REQUIRED',
              resolution_reason = $2,
              cash_received_centavos = $3,
              change_centavos = $4,
              payment_recorded_at = $5,
              updated_at = $5
        WHERE id = $1`,
      [
        input.checkoutId,
        input.reason,
        input.cashReceivedCentavos,
        input.changeCentavos,
        input.now,
      ],
    );
    return (await this.findCheckoutByReference(tx, input.reference))!;
  },

  async markCheckoutPaymentPending(
    tx: Queryable,
    input: { checkoutId: string; reference: string; now: Date },
  ): Promise<CheckoutDbRow> {
    await tx.query(
      `UPDATE pos_checkouts
          SET status = 'PAYMENT_PENDING',
              payment_started_at = COALESCE(payment_started_at, $2),
              updated_at = $2
        WHERE id = $1`,
      [input.checkoutId, input.now],
    );
    return (await this.findCheckoutByReference(tx, input.reference))!;
  },

  async markCheckoutCancelled(
    tx: Queryable,
    input: { checkoutId: string; reference: string; reason: string; now: Date },
  ): Promise<CheckoutDbRow> {
    await tx.query(
      `UPDATE pos_checkouts
          SET status = 'CANCELLED_DRAFT',
              resolution_reason = $2,
              cancellation_origin = 'EXPLICIT_OPERATOR',
              updated_at = $3
        WHERE id = $1`,
      [input.checkoutId, input.reason, input.now],
    );
    await this.releaseCommitmentsForCheckout(tx, input.checkoutId, input.now);
    return (await this.findCheckoutByReference(tx, input.reference))!;
  },

  async clearUnpaidDraftsForDay(tx: Queryable, dayId: string, now: Date): Promise<string[]> {
    const { rows } = await tx.query<{ id: string; reference: string }>(
      `UPDATE pos_checkouts
          SET status = 'CANCELLED_DRAFT',
              resolution_reason = 'CLEARED_ON_END_DAY',
              cancellation_origin = 'AUTO_END_DAY',
              updated_at = $2
        WHERE business_day_id = $1 AND status = 'DRAFT'
        RETURNING id, reference`,
      [dayId, now],
    );
    if (rows.length > 0) {
      await tx.query(
        `UPDATE pos_checkout_stock_commitments
            SET status = 'RELEASED',
                resolved_at = $2
          WHERE checkout_id = ANY($1::uuid[]) AND status = 'ACTIVE'`,
        [rows.map((r) => r.id), now],
      );
    }
    return rows.map((r) => r.reference).sort();
  },

  async insertSaleAtomic(
    tx: Queryable,
    input: {
      reference: string;
      checkoutId: string;
      businessDayId: string;
      businessDate: string;
      totalCentavos: number;
      cashReceivedCentavos: number;
      changeCentavos: number;
      totalContainers: number;
      totalVolumeMl: number;
      createdByUserId: string;
      items: QuoteLineItem[];
      lockedMerchandise?: ReadonlyMap<string, LockedMerchandiseItem>;
      now: Date;
    },
  ): Promise<{ sale: SaleView; checkout: CheckoutView }> {
    const { rows: saleInserted } = await tx.query<{ id: string }>(
      `INSERT INTO pos_sales (
         reference, checkout_id, business_day_id, business_date, status,
         total_centavos, cash_received_centavos, change_centavos,
         total_containers, total_volume_ml, created_by_user_id, created_at
       )
       VALUES ($1, $2, $3, $4::date, 'ACTIVE', $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        input.reference,
        input.checkoutId,
        input.businessDayId,
        input.businessDate,
        input.totalCentavos,
        input.cashReceivedCentavos,
        input.changeCentavos,
        input.totalContainers,
        input.totalVolumeMl,
        input.createdByUserId,
        input.now,
      ],
    );
    const saleId = saleInserted[0]!.id;

    for (const item of input.items) {
      const dbFaucetReportingType =
        item.kind !== "MERCHANDISE"
          ? null
          : item.faucetReportingType === "PUSH_TYPE" || item.faucetReportingType === "TWIST_TYPE"
            ? item.faucetReportingType
            : "faucetReportingType" in item
              ? "NONE"
              : null;

      await tx.query(
        `INSERT INTO pos_sale_items (
           sale_id, line_index, item_kind, catalog_code, water_type,
           inventory_item_id, stock_unit, pos_section, included_gripo, faucet_reporting_type,
           display_label, unit_volume_ml, unit_price_centavos, quantity,
           line_total_centavos, line_volume_ml
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          saleId,
          item.lineIndex,
          item.kind,
          item.catalogCode,
          item.waterType,
          item.productId ?? null,
          item.stockUnit ?? null,
          item.posSection ?? null,
          item.includedGripo ?? null,
          dbFaucetReportingType,
          item.displayLabel,
          item.unitVolumeMl,
          item.unitPriceCentavos,
          item.quantity,
          item.lineTotalCentavos,
          item.lineVolumeMl,
        ],
      );
    }

    const demandMap = aggregateMerchandiseDemand(input.items);
    if (demandMap.size > 0) {
      for (const [productId, qty] of demandMap.entries()) {
        const locked = input.lockedMerchandise?.get(productId);
        if (!locked || locked.currentQuantity === null) {
          throw new Error(`Missing locked stock for merchandise item ${productId}`);
        }
        const balanceBefore = locked.currentQuantity;
        const balanceAfter = balanceBefore - qty;
        if (balanceAfter < 0) {
          throw new Error(`Negative stock prevented for merchandise item ${productId}`);
        }

        await tx.query(
          `UPDATE inventory_items
              SET current_quantity = $2,
                  stock_revision = stock_revision + 1
            WHERE id = $1`,
          [productId, balanceAfter],
        );

        await tx.query(
          `INSERT INTO inventory_stock_movements (
             item_id, movement_type, quantity_delta, balance_before, balance_after,
             unit, pos_sale_id, pos_reference, actor_user_id, recorded_at
           )
           VALUES ($1, 'POS_SALE', $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            productId,
            -qty,
            balanceBefore,
            balanceAfter,
            locked.unit,
            saleId,
            input.reference,
            input.createdByUserId,
            input.now,
          ],
        );

        await tx.query(
          `INSERT INTO pos_checkout_stock_commitments
             (checkout_id, item_id, quantity, status, created_at, resolved_at)
           VALUES ($1, $2, $3, 'CONSUMED', $4, $4)
           ON CONFLICT (checkout_id, item_id)
           DO UPDATE SET quantity = EXCLUDED.quantity,
                         status = 'CONSUMED',
                         resolved_at = $4`,
          [input.checkoutId, productId, qty, input.now],
        );
      }
    }

    await tx.query(
      `INSERT INTO pos_sale_actions (sale_id, action, actor_user_id, note, recorded_at)
       VALUES ($1, 'SALE_SAVED', $2, NULL, $3)`,
      [saleId, input.createdByUserId, input.now],
    );

    await tx.query(
      `UPDATE pos_checkouts
          SET status = 'SAVED',
              cash_received_centavos = $2,
              change_centavos = $3,
              payment_recorded_at = $4,
              updated_at = $4
        WHERE id = $1`,
      [input.checkoutId, input.cashReceivedCentavos, input.changeCentavos, input.now],
    );

    const [sale, checkout] = await Promise.all([
      this.findSaleByReference(tx, input.reference),
      this.findCheckoutByReference(tx, input.reference),
    ]);

    return { sale: sale!, checkout: toCheckoutView(checkout!) };
  },

  async findSaleByReference(db: Queryable, reference: string): Promise<SaleView | undefined> {
    const sales = await loadSaleViews(db, `WHERE s.reference = $1`, [reference]);
    return sales[0];
  },

  async findSaleByCheckoutId(db: Queryable, checkoutId: string): Promise<SaleView | undefined> {
    const sales = await loadSaleViews(db, `WHERE s.checkout_id = $1`, [checkoutId]);
    return sales[0];
  },

  async listSales(
    db: Queryable,
    filters: {
      businessDate: string;
      status: "ACTIVE" | "VOIDED" | "ALL";
      referenceQuery: string;
    },
  ): Promise<SaleView[]> {
    const conditions: string[] = [`s.business_date = $1::date`];
    const params: unknown[] = [filters.businessDate];

    if (filters.status !== "ALL") {
      params.push(filters.status);
      conditions.push(`s.status = $${params.length}`);
    }

    const q = filters.referenceQuery.trim();
    if (q.length > 0) {
      const escaped = q.replace(/[\\%_]/g, "\\$&");
      params.push(`%${escaped}%`);
      conditions.push(`s.reference ILIKE $${params.length} ESCAPE '\\'`);
    }

    return loadSaleViews(
      db,
      `WHERE ${conditions.join(" AND ")} ORDER BY s.created_at DESC, s.reference DESC`,
      params,
    );
  },

  async findPriorDaySettlementByCheckoutId(
    db: Queryable,
    checkoutId: string,
  ): Promise<PriorDaySettlementView | undefined> {
    const rows = await loadPriorDaySettlements(db, `WHERE p.checkout_id = $1`, [checkoutId]);
    return rows[0];
  },

  async findPriorDaySettlementByReference(
    db: Queryable,
    reference: string,
  ): Promise<PriorDaySettlementView | undefined> {
    const rows = await loadPriorDaySettlements(db, `WHERE p.checkout_reference = $1`, [reference]);
    return rows[0];
  },

  async listPriorDaySettlements(
    db: Queryable,
    filters: {
      settlementDate?: string;
      originalBusinessDate?: string;
      referenceQuery: string;
    },
  ): Promise<PriorDaySettlementView[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.settlementDate) {
      params.push(filters.settlementDate);
      conditions.push(`p.settlement_date = $${params.length}::date`);
    }

    if (filters.originalBusinessDate) {
      params.push(filters.originalBusinessDate);
      conditions.push(`p.original_business_date = $${params.length}::date`);
    }

    const q = filters.referenceQuery.trim();
    if (q.length > 0) {
      const escaped = q.replace(/[\\%_]/g, "\\$&");
      params.push(`%${escaped}%`);
      conditions.push(`p.checkout_reference ILIKE $${params.length} ESCAPE '\\'`);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return loadPriorDaySettlements(
      db,
      `${whereSql} ORDER BY p.settled_at DESC, p.checkout_reference DESC`,
      params,
    );
  },

  async insertPriorDaySettlementAtomic(
    tx: Queryable,
    input: {
      checkoutId: string;
      checkoutReference: string;
      originalBusinessDayId: string;
      originalBusinessDate: string;
      settlementDate: string;
      netAmountKeptCentavos: number;
      cashReceivedCentavos: number | null;
      changeCentavos: number | null;
      totalContainers: number;
      totalVolumeMl: number;
      items: QuoteLineItem[];
      originalActorUserId: string;
      originalPaymentStartedAt: Date | null;
      originalPaymentRecordedAt: Date | null;
      settledByUserId: string;
      settledAt: Date;
      note: string | null;
      lockedMerchandise?: Map<string, LockedMerchandiseItem>;
    },
  ): Promise<{ settlement: PriorDaySettlementView; checkout: CheckoutView }> {
    const { rows: settlementRows } = await tx.query<{ id: string }>(
      `INSERT INTO pos_prior_day_settlements (
         checkout_id, checkout_reference, original_business_day_id,
         original_business_date, settlement_date, outcome,
         net_amount_kept_centavos, cash_received_centavos, change_centavos,
         total_containers, total_volume_ml, items_snapshot,
         original_actor_user_id, original_payment_started_at, original_payment_recorded_at,
         payment_kept_confirmed, refill_delivered_confirmed,
         settled_by_user_id, settled_at, note
       )
       VALUES (
         $1, $2, $3, $4::date, $5::date, 'PAID_AND_DELIVERED',
         $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, true, true, $15, $16, $17
       )
       RETURNING id`,
      [
        input.checkoutId,
        input.checkoutReference,
        input.originalBusinessDayId,
        input.originalBusinessDate,
        input.settlementDate,
        input.netAmountKeptCentavos,
        input.cashReceivedCentavos,
        input.changeCentavos,
        input.totalContainers,
        input.totalVolumeMl,
        JSON.stringify(input.items),
        input.originalActorUserId,
        input.originalPaymentStartedAt,
        input.originalPaymentRecordedAt,
        input.settledByUserId,
        input.settledAt,
        input.note,
      ],
    );
    const settlementId = settlementRows[0]!.id;

    await tx.query(
      `UPDATE pos_checkouts
          SET status = 'SETTLED_PRIOR_DAY',
              cash_received_centavos = COALESCE(cash_received_centavos, $2),
              change_centavos = COALESCE(change_centavos, $3),
              resolution_reason = 'SETTLED_PRIOR_DAY_PAID_AND_DELIVERED',
              updated_at = $4
        WHERE id = $1`,
      [
        input.checkoutId,
        input.cashReceivedCentavos,
        input.changeCentavos,
        input.settledAt,
      ],
    );

    const demandMap = aggregateMerchandiseDemand(input.items);
    if (demandMap.size > 0) {
      for (const productId of Array.from(demandMap.keys()).sort()) {
        const qty = demandMap.get(productId)!;
        const locked = input.lockedMerchandise?.get(productId);
        if (!locked || locked.currentQuantity === null) {
          throw new Error(`Missing locked stock for merchandise item ${productId}`);
        }
        const balanceBefore = locked.currentQuantity;
        const balanceAfter = balanceBefore - qty;
        if (balanceAfter < 0) {
          throw new Error(`Negative stock prevented for merchandise item ${productId}`);
        }

        await tx.query(
          `UPDATE inventory_items
              SET current_quantity = $2,
                  stock_revision = stock_revision + 1
            WHERE id = $1`,
          [productId, balanceAfter],
        );

        await tx.query(
          `INSERT INTO inventory_stock_movements (
             item_id, movement_type, quantity_delta, balance_before, balance_after,
             unit, pos_sale_id, prior_day_settlement_id, pos_reference, actor_user_id, recorded_at, note
           )
           VALUES ($1, 'PRIOR_DAY_SETTLEMENT', $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10)`,
          [
            productId,
            -qty,
            balanceBefore,
            balanceAfter,
            locked.unit,
            settlementId,
            input.checkoutReference,
            input.settledByUserId,
            input.settledAt,
            input.note,
          ],
        );

        await tx.query(
          `INSERT INTO pos_checkout_stock_commitments
             (checkout_id, item_id, quantity, status, created_at, resolved_at)
           VALUES ($1, $2, $3, 'CONSUMED', $4, $4)
           ON CONFLICT (checkout_id, item_id)
           DO UPDATE SET quantity = EXCLUDED.quantity,
                         status = 'CONSUMED',
                         resolved_at = $4`,
          [input.checkoutId, productId, qty, input.settledAt],
        );
      }
    }

    const [settlement, checkout] = await Promise.all([
      this.findPriorDaySettlementByCheckoutId(tx, input.checkoutId),
      this.findCheckoutByReference(tx, input.checkoutReference),
    ]);

    return { settlement: settlement!, checkout: toCheckoutView(checkout!) };
  },
};
