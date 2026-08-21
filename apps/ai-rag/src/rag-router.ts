import { Router, type RequestHandler } from "express";
import { json } from "express";

import type { Logger } from "@chatcap/telemetry";
import { VectorIndexMissingError } from "@chatcap/db-schema";

import { internalTokenMiddleware } from "./internal-token";
import { problemResponse, UpstreamDependencyError } from "./errors";
import {
  parseRagProcessRequest,
  type RagProcessRequest,
} from "./process-request";
import type { RagProcessResponse } from "./process-response";

/**
 * RAG process router (task 3.1): `POST /internal/rag/process`. Auth first
 * (internal token), then zod validation of the body (400), then the pipeline.
 * Upstream failures (OpenAI, pgvector) map to 502 `upstream_failed`; anything
 * else is a bug and maps to 500 `internal_error` with a debug-safe message.
 */

export interface RagRouterDeps {
  logger: Logger;
  internalTokens: readonly string[];
  pipeline: (input: RagProcessRequest) => Promise<RagProcessResponse>;
}

export function createRagRouter(deps: RagRouterDeps): Router {
  const router = Router();

  // The whole /internal/rag/* surface is private-network-only (design §8.3).
  router.use(internalTokenMiddleware(deps.internalTokens));
  router.use(json({ limit: "16kb" }));

  router.post("/internal/rag/process", async (req, res) => {
    const input = parseRagProcessRequest(req.body);
    if (input === undefined) {
      problemResponse(res, {
        type: "https://api.chatcap.app/errors/validation_error",
        title: "Invalid Request",
        status: 400,
        detail: "Expected { sessionId: string, message: string }.",
        code: "validation_error",
      });
      return;
    }
    try {
      const outcome = await deps.pipeline(input);
      res.status(200).json(outcome);
    } catch (error) {
      if (
        error instanceof UpstreamDependencyError ||
        error instanceof VectorIndexMissingError
      ) {
        problemResponse(res, {
          type: "https://api.chatcap.app/errors/upstream_failed",
          title: "Upstream Failure",
          status: 502,
          detail: "A dependency of the RAG pipeline is unavailable.",
          code: "upstream_failed",
        });
        return;
      }
      deps.logger.error("rag process failed", { error: String(error) });
      problemResponse(res, {
        type: "https://api.chatcap.app/errors/internal_error",
        title: "Internal Error",
        status: 500,
        detail: "The request could not be processed.",
        code: "internal_error",
      });
    }
  });

  return router;
}

// Re-exported so callers can attach the router with a stable type.
export type RagProcessHandler = RequestHandler;
