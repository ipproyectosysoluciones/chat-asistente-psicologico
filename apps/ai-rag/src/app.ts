import express, { type Express } from "express";

import type { Logger } from "@chatcap/telemetry";

import { notFoundHandler } from "./errors";
import { createRagRouter, type RagRouterDeps } from "./rag-router";

/**
 * Express app factory (task 3.1 scaffold). `/healthz` is pure liveness;
 * `/readyz` probes the real dependencies (pg, redis) so Docker healthchecks
 * route traffic only to a service that can serve (design §3.1). The RAG
 * internal router is mounted when `rag` deps are provided — keeps
 * health-only deployments dependency-free.
 */

export interface ReadinessCheck {
  check(): Promise<void>;
}

export interface AppDeps {
  logger: Logger;
  readiness: {
    database: ReadinessCheck;
    redis: ReadinessCheck;
  };
  rag?: RagRouterDeps;
}

export function createApp(deps: AppDeps): Express {
  const app: Express = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    const checks: Record<string, "ok" | "error"> = {};
    let ready = true;
    const probes: Array<[string, ReadinessCheck]> = [
      ["database", deps.readiness.database],
      ["redis", deps.readiness.redis],
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

  if (deps.rag !== undefined) {
    app.use(createRagRouter(deps.rag));
  }

  app.use(notFoundHandler);

  return app;
}
