import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPgDatabase, createPgliteDatabase, type Database } from "./db/database.js";

/** server/, resolved from both src/ and dist/. */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  production: boolean;
  port: number;
  /** Supabase/PostgreSQL connection string. Required in production. */
  databaseUrl?: string;
  databaseSsl: boolean;
  /** Local development database used when DATABASE_URL is not set. */
  pgliteDataDir: string;
  webDistDir: string;
  secureCookies: boolean;
  trustProxy?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (production && !databaseUrl) {
    throw new Error("DATABASE_URL is required when NODE_ENV=production.");
  }
  return {
    production,
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    databaseSsl: env.DATABASE_SSL !== "false",
    pgliteDataDir: env.PGLITE_DATA_DIR ?? path.join(SERVER_ROOT, ".data", "pglite"),
    webDistDir: env.WEB_DIST_DIR ?? path.join(SERVER_ROOT, "..", "web", "dist"),
    secureCookies: production || env.SECURE_COOKIES === "true",
    trustProxy: production ? 1 : undefined,
  };
}

export async function openDatabase(config: Config): Promise<{ db: Database; description: string }> {
  if (config.databaseUrl) {
    return { db: await createPgDatabase(config.databaseUrl, config.databaseSsl), description: "PostgreSQL (DATABASE_URL)" };
  }
  return {
    db: await createPgliteDatabase(config.pgliteDataDir),
    description: `local development database at ${config.pgliteDataDir}`,
  };
}
