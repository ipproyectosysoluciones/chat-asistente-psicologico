import type { PersistenceClass } from "@chatcap/shared-types";

import type { DbQueryable } from "./db";

/**
 * Conversation-history sink (task 4.6, REQ-CHATBOT-2). The `history` table is
 * OWNED by @builderbot/database-postgres — our migrations only add guarded
 * columns when it exists (0001_initial_schema.sql). So this repo checks for
 * the table first and degrades silently when absent: persistence is a
 * best-effort sink, never a reason to drop a chat emission. Rows carry the
 * dual-persistence metadata (persistence_class + purge_at, REQ-CONSENT-5) so
 * the anonymous cleanup job covers history too.
 */

export interface HistoryEntry {
  sessionId: string;
  sender: "user" | "bot";
  text: string;
  persistenceClass: PersistenceClass;
  purgeAt?: string;
}

export async function saveHistoryEntry(
  db: DbQueryable,
  entry: HistoryEntry
): Promise<void> {
  const exists = await db.query<{ exists: boolean }>(
    `SELECT to_regclass('public.history') IS NOT NULL AS exists;`
  );
  if (!(exists.rows[0]?.exists ?? false)) {
    return;
  }
  await db.query(
    `INSERT INTO history (session_id, sender, message, persistence_class, purge_at)
     VALUES ($1, $2, $3::jsonb, $4, $5);`,
    [
      entry.sessionId,
      entry.sender,
      JSON.stringify({ text: entry.text }),
      entry.persistenceClass,
      entry.purgeAt ?? null,
    ]
  );
}
