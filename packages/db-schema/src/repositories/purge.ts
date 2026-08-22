import type { DbQueryable } from "./db";

/**
 * Anonymous-data purge job (REQ-CONSENT-5: 24–48h cleanup contract).
 * Deletes in bounded batches (100–500 rows) — never a full-table sweep —
 * so the re-encryption/notification workers never see a long lock.
 * Sessions AND BuilderBot history rows (when present) are covered.
 */

export interface PurgeOptions {
  batchSize?: number;
}

export interface PurgeResult {
  purgedSessions: number;
  purgedHistory: number;
  batches: number;
}

const MIN_BATCH = 100;
const MAX_BATCH = 500;

const BATCHED_DELETE = (table: "sessions" | "history"): string => `
WITH to_delete AS (
  SELECT id FROM ${table}
   WHERE persistence_class = 'anonymous' AND purge_at <= now()
   LIMIT $1
)
DELETE FROM ${table} WHERE id IN (SELECT id FROM to_delete);`;

export async function purgeAnonymousSessions(
  db: DbQueryable,
  options: PurgeOptions = {}
): Promise<PurgeResult> {
  const batchSize = clamp(options.batchSize ?? MAX_BATCH, MIN_BATCH, MAX_BATCH);
  const result: PurgeResult = { purgedSessions: 0, purgedHistory: 0, batches: 0 };

  const historyExists = await historyTableExists(db);
  const targets: Array<"sessions" | "history"> = ["sessions", ...(historyExists ? ["history" as const] : [])];

  for (const table of targets) {
    let affected = 0;
    do {
      const batch = await db.query(BATCHED_DELETE(table), [batchSize]);
      affected = batch.rowCount ?? 0;
      if (table === "sessions") {
        result.purgedSessions += affected;
      } else {
        result.purgedHistory += affected;
      }
      result.batches += 1;
    } while (affected === batchSize);
  }

  return result;
}

async function historyTableExists(db: DbQueryable): Promise<boolean> {
  const check = await db.query<{ exists: boolean }>(
    `SELECT to_regclass('public.history') IS NOT NULL AS exists;`
  );
  return check.rows[0]?.exists ?? false;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
