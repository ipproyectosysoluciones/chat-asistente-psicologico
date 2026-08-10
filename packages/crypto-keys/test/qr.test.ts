import { describe, expect, test } from "vitest";

import { QR_SIGNATURE_STATUS } from "@chatcap/shared-types";
import {
  QrSigner,
  canonicalQrPayload,
  isQrPayload,
  signQrPayload,
  verifyQrPayload,
  type QrPayload,
  type QrSignatureStore,
  type StoredQrSignature,
} from "../src/index";

const QR_KEY_HEX = "0123456789abcdef0123456789abcdef"; // 32 bytes
const OTHER_KEY_HEX = "fedcba9876543210fedcba9876543210";
const CONSENT_ID = "consent_abc123";

/** Golden payload — this exact canonical string MUST survive rework (REQ-CONSENT-3). */
const canonical =
  "v=1;consent_id=consent_abc123;terms_version=3;key_version=7;iat=1723230000";

const payload: QrPayload = {
  v: 1,
  consentId: CONSENT_ID,
  termsVersion: 3,
  keyVersion: 7,
  iat: 1723230000,
};

const GOOD_SIG =
  "0a5cbe59ea8db09c2553f11c8afde9498628185de7ced2a098b9f245094ff810";

function makeSignature(
  keyHex: string,
  overrides: Partial<QrPayload> = {}
): { payload: QrPayload; signature: string } {
  const full: QrPayload = { ...payload, ...overrides };
  return {
    payload: full,
    signature: signQrPayload(full, Buffer.from(keyHex, "hex")),
  };
}

/** In-memory signature store: fixture double for the chain-of-trust contract. */
class MemorySignatureStore implements QrSignatureStore {
  readonly records = new Map<string, StoredQrSignature>();

  async findByConsentId(consentId: string): Promise<StoredQrSignature[]> {
    return [...this.records.values()].filter((r) => r.consentId === consentId);
  }

  async insert(record: StoredQrSignature): Promise<void> {
    this.records.set(record.id, record);
  }

  async update(record: StoredQrSignature): Promise<void> {
    this.records.set(record.id, record);
  }
}

describe("canonical QR payload (REQ-CONSENT-3, design §6.1)", () => {
  test("serializes the payload in the exact canonical order", () => {
    expect(canonicalQrPayload(payload)).toBe(canonical);
  });

  test("rejects payloads with a negative or non-integer iat", () => {
    expect(() => canonicalQrPayload({ ...payload, iat: -1 })).toThrow();
    expect(() => canonicalQrPayload({ ...payload, iat: 1.5 })).toThrow();
  });

  test("rejects payloads with a keyVersion below 1", () => {
    expect(() => canonicalQrPayload({ ...payload, keyVersion: 0 })).toThrow();
  });
});

describe("QR signing (REQ-CONSENT-3)", () => {
  test("matches the golden HMAC-SHA256 vector for the canonical payload", () => {
    expect(signQrPayload(payload, Buffer.from(QR_KEY_HEX, "hex"))).toBe(GOOD_SIG);
  });

  test("same payload + same key is deterministic", () => {
    const a = signQrPayload(payload, Buffer.from(QR_KEY_HEX, "hex"));
    const b = signQrPayload(payload, Buffer.from(QR_KEY_HEX, "hex"));
    expect(a).toBe(b);
  });

  test("signature changes when the signing key changes", () => {
    const a = signQrPayload(payload, Buffer.from(QR_KEY_HEX, "hex"));
    const b = signQrPayload(payload, Buffer.from(OTHER_KEY_HEX, "hex"));
    expect(a).not.toBe(b);
  });
});

