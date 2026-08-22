import type {
  BatchStatus,
  ReEncryptionBatch,
} from "@chatcap/shared-types";

import type { DbQueryable, QueryResultRow } from "./db";

/**
 * Re-encryption batches (REQ-KEY-4): status machine
 * pending → running → verified | rolled_back, per-batch integrity hash.
 */

export interface NewReEncryptionBatch {
  keyFrom: number;
  keyTo: number;
}

interface BatchRow extends QueryResultRow {
  id: string;
  key_from: number;
  key_to: number;
  status: BatchStatus;
  rows_count: number;
  integrity_hash: string | null;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

function mapBatch(row: BatchRow): ReEncryptionBatch {
  return {
    id: row.id,
    keyFrom: row.key_from,
    keyTo: row.key_to,
    status: row.status,
    rowsCount: row.rows_count,
    integrityHash: row.integrity_hash ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at?.toISOString() ?? new Date(0).toISOString(),
    completedAt: row.completed_at?.toISOString(),
  };
}

const BATCH_COLUMNS = `id, key_from, key_to, status, rows_count, integrity_hash,
            error, started_at, completed_at`;

export async function createReEncryptionBatch(
  db: DbQueryable,
  input: NewReEncryptionBatch
): Promise<ReEncryptionBatch> {
  const result = await db.query<BatchRow>(
    `INSERT INTO re_encryption_batches (key_from, key_to)
     VALUES ($1, $2)
     RETURNING ${BATCH_COLUMNS};`,
    [input.keyFrom, input.keyTo]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("re_encryption_batches: insert returned no row");
  }
  return mapBatch(row);
}

/** Atomically claims the oldest pending batch (single worker at a time). */
export async function claimNextPendingBatch(
  db: DbQueryable
): Promise<ReEncryptionBatch | undefined> {
  const result = await db.query<BatchRow>(
    `UPDATE re_encryption_batches
        SET status = 'running', started_at = now()
      WHERE id = (
        SELECT id FROM re_encryption_batches
         WHERE status = 'pending'
         ORDER BY created_at
         LIMIT 1
      )
      RETURNING ${BATCH_COLUMNS};`
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapBatch(row);
}

export async function completeBatch(
  db: DbQueryable,
  batchId: string,
  rowsCount: number,
  integrityHash: string
): Promise<ReEncryptionBatch> {
  const result = await db.query<BatchRow>(
    `UPDATE re_encryption_batches
        SET status = 'verified', rows_count = $2, integrity_hash = $3,
            completed_at = now(), error = NULL
      WHERE id = $1
      RETURNING ${BATCH_COLUMNS};`,
    [batchId, rowsCount, integrityHash]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`re_encryption_batches: complete failed for ${batchId}`);
  }
  return mapBatch(row);
}

export async function rollbackBatch(
  db: DbQueryable,
  batchId: string,
  error: string
): Promise<ReEncryptionBatch> {
  const result = await db.query<BatchRow>(
    `UPDATE re_encryption_batches
        SET status = 'rolled_back', error = $2, completed_at = now()
      WHERE id = $1
      RETURNING ${BATCH_COLUMNS};`,
    [batchId, error]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`re_encryption_batches: rollback failed for ${batchId}`);
  }
  return mapBatch(row);
}
