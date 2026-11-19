import { existsSync } from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type ErrorRequestHandler, type Express } from "express";
import helmet from "helmet";
import type { Database } from "./db/database.js";
import { calendarRoutes } from "./modules/calendar/routes.js";
import { cookieSettings, moduleAccess, requestClock } from "./modules/auth/guards.js";
import { authRoutes } from "./modules/auth/routes.js";
import { AuthService } from "./modules/auth/service.js";
import { navigationRoutes } from "./modules/navigation/routes.js";
import { posRoutes } from "./modules/pos/routes.js";
import { type Clock, systemClock } from "./shared/clock.js";
import { sendError } from "./shared/http.js";

export interface AppOptions {
  db: Database;
  clock?: Clock;
  /** Secure cookies (HTTPS). True in production. */
  secureCookies?: boolean;
  /** Express `trust proxy` setting, e.g. 1 behind Render's proxy. */
  trustProxy?: number | boolean;
  /** Built web client to serve, if present. */
  webDistDir?: string;
}

/** Composes the single Express application: shared auth plus module routers. */
export function createApp(options: AppOptions): Express {
  const app = express();
  const auth = new AuthService(options.db);
  const cookies = cookieSettings(options.secureCookies ?? false);

  app.disable("x-powered-by");
  if (options.trustProxy !== undefined) app.set("trust proxy", options.trustProxy);
  app.use(helmet());
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());

  const api = express.Router();
  api.use(requestClock(options.clock ?? systemClock));
  api.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  api.use("/auth", authRoutes(auth, cookies));
  api.use("/modules", moduleAccess(auth, cookies), navigationRoutes());
  api.use("/calendar", moduleAccess(auth, cookies), calendarRoutes(options.db));
  api.use("/pos", moduleAccess(auth, cookies), posRoutes(options.db));
  api.use((_req, res) => sendError(res, 404, "NOT_FOUND", "Not found."));
  app.use("/api", api);

  if (options.webDistDir && existsSync(path.join(options.webDistDir, "index.html"))) {
    const dist = options.webDistDir;
    app.use(express.static(dist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if ((error as { type?: string }).type === "entity.parse.failed") {
      sendError(res, 400, "VALIDATION_FAILED", "The request body is not valid JSON.");
      return;
    }
    // Log the error without request bodies, which may contain passwords.
    console.error("Unhandled request error:", error instanceof Error ? error.message : error);
    sendError(res, 500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  };
  app.use(onError);

  return app;
}
