import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { QR_SIGNATURE_STATUS, type QrPayload, type QrSignatureStatus } from "@chatcap/shared-types";

/**
 * Chain-of-trust record persisted per QR issuance (design §6.1, REQ-KEY-7).
 * `payload`/`issuedAt` extend the shared {@link QrSignature} shape with what
 * the verifier needs to replay the canonical string across rotations.
 */
export interface StoredQrSignature {
  id: string;
  consentId: string;
  keyVersion: number;
  signature: string;
  status: QrSignatureStatus;
  createdAt: string;
  payload: QrPayload;
  issuedAt: number;
}

/**
 * Persistence contract for the QR signature chain (`qr_signatures` table in a
 * later phase). Every issuance archives the previous active signature so old
 * QRs keep verifying across key rotations.
 */
export interface QrSignatureStore {
  findByConsentId(consentId: string): Promise<StoredQrSignature[]>;
  insert(record: StoredQrSignature): Promise<void>;
  update(record: StoredQrSignature): Promise<void>;
}

export interface SignQrOptions {
  consentId: string;
  termsVersion: number;
  /** Who initiated the issuance (defaults to `system`). */
  actor?: string;
}

export type QrAuditAction = "qr_issued" | "qr_validation";

/**
 * Audit record for a QR lifecycle event (REQ-DASH-8): who/when/why/outcome.
 * Contains only identifiers and the outcome reason — never health data. The
 * consuming service persists it (e.g. via `insertAuditEntry`).
 */
export interface QrAuditEntry {
  actor: string;
  consentId: string;
  action: QrAuditAction;
  outcome: "success" | "failure";
  reason?: string;
  keyVersion: number;
}

export type QrVerifyReason =
  | "signature_match"
  | "invalid_payload"
  | "unknown_consent"
  | "no_chain_entry";

export interface QrVerificationResult {
  valid: boolean;
  status: QrSignatureStatus;
  reason: QrVerifyReason;
}

export interface QrSignerOptions {
  store: QrSignatureStore;
  signerKey: Buffer;
  keyVersion?: number;
  /**
   * Mandatory audit sink (REQ-DASH-8): every issuance and every validation
   * records who/when/why. There is no un-audited QR path.
   */
  audit: (entry: QrAuditEntry) => Promise<void>;
}

export interface EncodedQr {
  payload: QrPayload;
  signature: string;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Canonical serialization of the QR payload. Field order and formatting are
 * part of the signing contract (REQ-CONSENT-3): the exact string
 * `v=1;consent_id=...;terms_version=...;key_version=...;iat=...` is what gets
 * HMAC'd, so any rework here breaks existing QRs.
 */
export function canonicalQrPayload(payload: QrPayload): string {
  if (payload.v !== 1) {
    throw new Error(`Unsupported QR payload version: ${payload.v}`);
  }
  if (!isPositiveInteger(payload.termsVersion)) {
    throw new Error(`Invalid terms_version: ${payload.termsVersion}`);
  }
  if (!isPositiveInteger(payload.keyVersion)) {
    throw new Error(`Invalid key_version: ${payload.keyVersion}`);
  }
  if (!isNonNegativeInteger(payload.iat)) {
    throw new Error(`Invalid iat: ${payload.iat}`);
  }
  return (
    `v=${payload.v}` +
    `;consent_id=${payload.consentId}` +
    `;terms_version=${payload.termsVersion}` +
    `;key_version=${payload.keyVersion}` +
    `;iat=${payload.iat}`
  );
}

/** HMAC-SHA256 of the canonical payload, hex-encoded (design §6.1). */
export function signQrPayload(payload: QrPayload, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalQrPayload(payload), "utf8").digest("hex");
}

/**
 * Constant-time verification of a QR signature. Returns false (never throws)
 * for malformed payloads or malformed signature hex — callers treat the
 * boolean as the only signal.
 */
