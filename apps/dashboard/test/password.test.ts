import { describe, expect, it } from "vitest";

import {
  hashPassword,
  verifyPassword,
} from "../src/server/auth/password";

/**
 * Password hashing (design §3.3): env-bootstrapped admins and supervisors
 * store bcrypt hashes; login compares with timing-safe bcrypt.compare.
 * Verification must never throw on a malformed stored hash — that would turn
 * a corrupt credential into a 500 instead of a clean 401.
 *
 * Tests hash with cost 4 (fast). Production defaults to BCRYPT_ROUNDS=12; the
 * runtime only verifies precomputed hashes, it never hashes on the hot path.
 */

const TEST_ROUNDS = 4;

describe("verifyPassword", () => {
  it("accepts the correct password for a freshly hashed value", async () => {
    const hash = await hashPassword("correct horse battery staple", TEST_ROUNDS);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple", TEST_ROUNDS);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("rejects empty input against a real hash", async () => {
    const hash = await hashPassword("secret", TEST_ROUNDS);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("returns false (never throws) for a malformed stored hash", async () => {
    await expect(verifyPassword("secret", "not-a-bcrypt-hash")).resolves.toBe(false);
  });
});
