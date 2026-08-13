import type {
  PersistenceClass,
  Session,
} from "@chatcap/shared-types";

import type { DbQueryable, QueryResultRow } from "./db";

/**
 * Sessions repository (design §4.1). `contact_key_anon` is
 * SHA-256(phone || pepper) — the raw phone never reaches the DB.
 * Anonymous sessions get purge_at = created_at + 24h (REQ-CONSENT-5).
 */

export interface SessionInput {
  contactKeyAnon: string;
  jurisdiction?: string;
}

interface SessionRow extends QueryResultRow {
  id: string;
  contact_key_anon: string;
  jurisdiction: string | null;
  persistence_class: PersistenceClass;
  consent_state: string;
  ai_state: string;
  created_at: Date;
  last_activity_at: Date;
  purge_at: Date | null;
}

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    contactKeyAnon: row.contact_key_anon,
    jurisdiction: row.jurisdiction ?? undefined,
    persistenceClass: row.persistence_class,
    // safe: consent_state is CHECK-constrained to the ConsentState literal set
    // in the sessions migration, so the DB row cannot carry a value outside it.
    consentState: row.consent_state as Session["consentState"],
    // safe: ai_state is CHECK-constrained to the AiState literal set in the
    // sessions migration (auto | takeover), enforced at the DB boundary.
    aiState: row.ai_state as Session["aiState"],
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    purgeAt: row.purge_at?.toISOString(),
  };
}

/** Find-or-create by anonymized contact key (never the raw phone). */
export async function upsertSession(
  db: DbQueryable,
  input: SessionInput
): Promise<Session> {
  const existing = await db.query<SessionRow>(
    `SELECT id, contact_key_anon, jurisdiction, persistence_class, consent_state,
            ai_state, created_at, last_activity_at, purge_at
       FROM sessions
      WHERE contact_key_anon = $1
      LIMIT 1;`,
    [input.contactKeyAnon]
  );
  if (existing.rows[0] !== undefined) {
    const updated = await db.query<SessionRow>(
      `UPDATE sessions SET last_activity_at = now()
        WHERE id = $1
        RETURNING id, contact_key_anon, jurisdiction, persistence_class, consent_state,
                  ai_state, created_at, last_activity_at, purge_at;`,
      [existing.rows[0].id]
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new Error("sessions: update returned no row");
    }
    return mapSession(row);
  }

  const inserted = await db.query<SessionRow>(
    `INSERT INTO sessions (contact_key_anon, jurisdiction, persistence_class,
                           consent_state, ai_state, purge_at)
     VALUES ($1, $2, 'anonymous', 'notice_shown', 'auto', now() + interval '24 hours')
     RETURNING id, contact_key_anon, jurisdiction, persistence_class, consent_state,
               ai_state, created_at, last_activity_at, purge_at;`,
    [input.contactKeyAnon, input.jurisdiction ?? null]
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error("sessions: insert returned no row");
  }
  return mapSession(row);
}

export async function getSession(
  db: DbQueryable,
  sessionId: string
): Promise<Session | undefined> {
  const result = await db.query<SessionRow>(
    `SELECT id, contact_key_anon, jurisdiction, persistence_class, consent_state,
            ai_state, created_at, last_activity_at, purge_at
       FROM sessions
      WHERE id = $1
      LIMIT 1;`,
    [sessionId]
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapSession(row);
}

/** Dual persistence switch (REQ-CONSENT-5): anonymous → 24h expiry, hc → none. */
export async function setSessionPersistence(
  db: DbQueryable,
  sessionId: string,
  persistenceClass: PersistenceClass
): Promise<Session> {
  const result = await db.query<SessionRow>(
    `UPDATE sessions
        SET persistence_class = $2,
            purge_at = CASE
              WHEN $2 = 'anonymous' THEN now() + interval '24 hours'
              ELSE NULL
            END
      WHERE id = $1
      RETURNING id, contact_key_anon, jurisdiction, persistence_class, consent_state,
                ai_state, created_at, last_activity_at, purge_at;`,
    [sessionId, persistenceClass]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`sessions: update failed for ${sessionId}`);
  }
  return mapSession(row);
}

export async function touchSessionActivity(
  db: DbQueryable,
  sessionId: string
): Promise<void> {
  await db.query(
    `UPDATE sessions SET last_activity_at = now() WHERE id = $1;`,
    [sessionId]
  );
}

/**
 * Persist the resolved legal jurisdiction (REQ-CHATBOT-3). Called by the
 * bot's `persist_jurisdiction` effect once the user confirms their country;
 * jurisdiction is a plaintext column (not health data), so no encryption is
 * required, but access is still RBAC-scoped.
 */
export async function setSessionJurisdiction(
  db: DbQueryable,
  sessionId: string,
  jurisdiction: string
): Promise<Session> {
  const result = await db.query<SessionRow>(
    `UPDATE sessions
        SET jurisdiction = $2,
            last_activity_at = now()
      WHERE id = $1
      RETURNING id, contact_key_anon, jurisdiction, persistence_class, consent_state,
                ai_state, created_at, last_activity_at, purge_at;`,
    [sessionId, jurisdiction]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`sessions: update failed for ${sessionId}`);
  }
  return mapSession(row);
}

/**
 * Marks the session consent_state (REQ-CONSENT-2/4): the consent flow sets
 * it to `accepted` once the acceptance is encrypted and registered. Only the
 * CHECK-constrained ConsentState values can be stored; the raw acceptance
 * (terms version, jurisdiction, key_version) lives in consent_records, not
 * on the session row.
 */
export async function setSessionConsentState(
  db: DbQueryable,
  sessionId: string,
  consentState: Session["consentState"]
): Promise<Session> {
  const result = await db.query<SessionRow>(
    `UPDATE sessions
        SET consent_state = $2,
            last_activity_at = now()
      WHERE id = $1
      RETURNING id, contact_key_anon, jurisdiction, persistence_class, consent_state,
                ai_state, created_at, last_activity_at, purge_at;`,
    [sessionId, consentState]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`sessions: update failed for ${sessionId}`);
  }
  return mapSession(row);
}

/**
 * Forces the session ai_state (REQ-ALERT-4, REQ-DASH-3): human takeover
 * disables AI emission per chat. The crisis flow calls this when a red alert
 * cannot be raised over pub-sub — the escalation must never depend on a
 * single channel, and the fallback is a human-only session.
 */
export async function setSessionAiState(
  db: DbQueryable,
  sessionId: string,
  aiState: Session["aiState"]
): Promise<Session> {
  const result = await db.query<SessionRow>(
    `UPDATE sessions
        SET ai_state = $2,
            last_activity_at = now()
      WHERE id = $1
      RETURNING id, contact_key_anon, jurisdiction, persistence_class, consent_state,
                ai_state, created_at, last_activity_at, purge_at;`,
    [sessionId, aiState]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`sessions: update failed for ${sessionId}`);
  }
  return mapSession(row);
}
