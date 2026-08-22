import { createHash, timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { problemResponse } from "./errors";

/**
 * Internal-token auth (task 5.3, design §8.3): services authenticate to the
 * /internal/* endpoints with one of the `X_INTERNAL_TOKENS`. Comparison is
 * constant-time and both sides are sha256-hashed first so the token length
 * leaks nothing. Same contract as the ai-rag and notifications services.
 */

/** Constant-time token comparison (sha256 both sides to hide length). */
export function tokensEqual(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/**
 * Express middleware: rejects requests without a matching `x-internal-token`
 * header with 401. Applied to the whole /internal/messages/* router so no
 * supervisor-reply stage is reachable from outside the private network.
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
