import { createApp } from "./app.js";
import { loadConfig, openDatabase } from "./config.js";
import { runMigrations } from "./db/migrate.js";

const config = loadConfig();
const { db, description } = await openDatabase(config);
const applied = await runMigrations(db);
console.log(`Database: ${description}. Migrations applied now: ${applied.length ? applied.join(", ") : "none"}.`);

const app = createApp({
  db,
  secureCookies: config.secureCookies,
  trustProxy: config.trustProxy,
  webDistDir: config.webDistDir,
});

const server = app.listen(config.port, () => {
  console.log(`Hydrop Deepo server listening on port ${config.port}.`);
});

async function shutdown(): Promise<void> {
  server.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
