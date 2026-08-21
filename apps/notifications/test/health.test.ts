import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { createLogger } from "@chatcap/telemetry";

import { createApp, type AppDeps } from "../src/app";

/**
 * Health/readiness contract (design §3.1: `/healthz` `/readyz` used by
 * Caddy/Docker healthchecks). Liveness answers "process up"; readiness
 * answers "can I serve traffic" by probing the real dependencies (pg, redis).
 */
const silentLogger = createLogger({ level: "silent", destination: { write: () => {} } });

const healthyCheck = { check: async () => {} };
const downCheck = { check: async () => { throw new Error("dependency down"); } };

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    logger: silentLogger,
    readiness: { database: healthyCheck, redis: healthyCheck },
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

async function startServer(deps: AppDeps): Promise<string> {
  const app = createApp(deps);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("liveness /healthz", () => {
  it("returns 200 ok without probing dependencies", async () => {
    const baseUrl = await startServer(makeDeps());
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("readiness /readyz", () => {
  it("returns 200 ready when database and redis checks pass", async () => {
    const baseUrl = await startServer(makeDeps());
    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      checks: { database: "ok", redis: "ok" },
    });
  });

  it("returns 503 unready and reports the failing dependency", async () => {
    const baseUrl = await startServer(
      makeDeps({ readiness: { database: downCheck, redis: healthyCheck } })
    );
    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "unready",
      checks: { database: "error", redis: "ok" },
    });
  });
});

describe("unknown routes", () => {
  it("returns RFC 7807 problem+json 404 with a stable error code", async () => {
    const baseUrl = await startServer(makeDeps());
    const response = await fetch(`${baseUrl}/api/v1/nope`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 404,
      code: "not_found",
      title: "Not Found",
    });
    expect(typeof body.type).toBe("string");
  });
});
