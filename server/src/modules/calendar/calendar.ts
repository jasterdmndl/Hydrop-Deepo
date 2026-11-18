import type { Role } from "../auth/policy.js";

/**
 * Calendar business rules. Task 1 provides only the role permissions;
 * scheduling, completion and reminders arrive in Task 2.
 */
export interface CalendarPermissions {
  canView: boolean;
  /** Schedule activities and record completion (Owner only, NAV-001). */
  canManage: boolean;
}

export function calendarPermissions(role: Role): CalendarPermissions {
  return { canView: true, canManage: role === "OWNER" };
}
