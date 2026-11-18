import { loadConfig, openDatabase } from "../config.js";
import { runMigrations } from "../db/migrate.js";

const { db, description } = await openDatabase(loadConfig());
try {
  const applied = await runMigrations(db);
  console.log(`Database: ${description}.`);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "No pending migrations.");
} finally {
  await db.close();
}
