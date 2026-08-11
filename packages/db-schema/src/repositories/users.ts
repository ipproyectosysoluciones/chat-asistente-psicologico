import type { Role } from "@chatcap/shared-types";

import type { DbQueryable, QueryResultRow } from "./db";

/**
 * Users repository (task 2.4, REQ-DASH-1): RBAC preflight for the alert
 * lifecycle endpoints. Only the role is ever read here — a caller proves its
 * role BEFORE any alert data is loaded (least privilege at the boundary).
 */

interface UserRoleRow extends QueryResultRow {
  role: Role;
}

/** Resolves a user's role, or undefined when the user does not exist. */
export async function findUserRole(
  db: DbQueryable,
  userId: string
): Promise<Role | undefined> {
  const result = await db.query<UserRoleRow>(
    `SELECT role FROM users WHERE id = $1 LIMIT 1;`,
    [userId]
  );
  return result.rows[0]?.role;
}
