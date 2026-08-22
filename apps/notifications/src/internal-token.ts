import { createHash, timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { problemResponse } from "./errors";

/**
 * Internal-token auth (task 2.3/2.4, REQ-DASH-1): services authenticate to
 * supervisor endpoints with one of the `X_INTERNAL_TOKENS`. Comparison is
 * constant-time and both sides are sha256-hashed first so the token length
 * leaks nothing. Shared by the Socket.io handshake gate (2.3) and the
 * lifecycle HTTP router (2.4) so auth is enforced identically everywhere.
 */

/** Constant-time token comparison (sha256 both sides to hide length). */
export function tokensEqual(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/**
 * Express middleware: rejects requests without a matching `x-internal-token`
 * header with 401. No audit row is written here — an unauthenticated caller
 * has no identity to attribute (REQ-DASH-8 applies to authenticated actors).
 */
export function internalTokenMiddleware(
  internalTokens: readonly string[]
): RequestHandler {
  return (req, res, next) => {
    const token = req.header("x-internal-token");
    if (
      typeof token === "string" &&
      internalTokens.some((expected) => tokensEqual(token, expected))
    ) {
      next();
      return;
    }
    problemResponse(res, {
      type: "https://api.chatcap.app/errors/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "A valid internal service token is required.",
      code: "unauthorized",
    });
  };
}
