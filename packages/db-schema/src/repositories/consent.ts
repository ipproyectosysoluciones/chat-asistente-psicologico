import type { ConsentRecord } from "@chatcap/shared-types";

import type { DbQueryable, QueryResultRow } from "./db";

/**
 * Consent records (REQ-CONSENT-4/5): encrypted payload (BYTEA) + integrity
 * hash + key_version for dual-read re-encryption (REQ-KEY-8).
 */

export interface NewConsentRecord {
  sessionId: string;
  jurisdiction: string;
  termsVersion: number;
  keyVersion: number;
  encryptedPayload: Buffer;
  integrityHash: string;
}

interface ConsentRow extends QueryResultRow {
  id: string;
  session_id: string;
  jurisdiction: string;
  terms_version: number;
  key_version: number;
  integrity_hash: string;
  active: boolean;
  created_at: Date;
}

function mapConsent(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    jurisdiction: row.jurisdiction,
    termsVersion: row.terms_version,
    keyVersion: row.key_version,
    integrityHash: row.integrity_hash,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createConsentRecord(
  db: DbQueryable,
  input: NewConsentRecord
): Promise<ConsentRecord> {
  const result = await db.query<ConsentRow>(
    `INSERT INTO consent_records
       (session_id, jurisdiction, terms_version, key_version, encrypted_payload, integrity_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, session_id, jurisdiction, terms_version, key_version,
               integrity_hash, active, created_at;`,
    [
      input.sessionId,
      input.jurisdiction,
      input.termsVersion,
      input.keyVersion,
      input.encryptedPayload,
      input.integrityHash,
    ]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("consent: insert returned no row");
  }
  return mapConsent(row);
}

/** The latest active consent for a session (one active record at a time). */
export async function findActiveConsentBySession(
  db: DbQueryable,
  sessionId: string
): Promise<ConsentRecord | undefined> {
  const result = await db.query<ConsentRow>(
    `SELECT id, session_id, jurisdiction, terms_version, key_version,
            integrity_hash, active, created_at
       FROM consent_records
      WHERE session_id = $1 AND active = true
      ORDER BY created_at DESC
      LIMIT 1;`,
    [sessionId]
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapConsent(row);
}

/** Revoke (REQ-CONSENT-4): marks the record inactive, keeping the audit chain. */
export async function deactivateConsent(
  db: DbQueryable,
  consentId: string
): Promise<void> {
  await db.query(
    `UPDATE consent_records SET active = false WHERE id = $1;`,
    [consentId]
  );
}

/** A row bound for re-encryption (REQ-KEY-4): id, current key, encrypted BYTEA. */
export interface ReEncryptionRow {
  rowId: string;
  keyVersion: number;
  encryptedPayload: Buffer;
}

/**
 * Batch source for the re-encryption worker: rows still encrypted under the
 * old key (REQ-KEY-4), bounded by the 100–500 batch contract.
 */
export async function listConsentRowsForReEncryption(
  db: DbQueryable,
  keyFrom: number,
  limit: number
): Promise<ReEncryptionRow[]> {
  const result = await db.query<{
    id: string;
    key_version: number;
    encrypted_payload: Buffer;
  }>(
    `SELECT id, key_version, encrypted_payload
       FROM consent_records
      WHERE key_version = $1
      ORDER BY created_at
      LIMIT $2;`,
    [keyFrom, limit]
  );
  return result.rows.map((row) => ({
    rowId: row.id,
    keyVersion: row.key_version,
    encryptedPayload: row.encrypted_payload,
  }));
}

/**
 * Applies the re-encrypted payload inside the batch transaction (REQ-KEY-4):
 * new key_version, new ciphertext, and a fresh integrity hash per row.
 */
export async function updateConsentEncryption(
  db: DbQueryable,
  rowId: string,
  keyVersion: number,
  encryptedPayload: Buffer,
  integrityHash: string
): Promise<void> {
  await db.query(
    `UPDATE consent_records
        SET key_version = $2, encrypted_payload = $3, integrity_hash = $4
      WHERE id = $1;`,
    [rowId, keyVersion, encryptedPayload, integrityHash]
  );
}

/**
 * Rows remaining under a key (REQ-KEY-4): the scheduler plans batches from
 * this count and the forced job verifies 100% migration when it reaches 0.
 */
export async function countConsentRowsByKeyVersion(
  db: DbQueryable,
  keyVersion: number
): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM consent_records
      WHERE key_version = $1;`,
    [keyVersion]
  );
  return result.rows[0]?.count ?? 0;
}
