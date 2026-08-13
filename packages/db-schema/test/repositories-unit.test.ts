import { describe, expect, it } from "vitest";

import type { QueryResultRow } from "pg";

import { purgeAnonymousSessions } from "../src/repositories/purge";
import { createNextKeyVersion, currentActiveKeyVersion, getKeyVersion } from "../src/repositories/key-versions";
import {
  listConsentRowsForReEncryption,
  updateConsentEncryption,
} from "../src/repositories/consent";
import {
  acknowledgeAlert,
  findAlertById,
  findOpenAlertByDedupeKey,
  resolveAlert,
  touchAlert,
} from "../src/repositories/alerts";
import { setSessionAiState, setSessionConsentState, setSessionJurisdiction } from "../src/repositories/sessions";
import { saveHistoryEntry } from "../src/repositories/history";
import type { DbQueryable } from "../src/repositories/db";
import { findUserRole } from "../src/repositories/users";

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
            updated_at: new Date("2026-08-09T00:00:00Z"),
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

  it("finds an alert by id regardless of status", async () => {
    const { db } = fakeDb([
      {
        rows: [
          {
            id: "alert-1",
            level: "orange",
            category: "self_harm",
            session_id: "sess-1",
            status: "acknowledged",
            dedupe_key: "k1",
            acknowledged_by: "user-9",
            created_at: new Date("2026-08-09T00:00:00Z"),
            updated_at: new Date("2026-08-09T00:00:00Z"),
            resolved_at: null,
          },
        ],
        rowCount: 1,
      },
    ]);
    const alert = await findAlertById(db, "alert-1");
    expect(alert?.id).toBe("alert-1");
    expect(alert?.status).toBe("acknowledged");
    expect(alert?.acknowledgedBy).toBe("user-9");
  });

  it("returns undefined for an unknown alert id", async () => {
    const { db } = fakeDb([{ rows: [], rowCount: 0 }]);
    expect(await findAlertById(db, "missing")).toBeUndefined();
  });

  it("queries alerts by id with a parameterized WHERE", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([{ rows: [], rowCount: 0 }]);
    await findAlertById(db, "alert-1");
    expect(sqlTexts[0]).toMatch(/WHERE id = \$1/);
    expect(paramLists[0]).toEqual(["alert-1"]);
  });

  it("bumps updated_at on touch without changing status", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([{ rows: [], rowCount: 1 }]);
    await touchAlert(db, "alert-1");
    expect(sqlTexts[0]).toMatch(/UPDATE alerts/);
    expect(sqlTexts[0]).toMatch(/updated_at = now\(\)/);
    expect(sqlTexts[0]).toMatch(/WHERE id = \$1/);
    expect(paramLists[0]).toEqual(["alert-1"]);
  });
});

describe("key-versions: getKeyVersion (dual-read lookup, REQ-KEY-8)", () => {
  it("returns the key metadata for a specific version", async () => {
    const { db } = fakeDb([
      {
        rows: [
          {
            key_version: 3,
            algorithm: "aes-256-cbc-hkdf-sha256",
            salt: "salt-3",
            status: "retired",
            created_at: new Date("2026-08-02T00:00:00Z"),
            expires_at: new Date("2026-08-09T00:00:00Z"),
            forced_rotation_due_at: new Date("2026-08-09T12:00:00Z"),
          },
        ],
        rowCount: 1,
      },
    ]);
    const key = await getKeyVersion(db, 3);
    expect(key?.keyVersion).toBe(3);
    expect(key?.salt).toBe("salt-3");
    expect(key?.status).toBe("retired");
  });

  it("filters by key_version with a parameterized query", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([{ rows: [], rowCount: 0 }]);
    await getKeyVersion(db, 7);
    expect(sqlTexts[0]).toMatch(/WHERE key_version = \$1/);
    expect(paramLists[0]).toEqual([7]);
  });

  it("returns undefined when the version does not exist", async () => {
    const { db } = fakeDb([{ rows: [], rowCount: 0 }]);
    expect(await getKeyVersion(db, 99)).toBeUndefined();
  });
});

