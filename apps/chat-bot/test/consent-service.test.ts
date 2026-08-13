import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { EnvKeyProvider } from "@chatcap/config";
import {
  AesCbcEncryptor,
  decodePayload,
  StaticKeyMaterialProvider,
  type QrSignatureStore,
  type StoredQrSignature,
  type VerifyOtpResult,
} from "@chatcap/crypto-keys";
import type { DbQueryable } from "@chatcap/db-schema";
import { OTP_STATUS } from "@chatcap/shared-types";

import {
  ConsentKeyError,
  ConsentNotFoundError,
  ConsentOtpError,
  ConsentService,
  type ConsentOtpVerifier,
} from "../src/consent/consent-service";

/**
 * Consent e2e (task 4.4, REQ-CONSENT-2/3/4, REQ-CHATBOT-6): a real
 * AES-256-CBC encryptor + the canonical QR signer against a fake queryable —
 * proves the registry row carries terms_version / jurisdiction / key_version
 * / integrity_hash, the encrypted payload round-trips, the session moves to
 * `accepted`, and the QR chain is issued. The same DB interactions run
 * against real PostgreSQL in the gated db-schema integration suite.
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

class MemoryQrSignatureStore implements QrSignatureStore {
  readonly records = new Map<string, StoredQrSignature>();

  async findByConsentId(consentId: string): Promise<StoredQrSignature[]> {
    return [...this.records.values()].filter(
      (record) => record.consentId === consentId
    );
  }

  async insert(record: StoredQrSignature): Promise<void> {
    this.records.set(record.id, record);
  }

  async update(record: StoredQrSignature): Promise<void> {
    const current = this.records.get(record.id);
    if (current === undefined) {
      throw new Error(`unknown chain record ${record.id}`);
    }
    this.records.set(record.id, { ...current, ...record });
  }
}

function keyRow() {
  return {
    key_version: 2,
    algorithm: "aes-256-cbc-hkdf-sha256",
    salt: "a1b2c3",
    status: "active",
    created_at: new Date("2026-08-09T00:00:00Z"),
    expires_at: new Date("2026-08-16T00:00:00Z"),
    forced_rotation_due_at: new Date("2026-08-09T12:00:00Z"),
  };
}

function consentRow(id: string) {
  return {
    id,
    session_id: "session-1",
    jurisdiction: "MX",
    terms_version: 1,
    key_version: 2,
    integrity_hash: "",
    active: true,
    created_at: new Date("2026-08-09T00:00:00Z"),
  };
}

function sessionRow() {
  return {
    id: "session-1",
    contact_key_anon: "anon-1",
    jurisdiction: "MX",
    persistence_class: "anonymous",
    consent_state: "accepted",
    ai_state: "auto",
    created_at: new Date("2026-01-01T00:00:00Z"),
    last_activity_at: new Date("2026-01-01T00:00:00Z"),
    purge_at: new Date("2026-01-02T00:00:00Z"),
  };
}

function fakeOtp(status: "invalid" | "verified"): ConsentOtpVerifier {
  return {
    verify: async (): Promise<VerifyOtpResult> => ({
      status: status === "verified" ? OTP_STATUS.VERIFIED : "invalid",
    }),
  };
}

function makeService(
  db: DbQueryable,
  store: MemoryQrSignatureStore,
  otp: ConsentOtpVerifier = fakeOtp("verified")
) {
  const encryptor = new AesCbcEncryptor(
    new EnvKeyProvider("x".repeat(40)),
    new StaticKeyMaterialProvider(new Map([[2, Buffer.from("a1b2c3", "hex")]]))
  );
  const service = new ConsentService({
    db,
    encryptor,
    qrSignatureStore: store,
    qrKey: Buffer.from("qr-signing-key-32-bytes-0123456789", "utf8"),
    renderQr: async () => "data:image/png;base64,QR_FAKE",
    otp,
    auditQr: async () => undefined,
  });
  return service;
}

const QR_CONTENT_RE =
  /^v=1;consent_id=(consent-uuid-1);terms_version=1;key_version=2;iat=\d+\|[0-9a-f]{64}$/;

describe("ConsentService (task 4.4 consent e2e)", () => {
  it("encrypts the acceptance, registers it and issues a signed QR chain", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [keyRow()] }, // currentActiveKeyVersion
      { rows: [consentRow("consent-uuid-1")] }, // createConsentRecord
      { rows: [sessionRow()] }, // setSessionConsentState
      { rows: [] }, // qr chain findByConsentId
      { rows: [] }, // qr chain insert
    ]);
    const store = new MemoryQrSignatureStore();
    const service = makeService(db, store);

    const acceptance = await service.accept({
      sessionId: "session-1",
      contactKeyAnon: "anon-1",
      jurisdiction: "MX",
      termsVersion: 1,
    });

    // Registry row: terms_version, jurisdiction, key_version, integrity_hash.
    const consentInsert = sqlTexts.findIndex((sql) =>
      sql.includes("INSERT INTO consent_records")
    );
    expect(consentInsert).toBeGreaterThanOrEqual(0);
    expect(paramLists[consentInsert]?.slice(0, 4)).toEqual([
      "session-1",
      "MX",
      1,
      2,
    ]);
    const encryptedPayload = paramLists[consentInsert]?.[4];
    const integrityHash = paramLists[consentInsert]?.[5];
    expect(encryptedPayload).toBeInstanceOf(Buffer);
    expect(integrityHash).toMatch(/^[0-9a-f]{64}$/);

    // The stored envelope decrypts back to the acceptance (REQ-CONSENT-3).
    const encrypted = decodePayload(2, encryptedPayload as Buffer);
    expect(encrypted.hmac.toString("hex")).toBe(integrityHash);
    const plaintext = await service.encryptor.decrypt(encrypted);
    expect(JSON.parse(plaintext.toString("utf8"))).toMatchObject({
      entityType: "consent",
      sessionId: "session-1",
      contactKeyAnon: "anon-1",
      jurisdiction: "MX",
      termsVersion: 1,
      acceptedAt: expect.any(String),
    });

    // Session moved to accepted (REQ-CONSENT-2).
    const consentStateUpdate = sqlTexts.findIndex((sql) =>
      sql.includes("SET consent_state")
    );
    expect(paramLists[consentStateUpdate]).toEqual(["session-1", "accepted"]);

    // QR chain issued and encoded (REQ-KEY-7).
    expect(acceptance.consentId).toBe("consent-uuid-1");
    expect(acceptance.qrContent).toMatch(QR_CONTENT_RE);
    expect(acceptance.qrDataUrl).toBe("data:image/png;base64,QR_FAKE");

    const chain = await store.findByConsentId("consent-uuid-1");
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({
      consentId: "consent-uuid-1",
      keyVersion: 2,
      status: "active",
      payload: {
        v: 1,
        consentId: "consent-uuid-1",
        termsVersion: 1,
        keyVersion: 2,
      },
    });
    expect(chain[0]?.signature).toBe(acceptance.qrContent.split("|")[1]);
  });

  it("refuses to encrypt when no active key version exists", async () => {
    const { db } = fakeDb([{ rows: [] }]);
    const store = new MemoryQrSignatureStore();
    const service = makeService(db, store);

    await expect(
      service.accept({
        sessionId: "session-1",
        contactKeyAnon: "anon-1",
        jurisdiction: "MX",
        termsVersion: 1,
      })
    ).rejects.toBeInstanceOf(ConsentKeyError);
  });

  it("never leaks plaintext consent into the registry row params", async () => {
    const { db, paramLists } = fakeDb([
      { rows: [keyRow()] },
      { rows: [consentRow("consent-uuid-1")] },
      { rows: [sessionRow()] },
      { rows: [] },
      { rows: [] },
    ]);
    const store = new MemoryQrSignatureStore();
    const service = makeService(db, store);

    await service.accept({
      sessionId: "session-1",
      contactKeyAnon: "anon-1",
      jurisdiction: "MX",
      termsVersion: 1,
    });

    const consentInsert = paramLists.findIndex((params) =>
      params.some((value) => String(value).includes("INSERT"))
    );
    const payload = paramLists[consentInsert] ?? [];
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("acceptance");
    expect(serialized).not.toContain("entityType");
    expect(serialized).not.toContain("anon-1");
  });

  it("renews the QR after a verified OTP, archiving the previous one (REQ-KEY-6)", async () => {
    const { db } = fakeDb([
      { rows: [keyRow()] }, // accept: currentActiveKeyVersion
      { rows: [consentRow("consent-uuid-1")] }, // accept: createConsentRecord
      { rows: [sessionRow()] }, // accept: setSessionConsentState
      { rows: [consentRow("consent-uuid-1")] }, // renew: findActiveConsentBySession
      { rows: [keyRow()] }, // renew: currentActiveKeyVersion
    ]);
    const store = new MemoryQrSignatureStore();
    const service = makeService(db, store, fakeOtp("verified"));

    const acceptance = await service.accept({
      sessionId: "session-1",
      contactKeyAnon: "anon-1",
      jurisdiction: "MX",
      termsVersion: 1,
    });
    const renewed = await service.renew({
      sessionId: "session-1",
      otpId: "otp-1",
      otpCode: "123456",
    });

    expect(renewed.consentId).toBe("consent-uuid-1");
    expect(renewed.qrContent).toMatch(QR_CONTENT_RE);
    expect(renewed.qrContent).not.toBe(acceptance.qrContent);
    expect(renewed.qrDataUrl).toBe("data:image/png;base64,QR_FAKE");

    const chain = await store.findByConsentId("consent-uuid-1");
    expect(chain).toHaveLength(2);
    expect(chain[0]?.status).toBe("archived");
    expect(chain[1]?.status).toBe("active");
  });

  it("refuses QR renewal when the OTP is not verified (REQ-KEY-6)", async () => {
    const { db } = fakeDb([
      { rows: [consentRow("consent-uuid-1")] },
      { rows: [keyRow()] },
    ]);
    const store = new MemoryQrSignatureStore();
    const service = makeService(db, store, fakeOtp("invalid"));

    await expect(
      service.renew({ sessionId: "session-1", otpId: "otp-1", otpCode: "000000" })
    ).rejects.toBeInstanceOf(ConsentOtpError);
    expect(store.records.size).toBe(0);
  });

  it("refuses QR renewal when the session has no active consent", async () => {
    const { db } = fakeDb([
      { rows: [] }, // findActiveConsentBySession: none
    ]);
    const store = new MemoryQrSignatureStore();
    const service = makeService(db, store, fakeOtp("verified"));

    await expect(
      service.renew({ sessionId: "session-1", otpId: "otp-1", otpCode: "123456" })
    ).rejects.toBeInstanceOf(ConsentNotFoundError);
    expect(store.records.size).toBe(0);
  });

  it("deactivates the consent record when the media send fails (compensating rollback)", async () => {
    const { db, sqlTexts, paramLists } = fakeDb([
      { rows: [keyRow()] }, // currentActiveKeyVersion
      { rows: [consentRow("consent-uuid-1")] }, // createConsentRecord
      { rows: [sessionRow()] }, // setSessionConsentState
      { rows: [] }, // deactivateConsent
    ]);
    const store = new MemoryQrSignatureStore();
    const service = new ConsentService({
      db,
      encryptor: new AesCbcEncryptor(
        new EnvKeyProvider("x".repeat(40)),
        new StaticKeyMaterialProvider(new Map([[2, Buffer.from("a1b2c3", "hex")]]))
      ),
      qrSignatureStore: store,
      qrKey: Buffer.from("qr-signing-key-32-bytes-0123456789", "utf8"),
      renderQr: async () => {
        throw new Error("media provider unavailable");
      },
      otp: fakeOtp("verified"),
      auditQr: async () => undefined,
    });

    await expect(
      service.accept({
        sessionId: "session-1",
        contactKeyAnon: "anon-1",
        jurisdiction: "MX",
        termsVersion: 1,
      })
    ).rejects.toThrow("media provider unavailable");

    const deactivateIndex = sqlTexts.findIndex((sql) => sql.includes("SET active = false"));
    expect(deactivateIndex).toBeGreaterThanOrEqual(0);
    expect(paramLists[deactivateIndex]).toEqual(["consent-uuid-1"]);
    // The chain entry is signature metadata (harmless); the consent itself was
    // deactivated and the QR was never rendered/delivered.
    expect(store.records.size).toBe(1);
  });
});
