/**
 * Local provisioning: creates one account with a generated temporary password.
 *
 *   npm run provision -- --username <name> --role OWNER|CASHIER
 *
 * The temporary password is printed once to this terminal only. It is not
 * stored anywhere except as an Argon2id hash. Hand it to the account holder
 * privately; they must replace it at first sign-in.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig, openDatabase } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { ROLES, type Role } from "../modules/auth/policy.js";
import { authRepository } from "../modules/auth/repository.js";
import { AuthService } from "../modules/auth/service.js";

const { values } = parseArgs({
  options: {
    username: { type: "string" },
    role: { type: "string" },
  },
});

const username = values.username?.trim();
const role = values.role?.toUpperCase() as Role | undefined;
if (!username || !/^[A-Za-z0-9._-]{3,64}$/.test(username) || !role || !ROLES.includes(role)) {
  console.error("Usage: npm run provision -- --username <3-64 letters, digits, . _ -> --role OWNER|CASHIER");
  process.exit(1);
}

const { db, description } = await openDatabase(loadConfig());
try {
  await runMigrations(db);
  if (await authRepository.findUserByUsername(db, username)) {
    console.error(`An account named "${username}" already exists. No changes were made.`);
    process.exitCode = 1;
  } else {
    const temporaryPassword = randomBytes(12).toString("base64url");
    const user = await new AuthService(db).provisionAccount({ username, role, temporaryPassword });
    console.log(`Database: ${description}`);
    console.log(`Created ${user.role} account "${user.username}".`);
    console.log(`Temporary password (shown once, do not save in project files): ${temporaryPassword}`);
  }
} finally {
  await db.close();
}
