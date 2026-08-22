import type { Role } from "@chatcap/shared-types";

import type { DbQueryable, QueryResultRow } from "./db";

/**
 * Users repository (task 2.4, REQ-DASH-1): RBAC preflight for the alert
 * lifecycle endpoints. Only the role is ever read here — a caller proves its
 * role BEFORE any alert data is loaded (least privilege at the boundary).
 * Task 5.1 adds the dashboard auth reads (login /me) and the env-bootstrapped
 * admin upsert (design §3.3).
 */

interface UserRoleRow extends QueryResultRow {
  role: Role;
}

/** Full user row as returned to the dashboard auth layer (no PII beyond email). */
export interface DashboardUser {
  id: string;
  email: string;
  passwordHash: string;
  role: "supervisor" | "admin";
  createdAt: string;
}

interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  password_hash: string;
  role: "supervisor" | "admin";
  created_at: Date;
}

function mapUser(row: UserRow): DashboardUser {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    // safe: role is CHECK-constrained to supervisor|admin in the users table.
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
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

/** Login lookup (task 5.1): the email is unique; no user → undefined. */
export async function findUserByEmail(
  db: DbQueryable,
  email: string
): Promise<DashboardUser | undefined> {
  const result = await db.query<UserRow>(
    `SELECT id, email, password_hash, role, created_at
       FROM users WHERE email = $1 LIMIT 1;`,
    [email]
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapUser(row);
}

/** `/auth/me` lookup (task 5.1): resolves the current user from the JWT sub. */
export async function findUserById(
  db: DbQueryable,
  userId: string
): Promise<DashboardUser | undefined> {
  const result = await db.query<UserRow>(
    `SELECT id, email, password_hash, role, created_at
       FROM users WHERE id = $1 LIMIT 1;`,
    [userId]
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapUser(row);
}

/**
 * Env-bootstrapped admin (task 5.1, design §3.3): `ADMIN_EMAIL` +
 * `ADMIN_PASSWORD_HASH` create/promote the first admin at boot. Existing
 * password hashes are preserved (an env change must not silently rotate a
 * live credential); the role is always forced to admin.
 */
export async function upsertAdminUser(
  db: DbQueryable,
  email: string,
  passwordHash: string
): Promise<DashboardUser> {
  const result = await db.query<UserRow>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO UPDATE SET role = 'admin', updated_at = now()
     RETURNING id, email, password_hash, role, created_at;`,
    [email, passwordHash]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("users: upsert admin returned no row");
  }
  return mapUser(row);
}
