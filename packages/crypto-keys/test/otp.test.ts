import { describe, expect, test } from "vitest";

import {
  OTP_DIGITS,
  OTP_LIFETIME_MS,
  OTP_MAX_ATTEMPTS,
  OtpService,
  hashOtpCode,
  type OtpStore,
  type StoredOtp,
} from "../src/index";

/** In-memory OtpStore: fixture double for the persistence contract (REQ-KEY-6). */
class MemoryOtpStore implements OtpStore {
  readonly records = new Map<string, StoredOtp>();

  async insert(record: StoredOtp): Promise<void> {
    this.records.set(record.id, record);
  }

  async findById(id: string): Promise<StoredOtp | undefined> {
    return this.records.get(id);
  }

  async update(record: StoredOtp): Promise<void> {
    this.records.set(record.id, record);
  }
}

const T0 = new Date("2026-08-09T12:00:00.000Z");

describe("OTP issue (REQ-KEY-6, design §6.1)", () => {
  test("issues a 6-digit numeric code with a 10-minute TTL, storing only a salted hash", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });

    const issued = await service.issue("consent_1", T0);

    expect(issued.otpCode).toMatch(/^\d{6}$/);
    expect(issued.expiresAt).toBe(new Date(T0.getTime() + OTP_LIFETIME_MS).toISOString());

    const stored = store.records.get(issued.id);
    expect(stored?.otpHash).toBeDefined();
    // The plaintext code is NEVER stored (AGENTS.md: no OTP plaintext at rest).
    expect(stored?.otpHash.includes(issued.otpCode)).toBe(false);
    expect(stored?.otpHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(stored?.attempts).toBe(0);
    expect(stored?.status).toBe("pending");
    expect(stored?.consentId).toBe("consent_1");
  });

  test("matches the golden salted-SHA-256 vector for a fixed code and salt", () => {
    expect(
      hashOtpCode("123456", Buffer.from("a1b2c3d4e5f60718", "hex"))
    ).toBe(
      "a1b2c3d4e5f60718:357f2b6e481272d101f23cf67f09c114aa06299b3cc60ad1c90a7b493f659eb2"
    );
  });

  test("each issue produces a distinct record (a fresh OTP per request)", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });

    const a = await service.issue("consent_1", T0);
    const b = await service.issue("consent_1", T0);

    expect(a.id).not.toBe(b.id);
    expect(store.records.size).toBe(2);
  });

  test("honors custom TTL and max-attempts options", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store, ttlMs: 60_000, maxAttempts: 2 });

    const { id, otpCode } = await service.issue("consent_1", T0);
    const stored = store.records.get(id);
    expect(stored?.expiresAt).toBe(new Date(T0.getTime() + 60_000).toISOString());

    expect(await service.verify(id, "000000", T0)).toEqual({ status: "invalid" });
    expect(await service.verify(id, "000000", T0)).toEqual({ status: "locked" });
    // Even the correct code is refused once the OTP is locked.
    expect(await service.verify(id, otpCode, T0)).toEqual({ status: "locked" });
  });

  test("issues a uuid id that fits the otp_codes uuid column (task 4.9 chat-side)", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });

    const issued = await service.issue("consent_1", T0);

    // otp_codes.id is a uuid column (migration 0001); a 24-char hex id would
    // fail the insert, so the issued id must be a uuid v4 (REQ-KEY-6 persist).
    expect(issued.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe("OTP verify (REQ-KEY-6)", () => {
  test("verifies a correct code within the TTL", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });
    const { id, otpCode } = await service.issue("consent_1", T0);

    const result = await service.verify(
      id,
      otpCode,
      new Date(T0.getTime() + 5 * 60 * 1000)
    );

    expect(result).toEqual({ status: "verified" });
    expect(store.records.get(id)?.status).toBe("verified");
  });

  test("refuses an incorrect code and counts the attempt without locking", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });
    const { id } = await service.issue("consent_1", T0);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.verify(id, "000000", T0)).toEqual({ status: "invalid" });
    }
    expect(store.records.get(id)?.attempts).toBe(4);
    expect(store.records.get(id)?.status).toBe("pending");
  });

  test("locks the OTP after 5 failed attempts and refuses the correct code once locked", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });
    const { id, otpCode } = await service.issue("consent_1", T0);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await service.verify(id, "000000", T0);
      expect(result.status).toBe(attempt < 4 ? "invalid" : "locked");
    }
    expect(store.records.get(id)?.status).toBe("locked");
    expect(await service.verify(id, otpCode, T0)).toEqual({ status: "locked" });
  });

  test("refuses an expired OTP even with the correct code (time injection)", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });
    const { id, otpCode } = await service.issue("consent_1", T0);

    const afterTtl = new Date(T0.getTime() + OTP_LIFETIME_MS + 1);
    expect(await service.verify(id, otpCode, afterTtl)).toEqual({ status: "expired" });
    expect(store.records.get(id)?.status).toBe("expired");
  });

  test("boundary: valid 1ms before expiry, expired at exactly the expiry instant", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });

    const stillValid = await service.issue("consent_1", T0);
    const justBefore = new Date(T0.getTime() + OTP_LIFETIME_MS - 1);
    expect(await service.verify(stillValid.id, stillValid.otpCode, justBefore)).toEqual({
      status: "verified",
    });

    const atExpiry = await service.issue("consent_1", T0);
    const exactly = new Date(T0.getTime() + OTP_LIFETIME_MS);
    expect(await service.verify(atExpiry.id, atExpiry.otpCode, exactly)).toEqual({
      status: "expired",
    });
  });

  test("a verified OTP cannot be reused", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });
    const { id, otpCode } = await service.issue("consent_1", T0);

    expect(await service.verify(id, otpCode, T0)).toEqual({ status: "verified" });
    expect(await service.verify(id, otpCode, T0)).toEqual({ status: "invalid" });
  });

  test("an unknown otp id is invalid", async () => {
    const service = new OtpService({ store: new MemoryOtpStore() });
    expect(await service.verify("missing-id", "123456", T0)).toEqual({ status: "invalid" });
  });

  test("AC: an expired OTP cannot gate a QR renewal", async () => {
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });
    const { id, otpCode } = await service.issue("consent_1", T0);

    const expired = await service.verify(
      id,
      otpCode,
      new Date(T0.getTime() + OTP_LIFETIME_MS + 1)
    );
    // The QR-renewal path only proceeds on a "verified" result; anything else
    // refuses the QR and a fresh OTP must be issued (REQ-KEY-6 scenario).
    expect(expired.status === "verified").toBe(false);
    expect(expired.status).toBe("expired");
  });
});

describe("OTP code shape", () => {
  test("OTP_DIGITS is the 6-digit contract used by issue", async () => {
    expect(OTP_DIGITS).toBe(6);
    const store = new MemoryOtpStore();
    const service = new OtpService({ store });
    const issued = await service.issue("consent_1", T0);
    expect(issued.otpCode).toHaveLength(OTP_DIGITS);
    expect(issued.otpCode).toMatch(/^\d{6}$/);
  });

  test("OTP_MAX_ATTEMPTS is the 5-attempt lockout contract", () => {
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(OTP_LIFETIME_MS).toBe(10 * 60 * 1000);
  });
});
