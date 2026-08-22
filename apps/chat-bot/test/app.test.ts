import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { createLogger } from "@chatcap/telemetry";

import { createApp, type AppDeps, type ReadinessCheck } from "../src/app";

/**
 * Health/readiness contract (task 4.1, design §3.1): `/healthz` is pure
 * liveness; `/readyz` probes the real dependencies (postgres, ai-rag) so
 * traffic is routed away while a dependency is degraded. The provider is
 * deliberately NOT part of readiness — a reconnecting WhatsApp channel is
 * handled gracefully (4.7), not killed.
 */

const silentLogger = createLogger({
  level: "silent",
  destination: { write: () => {} },
});
const healthyCheck: ReadinessCheck = { check: async () => {} };
const downCheck: ReadinessCheck = {
  check: async () => {
    throw new Error("dependency down");
  },
};

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    logger: silentLogger,
    readiness: { database: healthyCheck, aiRag: healthyCheck },
    ...overrides,
  };
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

async function listen(deps: AppDeps): Promise<{ baseUrl: string }> {
  const app = createApp(deps);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a port");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("chat-bot health endpoints (task 4.1)", () => {
  it("healthz answers ok", async () => {
    const { baseUrl } = await listen(makeDeps());
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("readyz reports ready when every dependency is healthy", async () => {
    const { baseUrl } = await listen(makeDeps());
    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      checks: { database: "ok", aiRag: "ok" },
    });
  });

  it("readyz reports unready and 503 when a dependency is down", async () => {
    const { baseUrl } = await listen(
      makeDeps({ readiness: { database: downCheck, aiRag: healthyCheck } })
    );
    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unready",
      checks: { database: "error", aiRag: "ok" },
    });
  });

  it("answers RFC 7807 problem+json for unknown routes", async () => {
    const { baseUrl } = await listen(makeDeps());
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      type: "https://api.chatcap.app/errors/not_found",
      code: "not_found",
    });
  });
});
