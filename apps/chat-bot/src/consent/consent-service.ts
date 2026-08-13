import {
  QrSigner,
  encodePayload,
  type Encryptor,
  type QrAuditEntry,
  type QrSignatureStore,
  type VerifyOtpResult,
} from "@chatcap/crypto-keys";
import {
  createConsentRecord,
  currentActiveKeyVersion,
  deactivateConsent,
  findActiveConsentBySession,
  setSessionConsentState,
  type DbQueryable,
} from "@chatcap/db-schema";
import { OTP_STATUS } from "@chatcap/shared-types";

/**
 * Consent e2e (task 4.4, REQ-CONSENT-2/3/4, REQ-CHATBOT-6): encrypts the
 * acceptance under the active key version, registers the encrypted payload
 * (terms_version, jurisdiction, key_version, integrity_hash) in
 * consent_records, moves the session to `accepted`, and issues a signed QR
 * chain entry whose content is delivered as media via the provider.
 * Nothing is persisted before this point (REQ-CONSENT-2).
 *
 * Every QR issuance and validation is audited (REQ-DASH-8), and a RENEWED QR
 * is only issued after a verified 6-digit OTP within its validity window
 * (REQ-KEY-6): first acceptance needs no OTP, renewal always does.
 */

/** Raised when no active key version exists for consent encryption. */
export class ConsentKeyError extends Error {
  readonly code = "consent_key_unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConsentKeyError";
  }
}

/** Raised when a QR renewal is attempted without a verified OTP. */
export class ConsentOtpError extends Error {
  readonly code = "consent_otp_not_verified" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConsentOtpError";
  }
}

/** Raised when no active consent record exists for the renewal session. */
export class ConsentNotFoundError extends Error {
  readonly code = "consent_not_found" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConsentNotFoundError";
  }
}

/**
 * Minimal OTP verifier contract (REQ-KEY-6): a 6-digit code within its
 * 10-minute window. The production wiring uses `OtpService` over the
 * `otp_codes` store; tests inject a double.
 */
export interface ConsentOtpVerifier {
  verify(id: string, code: string, now?: Date): Promise<VerifyOtpResult>;
}

export interface ConsentServiceOptions {
  db: DbQueryable;
  encryptor: Encryptor;
  qrSignatureStore: QrSignatureStore;
  qrKey: Buffer;
  renderQr: (content: string) => Promise<string>;
  otp: ConsentOtpVerifier;
  /** Audit sink for QR lifecycle events (REQ-DASH-8); app wires insertAuditEntry. */
  auditQr: (entry: QrAuditEntry) => Promise<void>;
}

export interface ConsentAcceptanceInput {
  sessionId: string;
  contactKeyAnon: string;
  jurisdiction: string;
  termsVersion: number;
}

export interface ConsentRenewalInput {
  sessionId: string;
  otpId: string;
  otpCode: string;
}

export interface ConsentAcceptance {
  consentId: string;
  qrContent: string;
  qrDataUrl: string;
}

export class ConsentService {
  /** Exposed so verifiers/re-encryption can decrypt the stored envelope. */
  readonly encryptor: Encryptor;
  private readonly db: DbQueryable;
  private readonly qrSignatureStore: QrSignatureStore;
  private readonly qrKey: Buffer;
  private readonly renderQr: (content: string) => Promise<string>;
  private readonly otp: ConsentOtpVerifier;
  private readonly auditQr: (entry: QrAuditEntry) => Promise<void>;
  /**
   * One QrSigner per key version: QrSigner guarantees strictly increasing
   * issuedAt per instance, so reusing the instance keeps a renewal distinct
   * from the issuance even within the same wall-clock second (REQ-KEY-7).
   */
  private readonly signersByKeyVersion = new Map<number, QrSigner>();

