import type { Role } from "../auth/policy.js";

/**
 * Choose Module entries (NAV-001). Each entry reflects the signed-in role and
 * whether the module has been built in this version of the application.
 *
 * - open: usable with full permissions for the role
 * - read-only: usable to view only
 * - locked: not permitted for the role
 * - coming-later: not built yet in this version
 */
export type ModuleState = "open" | "read-only" | "locked" | "coming-later";

export interface ModuleEntry {
  key: "pos" | "dashboard" | "calendar" | "inventory";
  name: string;
  description: string;
  state: ModuleState;
  /** Client route, present only when the module can be opened. */
  path?: string;
}

export function modulesFor(role: Role): ModuleEntry[] {
  return [
    {
      key: "pos",
      name: "POS",
      description: "Select refills, receive cash, and review transaction history.",
      state: "open",
      path: "/pos",
    },
    {
      key: "dashboard",
      name: "Dashboard",
      description: "View sales summaries, station reminders, and current stock levels.",
      // Dashboard remains locked for Cashier with no sales-summary preview (DEC-076, NAV-001).
      state: role === "OWNER" ? "open" : "locked",
      ...(role === "OWNER" ? { path: "/dashboard" } : {}),
    },
    {
      key: "calendar",
      name: "Activity Calendar",
      description: "Plan station care and keep a record of completed work.",
      // Calendar access never depends on whether the sales day is open.
      state: role === "OWNER" ? "open" : "read-only",
      path: "/calendar",
    },
    {
      key: "inventory",
      name: "Inventory",
      description: "View container stock on hand and record opening counts.",
      state: role === "OWNER" ? "open" : "read-only",
      path: "/inventory",
    },
  ];
}