describe("QR verification (REQ-CONSENT-3)", () => {
  test("accepts a signature produced by signQrPayload", () => {
    const { payload: p, signature } = makeSignature(QR_KEY_HEX);
    expect(verifyQrPayload(p, signature, Buffer.from(QR_KEY_HEX, "hex"))).toBe(true);
  });

  test("rejects when the signature is truncated or extended", () => {
    const { payload: p, signature } = makeSignature(QR_KEY_HEX);
    expect(verifyQrPayload(p, signature.slice(0, 16), Buffer.from(QR_KEY_HEX, "hex"))).toBe(
      false
    );
    expect(
      verifyQrPayload(p, signature + "ab", Buffer.from(QR_KEY_HEX, "hex"))
    ).toBe(false);
  });

  test("rejects when any canonical field is tampered (HMAC catches every byte)", () => {
    const cases: Array<Partial<Omit<QrPayload, "v">>> = [
      { consentId: "consent_abc124" },
      { termsVersion: 4 },
      { keyVersion: 8 },
      { iat: 1723230001 },
    ];
    for (const overrides of cases) {
      const { payload: p, signature } = makeSignature(QR_KEY_HEX);
      const tampered: QrPayload = { ...p, ...overrides };
      expect(verifyQrPayload(tampered, signature, Buffer.from(QR_KEY_HEX, "hex"))).toBe(
        false
      );
    }
    // Version tampering (v=2) is exercised via the decode path, where the
    // untrusted value actually enters the system (see encode/decode tests).
  });

  test("rejects a signature produced with a different key", () => {
    const { payload: p, signature } = makeSignature(OTHER_KEY_HEX);
    expect(verifyQrPayload(p, signature, Buffer.from(QR_KEY_HEX, "hex"))).toBe(false);
  });

  test("rejects malformed payloads instead of throwing", () => {
    const { signature } = makeSignature(QR_KEY_HEX);
    const bad: QrPayload = { ...payload, iat: -5 };
    expect(verifyQrPayload(bad, signature, Buffer.from(QR_KEY_HEX, "hex"))).toBe(false);
  });

  test("isQrPayload guards untrusted JSON before verification", () => {
    expect(isQrPayload(payload)).toBe(true);
    expect(isQrPayload({ ...payload, consentId: 42 })).toBe(false);
    expect(isQrPayload({ ...payload, extra: true })).toBe(false);
    expect(isQrPayload({})).toBe(false);
    expect(isQrPayload(null)).toBe(false);
  });
});