  constructor(options: ConsentServiceOptions) {
    this.db = options.db;
    this.encryptor = options.encryptor;
    this.qrSignatureStore = options.qrSignatureStore;
    this.qrKey = options.qrKey;
    this.renderQr = options.renderQr;
    this.otp = options.otp;
    this.auditQr = options.auditQr;
  }

  private signerFor(keyVersion: number): QrSigner {
    const cached = this.signersByKeyVersion.get(keyVersion);
    if (cached !== undefined) {
      return cached;
    }
    const signer = new QrSigner({
      store: this.qrSignatureStore,
      signerKey: this.qrKey,
      keyVersion,
      audit: this.auditQr,
    });
    this.signersByKeyVersion.set(keyVersion, signer);
    return signer;
  }

  async accept(input: ConsentAcceptanceInput): Promise<ConsentAcceptance> {
    const activeKey = await currentActiveKeyVersion(this.db);
    if (activeKey === undefined) {
      throw new ConsentKeyError(
        "no active key version available for consent encryption"
      );
    }
    const keyVersion = activeKey.keyVersion;

    const plaintext = Buffer.from(
      JSON.stringify({
        entityType: "consent",
        sessionId: input.sessionId,
        contactKeyAnon: input.contactKeyAnon,
        jurisdiction: input.jurisdiction,
        termsVersion: input.termsVersion,
        acceptedAt: new Date().toISOString(),
      }),
      "utf8"
    );

    const encrypted = await this.encryptor.encrypt(plaintext, keyVersion);
    const record = await createConsentRecord(this.db, {
      sessionId: input.sessionId,
      jurisdiction: input.jurisdiction,
      termsVersion: input.termsVersion,
      keyVersion,
      encryptedPayload: encodePayload(encrypted),
      integrityHash: encrypted.hmac.toString("hex"),
    });

    // Compensating rollback: the consent row is durable once inserted. If the
    // session state, the QR chain, or the media send fails afterwards, mark
    // the record inactive so no active consent exists half-persisted.
    try {
      await setSessionConsentState(this.db, input.sessionId, "accepted");

      const signer = this.signerFor(keyVersion);
      const signed = await signer.sign({
        consentId: record.id,
        termsVersion: input.termsVersion,
        actor: "system:chat-bot-consent",
      });
      const qrContent = signer.encode(signed);
      const qrDataUrl = await this.renderQr(qrContent);

      return { consentId: record.id, qrContent, qrDataUrl };
    } catch (error) {
      await deactivateConsent(this.db, record.id);
      throw error;
    }
  }

  /**
   * QR renewal (REQ-KEY-6, REQ-CONSENT-5): archives the previous active QR and
   * issues a new one — ONLY after a verified 6-digit OTP within its validity
   * window. The OTP is checked before any DB access, so a refused renewal
   * touches no data and issues nothing.
   */
  async renew(input: ConsentRenewalInput): Promise<ConsentAcceptance> {
    const otp = await this.otp.verify(input.otpId, input.otpCode, new Date());
    if (otp.status !== OTP_STATUS.VERIFIED) {
      throw new ConsentOtpError(
        `QR renewal refused: OTP not verified (status=${otp.status})`
      );
    }

    const consent = await findActiveConsentBySession(this.db, input.sessionId);
    if (consent === undefined) {
      throw new ConsentNotFoundError(
        `no active consent record for session ${input.sessionId}`
      );
    }

    const activeKey = await currentActiveKeyVersion(this.db);
    if (activeKey === undefined) {
      throw new ConsentKeyError(
        "no active key version available for QR renewal"
      );
    }

    const signer = this.signerFor(activeKey.keyVersion);
    const signed = await signer.sign({
      consentId: consent.id,
      termsVersion: consent.termsVersion,
      actor: "system:chat-bot-renewal",
    });
    const qrContent = signer.encode(signed);
    const qrDataUrl = await this.renderQr(qrContent);

    return { consentId: consent.id, qrContent, qrDataUrl };
  }
}
