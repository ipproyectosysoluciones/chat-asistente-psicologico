import { createHash, randomBytes, randomUUID } from "node:crypto";

import { OTP_STATUS, type OtpStatus } from "@chatcap/shared-types";

export const OTP_DIGITS = 6;
export const OTP_LIFETIME_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

/** Immutable record of an OTP as persisted by an {@link OtpStore}. */
export interface StoredOtp {
  id: string;
  consentId: string;
  /** Salted SHA-256 of the code: `<salt-hex>:<digest-hex>`. The plaintext code is never stored. */
  otpHash: string;
  attempts: number;
  expiresAt: string;
  status: OtpStatus;
}

/**
 * Persistence contract for OTP codes (REQ-KEY-6). The PostgreSQL
 * implementation (`otp_codes` table) arrives in a later phase; tests use an
 * in-memory double. Storage MUST be hash-only — never the plaintext code.
 */
export interface OtpStore {
  insert(record: StoredOtp): Promise<void>;
  findById(id: string): Promise<StoredOtp | undefined>;
  update(record: StoredOtp): Promise<void>;
}

export interface IssueOtpResult {
  id: string;
  otpCode: string;
  expiresAt: string;
}

export interface VerifyOtpResult {
  /**
   * "invalid" is a transient verification outcome (wrong code, unknown id,
   * or reuse of a verified OTP) — never a persisted row state.
   */
  status: OtpStatus | "invalid";
}

export interface OtpServiceOptions {
  store: OtpStore;
  /** OTP validity window; defaults to {@link OTP_LIFETIME_MS}. */
  ttlMs?: number;
  /** Failed attempts before the OTP locks; defaults to {@link OTP_MAX_ATTEMPTS}. */
  maxAttempts?: number;
}

/**
 * Salted-SHA-256 of a code: `sha256(salt || code)` hex, prefixed by the salt
 * in hex so the digest is self-describing. Pre-image resistant, so the code
 * cannot be recovered from storage.
 */
export function hashOtpCode(code: string, salt: Buffer): string {
  const digest = createHash("sha256").update(salt).update(code, "utf8").digest("hex");
  return `${salt.toString("hex")}:${digest}`;
}

function randomCode(): string {
  // Rejection sampling keeps the distribution uniform modulo 10.
  let value = 0;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= 4_000_000_000);
  return String(value % 10 ** OTP_DIGITS).padStart(OTP_DIGITS, "0");
}

function normalize(now: Date): Date {
  return new Date(now.getTime());
}

/**
 * Issues and verifies 6-digit OTPs (REQ-KEY-6, design §6.1). The clock is
 * injected as a `Date` argument so tests control expiry deterministically.
 * Verification NEVER reveals the stored hash or a timing difference for an
 * unknown id — unknown and wrong codes both resolve to "invalid".
 */
export class OtpService {
  private readonly store: OtpStore;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;

  constructor(options: OtpServiceOptions) {
    this.store = options.store;
    this.ttlMs = options.ttlMs ?? OTP_LIFETIME_MS;
    this.maxAttempts = options.maxAttempts ?? OTP_MAX_ATTEMPTS;
  }

  async issue(consentId: string, now: Date): Promise<IssueOtpResult> {
    // UUID on purpose: otp_codes.id is a uuid column (migration 0001), so the
    // issued id must round-trip through PostgreSQL (REQ-KEY-6 persistence).
    const id = randomUUID();
    const otpCode = randomCode();
    const expiresAt = normalize(now);
    expiresAt.setTime(now.getTime() + this.ttlMs);

    await this.store.insert({
      id,
      consentId,
      otpHash: hashOtpCode(otpCode, randomBytes(16)),
      attempts: 0,
      expiresAt: expiresAt.toISOString(),
      status: OTP_STATUS.PENDING,
    });

    return { id, otpCode, expiresAt: expiresAt.toISOString() };
  }

  async verify(id: string, code: string, now: Date): Promise<VerifyOtpResult> {
    const record = await this.store.findById(id);
    if (record === undefined) {
      return { status: "invalid" };
    }

    if (record.status === OTP_STATUS.LOCKED) {
      return { status: OTP_STATUS.LOCKED };
    }
    if (record.status === OTP_STATUS.VERIFIED) {
      return { status: "invalid" };
    }
    if (now.getTime() >= Date.parse(record.expiresAt)) {
      await this.store.update({ ...record, status: OTP_STATUS.EXPIRED });
      return { status: OTP_STATUS.EXPIRED };
    }

    const [saltHex] = record.otpHash.split(":");
    if (saltHex === undefined) {
      throw new Error(`Malformed otpHash for record ${id}`);
    }
    const candidate = hashOtpCode(code, Buffer.from(saltHex, "hex"));
    if (candidate === record.otpHash) {
      await this.store.update({ ...record, status: OTP_STATUS.VERIFIED });
      return { status: OTP_STATUS.VERIFIED };
    }

    const attempts = record.attempts + 1;
    const rowStatus = attempts >= this.maxAttempts ? OTP_STATUS.LOCKED : OTP_STATUS.PENDING;
    await this.store.update({ ...record, attempts, status: rowStatus });
    // The outcome for the caller is "invalid"; the row keeps its state.
    return { status: rowStatus === OTP_STATUS.LOCKED ? OTP_STATUS.LOCKED : "invalid" };
  }
}
