import { describe, expect, it } from "vitest";

import { hashContactKey } from "../src/contact-key";

/**
 * Contact-key hashing (task 4.1, REQ-CHATBOT-1/REQ-PRIVACY): provider
 * identifiers (phone/waid) are hashed with a deploy-scoped pepper before any
 * persistence or logging — the raw identifier never reaches the DB. Test
 * contract: determinism, salt sensitivity, format, and no identifier echo.
 */

const SALT = "x".repeat(16);

describe("hashContactKey (task 4.1 contact anonymization)", () => {
  it("returns a deterministic 64-char hex digest for the same input", () => {
    const first = hashContactKey("5491100000000", SALT);
    const second = hashContactKey("5491100000000", SALT);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
  });

  it("changes when the salt changes (pepper sensitivity)", () => {
    const withSaltA = hashContactKey("5491100000000", "a".repeat(16));
    const withSaltB = hashContactKey("5491100000000", "b".repeat(16));
    expect(withSaltA).not.toBe(withSaltB);
  });

  it("produces different digests for different identifiers", () => {
    const alice = hashContactKey("5491100000000", SALT);
    const bob = hashContactKey("5491100000001", SALT);
    expect(alice).not.toBe(bob);
  });

  it("never echoes the identifier in the digest", () => {
    const identifier = "5491100000000";
    expect(hashContactKey(identifier, SALT)).not.toContain(identifier);
  });
});
