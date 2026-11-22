import { Router } from "express";
import type { Database } from "../../db/database.js";
import { sendError } from "../../shared/http.js";
import { requireRole } from "../auth/guards.js";
import { dashboardRepository as repo } from "./repository.js";
import { assembleSalesReport, resolveSalesReportRange } from "./salesReport.js";

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

    const data = await repo.loadSalesInputs(db, {
      from: resolved.range.from,
      to: resolved.range.to,
      todayDate: resolved.range.todayDate,
      cutoffDate: resolved.range.cutoffDate,
    });

    res.json(
      assembleSalesReport({
        range: resolved.range,
        ...data,
      }),
    );
  });

  return router;
}
