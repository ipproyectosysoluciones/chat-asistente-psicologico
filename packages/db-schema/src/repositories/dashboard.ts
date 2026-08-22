import type {
  AlertLevel,
  DashboardChatSummary,
  DashboardMessage,
  RagTrace,
} from "@chatcap/shared-types";

import type { DbQueryable, QueryResultRow } from "./db";

/**
 * Dashboard read models (task 5.2, REQ-DASH-2/9): paginated chat list with
 * anonymized identifiers, the dual chat view (messages + RAG traces) and the
 * RAG-context read for flagged-answer review. Message content is only
 * returned to supervisor/admin callers (RBAC enforced at the router layer).
 *
 * The `history` table is BuilderBot-owned (may not exist at migration time),
 * so every history read is guarded like the history repo: absent table → empty
 * list, never a thrown flow.
 */

function toRegclassExists(db: DbQueryable, table: string): Promise<boolean> {
  return db
    .query<{ exists: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS exists;`,
      [table]
    )
    .then((result) => result.rows[0]?.exists ?? false);
}

export interface ChatPage {
  items: DashboardChatSummary[];
  total: number;
}

export interface ChatPageOptions {
  limit: number;
  offset: number;
}

interface ChatSummaryRow extends QueryResultRow {
  id: string;
  contact_key_anon: string;
  jurisdiction: string | null;
  persistence_class: "anonymous" | "hc";
  ai_state: "auto" | "takeover";
  last_activity_at: Date;
  message_count: number;
  open_alert_level: AlertLevel | null;
}

function mapChatSummary(row: ChatSummaryRow): DashboardChatSummary {
  return {
    sessionId: row.id,
    contactKeyAnon: row.contact_key_anon,
    jurisdiction: row.jurisdiction ?? undefined,
    persistenceClass: row.persistence_class,
    aiState: row.ai_state,
    lastActivityAt: row.last_activity_at.toISOString(),
    messageCount: Number(row.message_count),
    openAlertLevel: row.open_alert_level ?? undefined,
  };
}

/**
 * Paginated chat list ordered by last activity (design §3.1 offset
 * pagination for admin lists). Message counts come from the BuilderBot
 * history table when present; the alert column mirrors the highest open
 * alert so supervisors triage red chats first.
 */
export async function listDashboardChats(
  db: DbQueryable,
  options: ChatPageOptions
): Promise<ChatPage> {
  const historyExists = await toRegclassExists(db, "public.history");
  const countExpr = historyExists
    ? `(SELECT count(*) FROM history h WHERE h.session_id = s.id)`
    : `0::bigint`;
  const result = await db.query<ChatSummaryRow>(
    `SELECT s.id, s.contact_key_anon, s.jurisdiction, s.persistence_class,
            s.ai_state, s.last_activity_at,
            ${countExpr} AS message_count,
            (SELECT a.level
               FROM alerts a
              WHERE a.session_id = s.id AND a.status = 'open'
              ORDER BY (a.level = 'red') DESC, a.created_at DESC
              LIMIT 1) AS open_alert_level
       FROM sessions s
      ORDER BY s.last_activity_at DESC
      LIMIT $1 OFFSET $2;`,
    [options.limit, options.offset]
  );
  const totalResult = await db.query<{ total: number }>(
    `SELECT count(*) AS total FROM sessions;`
  );
  return {
    items: result.rows.map(mapChatSummary),
    total: Number(totalResult.rows[0]?.total ?? 0),
  };
}

interface HistoryMessageRow extends QueryResultRow {
  id: string;
  sender: string;
  message: unknown;
  created_at: Date;
}

interface HistoryMessageShape {
  text?: string;
  encrypted?: string;
  integrity_hash?: string;
}

function parseHistoryMessage(value: unknown): HistoryMessageShape {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  // Safe: value is a non-null object after the check above.
  const record = value as Record<string, unknown>;
  const result: HistoryMessageShape = {};
  if (typeof record.text === "string") {
    result.text = record.text;
  }
  if (typeof record.encrypted === "string") {
    result.encrypted = record.encrypted;
  }
  if (typeof record.integrity_hash === "string") {
    result.integrity_hash = record.integrity_hash;
  }
  return result;
}

/**
 * Messages of the dual chat view in creation order. Plaintext (anonymous)
 * rows expose `text`; encrypted (HC) rows only flag `encrypted: true` — the
 * dashboard never carries decryption keys (HC export is the decrypt path).
 */
export async function listDashboardMessages(
  db: DbQueryable,
  sessionId: string
): Promise<DashboardMessage[]> {
  if (!(await toRegclassExists(db, "public.history"))) {
    return [];
  }
  const result = await db.query<HistoryMessageRow>(
    `SELECT id, sender, message, created_at
       FROM history
      WHERE session_id = $1
      ORDER BY created_at ASC;`,
    [sessionId]
  );
  return result.rows.map((row) => {
    const parsed = parseHistoryMessage(row.message);
    return {
      id: row.id,
      sessionId,
      sender: row.sender === "user" ? "user" : "bot",
      text: parsed.text,
      encrypted: parsed.text === undefined && parsed.encrypted !== undefined,
      createdAt: row.created_at.toISOString(),
    };
  });
}

/**
 * Minimal runtime guard for untrusted `rag_traces.trace` jsonb. Covers the
 * fields the dashboard renders; anything else is dropped, never trusted.
 */
export function isRagTrace(value: unknown): value is RagTrace {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Safe: value is a non-null object after the check above.
  const record = value as Record<string, unknown>;
  const gate = record.gate;
  const gateOk =
    typeof gate === "object" &&
    gate !== null &&
    (gate as Record<string, unknown>).chunks !== undefined &&
    typeof (gate as Record<string, unknown>).cosine === "number";
  return (
    typeof record.traceId === "string" &&
    typeof record.sessionId === "string" &&
    (record.risk === "red" ||
      record.risk === "orange" ||
      record.risk === "yellow" ||
      record.risk === "normal") &&
    gateOk
  );
}

interface RagTraceRow extends QueryResultRow {
  trace: unknown;
}

/**
 * Exact RAG grounding traces for a chat (REQ-DASH-2/9), newest first — the
 * data behind the flagged-answer review scenario (orange/yellow gates).
 */
export async function listDashboardRagTraces(
  db: DbQueryable,
  sessionId: string,
  limit = 50
): Promise<RagTrace[]> {
  const result = await db.query<RagTraceRow>(
    `SELECT trace FROM rag_traces
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2;`,
    [sessionId, limit]
  );
  const traces: RagTrace[] = [];
  for (const row of result.rows) {
    // safe: untrusted jsonb is validated with isRagTrace before exposure.
    if (isRagTrace(row.trace)) {
      traces.push(row.trace);
    }
  }
  return traces;
}

/**
 * Persists a RAG grounding trace (task 5.2 enabling path): called by the
 * chat-bot emission addAction so the dashboard can reconstruct the exact
 * retrieval context of every emitted/blocked answer. The trace holds curated
 * clinical chunks and gate scores — no user PII, no phone, no raw payload —
 * so plaintext jsonb is compliant (REQ-DASH-8).
 */
export async function saveRagTrace(
  db: DbQueryable,
  sessionId: string,
  trace: RagTrace
): Promise<void> {
  await db.query(
    `INSERT INTO rag_traces (session_id, trace) VALUES ($1, $2::jsonb);`,
    [sessionId, JSON.stringify(trace)]
  );
}

/** Highest open alert level for a session, if any (red > orange > yellow). */
export async function findOpenAlertLevel(
  db: DbQueryable,
  sessionId: string
): Promise<AlertLevel | undefined> {
  const result = await db.query<{ level: AlertLevel }>(
    `SELECT a.level
       FROM alerts a
      WHERE a.session_id = $1 AND a.status = 'open'
      ORDER BY (a.level = 'red') DESC, a.created_at DESC
      LIMIT 1;`,
    [sessionId]
  );
  return result.rows[0]?.level;
}