export function verifyQrPayload(payload: QrPayload, signature: string, key: Buffer): boolean {
  if (!isQrPayload(payload)) {
    return false;
  }
  const expected = Buffer.from(signQrPayload(payload, key), "hex");
  const actual = Buffer.from(signature, "hex");
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

const QR_PAYLOAD_KEYS = ["v", "consentId", "termsVersion", "keyVersion", "iat"] as const;

/** Runtime guard for untrusted QR JSON (REQ-CONSENT-3): exact shape + values. */
export function isQrPayload(value: unknown): value is QrPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Safe: value is a non-null object after the check above.
  const record = value as Record<string, unknown>;
  if (QR_PAYLOAD_KEYS.some((key) => !(key in record))) {
    return false;
  }
  if (Object.keys(record).length !== QR_PAYLOAD_KEYS.length) {
    return false;
  }
  // Safe: every required key exists and the key count matches, so the object
  // has the exact QrPayload shape; field-level checks run below.
  const payload = value as QrPayload;
  return (
    payload.v === 1 &&
    typeof payload.consentId === "string" &&
    payload.consentId.length > 0 &&
    isPositiveInteger(payload.termsVersion) &&
    isPositiveInteger(payload.keyVersion) &&
    isNonNegativeInteger(payload.iat)
  );
}

/**
 * Parses the canonical string back into a payload. Lenient on purpose: field
 * coercion can yield values that {@link isQrPayload} rejects (e.g. `v=2`),
 * letting callers surface the failure instead of throwing on untrusted input.
 */
export function parseQrPayload(canonical: string): QrPayload {
  const fields = new Map<string, string>();
  for (const pair of canonical.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      throw new Error(`Malformed QR field: ${pair}`);
    }
    fields.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const asNumber = (key: string): number => Number(fields.get(key));
  return {
    // Deliberate lenient parse: the value may not be 1 (e.g. a v=2 attack);
    // isQrPayload() downstream rejects it instead of us throwing here.
    v: asNumber("v") as 1,
    consentId: fields.get("consent_id") ?? "",
    termsVersion: asNumber("terms_version"),
    keyVersion: asNumber("key_version"),
    iat: asNumber("iat"),
  };
}

/**
 * Issues and verifies QR signatures with an archive-on-sign chain of trust
 * (REQ-KEY-7). Each new signature for a consent archives the previous one, so
 * a QR presented later — even after rotations — matches a stored entry.
 */
export class QrSigner {
  private readonly store: QrSignatureStore;
  private readonly signerKey: Buffer;
  private readonly keyVersion: number;
  private readonly audit: (entry: QrAuditEntry) => Promise<void>;
  private lastIssuedAt = 0;

  constructor(options: QrSignerOptions) {
    this.store = options.store;
    this.signerKey = options.signerKey;
    this.keyVersion = options.keyVersion ?? 1;
    this.audit = options.audit;
  }

  async sign(options: SignQrOptions): Promise<StoredQrSignature> {
    const previous = await this.store.findByConsentId(options.consentId);
    for (const record of previous) {
      if (record.status !== QR_SIGNATURE_STATUS.ARCHIVED) {
        await this.store.update({ ...record, status: QR_SIGNATURE_STATUS.ARCHIVED });
      }
    }

    // Monotonic issuedAt within this process: two signs in the same wall-clock
    // second must still produce a strictly increasing chain (REQ-KEY-7).
    // Note: the guarantee is per-process — after a restart the counter resets,
    // which is acceptable because the chain verifies by signature, not by
    // ordering, and iat remains a valid epoch second either way.
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = Math.max(now, this.lastIssuedAt + 1);
    this.lastIssuedAt = issuedAt;
    const payload: QrPayload = {
      v: 1,
      consentId: options.consentId,
      termsVersion: options.termsVersion,
      keyVersion: this.keyVersion,
      iat: issuedAt,
    };
    const signature = signQrPayload(payload, this.signerKey);
    const record: StoredQrSignature = {
      // UUID on purpose: qr_signatures.id is a uuid column (migration 0001),
      // and the chain record must round-trip through PostgreSQL (REQ-KEY-7).
      id: randomUUID(),
      consentId: options.consentId,
      keyVersion: this.keyVersion,
      signature,
      status: QR_SIGNATURE_STATUS.ACTIVE,
      createdAt: new Date(issuedAt * 1000).toISOString(),
      payload,
      issuedAt,
    };
    await this.store.insert(record);
    await this.audit({
      actor: options.actor ?? "system",
      consentId: options.consentId,
      action: "qr_issued",
      outcome: "success",
      keyVersion: this.keyVersion,
    });
    return record;
  }