describe("consent: re-encryption row source (REQ-KEY-4)", () => {
  it("lists consent rows still on the old key with a bounded limit", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      {
        rows: [
          {
            id: "consent-1",
            key_version: 2,
            encrypted_payload: Buffer.from("payload-1"),
          },
          {
            id: "consent-2",
            key_version: 2,
            encrypted_payload: Buffer.from("payload-2"),
          },
        ],
        rowCount: 2,
      },
    ]);
    const rows = await listConsentRowsForReEncryption(db, 2, 200);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.rowId).toBe("consent-1");
    expect(rows[1]?.encryptedPayload?.toString()).toBe("payload-2");
    expect(sqlTexts[0]).toMatch(/key_version = \$1/);
    expect(sqlTexts[0]).toMatch(/LIMIT \$2/);
    expect(paramLists[0]).toEqual([2, 200]);
  });

  it("updates a consent row's key_version, payload and integrity hash", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([{ rows: [], rowCount: 1 }]);
    await updateConsentEncryption(
      db,
      "consent-1",
      3,
      Buffer.from("new-payload"),
      "hash-abc"
    );
    expect(sqlTexts[0]).toMatch(/UPDATE consent_records/);
    expect(sqlTexts[0]).toMatch(/key_version = \$2/);
    expect(sqlTexts[0]).toMatch(/encrypted_payload = \$3/);
    expect(sqlTexts[0]).toMatch(/integrity_hash = \$4/);
    expect(sqlTexts[0]).toMatch(/WHERE id = \$1/);
    expect(paramLists[0]).toEqual(["consent-1", 3, Buffer.from("new-payload"), "hash-abc"]);
  });
});

describe("users repo (REQ-DASH-1 RBAC preflight for alert lifecycle)", () => {
  it("findUserRole returns the role of a known user", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([{ rows: [{ role: "supervisor" }] }]);
    const role = await findUserRole(db, "00000000-0000-7000-8000-0000000000aa");
    expect(role).toBe("supervisor");
    expect(sqlTexts[0]).toMatch(/SELECT role FROM users/);
    expect(sqlTexts[0]).toMatch(/WHERE id = \$1/);
    expect(paramLists[0]).toEqual(["00000000-0000-7000-8000-0000000000aa"]);
  });

  it("returns undefined for an unknown user (never throws)", async () => {
    const { db } = fakeDb([{ rows: [] }]);
    await expect(findUserRole(db, "nope")).resolves.toBeUndefined();
  });
});

describe("sessions repo: setSessionJurisdiction (REQ-CHATBOT-3)", () => {
  const sessionRow = (overrides: Record<string, unknown> = {}) => ({
    id: "sess-1",
    contact_key_anon: "anon-hash-abc",
    jurisdiction: "CO",
    persistence_class: "anonymous",
    consent_state: "notice_shown",
    ai_state: "auto",
    created_at: new Date("2026-01-01T00:00:00Z"),
    last_activity_at: new Date("2026-01-01T00:00:00Z"),
    purge_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  });

  it("updates jurisdiction and returns the session", async () => {
    const { db } = fakeDb([{ rows: [sessionRow()], rowCount: 1 }]);
    const session = await setSessionJurisdiction(db, "sess-1", "CO");
    expect(session.id).toBe("sess-1");
    expect(session.jurisdiction).toBe("CO");
  });

  it("issues a parameterized UPDATE keyed by session id", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [sessionRow({ jurisdiction: "MX" })], rowCount: 1 },
    ]);
    await setSessionJurisdiction(db, "sess-1", "MX");
    expect(sqlTexts[0]).toMatch(/UPDATE sessions/);
    expect(sqlTexts[0]).toMatch(/jurisdiction = \$2/);
    expect(sqlTexts[0]).toMatch(/WHERE id = \$1/);
    expect(paramLists[0]).toEqual(["sess-1", "MX"]);
  });

  it("throws when the session id does not exist", async () => {
    const { db } = fakeDb([{ rows: [], rowCount: 0 }]);
    await expect(setSessionJurisdiction(db, "missing", "CO")).rejects.toThrow(
      "sessions"
    );
  });
});

