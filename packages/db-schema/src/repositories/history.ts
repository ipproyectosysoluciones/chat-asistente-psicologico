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
  /**
   * Encrypted-mode marker (task 4.9, REQ-CONSENT-5): when set, `text` holds
   * the base64 serialized cipher envelope and the row stores it as
   * `{encrypted, integrity_hash}` under this key version. Unset rows keep the
   * legacy `{text}` shape (anonymous/plaintext sink).
   */
  keyVersion?: number;
  /** Integrity hash of the envelope (HMAC hex) — the export verifies it on read. */
  integrityHash?: string;
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
  if (entry.keyVersion !== undefined) {
    await db.query(
      `INSERT INTO history (session_id, sender, message, persistence_class, key_version, purge_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6);`,
      [
        entry.sessionId,
        entry.sender,
        JSON.stringify({
          encrypted: entry.text,
          integrity_hash: entry.integrityHash,
        }),
        entry.persistenceClass,
        entry.keyVersion,
        entry.purgeAt ?? null,
      ]
    );
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

/** Parsed `message` jsonb from the BuilderBot-owned history table. */
export interface HistoryMessage {
  text?: string;
  encrypted?: string;
  integrity_hash?: string;
}

/** Read model for the HC export (task 4.9): PII stays inside `message`. */
export interface ExportedHistoryRow {
  id: string;
  sender: "user" | "bot";
  createdAt: string;
  keyVersion: number | null;
  message: HistoryMessage;
}

function isHistoryMessage(value: unknown): value is HistoryMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Safe: value is a non-null object after the check above.
  const record = value as Record<string, unknown>;
  return (
    (typeof record.text === "string" ||
      typeof record.encrypted === "string") &&
    (record.integrity_hash === undefined ||
      typeof record.integrity_hash === "string")
  );
}

/**
 * History read for the HC export (task 4.9): returns every row of a session
 * in creation order with the key version that protects each encrypted row.
 * Same best-effort guard as {@link saveHistoryEntry}: an absent BuilderBot
 * table yields an empty export, never a thrown flow.
 */
export async function listHistoryForExport(
  db: DbQueryable,
  sessionId: string
): Promise<ExportedHistoryRow[]> {
  const exists = await db.query<{ exists: boolean }>(
    `SELECT to_regclass('public.history') IS NOT NULL AS exists;`
  );
  if (!(exists.rows[0]?.exists ?? false)) {
    return [];
  }
  const result = await db.query<{
    id: string;
    sender: string;
    message: unknown;
    key_version: number | null;
    created_at: Date;
  }>(
    `SELECT id, sender, message, key_version, created_at
       FROM history
      WHERE session_id = $1
      ORDER BY created_at ASC;`,
    [sessionId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    sender: row.sender === "user" ? "user" : "bot",
    createdAt: row.created_at.toISOString(),
    keyVersion: row.key_version,
    // safe: the row's message jsonb is validated by isHistoryMessage before
    // being exposed to the export consumer (untrusted DB content).
    message: isHistoryMessage(row.message)
      ? row.message
      : { text: undefined, encrypted: undefined, integrity_hash: undefined },
  }));
}
