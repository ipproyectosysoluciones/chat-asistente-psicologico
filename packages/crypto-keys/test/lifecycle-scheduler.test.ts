import { describe, expect, it } from "vitest";

import { ensureActiveKey, retireKey } from "../src/lifecycle/key-lifecycle";
import { RotationScheduler } from "../src/lifecycle/rotation-scheduler";
import type { BatchCryptoRequest } from "../src/lifecycle/batch-crypto";
import { InMemoryAuditSink, MockBatchWorker, fakeDb, staticMasterKeyProvider } from "./helpers";

const KEY_ROW = (keyVersion: number, expiresAt: Date, salt = "aa".repeat(32)) => ({
  key_version: keyVersion,
  algorithm: "aes-256-cbc-hkdf-sha256",
  salt,
  status: "active",
  created_at: new Date("2026-08-01T00:00:00Z"),
  expires_at: expiresAt,
  forced_rotation_due_at: new Date(expiresAt.getTime() + 12 * 60 * 60 * 1000),
});

function insertResponse(keyVersion: number, expiresAt: Date) {
  return {
    match: (sql: string) => sql.includes("INSERT INTO key_versions"),
    rows: [KEY_ROW(keyVersion, expiresAt, keyVersion === 2 ? "bb".repeat(32) : "aa".repeat(32))],
  };
}

/** Response for createNextKeyVersion's `SELECT COALESCE(MAX(key_version), 0)` probe. */
function maxResponse(max: number) {
  return {
    match: (sql: string) => sql.includes("COALESCE(MAX(key_version), 0)"),
    rows: [{ max }],
  };
}

const workerResult = (request: BatchCryptoRequest) => ({
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
});

const baseDeps = (db: ReturnType<typeof fakeDb>, audit?: InMemoryAuditSink) => ({
  db,
  masterKeyProvider: staticMasterKeyProvider(),
  crypto: new MockBatchWorker(workerResult),
  audit,
});

/** Shared responses for a full batch cycle under key 1 → key 2. */
function batchCycleResponses() {
  return [
    { match: (sql: string) => sql.includes("INSERT INTO re_encryption_batches"), rows: [{ id: "b1", key_from: 1, key_to: 2, status: "pending", rows_count: null, integrity_hash: null, error: null, started_at: new Date(), completed_at: null }] },
    { match: (sql: string) => sql.includes("SET status = 'running'"), rows: [{ id: "b1", key_from: 1, key_to: 2, status: "running", rows_count: null, integrity_hash: null, error: null, started_at: new Date(), completed_at: null }] },
    { match: (sql: string, p: unknown[]) => sql.includes("WHERE key_version = $1") && p[0] === 1, rows: [KEY_ROW(1, new Date("2026-08-08T00:00:00Z"))] },
    { match: (sql: string, p: unknown[]) => sql.includes("WHERE key_version = $1") && p[0] === 2, rows: [KEY_ROW(2, new Date("2026-08-16T00:00:00Z"), "bb".repeat(32))] },
    { match: (sql: string) => sql.includes("FROM consent_records") && sql.includes("LIMIT"), rows: [{ id: "c1", key_version: 1, encrypted_payload: Buffer.from("enc-1") }] },
    { match: (sql: string) => sql.includes("SET status = 'verified'"), rows: [{ id: "b1", key_from: 1, key_to: 2, status: "verified", rows_count: 1, integrity_hash: "cd".repeat(32), error: null, started_at: new Date(), completed_at: new Date() }] },
  ];
}