describe("sessions repo: consent_state (REQ-CONSENT-2)", () => {
  const sessionRow = (overrides: Record<string, unknown> = {}) => ({
    id: "sess-1",
    contact_key_anon: "anon-1",
    jurisdiction: "CO",
    persistence_class: "anonymous",
    consent_state: "accepted",
    ai_state: "auto",
    created_at: new Date("2026-01-01T00:00:00Z"),
    last_activity_at: new Date("2026-01-01T00:00:00Z"),
    purge_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  });

  it("marks the session consent_state as accepted", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [sessionRow()], rowCount: 1 },
    ]);
    const session = await setSessionConsentState(db, "sess-1", "accepted");
    expect(session.consentState).toBe("accepted");
    expect(sqlTexts[0]).toMatch(/UPDATE sessions/);
    expect(sqlTexts[0]).toMatch(/consent_state = \$2/);
    expect(sqlTexts[0]).toMatch(/WHERE id = \$1/);
    expect(paramLists[0]).toEqual(["sess-1", "accepted"]);
  });

  it("throws when the session id does not exist", async () => {
    const { db } = fakeDb([{ rows: [], rowCount: 0 }]);
    await expect(setSessionConsentState(db, "missing", "accepted")).rejects.toThrow(
      "sessions"
    );
  });
});

describe("sessions repo: ai_state takeover (REQ-ALERT-4, REQ-DASH-3)", () => {
  const sessionRow = (overrides: Record<string, unknown> = {}) => ({
    id: "sess-1",
    contact_key_anon: "anon-1",
    jurisdiction: "CO",
    persistence_class: "anonymous",
    consent_state: "accepted",
    ai_state: "takeover",
    created_at: new Date("2026-01-01T00:00:00Z"),
    last_activity_at: new Date("2026-01-01T00:00:00Z"),
    purge_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  });

  it("forces the session to takeover and returns the session", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [sessionRow()], rowCount: 1 },
    ]);
    const session = await setSessionAiState(db, "sess-1", "takeover");
    expect(session.aiState).toBe("takeover");
    expect(sqlTexts[0]).toMatch(/UPDATE sessions/);
    expect(sqlTexts[0]).toMatch(/ai_state = \$2/);
    expect(sqlTexts[0]).toMatch(/WHERE id = \$1/);
    expect(paramLists[0]).toEqual(["sess-1", "takeover"]);
  });

  it("throws when the session id does not exist", async () => {
    const { db } = fakeDb([{ rows: [], rowCount: 0 }]);
    await expect(setSessionAiState(db, "missing", "takeover")).rejects.toThrow(
      "sessions"
    );
  });
});

describe("history sink (task 4.6, REQ-CHATBOT-2)", () => {
  it("is a no-op when the BuilderBot history table does not exist (degraded sink)", async () => {
    const { db, sqlTexts } = fakeDb([{ rows: [{ exists: false }] }]);
    await saveHistoryEntry(db, {
      sessionId: "sess-1",
      sender: "user",
      text: "mensaje",
      persistenceClass: "anonymous",
    });
    expect(sqlTexts).toHaveLength(1);
    expect(sqlTexts[0]).toContain("to_regclass");
  });

  it("inserts a parameterized row with a jsonb message and persistence metadata", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [{ exists: true }] },
      { rows: [], rowCount: 1 },
    ]);
    await saveHistoryEntry(db, {
      sessionId: "sess-1",
      sender: "bot",
      text: "respuesta",
      persistenceClass: "hc",
    });
    expect(sqlTexts[1]).toMatch(/INSERT INTO history/);
    expect(sqlTexts[1]).toMatch(/message/);
    expect(sqlTexts[1]).toMatch(/persistence_class/);
    expect(sqlTexts[1]).toMatch(/purge_at/);
    expect(sqlTexts[1]).not.toContain("'" + "respuesta" + "'");
    const [sessionId, sender, message, persistenceClass] = paramLists[1] ?? [];
    expect(sessionId).toBe("sess-1");
    expect(sender).toBe("bot");
    expect(message).toBe('{"text":"respuesta"}');
    expect(persistenceClass).toBe("hc");
  });
});
