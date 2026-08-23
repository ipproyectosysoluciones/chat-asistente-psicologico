import { afterEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import type { Server } from "node:http";

import {
  createCriticalRateLimit,
  createRateLimiter,
} from "../src/server/middleware/rate-limit";

/**
 * Rate-limit middleware (spec: edge-rate-limiting):
 *   - 429 after bound exceeded
 *   - Retry-After header present
 *   - X-RateLimit-* headers on success
 *   - Per-user isolation (separate keys don't collide)
 */

function appWithLimiter(
  limiter: ReturnType<typeof createRateLimiter>,
  getKey: (req: express.Request) => string
): Express {
  const app = express();
  app.use(express.json());
  app.post(
    "/test",
    createCriticalRateLimit(limiter, getKey),
    (_req, res) => {
      res.status(200).json({ ok: true });
    }
  );
  return app;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  servers.length = 0;
});

async function startServer(app: Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("rate-limit middleware", () => {
  it("returns 429 with Retry-After after exceeding limit", async () => {
    const limiter = createRateLimiter({ points: 3, duration: 1 });
    const app = appWithLimiter(limiter, () => "user-1");
    const baseUrl = await startServer(app);

    // First 3 should succeed
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/test`, { method: "POST" });
      expect(res.status).toBe(200);
    }
    // 4th should be 429
    const res = await fetch(`${baseUrl}/test`, { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("includes X-RateLimit-* headers on success", async () => {
    const limiter = createRateLimiter({ points: 5, duration: 60 });
    const app = appWithLimiter(limiter, () => "user-headers");
    const baseUrl = await startServer(app);

    const res = await fetch(`${baseUrl}/test`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("5");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(res.headers.get("x-ratelimit-reset")).toBeTruthy();
  });

  it("isolates per-user counters (different keys don't collide)", async () => {
    const limiter = createRateLimiter({ points: 2, duration: 60 });
    const app = appWithLimiter(limiter, (req) => {
      return (req.query.user as string) ?? "default";
    });
    const baseUrl = await startServer(app);

    // user-a uses 2 requests (limit reached)
    await fetch(`${baseUrl}/test?user=user-a`, { method: "POST" });
    await fetch(`${baseUrl}/test?user=user-a`, { method: "POST" });
    const blockedA = await fetch(`${baseUrl}/test?user=user-a`, {
      method: "POST",
    });
    expect(blockedA.status).toBe(429);

    // user-b should still be allowed
    const okB = await fetch(`${baseUrl}/test?user=user-b`, { method: "POST" });
    expect(okB.status).toBe(200);
  });
});
