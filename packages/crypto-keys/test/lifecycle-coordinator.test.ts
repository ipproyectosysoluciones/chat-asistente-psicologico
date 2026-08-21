import { describe, expect, it } from "vitest";

import type { BatchCryptoRequest } from "../src/lifecycle/batch-crypto";
import { BatchReencryptionCoordinator } from "../src/lifecycle/reencryption-coordinator";
import {
  REENCRYPTION_BATCH_DEFAULT,
  REENCRYPTION_BATCH_MAX,
  REENCRYPTION_BATCH_MIN,
} from "../src/lifecycle/policy";
import { InMemoryAuditSink, MockBatchWorker, fakeDb, staticMasterKeyProvider } from "./helpers";

const RUNNING_BATCH = {
  id: "batch-1",
  key_from: 1,
  key_to: 2,
  status: "running",
  rows_count: null,
  integrity_hash: null,
  error: null,
  started_at: new Date("2026-08-09T03:00:00Z"),
  completed_at: null,
};

const KEY_META = (keyVersion: number, salt: string) => ({
  key_version: keyVersion,
  algorithm: "aes-256-cbc-hkdf-sha256",
  salt,
  status: "retired",
  created_at: new Date("2026-08-01T00:00:00Z"),
  expires_at: new Date("2026-08-08T00:00:00Z"),
  forced_rotation_due_at: new Date("2026-08-08T12:00:00Z"),
});

const CONSENT_ROWS = [
  { id: "c1", key_version: 1, encrypted_payload: Buffer.from("enc-1") },
  { id: "c2", key_version: 1, encrypted_payload: Buffer.from("enc-2") },
];

const VERIFIED_BATCH = {
  id: "batch-1",
  key_from: 1,
  key_to: 2,
  status: "verified",
  rows_count: 2,
  integrity_hash: "ab".repeat(32),
  error: null,
  started_at: new Date("2026-08-09T03:00:00Z"),
  completed_at: new Date("2026-08-09T03:01:00Z"),
};

function fakeWorkerResult(request: BatchCryptoRequest) {
  return {
    keyFrom: request.keyFrom,
    keyTo: request.keyTo,
    rows: request.rows.map((row) => ({
      rowId: row.rowId,
      keyTo: request.keyTo,
      encodedPayload: Buffer.from(`re-${row.rowId}`),
      iv: Buffer.alloc(16),
      ciphertext: Buffer.alloc(8),
      hmac: Buffer.alloc(32),
      integrityHash: "ee".repeat(32),
    })),
    integrityHash: "cd".repeat(32),
    verified: true,
  };
}

function failingWorker(message: string) {
  return new MockBatchWorker(() => {
    throw new Error(message);
  });
}

