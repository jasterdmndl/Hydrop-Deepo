import { Router } from "express";
import { modulesFor } from "./modules.js";

/** Mounted behind the shared module-access guards. */
export function navigationRoutes(): Router {
  const router = Router();
  router.get("/", (req, res) => {
    res.json({
      modules: modulesFor(req.auth!.user.role),
      // Shown only once the business-day feature provides the actual state.
      stationStatus: null,
    });
  });
  return router;
}
