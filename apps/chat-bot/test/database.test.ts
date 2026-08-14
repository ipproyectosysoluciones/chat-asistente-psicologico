import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { EnvKeyProvider } from "@chatcap/config";
import {
  AesCbcEncryptor,
  parsePayload,
  StaticKeyMaterialProvider,
  type Encryptor,
} from "@chatcap/crypto-keys";
import type { Session } from "@chatcap/shared-types";

import { MemoryChatDatabase } from "../src/database/memory";
import { PostgresChatDatabase } from "../src/database/postgres";
import type { DbQueryable } from "@chatcap/db-schema";

/**
 * Database pillar (task 4.1, REQ-CHATBOT-1): the orchestrator depends on the
 * `ChatDatabase` interface, never on pg. Memory is the deterministic test
 * double; Postgres adapts the shared db-schema repositories (upsertSession,
 * setSessionJurisdiction), which are themselves covered by unit tests against
 * a fake queryable.
 */

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

function makeEncryptor(): Encryptor {
  return new AesCbcEncryptor(
    new EnvKeyProvider("x".repeat(40)),
    new StaticKeyMaterialProvider(new Map([[2, Buffer.from("a1b2c3", "hex")]]))
  );
}

function sessionRow(overrides: Partial<Record<string, unknown>> = {}): QueryResultRow {
  return {
    id: "session-1",
    contact_key_anon: "anon-1",
    jurisdiction: null,
    persistence_class: "anonymous",
    consent_state: "notice_shown",
    ai_state: "auto",
    created_at: new Date("2026-01-01T00:00:00Z"),
    last_activity_at: new Date("2026-01-01T00:00:00Z"),
    purge_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

describe("MemoryChatDatabase (task 4.1 test double)", () => {
  it("creates an anonymous session with 24h purge window on first contact", async () => {
    const db = new MemoryChatDatabase();
    const session = await db.findOrCreateSession("anon-1");
    expect(session.contactKeyAnon).toBe("anon-1");
    expect(session.persistenceClass).toBe("anonymous");
    expect(session.consentState).toBe("notice_shown");
    expect(session.purgeAt).toBeDefined();
    const purgeMs = Date.parse(session.purgeAt as string);
    const createdMs = Date.parse(session.createdAt);
    expect(purgeMs - createdMs).toBe(24 * 60 * 60 * 1000);
  });

  it("is idempotent: same contact key returns the same session id", async () => {
    const db = new MemoryChatDatabase();
    const first = await db.findOrCreateSession("anon-1");
    const second = await db.findOrCreateSession("anon-1");
    expect(second.id).toBe(first.id);
    expect(db.sessionCount).toBe(1);
  });

  it("stores the jurisdiction on the session row", async () => {
    const db = new MemoryChatDatabase();
    const session = await db.findOrCreateSession("anon-1");
    const updated = await db.setSessionJurisdiction(session.id, "EU-GDPR");
    expect(updated.jurisdiction).toBe("EU-GDPR");
    expect((await db.findOrCreateSession("anon-1")).jurisdiction).toBe("EU-GDPR");
  });

  it("throws on jurisdiction update for an unknown session", async () => {
    const db = new MemoryChatDatabase();
    await expect(
      db.setSessionJurisdiction("missing", "EU-GDPR")
    ).rejects.toThrow("session not found");
  });

  it("ping is a no-op that can be observed", async () => {
    const db = new MemoryChatDatabase();
    await db.ping();
    expect(db.pingCountValue).toBe(1);
  });
});

describe("PostgresChatDatabase (task 4.1 adapter over db-schema)", () => {
  it("delegates find-or-create to upsertSession with the contact key", async () => {
    const { db, sqlTexts } = fakeDb([
      { rows: [] },
      { rows: [sessionRow()] },
    ]);
    const chatDb = new PostgresChatDatabase(db);
    const session: Session = await chatDb.findOrCreateSession("anon-1");
    expect(session.id).toBe("session-1");
    expect(sqlTexts.join(" ").toLowerCase()).toContain("from sessions");
    expect(sqlTexts.join(" ").toLowerCase()).toContain("contact_key_anon");
  });

  it("delegates jurisdiction persistence to setSessionJurisdiction", async () => {
    const { db, sqlTexts } = fakeDb([{ rows: [sessionRow({ jurisdiction: "EU-GDPR" })] }]);
    const chatDb = new PostgresChatDatabase(db);
    const session = await chatDb.setSessionJurisdiction("session-1", "EU-GDPR");
    expect(session.jurisdiction).toBe("EU-GDPR");
    expect(sqlTexts.join(" ")).toContain("SET jurisdiction = $2");
  });

  it("ping runs a liveness query", async () => {
    const { db, sqlTexts } = fakeDb([{ rows: [], rowCount: 1 }]);
    const chatDb = new PostgresChatDatabase(db);
    await chatDb.ping();
    expect(sqlTexts[0]).toBe("SELECT 1");
  });
});

describe("PostgresChatDatabase HC history at rest (task 4.9, REQ-CONSENT-5)", () => {
  it("encrypts HC history under the active key version, never the plaintext text", async () => {
    const encryptor = makeEncryptor();
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [{ exists: true }] }, // history exists
      { rows: [], rowCount: 1 }, // insert
    ]);
    const chatDb = new PostgresChatDatabase(db, {
      historyEncryptor: encryptor,
      activeKeyVersion: async () => 2,
    });

    await chatDb.saveHistoryEntry({
      sessionId: "sess-hc",
      sender: "user",
      text: "no me siento bien",
      persistenceClass: "hc",
    });

    const insertIndex = sqlTexts.findIndex((sql) =>
      sql.includes("INSERT INTO history")
    );
    expect(sqlTexts[insertIndex]).toContain("key_version");
    const [sessionId, sender, message, persistenceClass, keyVersion] =
      paramLists[insertIndex] ?? [];
    expect(sessionId).toBe("sess-hc");
    expect(sender).toBe("user");
    expect(persistenceClass).toBe("hc");
    expect(keyVersion).toBe(2);
    const parsed = JSON.parse(message as string) as {
      encrypted: string;
      integrity_hash: string;
    };
    expect(typeof parsed.encrypted).toBe("string");
    expect(parsed.encrypted).not.toContain("no me siento bien");
    expect(parsed.integrity_hash).toMatch(/^[0-9a-f]{64}$/);
    // The row envelope decrypts back to the original turn (REQ-CONSENT-3).
    const decrypted = await encryptor.decrypt(parsePayload(2, parsed.encrypted));
    expect(JSON.parse(decrypted.toString("utf8"))).toEqual({
      text: "no me siento bien",
    });
  });

  it("keeps anonymous history plaintext even with an encryptor configured", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [{ exists: true }] },
      { rows: [], rowCount: 1 },
    ]);
    const chatDb = new PostgresChatDatabase(db, {
      historyEncryptor: makeEncryptor(),
      activeKeyVersion: async () => 2,
    });

    await chatDb.saveHistoryEntry({
      sessionId: "sess-anon",
      sender: "bot",
      text: "respuesta",
      persistenceClass: "anonymous",
    });

    const insertIndex = sqlTexts.findIndex((sql) =>
      sql.includes("INSERT INTO history")
    );
    expect(sqlTexts[insertIndex]).not.toContain("key_version");
    expect(paramLists[insertIndex]?.[2]).toBe('{"text":"respuesta"}');
  });

  it("degrades to plaintext when HC but no active key version (best-effort sink)", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [{ exists: true }] },
      { rows: [], rowCount: 1 },
    ]);
    const chatDb = new PostgresChatDatabase(db, {
      historyEncryptor: makeEncryptor(),
      activeKeyVersion: async () => undefined,
    });

    await chatDb.saveHistoryEntry({
      sessionId: "sess-hc",
      sender: "user",
      text: "mensaje",
      persistenceClass: "hc",
    });

    const insertIndex = sqlTexts.findIndex((sql) =>
      sql.includes("INSERT INTO history")
    );
    expect(sqlTexts[insertIndex]).not.toContain("key_version");
    expect(paramLists[insertIndex]?.[2]).toBe('{"text":"mensaje"}');
  });

  it("warns (PII-free) when an HC turn degrades to plaintext (no silent HC at rest)", async () => {
    const warns: Array<{ msg: string; meta: Record<string, unknown> }> = [];
    const logger = {
      warn: (msg: string, meta: Record<string, unknown>) => {
        warns.push({ msg, meta });
      },
    };
    const { db, sqlTexts } = fakeDb([
      { rows: [{ exists: true }] },
      { rows: [], rowCount: 1 },
    ]);
    const chatDb = new PostgresChatDatabase(db, {
      historyEncryptor: makeEncryptor(),
      activeKeyVersion: async () => undefined,
      logger,
    });

    await chatDb.saveHistoryEntry({
      sessionId: "sess-hc",
      sender: "user",
      text: "detalle clinico",
      persistenceClass: "hc",
    });

    expect(sqlTexts.some((sql) => sql.includes("INSERT INTO history"))).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toContain("hc");
    expect(warns[0]?.meta.sessionId).toBe("sess-hc");
    // The warning must never carry message content.
    expect(JSON.stringify(warns)).not.toContain("detalle clinico");
  });
});
