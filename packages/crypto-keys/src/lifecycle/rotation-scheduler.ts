import type { KeyProvider } from "@chatcap/config";
import type { DbQueryable } from "@chatcap/db-schema";
import { currentActiveKeyVersion, listKeysPastForcedDue } from "@chatcap/db-schema";

import type { RotationAuditSink } from "./audit-hooks";
import type { BatchCryptoWorker } from "./batch-crypto";
import { ensureActiveKey } from "./key-lifecycle";
import { LOW_TRAFFIC_WINDOW, isWithinWindow } from "./policy";
import type { TimeWindow } from "./policy";
import { BatchReencryptionCoordinator } from "./reencryption-coordinator";

/**
 * Rotation scheduler (REQ-KEY-5): one `run()` tick —
 *   1. guarantee an active writer key (rotate to N+1 on expiry);
 *   2. inside the low-traffic window, migrate the rotated-out key's rows;
 *   3. run the forced 12h job for any key past its forced due date,
 *      regardless of the window (REQ-KEY-3);
 *   4. retire fully-migrated keys.
 * The scheduler is stateless — the DB is the source of truth — so it can be
 * invoked by a cron/systemd timer at any cadence.
 */

export interface RotationSchedulerDeps {
  db: DbQueryable;
  masterKeyProvider: KeyProvider;
  crypto: BatchCryptoWorker;
  audit?: RotationAuditSink;
  clock?: () => Date;
  lowTrafficWindow?: TimeWindow;
  maxPendingBatches?: number;
}

export interface RotationSchedulerReport {
  runAt: string;
  currentKeyVersion: number;
  createdKey: boolean;
  windowActive: boolean;
  pendingProcessed: number;
  forcedKeysProcessed: number;
  retiredKeys: number[];
  errors: string[];
}

export class RotationScheduler {
  constructor(private readonly deps: RotationSchedulerDeps) {}

  async run(): Promise<RotationSchedulerReport> {
    const { db } = this.deps;
    const now = this.deps.clock?.() ?? new Date();
    const window = this.deps.lowTrafficWindow ?? LOW_TRAFFIC_WINDOW;
    const errors: string[] = [];

    const previous = await currentActiveKeyVersion(db);
    const { current, created } = await ensureActiveKey({
      db,
      masterKeyProvider: this.deps.masterKeyProvider,
      audit: this.deps.audit,
      now: this.deps.clock,
    });

    const coordinator = new BatchReencryptionCoordinator({
      db,
      masterKeyProvider: this.deps.masterKeyProvider,
      crypto: this.deps.crypto,
      audit: this.deps.audit,
    });

    const windowActive = isWithinWindow(now, window);
    let pendingProcessed = 0;
    const retiredKeys: number[] = [];
    if (windowActive) {
      if (created && previous !== undefined && previous.keyVersion !== current.keyVersion) {
        // Deferred re-encryption of the key we just rotated out
        const result = await coordinator.reencryptKey(previous.keyVersion, current.keyVersion);
        pendingProcessed += result.processed;
        if (result.retired) retiredKeys.push(previous.keyVersion);
      } else {
        const result = await coordinator.processPending(this.deps.maxPendingBatches ?? 50);
        pendingProcessed += result.processed;
      }
    }

    const forcedKeys = await listKeysPastForcedDue(db, now);
    let forcedKeysProcessed = 0;
    for (const key of forcedKeys) {
      if (key.keyVersion === current.keyVersion) continue;
      try {
        const result = await coordinator.reencryptKey(key.keyVersion, current.keyVersion, {
          forced: true,
        });
        forcedKeysProcessed += result.processed;
        if (result.retired) retiredKeys.push(key.keyVersion);
      } catch (error) {
        errors.push(
          `forced re-encryption of key ${key.keyVersion}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return {
      runAt: now.toISOString(),
      currentKeyVersion: current.keyVersion,
      createdKey: created,
      windowActive,
      pendingProcessed,
      forcedKeysProcessed,
      retiredKeys,
      errors,
    };
  }
}
