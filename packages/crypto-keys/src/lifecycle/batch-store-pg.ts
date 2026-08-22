import type { DbQueryable } from "@chatcap/db-schema";
import { updateConsentEncryption } from "@chatcap/db-schema";

import type { ReencryptionBatchStore, ReencryptedRow } from "./batch-crypto";

/**
 * PostgreSQL transaction store for one re-encryption batch (REQ-KEY-4).
 * Runs BEGIN … UPDATE … read-back … COMMIT/ROLLBACK on the given client.
 * The client is acquired/released by the caller (pool ownership stays out of
 * the store).
 */
export class PgBatchStore implements ReencryptionBatchStore {
  constructor(private readonly db: DbQueryable) {}

  async begin(): Promise<void> {
    await this.db.query("BEGIN;");
  }

  async writeRows(rows: ReencryptedRow[]): Promise<void> {
    for (const row of rows) {
      await updateConsentEncryption(
        this.db,
        row.rowId,
        row.keyTo,
        row.encodedPayload,
        row.integrityHash
      );
    }
  }

  async readBackRows(
    rowIds: string[]
  ): Promise<Array<{ rowId: string; keyTo: number; encodedPayload: Buffer }>> {
    if (rowIds.length === 0) return [];
    const placeholders = rowIds.map((_, index) => `$${index + 1}`).join(", ");
    const result = await this.db.query<{
      id: string;
      key_version: number;
      encrypted_payload: Buffer;
    }>(
      `SELECT id, key_version, encrypted_payload
         FROM consent_records
        WHERE id IN (${placeholders})
        ORDER BY id;`,
      rowIds
    );
    return result.rows.map((row) => ({
      rowId: row.id,
      keyTo: row.key_version,
      encodedPayload: row.encrypted_payload,
    }));
  }

  async commit(): Promise<void> {
    await this.db.query("COMMIT;");
  }

  async rollback(): Promise<void> {
    await this.db.query("ROLLBACK;");
  }

  async end(): Promise<void> {
    // No-op: the caller owns client release (pool lifecycle stays outside).
  }
}
