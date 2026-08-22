import type { DbQueryable } from "@chatcap/db-schema";
import { insertAuditEntry } from "@chatcap/db-schema";

/**
 * Rotation audit trail (REQ-DASH-8, REQ-AUDIT-1): who/when/why with PII
 * stripped. `RepositoryAuditSink` is the production sink (audit_logs table);
 * tests use an in-memory sink. Metadata must never carry message content,
 * phone numbers or raw payloads.
 */

export type RotationAuditAction =
  | "key_created"
  | "key_retired"
  | "reencryption_batch_created"
  | "reencryption_batch_verified"
  | "reencryption_batch_rolled_back"
  | "forced_reencryption_started"
  | "forced_reencryption_completed";

export interface RotationAuditEvent {
  action: RotationAuditAction;
  actorType: "system";
  resourceType: "key_version" | "re_encryption_batch";
  resourceId?: string;
  reason?: string;
  meta?: Record<string, unknown>;
  occurredAt: string;
}

export interface RotationAuditSink {
  write(event: RotationAuditEvent): Promise<void>;
}

/** Persists events into the audit_logs table (non-PII metadata only). */
export class RepositoryAuditSink implements RotationAuditSink {
  constructor(private readonly db: DbQueryable) {}

  async write(event: RotationAuditEvent): Promise<void> {
    await insertAuditEntry(this.db, {
      actorType: event.actorType,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      reason: event.reason,
      meta: { ...event.meta, occurredAt: event.occurredAt },
    });
  }
}

/** No-op sink for schedulers that run without an audit backend. */
export class NullAuditSink implements RotationAuditSink {
  async write(_event: RotationAuditEvent): Promise<void> {}
}
