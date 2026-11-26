import { loadConfig, openDatabase } from "../config.js";
import { rollbackEmployeeRoleMigration } from "../db/rollbackEmployeeRole.js";

const { db, description } = await openDatabase(loadConfig());
try {
  const result = await rollbackEmployeeRoleMigration(db);
  console.log(`Database: ${description}.`);
  if (result.rolledBack) {
    console.log(
      `Rolled back 0017_employee_role_rename.sql (converted ${result.convertedUsers} EMPLOYEE user(s) to CASHIER).`,
    );
  } else {
    console.log("0017_employee_role_rename.sql is not applied; no changes were made.");
  }
} finally {
  await db.close();
}
