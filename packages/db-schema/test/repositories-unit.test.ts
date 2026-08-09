import { describe, expect, it } from "vitest";

import type { QueryResultRow } from "pg";

import { purgeAnonymousSessions } from "../src/repositories/purge";
import { createNextKeyVersion, currentActiveKeyVersion } from "../src/repositories/key-versions";
import {
  acknowledgeAlert,
  findOpenAlertByDedupeKey,
  resolveAlert,
} from "../src/repositories/alerts";
import type { DbQueryable } from "../src/repositories/db";

/** Fake queryable: returns queued results per query, records SQL + params. */
function fakeDb(
  responses: Array<{ rows?: QueryResultRow[]; rowCount?: number | null }>
): { db: DbQueryable; sqlTexts: string[]; paramLists: unknown[][] } {
  const sqlTexts: string[] = [];
  const paramLists: unknown[][] = [];
  let cursor = 0;
  const db: DbQueryable = {
    async query<T extends QueryResultRow>(text: string, values?: unknown[]) {
      sqlTexts.push(text);
      paramLists.push(values ?? []);
      const response = responses[Math.min(cursor, responses.length - 1)];
      cursor += 1;
      return {
        rows: (response?.rows ?? []) as T[],
        rowCount: response?.rowCount ?? null,
      };
    },
  };
  return { db, sqlTexts, paramLists };
}

describe("purge job (REQ-CONSENT-5: batched anonymous cleanup 100–500)", () => {
  it("deletes in batches until fewer than batchSize remain", async () => {
    // Query order in purgeAnonymousSessions: history check, then sessions
    // batches, then history batches.
    const { db, sqlTexts } = fakeDb([
      { rows: [{ exists: true }] }, // history exists
      { rows: [], rowCount: 500 },
      { rows: [], rowCount: 500 },
      { rows: [], rowCount: 200 }, // < 500 → sessions done
      { rows: [], rowCount: 3 }, // < 500 → history done
    ]);
    const result = await purgeAnonymousSessions(db, { batchSize: 500 });
    expect(result).toEqual({ purgedSessions: 1200, purgedHistory: 3, batches: 4 });
    expect(sqlTexts.filter((sql) => sql.includes("DELETE"))).toHaveLength(4);
  });

  it("clamps batchSize to the 100–500 contract bounds", async () => {
    const low = fakeDb([
      { rows: [{ exists: false }] },
      { rows: [], rowCount: 0 },
    ]);
    await purgeAnonymousSessions(low.db, { batchSize: 10 });
    const deleteIdx = low.sqlTexts.findIndex((sql) => sql.includes("DELETE FROM sessions"));
    expect(low.paramLists[deleteIdx]?.[0]).toBe(100);

    const high = fakeDb([
      { rows: [{ exists: false }] },
      { rows: [], rowCount: 0 },
    ]);
    await purgeAnonymousSessions(high.db, { batchSize: 9999 });
    const highIdx = high.sqlTexts.findIndex((sql) => sql.includes("DELETE FROM sessions"));
    expect(high.paramLists[highIdx]?.[0]).toBe(500);
  });

  it("targets only anonymous rows past purge_at with LIMIT $1", async () => {
    const { db, sqlTexts } = fakeDb([
      { rows: [{ exists: false }] },
      { rows: [], rowCount: 0 },
    ]);
    await purgeAnonymousSessions(db, { batchSize: 100 });
    const deleteSql = sqlTexts.find((sql) => sql.includes("DELETE FROM sessions"));
    expect(deleteSql).toMatch(/persistence_class = 'anonymous'/);
    expect(deleteSql).toMatch(/purge_at <= now\(\)/);
    expect(deleteSql).toMatch(/LIMIT \$1/);
  });

  it("skips history when the BuilderBot table does not exist", async () => {
    const { db, sqlTexts } = fakeDb([
      { rows: [{ exists: false }] }, // history absent
      { rows: [], rowCount: 0 },
    ]);
    await purgeAnonymousSessions(db, { batchSize: 100 });
    const historyDelete = sqlTexts.find((sql) => sql.includes("DELETE FROM history"));
    expect(historyDelete).toBeUndefined();
  });
});

describe("key versions repo (REQ-KEY-1)", () => {
  const insertRow = (keyVersion: number) => ({
    key_version: keyVersion,
    algorithm: "aes-256-cbc-hkdf-sha256",
    salt: "salt-abc",
    status: "active",
    created_at: new Date("2026-08-09T00:00:00Z"),
    expires_at: new Date("2026-08-16T00:00:00Z"),
    forced_rotation_due_at: new Date("2026-08-09T12:00:00Z"),
  });

  it("derives the next version as max+1", async () => {
    const { db } = fakeDb([
      { rows: [{ max: 7 }], rowCount: 1 },
      { rows: [insertRow(8)], rowCount: 1 },
    ]);
    const version = await createNextKeyVersion(db, {
      salt: "salt-abc",
      expiresAt: new Date("2026-08-16T00:00:00Z"),
    });
    expect(version.keyVersion).toBe(8);
  });

  it("starts at version 1 on an empty table", async () => {
    const { db } = fakeDb([
      { rows: [{ max: null }], rowCount: 0 },
      { rows: [insertRow(1)], rowCount: 1 },
    ]);
    const version = await createNextKeyVersion(db, {
      salt: "salt-abc",
      expiresAt: new Date("2026-08-16T00:00:00Z"),
    });
    expect(version.keyVersion).toBe(1);
  });

  it("currentActive returns the newest active version", async () => {
    const { db } = fakeDb([
      {
        rows: [
          {
            key_version: 2,
            algorithm: "aes-256-cbc-hkdf-sha256",
            salt: "salt-2",
            status: "active",
            created_at: new Date("2026-08-09T00:00:00Z"),
            expires_at: new Date("2026-08-16T00:00:00Z"),
            forced_rotation_due_at: new Date("2026-08-09T12:00:00Z"),
          },
        ],
        rowCount: 1,
      },
    ]);
    const current = await currentActiveKeyVersion(db);
    expect(current?.keyVersion).toBe(2);
    expect(current?.salt).toBe("salt-2");
  });
});

describe("alerts repo (REQ-ALERT-5 dedupe)", () => {
  it("finds the open alert for a dedupe key", async () => {
    const { db } = fakeDb([
      {
        rows: [
          {
            id: "alert-1",
            level: "red",
            category: "suicide",
            session_id: "sess-1",
            status: "open",
            dedupe_key: "k1",
            acknowledged_by: null,
            created_at: new Date("2026-08-09T00:00:00Z"),
            resolved_at: null,
          },
        ],
        rowCount: 1,
      },
    ]);
    const alert = await findOpenAlertByDedupeKey(db, "k1");
    expect(alert?.id).toBe("alert-1");
    expect(alert?.level).toBe("red");
  });

  it("queries only open alerts", async () => {
    const { db, sqlTexts } = fakeDb([{ rows: [], rowCount: 0 }]);
    await findOpenAlertByDedupeKey(db, "k1");
    expect(sqlTexts[0]).toMatch(/status = 'open'/);
    expect(sqlTexts[0]).toMatch(/\$1/);
  });

  it("transitions acknowledge then resolve", async () => {
    const { db, sqlTexts } = fakeDb([{ rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }]);
    await acknowledgeAlert(db, "alert-1", "user-9");
    expect(sqlTexts[0]).toMatch(/acknowledged/);
    await resolveAlert(db, "alert-1");
    expect(sqlTexts[1]).toMatch(/resolved/);
  });
});
