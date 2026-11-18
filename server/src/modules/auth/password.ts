import { hash, verify } from "@node-rs/argon2";
import { ARGON2_OPTIONS, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./policy.js";

// @node-rs/argon2 defaults to the Argon2id variant; tests assert the
// `$argon2id$` prefix of stored hashes.
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Spends comparable time when the account does not exist. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("hydrop-deepo-dummy-password");
  await verifyPassword(await dummyHash, password);
}

/** Returns a user-facing problem with a proposed new password, or null. */
export function passwordProblem(newPassword: string, username: string): string | null {
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (newPassword.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (newPassword.trim().toLowerCase() === username.trim().toLowerCase()) {
    return "Do not use your username as your password.";
  }
  return null;
}
