import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";

/** server/db/rollbacks/0017_employee_role_rename_down.sql, resolved from both src/db and dist/db. */
export const ROLLBACK_0017_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/rollbacks/0017_employee_role_rename_down.sql",
);

export interface RollbackEmployeeRoleResult {
  rolledBack: boolean;
  convertedUsers: number;
}

/**
 * Reverses `0017_employee_role_rename.sql` in one database transaction so an
 * earlier pre-DEC-114 application build can run safely after a rollback.
 */
export async function rollbackEmployeeRoleMigration(
  db: Database,
  rollbackPath = ROLLBACK_0017_PATH,
): Promise<RollbackEmployeeRoleResult> {
  const sql = await readFile(rollbackPath, "utf8");
  return db.transaction(async (tx) => {
    const { rows: tableRows } = await tx.query<{ exists: boolean }>(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS exists",
    );
    if (!tableRows[0]?.exists) {
      return { rolledBack: false, convertedUsers: 0 };
    }

    const { rows: appliedRows } = await tx.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name = $1",
      ["0017_employee_role_rename.sql"],
    );
    if (appliedRows.length === 0) {
      return { rolledBack: false, convertedUsers: 0 };
    }

    const { rows: countRows } = await tx.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM app_users WHERE role = 'EMPLOYEE'",
    );
    const convertedUsers = countRows[0]?.count ?? 0;
    await tx.exec(sql);
    return { rolledBack: true, convertedUsers };
  });
}
