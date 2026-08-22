import express, { type Express } from "express";

import type { Logger } from "@chatcap/telemetry";

import { notFoundHandler } from "./errors";
import { createIngestRouter, type IngestDeps } from "./ingest";

/**
 * Express app factory (task 4.1 scaffold). `/healthz` is pure liveness;
 * `/readyz` probes the real dependencies (postgres via the chat database,
 * ai-rag) so Docker healthchecks route traffic only to a service that can
 * serve (design §3.1). The provider is deliberately NOT part of readiness:
 * a reconnecting WhatsApp channel is handled gracefully, not killed (4.7).
 * The supervisor-reply ingest router (task 5.3) is mounted when the
 * composition root wires `ingest` — omitted in health-only deployments.
 */

export interface ReadinessCheck {
  check(): Promise<void>;
}

export interface AppDeps {
  logger: Logger;
  readiness: {
    database: ReadinessCheck;
    aiRag: ReadinessCheck;
  };
  ingest?: IngestDeps;
}

export function createApp(deps: AppDeps): Express {
  const app: Express = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    const checks: Record<string, "ok" | "error"> = {};
    let ready = true;
    const probes: Array<[string, ReadinessCheck]> = [
      ["database", deps.readiness.database],
      ["aiRag", deps.readiness.aiRag],
    ];
    for (const [name, check] of probes) {
      try {
        await check.check();
        checks[name] = "ok";
      } catch {
        checks[name] = "error";
        ready = false;
      }
    }
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "unready",
      checks,
    });
  });

  // Supervisor-reply ingest (task 5.3, REQ-DASH-3): internal-token gated,
  // mounted before the JSON 404 handler.
  if (deps.ingest !== undefined) {
    app.use(createIngestRouter(deps.ingest));
  }

  app.use(notFoundHandler);

  return app;
}
