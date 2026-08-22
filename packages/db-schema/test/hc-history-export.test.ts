import { describe, expect, it } from "vitest";

import type { QueryResultRow } from "pg";

import {
  findActiveConsentWithPayload,
} from "../src/repositories/consent";
import {
  listHistoryForExport,
  saveHistoryEntry,
} from "../src/repositories/history";
import type { DbQueryable } from "../src/repositories/db";

/**
 * HC history-at-rest + export read model (task 4.9, REQ-CONSENT-5): HC rows
 * carry an encrypted envelope (`{encrypted, integrity_hash}`) under a
 * `key_version` so the bot decrypts them for the user's export; anonymous rows
 * stay plaintext. `listHistoryForExport` returns a PII-safe read model ordered
 * by creation time, degrading to [] when the BuilderBot table is absent.
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

const ENVELOPE =
  "O3mFzD4rxQvJbK9pW2sN6tYhE7cUaG1iL5oM0qR8dS4vXwB2nP9kTm6uJcY3rAeF";

describe("history sink: encrypted HC mode (task 4.9, REQ-CONSENT-5)", () => {
  it("writes an encrypted envelope + key_version for an HC row, never the plaintext text", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [{ exists: true }] },
      { rows: [], rowCount: 1 },
    ]);

    await saveHistoryEntry(db, {
      sessionId: "sess-hc",
      sender: "bot",
      text: ENVELOPE,
      persistenceClass: "hc",
      keyVersion: 2,
      integrityHash: "a".repeat(64),
    });

    expect(sqlTexts[1]).toMatch(/INSERT INTO history/);
    expect(sqlTexts[1]).toContain("key_version");
    const [sessionId, sender, message, persistenceClass, keyVersion] =
      paramLists[1] ?? [];
    expect(sessionId).toBe("sess-hc");
    expect(sender).toBe("bot");
    expect(message).toBe(
      JSON.stringify({ encrypted: ENVELOPE, integrity_hash: "a".repeat(64) })
    );
    expect(persistenceClass).toBe("hc");
    expect(keyVersion).toBe(2);
    // No plaintext chat content may leak into the row or its params.
    expect(JSON.stringify(paramLists[1])).not.toContain("hola");
  });

  it("keeps the plaintext {text} shape when no key_version is set (anonymous/legacy)", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [{ exists: true }] },
      { rows: [], rowCount: 1 },
    ]);

    await saveHistoryEntry(db, {
      sessionId: "sess-anon",
      sender: "user",
      text: "hola",
      persistenceClass: "anonymous",
    });

    expect(sqlTexts[1]).not.toContain("key_version");
    expect(paramLists[1]?.[2]).toBe('{"text":"hola"}');
  });
});

describe("listHistoryForExport (task 4.9 export read model)", () => {
  it("returns mapped rows in creation order, keeping PII out of the row shape", async () => {
    const { db, paramLists } = fakeDb([
      { rows: [{ exists: true }] },
      {
        rows: [
          {
            id: "h1",
            sender: "user",
            message: { text: "no me siento bien" },
            key_version: null,
            created_at: new Date("2026-08-09T12:00:01Z"),
          },
          {
            id: "h2",
            sender: "bot",
            message: { encrypted: ENVELOPE, integrity_hash: "b".repeat(64) },
            key_version: 2,
            created_at: new Date("2026-08-09T12:00:02Z"),
          },
        ],
      },
    ]);

    const rows = await listHistoryForExport(db, "sess-hc");

    expect(paramLists[1]).toEqual(["sess-hc"]);
    expect(rows).toEqual([
      {
        id: "h1",
        sender: "user",
        createdAt: "2026-08-09T12:00:01.000Z",
        keyVersion: null,
        message: { text: "no me siento bien" },
      },
      {
        id: "h2",
        sender: "bot",
        createdAt: "2026-08-09T12:00:02.000Z",
        keyVersion: 2,
        message: { encrypted: ENVELOPE, integrity_hash: "b".repeat(64) },
      },
    ]);
  });

  it("degrades to [] when the BuilderBot history table does not exist", async () => {
    const { db, sqlTexts } = fakeDb([{ rows: [{ exists: false }] }]);

    const rows = await listHistoryForExport(db, "sess-hc");

    expect(rows).toEqual([]);
    expect(sqlTexts).toHaveLength(1);
  });
});

describe("findActiveConsentWithPayload (task 4.9 export source)", () => {
  it("returns the active consent together with its encrypted payload", async () => {
    const { db, paramLists } = fakeDb([
      {
        rows: [
          {
            id: "consent-uuid-1",
            session_id: "sess-hc",
            jurisdiction: "MX",
            terms_version: 1,
            key_version: 2,
            integrity_hash: "a".repeat(64),
            active: true,
            created_at: new Date("2026-08-09T00:00:00Z"),
            encrypted_payload: Buffer.from("cipher", "utf8"),
          },
        ],
      },
    ]);

    const consent = await findActiveConsentWithPayload(db, "sess-hc");

    expect(paramLists[0]).toEqual(["sess-hc"]);
    expect(consent).toEqual({
      id: "consent-uuid-1",
      sessionId: "sess-hc",
      jurisdiction: "MX",
      termsVersion: 1,
      keyVersion: 2,
      integrityHash: "a".repeat(64),
      active: true,
      createdAt: "2026-08-09T00:00:00.000Z",
      encryptedPayload: Buffer.from("cipher", "utf8"),
    });
  });

  it("returns undefined when the session has no active consent", async () => {
    const { db } = fakeDb([{ rows: [] }]);

    expect(await findActiveConsentWithPayload(db, "sess-hc")).toBeUndefined();
  });
});