describe("QR chain of trust (design §6.1 — signing always archives)", () => {
  function freshSigner(): { signer: QrSigner; store: MemorySignatureStore } {
    const store = new MemorySignatureStore();
    const signer = new QrSigner({
      store,
      signerKey: Buffer.from(QR_KEY_HEX, "hex"),
    });
    return { signer, store };
  }

  test("signing an existing consent archives the old QR before issuing the new one", async () => {
    const { signer, store } = freshSigner();

    const first = await signer.sign({ consentId: CONSENT_ID, termsVersion: 3 });
    const second = await signer.sign({ consentId: CONSENT_ID, termsVersion: 4 });

    expect(first.signature).not.toBe(second.signature);
    expect(first.issuedAt).toBeLessThan(second.issuedAt);

    const history = await store.findByConsentId(CONSENT_ID);
    expect(history).toHaveLength(2);

    const sorted = [...history].sort((x, y) => x.issuedAt - y.issuedAt);
    const [oldest, newest] = sorted;
    if (oldest === undefined || newest === undefined) {
      throw new Error("Expected two chain records");
    }
    expect(oldest.status).toBe(QR_SIGNATURE_STATUS.ARCHIVED);
    expect(newest.status).toBe(QR_SIGNATURE_STATUS.ACTIVE);
    expect(newest.signature).toBe(second.signature);
  });

  test("the archived old QR still verifies with its original key (chain of trust)", async () => {
    const store = new MemorySignatureStore();
    const first = await new QrSigner({
      store,
      signerKey: Buffer.from(QR_KEY_HEX, "hex"),
    }).sign({ consentId: CONSENT_ID, termsVersion: 3 });

    // Second issuance under the same key.
    await new QrSigner({
      store,
      signerKey: Buffer.from(QR_KEY_HEX, "hex"),
    }).sign({ consentId: CONSENT_ID, termsVersion: 4 });

    // Read back: the store now shows the first signature archived (DB semantics).
    const archived = (await store.findByConsentId(CONSENT_ID)).find(
      (record) => record.signature === first.signature
    );
    if (archived === undefined) {
      throw new Error("Expected the first signature to remain in the chain");
    }
    expect(archived.status).toBe(QR_SIGNATURE_STATUS.ARCHIVED);
    expect(
      verifyQrPayload(archived.payload, archived.signature, Buffer.from(QR_KEY_HEX, "hex"))
    ).toBe(true);
  });

  test("no_chain_entry: HMAC is valid but the signature was never issued for this consent", async () => {
    const { signer } = freshSigner();
    // One real issuance for CONSENT_ID (real iat, real signature).
    await signer.sign({ consentId: CONSENT_ID, termsVersion: 3 });

    // The golden payload+GOOD_SIG is cryptographically valid under QR_KEY
    // but was never signed by the chain — a forged-but-valid QR.
    const result = await signer.verify({ payload, signature: GOOD_SIG });

    expect(result.valid).toBe(false);
    expect(result.status).toBe(QR_SIGNATURE_STATUS.REVOKED);
    expect(result.reason).toBe("no_chain_entry");
  });

  test("unknown_consent: signature valid but the consent id has no chain", async () => {
    const { signer } = freshSigner();
    const { payload: p, signature } = makeSignature(QR_KEY_HEX, {
      consentId: "consent_ghost",
    });

    const result = await signer.verify({ payload: p, signature });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("unknown_consent");
  });

  test("invalid_payload: HMAC mismatch fails with a clear reason", async () => {
    const { signer } = freshSigner();
    await signer.sign({ consentId: CONSENT_ID, termsVersion: 3 });

    // Golden payload with one tampered field → HMAC no longer matches GOOD_SIG.
    const tampered: QrPayload = { ...payload, termsVersion: 99 };
    const result = await signer.verify({ payload: tampered, signature: GOOD_SIG });

    expect(result.valid).toBe(false);
    expect(result.status).toBe(QR_SIGNATURE_STATUS.REVOKED);
    expect(result.reason).toBe("invalid_payload");
  });

  test("success: matching active signature in the chain", async () => {
    const { signer } = freshSigner();
    const signed = await signer.sign({ consentId: CONSENT_ID, termsVersion: 3 });

    const result = await signer.verify({ payload: signed.payload, signature: signed.signature });

    expect(result.valid).toBe(true);
    expect(result.status).toBe(QR_SIGNATURE_STATUS.ACTIVE);
    expect(result.reason).toBe("signature_match");
  });
});

describe("QR encode/decode round-trip (QR delivery path)", () => {
  test("encode then decode preserves the exact payload and signature", async () => {
    const store = new MemorySignatureStore();
    const signer = new QrSigner({
      store,
      signerKey: Buffer.from(QR_KEY_HEX, "hex"),
    });

    const signed = await signer.sign({ consentId: CONSENT_ID, termsVersion: 3 });
    const encoded = await signer.encode(signed);
    const decoded = signer.decode(encoded);

    expect(decoded.payload).toEqual(signed.payload);
    expect(decoded.signature).toBe(signed.signature);
  });

  test("tampering the encoded text invalidates the QR", async () => {
    const store = new MemorySignatureStore();
    const signer = new QrSigner({
      store,
      signerKey: Buffer.from(QR_KEY_HEX, "hex"),
    });

    const signed = await signer.sign({ consentId: CONSENT_ID, termsVersion: 3 });
    const encoded = await signer.encode(signed);
    const corrupted = encoded.replace("v=1", "v=2");

    const decoded = signer.decode(corrupted);
    expect(verifyQrPayload(decoded.payload, decoded.signature, Buffer.from(QR_KEY_HEX, "hex"))).toBe(
      false
    );
  });
});