  /**
   * Verifies a presented QR against the consent's chain of trust. Fails hard
   * (never silently passes) when the consent is unknown, the signature was
   * never issued, or the HMAC does not verify. Every validation outcome is
   * audited (REQ-DASH-8), including the failure reason.
   */
  async verify(
    input: EncodedQr,
    context?: { actor?: string }
  ): Promise<QrVerificationResult> {
    const { payload, signature } = input;

    if (!isQrPayload(payload)) {
      // Safe: the payload is untrusted input that failed the runtime guard;
      // read it loosely to build an audit entry without trusting its fields.
      const loose = payload as Record<string, unknown>;
      await this.audit({
        actor: context?.actor ?? "system:qr-validator",
        consentId: typeof loose.consentId === "string" ? loose.consentId : "unknown",
        action: "qr_validation",
        outcome: "failure",
        reason: "invalid_payload",
        keyVersion: typeof loose.keyVersion === "number" ? loose.keyVersion : 0,
      });
      return { valid: false, status: QR_SIGNATURE_STATUS.REVOKED, reason: "invalid_payload" };
    }
    if (!verifyQrPayload(payload, signature, this.signerKey)) {
      await this.audit({
        actor: context?.actor ?? "system:qr-validator",
        consentId: payload.consentId,
        action: "qr_validation",
        outcome: "failure",
        reason: "invalid_payload",
        keyVersion: payload.keyVersion,
      });
      return { valid: false, status: QR_SIGNATURE_STATUS.REVOKED, reason: "invalid_payload" };
    }

    const chain = await this.store.findByConsentId(payload.consentId);
    if (chain.length === 0) {
      await this.audit({
        actor: context?.actor ?? "system:qr-validator",
        consentId: payload.consentId,
        action: "qr_validation",
        outcome: "failure",
        reason: "unknown_consent",
        keyVersion: payload.keyVersion,
      });
      return { valid: false, status: QR_SIGNATURE_STATUS.REVOKED, reason: "unknown_consent" };
    }

    const match = chain.find(
      (record) =>
        record.signature === signature &&
        record.status !== QR_SIGNATURE_STATUS.REVOKED &&
        record.keyVersion === payload.keyVersion
    );
    if (match === undefined) {
      await this.audit({
        actor: context?.actor ?? "system:qr-validator",
        consentId: payload.consentId,
        action: "qr_validation",
        outcome: "failure",
        reason: "no_chain_entry",
        keyVersion: payload.keyVersion,
      });
      return { valid: false, status: QR_SIGNATURE_STATUS.REVOKED, reason: "no_chain_entry" };
    }

    await this.audit({
      actor: context?.actor ?? "system:qr-validator",
      consentId: payload.consentId,
      action: "qr_validation",
      outcome: "success",
      reason: "signature_match",
      keyVersion: payload.keyVersion,
    });
    return { valid: true, status: match.status, reason: "signature_match" };
  }

  /** Encodes a signed QR into a single portable string for the QR media path. */
  encode(signed: StoredQrSignature): string {
    return `${canonicalQrPayload(signed.payload)}|${signed.signature}`;
  }

  /** Decodes the portable QR string back into payload + signature. */
  decode(encoded: string): EncodedQr {
    const separator = encoded.indexOf("|");
    if (separator === -1) {
      throw new Error("Malformed encoded QR: missing signature separator");
    }
    return {
      payload: parseQrPayload(encoded.slice(0, separator)),
      signature: encoded.slice(separator + 1),
    };
  }
}
