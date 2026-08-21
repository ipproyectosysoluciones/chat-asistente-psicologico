import type { DbQueryable } from "./db";

/**
 * Contact-phone resolution (task 5.3, REQ-DASH-3): the supervisor-reply
 * ingest endpoint must send to the contact, but the raw phone is never stored
 * in `sessions` — only the salted digest `contact_key_anon` (REQ-DASH-9). The
 * BuilderBot-owned `contacts` table is the runtime source of truth: the
 * provider writes a contact row per remote and links history rows via
 * `contact_id`. Same best-effort guard as the history repo — when the
 * BuilderBot tables are absent this returns undefined and the ingest endpoint
 * fails loud with a PII-free log, never touching a raw phone.
 */
export async function findContactPhoneBySession(
  db: DbQueryable,
  sessionId: string
): Promise<string | undefined> {
  const exists = await db.query<{ exists: boolean }>(
    `SELECT to_regclass('public.history') IS NOT NULL
            AND to_regclass('public.contacts') IS NOT NULL AS exists;`
  );
  if (!(exists.rows[0]?.exists ?? false)) {
    return undefined;
  }
  const result = await db.query<{ phone: string }>(
    `SELECT c.phone
       FROM history h
       JOIN contacts c ON c.id = h.contact_id
      WHERE h.session_id = $1
      ORDER BY h.created_at ASC
      LIMIT 1;`,
    [sessionId]
  );
  return result.rows[0]?.phone;
}
