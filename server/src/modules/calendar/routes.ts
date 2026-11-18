import { Router } from "express";
import { calendarPermissions } from "./calendar.js";

/**
 * Calendar HTTP endpoints, mounted at /api/calendar behind the shared
 * module-access guards. Owner-only writes added in Task 2 must also use
 * `requireRole("OWNER")`.
 */
export function calendarRoutes(): Router {
  const router = Router();
  router.get("/access", (req, res) => {
    res.json(calendarPermissions(req.auth!.user.role));
  });
  return router;
}
