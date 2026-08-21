import type { ActorType, AuditLogEntry } from "@chatcap/shared-types";

import type { DbQueryable, QueryResultRow } from "./db";

/**
 * Audit log (REQ-DASH-8): who/when/why with PII stripped. `meta` JSONB may
 * only hold non-PII detail — never message content, phone, or webhook payload.
 */

export interface NewAuditEntry {
  actorType: ActorType;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

interface AuditRow extends QueryResultRow {
  id: string;
  actor_type: ActorType;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  reason: string | null;
  meta: Record<string, unknown>;
  created_at: Date;
}

function mapAudit(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id ?? undefined,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? undefined,
    reason: row.reason ?? undefined,
    meta: row.meta,
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertAuditEntry(
  db: DbQueryable,
  entry: NewAuditEntry
): Promise<AuditLogEntry> {
  const result = await db.query<AuditRow>(
    `INSERT INTO audit_logs (actor_type, actor_id, action, resource_type,
                             resource_id, reason, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id, actor_type, actor_id, action, resource_type, resource_id,
               reason, meta, created_at;`,
    [
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.reason ?? null,
      JSON.stringify(entry.meta ?? {}),
    ]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("audit: insert returned no row");
  }
  return mapAudit(row);
}

export async function listAuditByResource(
  db: DbQueryable,
  resourceType: string,
  resourceId: string,
  limit = 50
): Promise<AuditLogEntry[]> {
  const result = await db.query<AuditRow>(
    `SELECT id, actor_type, actor_id, action, resource_type, resource_id,
            reason, meta, created_at
       FROM audit_logs
      WHERE resource_type = $1 AND resource_id = $2
       ORDER BY created_at DESC
       LIMIT $3;`,
    [resourceType, resourceId, limit]
  );
  return result.rows.map(mapAudit);
}

export interface AuditQuery {
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function listAuditEntries(
  db: DbQueryable,
  q: AuditQuery
): Promise<AuditLogEntry[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (q.resourceType !== undefined) {
    values.push(q.resourceType);
    conditions.push(`resource_type = $${values.length}`);
  }
  if (q.resourceId !== undefined) {
    values.push(q.resourceId);
    conditions.push(`resource_id = $${values.length}`);
  }
  if (q.actorId !== undefined) {
    values.push(q.actorId);
    conditions.push(`actor_id = $${values.length}`);
  }
  if (q.from !== undefined) {
    values.push(q.from);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (q.to !== undefined) {
    values.push(q.to);
    conditions.push(`created_at <= $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  values.push(limit);

  const result = await db.query<AuditRow>(
    `SELECT id, actor_type, actor_id, action, resource_type, resource_id,
             reason, meta, created_at
        FROM audit_logs
        ${where}
        ORDER BY created_at DESC
        LIMIT $${values.length};`,
    values
  );
  return result.rows.map(mapAudit);
}
