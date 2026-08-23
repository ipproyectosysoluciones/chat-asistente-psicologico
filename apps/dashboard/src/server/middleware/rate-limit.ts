import type { Request, RequestHandler, Response } from "express";
import { RateLimiterMemory } from "rate-limiter-flexible";

/**
 * Rate-limit middleware (design §B1–B5, spec: edge-rate-limiting).
 *
 * Factory-based composition mirroring `createAuthenticate`/`createAuthorize`.
 * Uses `RateLimiterMemory` (single dashboard instance — B5).
 * Sets `X-RateLimit-*` headers on success; 429 + `Retry-After` on exceed.
 *
 * The limiter instance owns the `points`/`duration` config. Create it with
 * the desired limits and pass it to this factory — no overrides needed.
 */

/** Re-export the type so consumers can type their deps without importing the class. */
export type { RateLimiterMemory } from "rate-limiter-flexible";

export interface RateLimitConfig {
  /** Maximum requests allowed in the window. */
  points: number;
  /** Window duration in seconds. */
  duration: number;
}

/** Creates an in-memory rate limiter with the given config. */
export function createRateLimiter(
  config: RateLimitConfig = { points: 20, duration: 60 }
): RateLimiterMemory {
  return new RateLimiterMemory(config);
}

/**
 * Builds a rate-limit `RequestHandler` that:
 *   1. Resolves the per-user key via `getKey(req)`
 *   2. Consumes one point from the limiter
 *   3. On success: sets `X-RateLimit-Limit/Remaining/Reset` and calls `next()`
 *   4. On exceed: responds 429 with `Retry-After`
 *
 * @param limiter  Shared `RateLimiterMemory` instance (owns points/duration)
 * @param getKey   Key resolver — `req.body.email || req.ip` for login,
 *                 `req.principal.userId` for authenticated endpoints
 */
export function createCriticalRateLimit(
  limiter: RateLimiterMemory,
  getKey: (req: Request) => string
): RequestHandler {
  return async (req: Request, res: Response, next) => {
    const key = getKey(req);
    // limiter.points/duration are abstract properties on the base class;
    // the concrete RateLimiterMemory always sets them as plain numbers.
    const maxPoints = limiter.points as unknown as number;
    const maxDuration = limiter.duration as unknown as number;

    try {
      const result = await limiter.consume(key);
      res.setHeader("X-RateLimit-Limit", String(maxPoints));
      res.setHeader(
        "X-RateLimit-Remaining",
        String(Math.max(0, maxPoints - (result.consumedPoints ?? 0)))
      );
      res.setHeader(
        "X-RateLimit-Reset",
        String(Math.ceil(Date.now() / 1000 + maxDuration))
      );
      next();
    } catch (rejRes: unknown) {
      // rate-limiter-flexible rejects with a RateLimiterRes-shaped object
      const retryAfterSeconds =
        rejRes instanceof Object && "msBeforeNext" in rejRes
          ? Math.ceil(
              // RateLimiterRes has msBeforeNext in milliseconds
              (rejRes as { msBeforeNext: number }).msBeforeNext / 1000
            )
          : 1;
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        type: "urn:ietf:params:rfc:7807:problem-headers",
        title: "Too Many Requests",
        status: 429,
        detail: `Rate limit exceeded. Retry after ${retryAfterSeconds}s.`,
        code: "rate_limit_exceeded",
      });
    }
  };
}
