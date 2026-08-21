import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal HS256 JWT (task 5.1) — hand-rolled on node:crypto to avoid a
 * dependency for two primitives. Claims are `{ sub, role, exp }`; access
 * tokens are short-lived (15-min pilot default) and carry no PII beyond the
 * subject id + role.
 *
 * Security properties kept on purpose:
 * - alg is pinned to HS256; a token whose header says otherwise is rejected
 *   (no algorithm-confusion surface).
 * - Signature check is constant-time via timingSafeEqual.
 * - `sub` must be a UUID (validated by the authenticate middleware downstream).
 */

export interface JwtConfig {
  secret: string;
  /** TTL in seconds for issued access tokens. */
  ttlSeconds: number;
}

export interface JwtClaims {
  sub: string;
  role: string;
  /** Unix seconds (expiry, inclusive). */
  exp: number;
  iat?: number;
}

const ALG = "HS256";
const HEADER = Buffer.from(
  JSON.stringify({ alg: ALG, typ: "JWT" })
).toString("base64url");

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(secret: string, signingInput: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signAccessToken(
  config: JwtConfig,
  claims: Pick<JwtClaims, "sub" | "role"> & Partial<Pick<JwtClaims, "exp" | "iat">>
): string {
  const iat = claims.iat ?? Math.floor(Date.now() / 1000);
  const exp = claims.exp ?? iat + config.ttlSeconds;
  const payload = b64url(JSON.stringify({ ...claims, iat, exp }));
  const signingInput = `${HEADER}.${payload}`;
  return `${signingInput}.${sign(config.secret, signingInput)}`;
}

export interface JwtVerifyError {
  code: "malformed" | "bad_signature" | "bad_alg" | "expired";
}

export function verifyAccessToken(
  config: JwtConfig,
  token: string
): { ok: true; claims: JwtClaims } | { ok: false; error: JwtVerifyError } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: { code: "malformed" } };
  }
  // All three parts exist: the length check above proves the tuple shape.
  const header = parts[0]!;
  const payload = parts[1]!;
  const signature = parts[2]!;

  let decodedHeader: { alg?: string } | null;
  try {
    // JSON.parse can return null for the literal token `null` without
    // throwing; property access on null must stay inside the guard so
    // attacker-controlled input yields a clean 401, never a 500.
    decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: { code: "malformed" } };
  }
  if (decodedHeader === null || decodedHeader.alg !== ALG) {
    return { ok: false, error: { code: "bad_alg" } };
  }

  const expected = sign(config.secret, `${header}.${payload}`);
  if (!safeEqual(signature, expected)) {
    return { ok: false, error: { code: "bad_signature" } };
  }

  let claims: JwtClaims | null;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: { code: "malformed" } };
  }
  if (
    claims === null ||
    typeof claims.sub !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, error: { code: "malformed" } };
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, error: { code: "expired" } };
  }

  return { ok: true, claims };
}
