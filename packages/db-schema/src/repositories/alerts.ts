import type { AlertLevel, AlertStatus } from "@chatcap/shared-types";

import type { DbQueryable, QueryResultRow } from "./db";

/**
 * Alerts repository (REQ-ALERT-5): one-open-alert semantics via dedupe_key.
 * Follow-ups UPDATE the existing open alert; a new alert is only inserted
 * after the previous one is resolved.
 */

export interface NewAlert {
  level: AlertLevel;
  category: string;
  sessionId: string;
  dedupeKey: string;
}

export interface AlertRow {
  id: string;
  level: AlertLevel;
  category: string;
  sessionId: string;
  status: AlertStatus;
  dedupeKey: string;
  acknowledgedBy?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

interface AlertDbRow extends QueryResultRow {
  id: string;
  level: AlertLevel;
  category: string;
  session_id: string;
  status: AlertStatus;
  dedupe_key: string;
  acknowledged_by: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

function mapAlert(row: AlertDbRow): AlertRow {
  return {
    id: row.id,
    level: row.level,
    category: row.category,
    sessionId: row.session_id,
    status: row.status,
    dedupeKey: row.dedupe_key,
    acknowledgedBy: row.acknowledged_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString(),
  };
}

const ALERT_COLUMNS = `id, level, category, session_id, status, dedupe_key,
            acknowledged_by, created_at, updated_at, resolved_at`;

export async function findOpenAlertByDedupeKey(
  db: DbQueryable,
  dedupeKey: string
): Promise<AlertRow | undefined> {
  const result = await db.query<AlertDbRow>(
    `SELECT ${ALERT_COLUMNS}
       FROM alerts
      WHERE dedupe_key = $1 AND status = 'open'
      LIMIT 1;`,
    [dedupeKey]
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapAlert(row);
}

export async function createAlert(
  db: DbQueryable,
  input: NewAlert
): Promise<AlertRow> {
  const result = await db.query<AlertDbRow>(
    `INSERT INTO alerts (level, category, session_id, dedupe_key)
     VALUES ($1, $2, $3, $4)
     RETURNING ${ALERT_COLUMNS};`,
    [input.level, input.category, input.sessionId, input.dedupeKey]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("alerts: insert returned no row");
  }
  return mapAlert(row);
}

/** REQ-ALERT-6: open → acknowledged (supervisor takeover). */
export async function acknowledgeAlert(
  db: DbQueryable,
  alertId: string,
  actorId: string
): Promise<void> {
  await db.query(
    `UPDATE alerts SET status = 'acknowledged', acknowledged_by = $2
      WHERE id = $1;`,
    [alertId, actorId]
  );
}

/** REQ-ALERT-6: acknowledged → resolved. */
export async function resolveAlert(
  db: DbQueryable,
  alertId: string
): Promise<void> {
  await db.query(
    `UPDATE alerts SET status = 'resolved', resolved_at = now()
      WHERE id = $1;`,
    [alertId]
  );
}

/** Finds a single alert by id regardless of status (REQ-ALERT-5 touch, 2.4 lifecycle). */
export async function findAlertById(
  db: DbQueryable,
  alertId: string
): Promise<AlertRow | undefined> {
  const result = await db.query<AlertDbRow>(
    `SELECT ${ALERT_COLUMNS}
       FROM alerts
      WHERE id = $1
      LIMIT 1;`,
    [alertId]
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapAlert(row);
}

/**
 * Bumps updated_at on a follow-up without changing status (REQ-ALERT-5):
 * a repeated identical alert refreshes the open alert instead of inserting.
 */
export async function touchAlert(
  db: DbQueryable,
  alertId: string
): Promise<void> {
  await db.query(
    `UPDATE alerts SET updated_at = now()
      WHERE id = $1;`,
    [alertId]
  );
}

export interface AlertPage {
  items: AlertRow[];
  total: number;
}

export interface AlertPageOptions {
  limit: number;
  offset: number;
}

/**
 * Paginated alert feed for the supervisor dashboard (task 5.4, REQ-DASH-4):
 * severity-first (red > orange > yellow), newest first within a level so the
 * semaphore surfaces vital-risk alerts on top. Mirrors the offset pagination
 * contract of the chats read models (design §3.1). Rows are PII-free by
 * construction (no message content, no phone, no raw payload — REQ-ALERT-6).
 */
export async function listAlerts(
  db: DbQueryable,
  options: AlertPageOptions
): Promise<AlertPage> {
  const result = await db.query<AlertDbRow>(
    `SELECT ${ALERT_COLUMNS}
       FROM alerts
      ORDER BY (level = 'red') DESC, (level = 'orange') DESC, created_at DESC
      LIMIT $1 OFFSET $2;`,
    [options.limit, options.offset]
  );
  const totalResult = await db.query<{ total: number }>(
    `SELECT count(*) AS total FROM alerts;`
  );
  return {
    items: result.rows.map(mapAlert),
    total: Number(totalResult.rows[0]?.total ?? 0),
  };
}