describe("BatchReencryptionCoordinator (REQ-KEY-4/REQ-KEY-3)", () => {
  it("processes a pending batch to verified and audits it", async () => {
    const db = fakeDb([
      { match: (sql) => sql.includes("SET status = 'running'"), rows: [RUNNING_BATCH] },
      { match: (sql, p) => sql.includes("FROM key_versions") && sql.includes("WHERE key_version = $1") && p[0] === 1, rows: [KEY_META(1, "aa".repeat(32))] },
      { match: (sql, p) => sql.includes("FROM key_versions") && sql.includes("WHERE key_version = $1") && p[0] === 2, rows: [KEY_META(2, "bb".repeat(32))] },
      { match: (sql) => sql.includes("FROM consent_records") && sql.includes("LIMIT"), rows: CONSENT_ROWS },
      { match: (sql) => sql.includes("SET status = 'verified'"), rows: [VERIFIED_BATCH] },
    ]);
    const audit = new InMemoryAuditSink();
    const coordinator = new BatchReencryptionCoordinator({
      db,
      masterKeyProvider: staticMasterKeyProvider(),
      crypto: new MockBatchWorker(fakeWorkerResult),
      audit,
    });

    const outcome = await coordinator.runNextPendingBatch();

    expect(outcome).toMatchObject({ kind: "verified", batchId: "batch-1", rowsProcessed: 2 });
    expect(outcome.kind === "verified" && outcome.integrityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.events.map((e) => e.action)).toContain("reencryption_batch_verified");
  });

  it("rolls back the batch row when the crypto worker fails", async () => {
    const db = fakeDb([
      { match: (sql) => sql.includes("SET status = 'running'"), rows: [RUNNING_BATCH] },
      { match: (sql, p) => sql.includes("FROM key_versions") && sql.includes("WHERE key_version = $1") && p[0] === 1, rows: [KEY_META(1, "aa".repeat(32))] },
      { match: (sql, p) => sql.includes("FROM key_versions") && sql.includes("WHERE key_version = $1") && p[0] === 2, rows: [KEY_META(2, "bb".repeat(32))] },
      { match: (sql) => sql.includes("FROM consent_records") && sql.includes("LIMIT"), rows: CONSENT_ROWS },
      { match: (sql) => sql.includes("SET status = 'rolled_back'"), rows: [{ ...RUNNING_BATCH, status: "rolled_back", error: "boom", completed_at: new Date() }] },
    ]);
    const audit = new InMemoryAuditSink();
    const coordinator = new BatchReencryptionCoordinator({
      db,
      masterKeyProvider: staticMasterKeyProvider(),
      crypto: failingWorker("boom"),
      audit,
    });

    const outcome = await coordinator.runNextPendingBatch();

    expect(outcome).toEqual({ kind: "rolled_back", batchId: "batch-1", error: "boom" });
    expect(audit.events.map((e) => e.action)).toContain("reencryption_batch_rolled_back");
  });

  it("returns none when no pending batch exists", async () => {
    const db = fakeDb([
      { match: (sql) => sql.includes("SET status = 'running'"), rows: [] },
    ]);
    const coordinator = new BatchReencryptionCoordinator({
      db,
      masterKeyProvider: staticMasterKeyProvider(),
      crypto: new MockBatchWorker(fakeWorkerResult),
    });

    expect(await coordinator.runNextPendingBatch()).toEqual({ kind: "none" });
  });

  it("clamps the batch size to the 100–500 contract", async () => {
    const db = fakeDb([
      { match: (sql) => sql.includes("SET status = 'running'"), rows: [RUNNING_BATCH] },
      { match: (sql) => sql.includes("FROM key_versions") && sql.includes("WHERE key_version = $1"), rows: [KEY_META(1, "aa".repeat(32))] },
      { match: (sql) => sql.includes("LIMIT"), rows: CONSENT_ROWS },
      { match: (sql) => sql.includes("SET status = 'verified'"), rows: [VERIFIED_BATCH] },
    ]);

    const small = new BatchReencryptionCoordinator({
      db,
      masterKeyProvider: staticMasterKeyProvider(),
      crypto: new MockBatchWorker(fakeWorkerResult),
      batchSize: 3,
    });
    await small.runNextPendingBatch();
    const smallLimit = db.calls.find((c) => c.sql.includes("LIMIT $2"))?.params[1];
    expect(smallLimit).toBe(REENCRYPTION_BATCH_MIN);

    const huge = new BatchReencryptionCoordinator({
      db,
      masterKeyProvider: staticMasterKeyProvider(),
      crypto: new MockBatchWorker(fakeWorkerResult),
      batchSize: 100_000,
    });
    await huge.runNextPendingBatch();
    const hugeLimit = db.calls.filter((c) => c.sql.includes("LIMIT $2")).pop()?.params[1];
    expect(hugeLimit).toBe(REENCRYPTION_BATCH_MAX);

    expect(REENCRYPTION_BATCH_MIN).toBe(100);
    expect(REENCRYPTION_BATCH_MAX).toBe(500);
    expect(REENCRYPTION_BATCH_DEFAULT).toBeGreaterThanOrEqual(REENCRYPTION_BATCH_MIN);
    expect(REENCRYPTION_BATCH_DEFAULT).toBeLessThanOrEqual(REENCRYPTION_BATCH_MAX);
  });

  it("reencryptKey creates batches until 0 rows remain, then retires the key", async () => {
    const countResponse = { match: (sql: string) => sql.includes("FROM consent_records") && sql.includes("count"), rowsQueue: [[{ count: 4 }], [{ count: 0 }]] };
    const db = fakeDb([
      { match: (sql) => sql.includes("INSERT INTO re_encryption_batches"), rows: [{ id: "b1", key_from: 1, key_to: 2, status: "pending", rows_count: null, integrity_hash: null, error: null, started_at: new Date(), completed_at: null }] },
      { match: (sql) => sql.includes("SET status = 'running'"), rows: [RUNNING_BATCH] },
      { match: (sql, p) => sql.includes("FROM key_versions") && sql.includes("WHERE key_version = $1") && p[0] === 1, rows: [KEY_META(1, "aa".repeat(32))] },
      { match: (sql, p) => sql.includes("FROM key_versions") && sql.includes("WHERE key_version = $1") && p[0] === 2, rows: [KEY_META(2, "bb".repeat(32))] },
      { match: (sql) => sql.includes("FROM consent_records") && sql.includes("LIMIT"), rows: CONSENT_ROWS },
      { match: (sql) => sql.includes("SET status = 'verified'"), rows: [VERIFIED_BATCH] },
      countResponse,
      { match: (sql) => sql.includes("SET status = 'retired'"), rows: [] },
    ]);
    const audit = new InMemoryAuditSink();
    const coordinator = new BatchReencryptionCoordinator({
      db,
      masterKeyProvider: staticMasterKeyProvider(),
      crypto: new MockBatchWorker(fakeWorkerResult),
      audit,
    });

    const result = await coordinator.reencryptKey(1, 2, { forced: true });

    expect(result).toMatchObject({ processed: 1, remaining: 0, retired: true });
    expect(db.calls.some((c) => c.sql.includes("SET status = 'retired'"))).toBe(true);
    expect(audit.events.map((e) => e.action)).toContain("forced_reencryption_started");
    expect(audit.events.map((e) => e.action)).toContain("forced_reencryption_completed");
  });

  it("reencryptKey retires immediately when no rows remain under the key", async () => {
    const db = fakeDb([
      { match: (sql) => sql.includes("count"), rows: [{ count: 0 }] },
      { match: (sql) => sql.includes("SET status = 'retired'"), rows: [] },
    ]);
    const coordinator = new BatchReencryptionCoordinator({
      db,
      masterKeyProvider: staticMasterKeyProvider(),
      crypto: new MockBatchWorker(fakeWorkerResult),
    });

    const result = await coordinator.reencryptKey(5, 6, { forced: true });

    expect(result).toEqual({ processed: 0, remaining: 0, retired: true, outcomes: [] });
  });
});
