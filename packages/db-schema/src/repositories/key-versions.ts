import type { KeyStatus, KeyVersionInfo } from "@chatcap/shared-types";

import type { DbQueryable, QueryResultRow } from "./db";

/**
 * key_versions metadata (REQ-KEY-1): key material is DERIVED from the master
 * secret via HKDF with the per-version salt — never stored here.
 */

export interface NewKeyVersion {
  salt: string;
  algorithm?: string;
  expiresAt: Date;
  forcedRotationDueAt?: Date;
}

interface KeyVersionRow extends QueryResultRow {
  key_version: number;
  algorithm: string;
  salt: string;
  status: KeyStatus;
  created_at: Date;
  expires_at: Date;
  forced_rotation_due_at: Date | null;
}

function mapKeyVersion(row: KeyVersionRow): KeyVersionInfo {
  return {
    keyVersion: row.key_version,
    algorithm: row.algorithm,
    salt: row.salt,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    forcedRotationDueAt:
      row.forced_rotation_due_at?.toISOString() ?? row.expires_at.toISOString(),
  };
}

/** Creates version max+1 (7-day cycle, REQ-KEY-2). */
export async function createNextKeyVersion(
  db: DbQueryable,
  input: NewKeyVersion
): Promise<KeyVersionInfo> {
  const maxResult = await db.query<{ max: number | null }>(
    `SELECT COALESCE(MAX(key_version), 0) AS max FROM key_versions;`
  );
  const nextVersion = (maxResult.rows[0]?.max ?? 0) + 1;

  const result = await db.query<KeyVersionRow>(
    `INSERT INTO key_versions (key_version, algorithm, salt, expires_at, forced_rotation_due_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING key_version, algorithm, salt, status, created_at, expires_at, forced_rotation_due_at;`,
    [
      nextVersion,
      input.algorithm ?? "aes-256-cbc-hkdf-sha256",
      input.salt,
      input.expiresAt,
      input.forcedRotationDueAt ?? null,
    ]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("key_versions: insert returned no row");
  }
  return mapKeyVersion(row);
}

/** Newest active key version (encryption target, REQ-KEY-8 dual-read). */
export async function currentActiveKeyVersion(
  db: DbQueryable
): Promise<KeyVersionInfo | undefined> {
  const result = await db.query<KeyVersionRow>(
    `SELECT key_version, algorithm, salt, status, created_at, expires_at, forced_rotation_due_at
       FROM key_versions
      WHERE status = 'active'
      ORDER BY key_version DESC
      LIMIT 1;`
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapKeyVersion(row);
}

export async function retireKeyVersion(
  db: DbQueryable,
  keyVersion: number
): Promise<void> {
  await db.query(
    `UPDATE key_versions SET status = 'retired' WHERE key_version = $1;`,
    [keyVersion]
  );
}
