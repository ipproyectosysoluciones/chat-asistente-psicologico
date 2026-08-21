import { describe, expect, it } from "vitest";

import type { DbQueryable, QueryResultRow } from "../src/repositories/db";
import { countConsentRowsByKeyVersion } from "../src/repositories/consent";
import { listKeysPastForcedDue } from "../src/repositories/key-versions";

/** Fake queryable that pattern-matches SQL and records calls. */
function fakeDb(
  responses: Array<{ match: (sql: string) => boolean; rows: QueryResultRow[] }>
): { db: DbQueryable; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: DbQueryable = {
    async query<T extends QueryResultRow>(text: string, values?: unknown[]) {
      calls.push({ sql: text, params: values ?? [] });
      const hit = responses.find((entry) => entry.match(text));
      const rows = (hit?.rows ?? []) as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { db, calls };
}

const KEY_ROW = {
  key_version: 3,
  algorithm: "aes-256-cbc-hkdf-sha256",
  salt: "a1b2c3d4",
  status: "retired",
  created_at: new Date("2026-08-01T00:00:00Z"),
  expires_at: new Date("2026-08-08T00:00:00Z"),
  forced_rotation_due_at: new Date("2026-08-08T12:00:00Z"),
};

describe("listKeysPastForcedDue (REQ-KEY-3: forced 12h re-encryption)", () => {
  it("returns keys whose forced_rotation_due_at is at or before now", async () => {
    const { db, calls } = fakeDb([
      {
        match: (sql) => sql.includes("FROM key_versions"),
        rows: [KEY_ROW],
      },
    ]);
    const now = new Date("2026-08-09T00:00:00Z");
    const keys = await listKeysPastForcedDue(db, now);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.keyVersion).toBe(3);
    expect(calls[0]?.params[0]).toBe(now);
  });

  it("passes now as a parameterized value, never interpolated", async () => {
    const { calls } = fakeDb([
      { match: () => true, rows: [KEY_ROW] },
    ]);
    await listKeysPastForcedDue(
      {
        async query<T extends QueryResultRow>(text: string, values?: unknown[]) {
          calls.push({ sql: text, params: values ?? [] });
          return { rows: [] as T[], rowCount: 0 };
        },
      },
      new Date("2026-08-09T12:00:00Z")
    );
    expect(calls[0]?.sql).toContain("$1");
    expect(calls[0]?.sql).not.toContain("2026-08-09");
  });

  it("excludes compromised keys from the forced path", async () => {
    const { db } = fakeDb([{ match: () => true, rows: [KEY_ROW] }]);
    const keys = await listKeysPastForcedDue(db, new Date("2026-08-09T00:00:00Z"));
    expect(keys).toHaveLength(1);
  });
});

describe("countConsentRowsByKeyVersion (REQ-KEY-4 batch planning)", () => {
  it("returns the number of consent rows still under a key", async () => {
    const { db, calls } = fakeDb([
      { match: (sql) => sql.includes("FROM consent_records"), rows: [{ count: 347 }] },
    ]);
    const count = await countConsentRowsByKeyVersion(db, 2);
    expect(count).toBe(347);
    expect(calls[0]?.params[0]).toBe(2);
  });

  it("returns 0 when no rows remain under the key (migration complete)", async () => {
    const { db } = fakeDb([
      { match: () => true, rows: [{ count: 0 }] },
    ]);
    const count = await countConsentRowsByKeyVersion(db, 9);
    expect(count).toBe(0);
  });
});
