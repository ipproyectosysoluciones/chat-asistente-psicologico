import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { signAccessToken, verifyAccessToken, type JwtConfig } from "../src/server/auth/jwt";

/**
 * HS256 JWT (design §3.3): 15-min pilot access tokens with claims
 * `{ sub, role, exp }`. No external jwt dependency — the sign/verify pair is
 * the whole security surface, so malformed / expired / tampered paths are
 * covered explicitly. verifyAccessToken returns a discriminated union
 * (`{ ok: true, claims }` | `{ ok: false, error }`) — expected auth failures
 * are values, never thrown exceptions.
 */

const config: JwtConfig = { secret: "s".repeat(32), ttlSeconds: 900 };

describe("signAccessToken / verifyAccessToken", () => {
  it("round-trips sub + role claims", () => {
    const token = signAccessToken(config, { sub: "user-1", role: "admin" });
    const verified = verifyAccessToken(config, token);
    expect(verified).toMatchObject({ ok: true });
    if (verified.ok) {
      const iat = verified.claims.iat;
      expect(verified.claims).toMatchObject({ sub: "user-1", role: "admin" });
      expect(iat).toBeTypeOf("number");
      expect(verified.claims.exp).toBe((iat ?? 0) + 900);
    }
  });

  it("accepts supervisor tokens", () => {
    const token = signAccessToken(config, { sub: "user-2", role: "supervisor" });
    const verified = verifyAccessToken(config, token);
    expect(verified).toMatchObject({ ok: true });
    if (verified.ok) {
      expect(verified.claims.role).toBe("supervisor");
    }
  });

  it("expires tokens after the TTL (exp claim enforced)", () => {
    const token = signAccessToken(config, {
      sub: "user-1",
      role: "admin",
      iat: Date.UTC(2026, 7, 13, 12, 0, 0) / 1000,
      exp: Date.UTC(2026, 7, 13, 12, 0, 0) / 1000 + 10,
    });
    const verified = verifyAccessToken(config, token);
    expect(verified).toMatchObject({ ok: false, error: { code: "expired" } });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signAccessToken(config, { sub: "user-1", role: "admin" });
    const other: JwtConfig = { secret: "x".repeat(32), ttlSeconds: 900 };
    expect(verifyAccessToken(other, token)).toMatchObject({
      ok: false,
      error: { code: "bad_signature" },
    });
  });

  it("rejects a tampered payload", () => {
    const token = signAccessToken(config, { sub: "user-1", role: "admin" });
    const [header, payload, signature] = token.split(".");
    // Flip a char in the payload, keep the signature → signature mismatch.
    const tampered = `${header}.${payload?.slice(0, -2) ?? ""}x.${signature}`;
    expect(verifyAccessToken(config, tampered)).toMatchObject({
      ok: false,
      error: { code: "bad_signature" },
    });
  });

  it("rejects a malformed token (not 3 dot-parts)", () => {
    expect(verifyAccessToken(config, "not-a-jwt")).toMatchObject({
      ok: false,
      error: { code: "malformed" },
    });
  });

  it("rejects a token whose header algorithm is not HS256", () => {
    const token = signAccessToken(config, { sub: "user-1", role: "admin" });
    const [, payload, signature] = token.split(".");
    const badHeader = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" })
    ).toString("base64url");
    const forged = `${badHeader}.${payload}.${signature}`;
    expect(verifyAccessToken(config, forged)).toMatchObject({
      ok: false,
      error: { code: "bad_alg" },
    });
  });

  it("rejects tokens with non-string/unknown claims", () => {
    const token = signAccessToken(config, { sub: "user-1", role: "admin" });
    const [header] = token.split(".");
    // Re-sign a malformed payload with the real secret so the signature is
    // valid and the claim-shape validation is what rejects it.
    const badPayload = Buffer.from(
      JSON.stringify({ sub: 42, role: "king", exp: 9999999999 })
    ).toString("base64url");
    const badSignature = createHmac("sha256", config.secret)
      .update(`${header}.${badPayload}`)
      .digest("base64url");
    expect(verifyAccessToken(config, `${header}.${badPayload}.${badSignature}`)).toMatchObject({
      ok: false,
      error: { code: "malformed" },
    });
  });

  it("rejects a header segment decoding to the JSON literal null", () => {
    // base64url("null") is "bnVsbA": JSON.parse returns null without
    // throwing, so property access must stay guarded (regression for a
    // 500-instead-of-401 defect caught by GGA).
    const nullHeader = Buffer.from("null").toString("base64url");
    expect(verifyAccessToken(config, `${nullHeader}.e30.e30`)).toMatchObject({
      ok: false,
      error: { code: "bad_alg" },
    });
  });

  it("rejects a payload segment decoding to the JSON literal null", () => {
    // Re-sign with the real secret so the signature is valid and the
    // claim-shape validation is what rejects it.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url"
    );
    const nullPayload = Buffer.from("null").toString("base64url");
    const nullSignature = createHmac("sha256", config.secret)
      .update(`${header}.${nullPayload}`)
      .digest("base64url");
    expect(verifyAccessToken(config, `${header}.${nullPayload}.${nullSignature}`)).toMatchObject({
      ok: false,
      error: { code: "malformed" },
    });
  });
});
