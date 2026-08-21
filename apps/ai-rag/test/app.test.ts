import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { createLogger } from "@chatcap/telemetry";
import type { GateResult } from "@chatcap/shared-types";

import { createApp, type AppDeps } from "../src/app";
import type { RagProcessResponse } from "../src/process-response";
import type { RagProcessRequest } from "../src/process-request";

/**
 * Health/readiness contract (task 3.1, design §3.1): `/healthz` is pure
 * liveness; `/readyz` probes the real dependencies (pg, redis). The RAG
 * router (when wired) enforces internal-token auth on /internal/rag/process
 * and answers RFC 7807 problem+json for bad input/unauthenticated calls.
 */

const silentLogger = createLogger({
  level: "silent",
  destination: { write: () => {} },
});
const healthyCheck = { check: async () => {} };
const downCheck = {
  check: async () => {
    throw new Error("dependency down");
  },
};

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
  it("returns 200 ready when database and redis are healthy", async () => {
    const baseUrl = await startServer(makeDeps());
    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      checks: { database: "ok", redis: "ok" },
    });
  });

  it("returns 503 with per-check status when a dependency is down", async () => {
    const baseUrl = await startServer(
      makeDeps({
        readiness: { database: downCheck, redis: healthyCheck },
      })
    );
    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "unready",
      checks: { database: "error", redis: "ok" },
    });
  });
});

describe("RAG internal endpoint (task 3.1 ACs)", () => {
  const gateResult: GateResult = {
    verdict: "emit",
    cosine: 0.9,
    nli: { verdict: "entailment", confidence: 0.99 },
    guardrail: { blocked: false, deviationTerms: [], level: "none" },
    chunks: [],
  };

  const emittedResponse: RagProcessResponse = {
    kind: "emitted",
    answer: "respuesta",
    trace: {
      traceId: "t1",
      sessionId: "s1",
      risk: "normal",
      classification: { model: "gpt-4o-mini", risk: "normal", confidence: 1 },
      retrieval: {
        model: "text-embedding-3-small",
        topK: 0,
        hnsw: { efSearch: 40 },
        chunks: [],
      },
      generation: { model: "gpt-4o", temperature: 0, promptCharCount: 0 },
      gate: gateResult,
      emitted: true,
      createdAt: "2026-08-10T00:00:00.000Z",
    },
  };

  function depsWithPipeline(
    pipeline: (input: RagProcessRequest) => Promise<RagProcessResponse>
  ): AppDeps {
    return makeDeps({
      rag: {
        logger: silentLogger,
        internalTokens: ["internal-secret"],
        pipeline,
      },
    });
  }

  it("rejects an unauthenticated POST with 401 problem+json", async () => {
    const baseUrl = await startServer(
      depsWithPipeline(async () => emittedResponse)
    );

    const response = await fetch(`${baseUrl}/internal/rag/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hola" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain(
      "application/problem+json"
    );
    expect(
      (await response.json()) as Record<string, unknown>
    ).toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("rejects a malformed body with 400 problem+json", async () => {
    const baseUrl = await startServer(
      depsWithPipeline(async () => emittedResponse)
    );

    const response = await fetch(`${baseUrl}/internal/rag/process`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": "internal-secret",
      },
      body: JSON.stringify({ sessionId: "s1" }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type") ?? "").toContain(
      "application/problem+json"
    );
    expect(
      (await response.json()) as Record<string, unknown>
    ).toMatchObject({ status: 400, code: "validation_error" });
  });

  it("returns the pipeline outcome for a valid authenticated request", async () => {
    const baseUrl = await startServer(
      depsWithPipeline(async () => emittedResponse)
    );

    const response = await fetch(`${baseUrl}/internal/rag/process`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": "internal-secret",
      },
      body: JSON.stringify({ sessionId: "s1", message: "hola" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(emittedResponse);
  });
});

describe("not found", () => {
  it("answers an unknown route with 404 problem+json", async () => {
    const baseUrl = await startServer(makeDeps());

    const response = await fetch(`${baseUrl}/nope`);

    expect(response.status).toBe(404);
    expect(
      (await response.json()) as Record<string, unknown>
    ).toMatchObject({ status: 404, code: "not_found" });
  });
});
