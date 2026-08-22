import type { KeyProvider } from "@chatcap/config";
import type { DbQueryable } from "@chatcap/db-schema";
import {
  claimNextPendingBatch,
  completeBatch,
  countConsentRowsByKeyVersion,
  createReEncryptionBatch,
  getKeyVersion,
  listConsentRowsForReEncryption,
  retireKeyVersion,
  rollbackBatch,
} from "@chatcap/db-schema";

import type {
  BatchCryptoRequest,
  BatchCryptoWorker,
} from "./batch-crypto";
import type { RotationAuditSink } from "./audit-hooks";
import { NullAuditSink } from "./audit-hooks";
import {
  REENCRYPTION_BATCH_DEFAULT,
  REENCRYPTION_BATCH_MAX,
  REENCRYPTION_BATCH_MIN,
} from "./policy";

/**
 * Batch re-encryption coordinator (REQ-KEY-3/REQ-KEY-4): owns the batch
 * lifecycle — claim pending → fetch key metadata → dispatch crypto → mark
 * verified or rolled back — plus the key-level job that creates batches until
 * a key's rows are fully migrated, then retires it. Single-worker assumption
 * (design §6.3): the pilot runs one coordinator at a time.
 */

export interface ReencryptionDeps {
  db: DbQueryable;
  masterKeyProvider: KeyProvider;
  crypto: BatchCryptoWorker;
  batchSize?: number;
  audit?: RotationAuditSink;
}

export type BatchOutcome =
  | { kind: "verified"; batchId: string; rowsProcessed: number; integrityHash: string }
  | { kind: "rolled_back"; batchId: string; error: string }
  | { kind: "none" };

export interface ReencryptKeyResult {
  processed: number;
  remaining: number;
  retired: boolean;
  outcomes: BatchOutcome[];
}

function clampBatchSize(requested: number | undefined): number {
  if (requested === undefined) return REENCRYPTION_BATCH_DEFAULT;
  if (requested < REENCRYPTION_BATCH_MIN) return REENCRYPTION_BATCH_MIN;
  if (requested > REENCRYPTION_BATCH_MAX) return REENCRYPTION_BATCH_MAX;
  return requested;
}

export class BatchReencryptionCoordinator {
  private readonly batchSize: number;
  private readonly audit: RotationAuditSink;

  constructor(private readonly deps: ReencryptionDeps) {
    this.batchSize = clampBatchSize(deps.batchSize);
    this.audit = deps.audit ?? new NullAuditSink();
  }

  /** Claims and processes a single pending batch. */
  async runNextPendingBatch(): Promise<BatchOutcome> {
    const { db } = this.deps;
    const batch = await claimNextPendingBatch(db);
    if (batch === undefined) return { kind: "none" };

    const keyFromMeta = await getKeyVersion(db, batch.keyFrom);
    const keyToMeta = await getKeyVersion(db, batch.keyTo);
    if (keyFromMeta === undefined || keyToMeta === undefined) {
      const error = `Missing key metadata for batch ${batch.id} (from=${batch.keyFrom}, to=${batch.keyTo})`;
      await rollbackBatch(db, batch.id, error);
      await this.audit.write({
        action: "reencryption_batch_rolled_back",
        actorType: "system",
        resourceType: "re_encryption_batch",
        resourceId: batch.id,
        reason: error,
        occurredAt: new Date().toISOString(),
      });
      return { kind: "rolled_back", batchId: batch.id, error };
    }

    const rows = await listConsentRowsForReEncryption(db, batch.keyFrom, this.batchSize);
    const request: BatchCryptoRequest = {
      keyFrom: batch.keyFrom,
      keyTo: batch.keyTo,
      saltFrom: Buffer.from(keyFromMeta.salt, "hex"),
      saltTo: Buffer.from(keyToMeta.salt, "hex"),
      rows: rows.map((row) => ({
        rowId: row.rowId,
        keyFrom: batch.keyFrom,
        keyTo: batch.keyTo,
        encodedPayload: row.encryptedPayload,
      })),
    };

    try {
      const result = await this.deps.crypto.run(request);
      await completeBatch(db, batch.id, result.rows.length, result.integrityHash);
      await this.audit.write({
        action: "reencryption_batch_verified",
        actorType: "system",
        resourceType: "re_encryption_batch",
        resourceId: batch.id,
        meta: { keyFrom: batch.keyFrom, keyTo: batch.keyTo, rowsProcessed: result.rows.length },
        occurredAt: new Date().toISOString(),
      });
      return {
        kind: "verified",
        batchId: batch.id,
        rowsProcessed: result.rows.length,
        integrityHash: result.integrityHash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await rollbackBatch(db, batch.id, message);
      await this.audit.write({
        action: "reencryption_batch_rolled_back",
        actorType: "system",
        resourceType: "re_encryption_batch",
        resourceId: batch.id,
        reason: message,
        occurredAt: new Date().toISOString(),
      });
      return { kind: "rolled_back", batchId: batch.id, error: message };
    }
  }

  /** Processes up to `maxBatches` pending batches (low-traffic window). */
  async processPending(
    maxBatches: number
  ): Promise<{ processed: number; outcomes: BatchOutcome[] }> {
    const outcomes: BatchOutcome[] = [];
    let processed = 0;
    while (processed < maxBatches) {
      const outcome = await this.runNextPendingBatch();
      outcomes.push(outcome);
      if (outcome.kind === "none") break;
      processed += 1;
    }
    return { processed, outcomes };
  }

  /**
   * Migrates every remaining row of `keyFrom` to `keyTo`, creating and
   * processing batches until none remain; then retires `keyFrom`. `forced`
   * marks the 12h forced path for audit (REQ-KEY-3).
   */
  async reencryptKey(
    keyFrom: number,
    keyTo: number,
    opts: { forced?: boolean } = {}
  ): Promise<ReencryptKeyResult> {
    const { db } = this.deps;
    const forced = opts.forced ?? false;
    const outcomes: BatchOutcome[] = [];
    const auditBase = {
      actorType: "system" as const,
      resourceType: "key_version" as const,
      resourceId: String(keyFrom),
      occurredAt: new Date().toISOString(),
    };

    if (forced) {
      await this.audit.write({
        ...auditBase,
        action: "forced_reencryption_started",
        meta: { keyTo },
      });
    }

    let remaining = await countConsentRowsByKeyVersion(db, keyFrom);
    let processed = 0;
    while (remaining > 0) {
      const batch = await createReEncryptionBatch(db, { keyFrom, keyTo });
      await this.audit.write({
        ...auditBase,
        action: "reencryption_batch_created",
        resourceType: "re_encryption_batch",
        resourceId: batch.id,
        meta: { keyFrom, keyTo },
      });
      const outcome = await this.runNextPendingBatch();
      outcomes.push(outcome);
      if (outcome.kind === "rolled_back" || outcome.kind === "none") break;
      processed += 1;
      remaining = await countConsentRowsByKeyVersion(db, keyFrom);
    }

    const retired = remaining === 0;
    if (retired) {
      await retireKeyVersion(db, keyFrom);
      await this.audit.write({ ...auditBase, action: "key_retired" });
    }
    if (forced) {
      await this.audit.write({
        ...auditBase,
        action: "forced_reencryption_completed",
        meta: { retired, remaining },
      });
    }
    return { processed, remaining, retired, outcomes };
  }
}
