import { describe, expect, test } from "vitest";

import type { DbQueryable, QueryResultRow } from "@chatcap/db-schema";

import { PgOtpStore, type StoredOtp } from "../src/index";

/**
 * PostgreSQL OTP store (task 4.9 chat-side, REQ-KEY-6): maps StoredOtp onto
 * the `otp_codes` table (migration 0001) through the shared DbQueryable
 * contract — storage is hash-only, never the plaintext code. The same
 * interactions run against real PostgreSQL in the gated db-schema suite.
 */

function fakeDb(
  responses: Array<{ rows?: QueryResultRow[]; rowCount?: number | null }>
): { db: DbQueryable; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let cursor = 0;
  const db: DbQueryable = {
    async query<T extends QueryResultRow>(text: string, values?: unknown[]) {
      calls.push({ sql: text, params: values ?? [] });
      const response = responses[Math.min(cursor, responses.length - 1)];
      cursor += 1;
      return {
        rows: (response?.rows ?? []) as T[],
        rowCount: response?.rowCount ?? null,
      };
    },
  };
  return { db, calls };
}

const RECORD: StoredOtp = {
  id: "2b8d0e3a-71b6-4f0c-9a3e-1c4d5e6f7089",
  consentId: "consent-uuid-1",
  otpHash: "a1b2c3d4e5f60718:357f2b6e481272d101f23cf67f09c114aa06299b3cc60ad1c90a7b493f659eb2",
  attempts: 0,
  expiresAt: "2026-08-09T12:10:00.000Z",
  status: "pending",
};

describe("PgOtpStore (task 4.9, REQ-KEY-6 persistence)", () => {
  test("inserts a row into otp_codes without ever passing the plaintext code", async () => {
    const { db, calls } = fakeDb([{ rows: [], rowCount: 1 }]);
    const store = new PgOtpStore(db);

    await store.insert(RECORD);

    expect(calls[0]?.sql).toMatch(/INSERT INTO otp_codes/);
    expect(calls[0]?.params).toEqual([
      RECORD.id,
      RECORD.consentId,
      RECORD.otpHash,
      RECORD.attempts,
      new Date(RECORD.expiresAt),
      RECORD.status,
    ]);
    // The salted hash is the only code material on the wire (AGENTS.md).
    expect(calls[0]?.params.join(" ")).not.toContain("123456");
  });

  test("maps a row back to a StoredOtp on findById", async () => {
    const { db } = fakeDb([
      {
        rows: [
          {
            id: RECORD.id,
            consent_id: RECORD.consentId,
            otp_hash: RECORD.otpHash,
            attempts: RECORD.attempts,
            expires_at: new Date(RECORD.expiresAt),
            status: RECORD.status,
          },
        ],
      },
    ]);
    const store = new PgOtpStore(db);

    const found = await store.findById(RECORD.id);

    expect(found).toEqual(RECORD);
  });

  test("returns undefined for an unknown id", async () => {
    const { db } = fakeDb([{ rows: [] }]);
    const store = new PgOtpStore(db);

    expect(await store.findById("missing")).toBeUndefined();
  });

  test("updates the row in place, keeping hash-only storage", async () => {
    const { db, calls } = fakeDb([{ rows: [], rowCount: 1 }]);
    const store = new PgOtpStore(db);
    const locked: StoredOtp = { ...RECORD, attempts: 5, status: "locked" };

    await store.update(locked);

    expect(calls[0]?.sql).toMatch(/UPDATE otp_codes/);
    expect(calls[0]?.params).toEqual([
      locked.id,
      locked.otpHash,
      locked.attempts,
      new Date(locked.expiresAt),
      locked.status,
    ]);
  });
});
