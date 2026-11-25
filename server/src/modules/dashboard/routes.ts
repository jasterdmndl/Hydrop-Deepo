import { Router } from "express";
import type { Database } from "../../db/database.js";
import { sendError } from "../../shared/http.js";
import { requireRole } from "../auth/guards.js";
import { manilaReminderWindow } from "../calendar/calendar.js";
import { calendarRepository } from "../calendar/repository.js";
import { isUuid, parseContainerShape } from "../inventory/inventory.js";
import type { OpeningStockTarget } from "../inventory/repository.js";
import { dashboardRepository as repo } from "./repository.js";
import { assembleSalesReport, resolveSalesReportRange } from "./salesReport.js";
import { buildDashboardStockTrend } from "./stockTrend.js";

function resolveDashboardItemTarget(rawKey: string): OpeningStockTarget | null {
  const shape = parseContainerShape(rawKey);
  if (shape) {
    return { kind: "shape", shape };
  }
  if (isUuid(rawKey)) {
    return { kind: "id", id: rawKey };
  }
  return null;
}

/**
 * Dashboard HTTP endpoints, mounted at /api/dashboard behind the shared
 * module-access guards. Restricted exclusively to OWNER (DEC-076, NAV-001).
 */
export function dashboardRoutes(db: Database): Router {
  const router = Router();
  router.use(requireRole("OWNER"));

  router.get("/sales", async (req, res) => {
    const resolved = resolveSalesReportRange(
      {
        period: req.query.period,
        from: req.query.from,
        to: req.query.to,
      },
      req.now,
    );
    if (!resolved.ok) {
      sendError(res, 400, "VALIDATION_FAILED", resolved.message);
      return;
    }

    const comp = resolved.range.comparisonTarget;

    const [data, calendarOverdueCount] = await Promise.all([
      repo.loadSalesInputs(db, {
        from: resolved.range.from,
        to: resolved.range.to,
        isPartialEndDay: resolved.range.isPartialEndDay,
        cutoffDate: resolved.range.cutoffDate,
        requestNow: req.now,
        comparisonFrom: comp?.from ?? null,
        comparisonTo: comp?.to ?? null,
        comparisonIsPartialEndDay: comp?.isPartialEndDay ?? false,
        comparisonCutoffDate: comp?.endCutoffDate ?? null,
      }),
      (async (): Promise<number | null> => {
        try {
          const { nowUtc, upcomingCutoffUtc } = manilaReminderWindow(req.now);
          const unfinished = await calendarRepository.listUnfinishedBeforeCutoff(
            db,
            upcomingCutoffUtc,
          );
          let overdue = 0;
          for (const row of unfinished) {
            const scheduledAt =
              row.scheduledAt instanceof Date ? row.scheduledAt : new Date(row.scheduledAt);
            if (scheduledAt.getTime() < nowUtc.getTime()) {
              overdue += 1;
            }
          }
          return overdue;
        } catch {
          return null;
        }
      })(),
    ]);

    res.json(
      assembleSalesReport({
        range: resolved.range,
        ...data,
        calendarOverdueCount,
      }),
    );
  });

  router.get("/stocks/:itemKey/trend", async (req, res) => {
    const rawKey = typeof req.params.itemKey === "string" ? req.params.itemKey.trim() : "";
    const target = resolveDashboardItemTarget(rawKey);
    if (!target) {
      sendError(res, 400, "VALIDATION_FAILED", "Choose a valid Inventory item.");
      return;
    }

    const data = await repo.loadStockTrendInputs(db, target);
    if (!data) {
      sendError(res, 404, "NOT_FOUND", "Inventory item not found.");
      return;
    }

    res.json(buildDashboardStockTrend(data));
  });

  return router;
}