describe("key lifecycle (REQ-KEY-2)", () => {
  it("seeds key 1 with a 7-day cycle and audits key_created", async () => {
    const now = new Date("2026-08-09T00:00:00Z");
    const db = fakeDb([
      { match: (sql: string) => sql.includes("WHERE status = 'active'"), rows: [] },
      maxResponse(0),
      insertResponse(1, new Date("2026-08-16T00:00:00Z")),
    ]);
    const audit = new InMemoryAuditSink();

    const result = await ensureActiveKey({ db, masterKeyProvider: staticMasterKeyProvider(), audit, now: () => now });

    expect(result.created).toBe(true);
    expect(result.current.keyVersion).toBe(1);
    const insert = db.calls.find((c) => c.sql.includes("INSERT INTO key_versions"));
    expect(insert?.params[2]).toMatch(/^[0-9a-f]{64}$/); // salt
    expect((insert?.params[3] as Date).getTime()).toBe(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(audit.events.map((e) => e.action)).toContain("key_created");
  });

  it("keeps the existing active key when it has not expired", async () => {
    const db = fakeDb([
      { match: (sql: string) => sql.includes("WHERE status = 'active'"), rows: [KEY_ROW(1, new Date("2026-08-16T00:00:00Z"))] },
    ]);
    const result = await ensureActiveKey({ db, masterKeyProvider: staticMasterKeyProvider(), now: () => new Date("2026-08-09T00:00:00Z") });

    expect(result.created).toBe(false);
    expect(result.current.keyVersion).toBe(1);
    expect(db.calls.some((c) => c.sql.includes("INSERT INTO key_versions"))).toBe(false);
  });

  it("rotates to key N+1 when the active key is past expiry (dual-read)", async () => {
    const db = fakeDb([
      { match: (sql: string) => sql.includes("WHERE status = 'active'"), rows: [KEY_ROW(1, new Date("2026-08-08T00:00:00Z"))] },
      maxResponse(1),
      insertResponse(2, new Date("2026-08-16T00:00:00Z")),
    ]);
    const result = await ensureActiveKey({ db, masterKeyProvider: staticMasterKeyProvider(), now: () => new Date("2026-08-09T00:00:00Z") });

    expect(result.created).toBe(true);
    expect(result.current.keyVersion).toBe(2);
  });

  it("retireKey audits the retirement", async () => {
    const db = fakeDb([
      { match: (sql: string) => sql.includes("SET status = 'retired'"), rows: [] },
    ]);
    const audit = new InMemoryAuditSink();
    await retireKey({ db, masterKeyProvider: staticMasterKeyProvider(), audit }, 1);
    expect(db.calls.some((c) => c.sql.includes("SET status = 'retired'"))).toBe(true);
    expect(audit.events.map((e) => e.action)).toContain("key_retired");
  });
});

describe("RotationScheduler.run (REQ-KEY-5 / REQ-KEY-3)", () => {
  it("seeds the first key when none exists", async () => {
    const db = fakeDb([
      { match: (sql: string) => sql.includes("WHERE status = 'active'"), rows: [] },
      maxResponse(0),
      insertResponse(1, new Date("2026-08-16T00:00:00Z")),
      { match: (sql: string) => sql.includes("SET status = 'running'"), rows: [] },
      { match: (sql: string) => sql.includes("forced_rotation_due_at"), rows: [] },
    ]);
    const scheduler = new RotationScheduler({
      ...baseDeps(db),
      clock: () => new Date("2026-08-09T03:00:00Z"),
    });

    const report = await scheduler.run();

    expect(report.createdKey).toBe(true);
    expect(report.currentKeyVersion).toBe(1);
    expect(report.pendingProcessed).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("does nothing when the active key is fresh and the window is closed", async () => {
    const db = fakeDb([
      { match: (sql: string) => sql.includes("WHERE status = 'active'"), rows: [KEY_ROW(1, new Date("2026-08-16T00:00:00Z"))] },
      { match: (sql: string) => sql.includes("forced_rotation_due_at"), rows: [] },
    ]);
    const scheduler = new RotationScheduler({
      ...baseDeps(db),
      clock: () => new Date("2026-08-09T10:00:00Z"),
    });

    const report = await scheduler.run();

    expect(report.createdKey).toBe(false);
    expect(report.pendingProcessed).toBe(0);
    expect(report.forcedKeysProcessed).toBe(0);
  });

  it("rotates and runs deferred re-encryption inside the low-traffic window", async () => {
    const db = fakeDb([
      { match: (sql: string) => sql.includes("WHERE status = 'active'"), rows: [KEY_ROW(1, new Date("2026-08-08T00:00:00Z"))] },
      maxResponse(1),
      insertResponse(2, new Date("2026-08-16T00:00:00Z")),
      { match: (sql: string) => sql.includes("FROM consent_records") && sql.includes("count"), rowsQueue: [[{ count: 4 }], [{ count: 0 }]] },
      ...batchCycleResponses(),
      { match: (sql: string) => sql.includes("SET status = 'retired'"), rows: [] },
      { match: (sql: string) => sql.includes("forced_rotation_due_at"), rows: [] },
    ]);
    const audit = new InMemoryAuditSink();
    const scheduler = new RotationScheduler({
      ...baseDeps(db, audit),
      clock: () => new Date("2026-08-09T03:00:00Z"),
    });

    const report = await scheduler.run();

    expect(report.createdKey).toBe(true);
    expect(report.currentKeyVersion).toBe(2);
    expect(report.pendingProcessed).toBe(1);
    expect(report.retiredKeys).toEqual([1]);
    expect(audit.events.some((e) => e.action === "forced_reencryption_started")).toBe(false);
    expect(audit.events.map((e) => e.action)).toContain("reencryption_batch_created");
  });

  it("runs the forced 12h job even when the window is closed", async () => {
    const db = fakeDb([
      { match: (sql: string) => sql.includes("WHERE status = 'active'"), rows: [KEY_ROW(2, new Date("2026-08-16T00:00:00Z"), "bb".repeat(32))] },
      { match: (sql: string) => sql.includes("FROM consent_records") && sql.includes("count"), rowsQueue: [[{ count: 4 }], [{ count: 0 }]] },
      ...batchCycleResponses(),
      { match: (sql: string) => sql.includes("SET status = 'retired'"), rows: [] },
      { match: (sql: string) => sql.includes("forced_rotation_due_at"), rows: [KEY_ROW(1, new Date("2026-08-08T00:00:00Z"))] },
    ]);
    const audit = new InMemoryAuditSink();
    const scheduler = new RotationScheduler({
      ...baseDeps(db, audit),
      clock: () => new Date("2026-08-09T10:00:00Z"),
    });

    const report = await scheduler.run();

    expect(report.createdKey).toBe(false);
    expect(report.windowActive).toBe(false);
    expect(report.forcedKeysProcessed).toBe(1);
    expect(report.retiredKeys).toEqual([1]);
    expect(audit.events.map((e) => e.action)).toContain("forced_reencryption_started");
    expect(audit.events.map((e) => e.action)).toContain("forced_reencryption_completed");
  });

  it("never treats the current active key as a forced target", async () => {
    const current = KEY_ROW(2, new Date("2026-08-16T00:00:00Z"), "bb".repeat(32));
    const db = fakeDb([
      { match: (sql: string) => sql.includes("WHERE status = 'active'"), rows: [current] },
      { match: (sql: string) => sql.includes("forced_rotation_due_at"), rows: [current] },
    ]);
    const scheduler = new RotationScheduler({
      ...baseDeps(db),
      clock: () => new Date("2026-08-09T10:00:00Z"),
    });

    const report = await scheduler.run();

    expect(report.forcedKeysProcessed).toBe(0);
    expect(report.retiredKeys).toEqual([]);
    expect(db.calls.some((c) => c.sql.includes("INSERT INTO re_encryption_batches"))).toBe(false);
  });
});
