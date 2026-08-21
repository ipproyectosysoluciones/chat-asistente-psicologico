import express, { type Express } from "express";

import type { Logger } from "@chatcap/telemetry";

import type { IngestionDeps } from "./ingest-router";
import { createIngestionRouter } from "./ingest-router";
import type { RemovalDeps } from "./removal-router";
import { createRemovalRouter } from "./removal-router";

/**
 * App factory (task 6.1/6.6): health/readiness probes + the internal ingestion
 * router (POST /documents) and the manual-removal router (DELETE
 * /:docId/chunks/:chunkIndex). Auth is internal-token everywhere (the
 * dashboard verifies the supervisor JWT upstream over the private network).
 */

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface AppDeps {
  logger: Logger;
  internalTokens: readonly string[];
  ingestion: IngestionDeps;
  removal: RemovalDeps;
  readiness: {
    database: ReadinessProbe;
  };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    try {
      await deps.readiness.database.check();
      res.status(200).json({ status: "ready" });
    } catch {
      deps.logger.error("readyz probe failed", new Error("database unreachable"));
      res.status(503).json({ status: "unready" });
    }
  });

  app.use("/api/v1/documents", createIngestionRouter(deps.ingestion));
  app.use("/api/v1/documents", createRemovalRouter(deps.removal));

  return app;
}
