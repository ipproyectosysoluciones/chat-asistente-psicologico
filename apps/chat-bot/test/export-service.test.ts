import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { EnvKeyProvider } from "@chatcap/config";
import {
  AesCbcEncryptor,
  encodePayload,
  serializePayload,
  StaticKeyMaterialProvider,
  type Encryptor,
} from "@chatcap/crypto-keys";
import type { DbQueryable, NewAuditEntry } from "@chatcap/db-schema";

import {
  ExportAccessError,
  ExportConsentMissingError,
  ExportService,
} from "../src/consent/export-service";

/**
 * HC export (task 4.9, REQ-CONSENT-5, REQ-DASH-8): decrypts the consent
 * envelope and the session's history for an hc session and hands back a
 * plaintext clinical-history snapshot — audit-logged with zero PII in the
 * audit row. Denied for anonymous sessions and for sessions without an active
 * consent. Same queryable-fake pattern as consent-service.test.ts.
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

function hcSessionRow() {
  return {
    id: "sess-hc",
    contact_key_anon: "anon-hc",
    jurisdiction: "MX",
    persistence_class: "hc",
    consent_state: "accepted",
    ai_state: "auto",
    created_at: new Date("2026-01-01T00:00:00Z"),
    last_activity_at: new Date("2026-08-09T12:00:00Z"),
    purge_at: null,
  };
}

function anonSessionRow() {
  return {
    ...hcSessionRow(),
    id: "sess-anon",
    persistence_class: "anonymous",
    purge_at: new Date("2026-01-02T00:00:00Z"),
  };
}

function consentRow(encryptedPayload: Buffer) {
  return {
    id: "consent-uuid-1",
    session_id: "sess-hc",
    jurisdiction: "MX",
    terms_version: 1,
    key_version: 2,
    integrity_hash: "a".repeat(64),
    active: true,
    created_at: new Date("2026-08-09T00:00:00Z"),
    encrypted_payload: encryptedPayload,
  };
}

interface AuditCapture {
  entry?: NewAuditEntry;
}

function auditCapture(): { audit: (entry: NewAuditEntry) => Promise<void>; capture: AuditCapture } {
  const capture: AuditCapture = {};
  return {
    audit: async (entry) => {
      capture.entry = entry;
    },
    capture,
  };
}

function makeService(
  db: DbQueryable,
  encryptor: Encryptor,
  audit: (entry: NewAuditEntry) => Promise<void>
): ExportService {
  return new ExportService({ db, encryptor, audit });
}

describe("ExportService (task 4.9 HC export)", () => {
  it("exports the decrypted clinical history for an hc session, audit-logged without PII", async () => {
    const encryptor = makeEncryptor();
    const consentEnvelope = await encryptor.encrypt(
      Buffer.from(
        JSON.stringify({
          entityType: "consent",
          sessionId: "sess-hc",
          contactKeyAnon: "anon-hc",
          jurisdiction: "MX",
          termsVersion: 1,
          acceptedAt: "2026-08-09T00:00:00.000Z",
        }),
        "utf8"
      ),
      2
    );
    const botEnvelope = await encryptor.encrypt(
      Buffer.from(JSON.stringify({ text: "me siento mejor" }), "utf8"),
      2
    );
    const { db } = fakeDb([
      { rows: [hcSessionRow()] }, // getSession
      { rows: [consentRow(encodePayload(consentEnvelope))] }, // findActiveConsentWithPayload
      { rows: [{ exists: true }] }, // listHistoryForExport: history exists
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
            message: {
              encrypted: serializePayload(botEnvelope),
              integrity_hash: botEnvelope.hmac.toString("hex"),
            },
            key_version: 2,
            created_at: new Date("2026-08-09T12:00:02Z"),
          },
        ],
      },
    ]);
    const { audit, capture } = auditCapture();
    const service = makeService(db, encryptor, audit);

    const export_ = await service.exportClinicalHistory({
      sessionId: "sess-hc",
      actorType: "patient",
      actorId: "anon-hc",
      reason: "user_requested_export",
    });

    expect(export_.consentId).toBe("consent-uuid-1");
    expect(export_.sessionId).toBe("sess-hc");
    expect(export_.jurisdiction).toBe("MX");
    expect(export_.termsVersion).toBe(1);
    expect(export_.keyVersion).toBe(2);
    expect(export_.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(export_.history).toEqual([
      { sender: "user", createdAt: "2026-08-09T12:00:01.000Z", text: "no me siento bien" },
      { sender: "bot", createdAt: "2026-08-09T12:00:02.000Z", text: "me siento mejor" },
    ]);

    // Audit row: who/when/why, resource = consent, zero message content.
    expect(capture.entry).toMatchObject({
      actorType: "patient",
      actorId: "anon-hc",
      action: "hc_history_export",
      resourceType: "consent",
      resourceId: "consent-uuid-1",
      reason: "user_requested_export",
      meta: {
        entryCount: 2,
        exportedAt: export_.exportedAt,
      },
    });
    expect(JSON.stringify(capture.entry)).not.toContain("me siento");
    expect(JSON.stringify(capture.entry)).not.toContain("no me siento");
  });

  it("refuses the export for an anonymous session", async () => {
    const encryptor = makeEncryptor();
    const { db } = fakeDb([{ rows: [anonSessionRow()] }]);
    const { audit } = auditCapture();
    const service = makeService(db, encryptor, audit);

    await expect(
      service.exportClinicalHistory({ sessionId: "sess-anon", actorType: "patient" })
    ).rejects.toBeInstanceOf(ExportAccessError);
  });

  it("refuses the export when the session does not exist", async () => {
    const encryptor = makeEncryptor();
    const { db } = fakeDb([{ rows: [] }]);
    const { audit } = auditCapture();
    const service = makeService(db, encryptor, audit);

    await expect(
      service.exportClinicalHistory({ sessionId: "missing", actorType: "patient" })
    ).rejects.toBeInstanceOf(ExportAccessError);
  });

  it("refuses the export when the session has no active consent", async () => {
    const encryptor = makeEncryptor();
    const { db } = fakeDb([{ rows: [hcSessionRow()] }, { rows: [] }]);
    const { audit } = auditCapture();
    const service = makeService(db, encryptor, audit);

    await expect(
      service.exportClinicalHistory({
        sessionId: "sess-hc",
        actorType: "patient",
        actorId: "anon-hc",
      })
    ).rejects.toBeInstanceOf(ExportConsentMissingError);
  });

  it("refuses an export when a patient requests another session's history (RBAC)", async () => {
    const encryptor = makeEncryptor();
    const { db } = fakeDb([{ rows: [hcSessionRow()] }]);
    const { audit } = auditCapture();
    const service = makeService(db, encryptor, audit);

    await expect(
      service.exportClinicalHistory({
        sessionId: "sess-hc",
        actorType: "patient",
        actorId: "anon-other",
      })
    ).rejects.toBeInstanceOf(ExportAccessError);
  });

  it("refuses an export when the actor is neither owner nor supervisor/admin", async () => {
    const encryptor = makeEncryptor();
    const { db } = fakeDb([{ rows: [hcSessionRow()] }]);
    const { audit } = auditCapture();
    const service = makeService(db, encryptor, audit);

    await expect(
      service.exportClinicalHistory({ sessionId: "sess-hc", actorType: "anonymous" })
    ).rejects.toBeInstanceOf(ExportAccessError);
  });

  it("refuses a supervisor export without a documented reason", async () => {
    const encryptor = makeEncryptor();
    const { db } = fakeDb([{ rows: [hcSessionRow()] }]);
    const { audit } = auditCapture();
    const service = makeService(db, encryptor, audit);

    await expect(
      service.exportClinicalHistory({
        sessionId: "sess-hc",
        actorType: "supervisor",
        actorId: "sup-1",
      })
    ).rejects.toBeInstanceOf(ExportAccessError);
  });

  it("allows a supervisor export with a documented reason, audit-logged", async () => {
    const encryptor = makeEncryptor();
    const consentEnvelope = await encryptor.encrypt(
      Buffer.from(
        JSON.stringify({
          entityType: "consent",
          sessionId: "sess-hc",
          contactKeyAnon: "anon-hc",
          jurisdiction: "MX",
          termsVersion: 1,
          acceptedAt: "2026-08-09T00:00:00.000Z",
        }),
        "utf8"
      ),
      2
    );
    const { db } = fakeDb([
      { rows: [hcSessionRow()] }, // getSession
      { rows: [consentRow(encodePayload(consentEnvelope))] }, // findActiveConsentWithPayload
      { rows: [{ exists: true }] }, // listHistoryForExport: history exists
      { rows: [] }, // no history rows
    ]);
    const { audit, capture } = auditCapture();
    const service = makeService(db, encryptor, audit);

    const export_ = await service.exportClinicalHistory({
      sessionId: "sess-hc",
      actorType: "supervisor",
      actorId: "sup-1",
      reason: "court_order_2026-08",
    });

    expect(export_.history).toEqual([]);
    expect(capture.entry).toMatchObject({
      actorType: "supervisor",
      actorId: "sup-1",
      action: "hc_history_export",
      reason: "court_order_2026-08",
      meta: { entryCount: 0, exportedAt: export_.exportedAt },
    });
  });
});
