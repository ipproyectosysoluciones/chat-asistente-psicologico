import type { ActorType } from "@chatcap/shared-types";
import type { RequestHandler, Response } from "express";
import { Router } from "express";

import { requireInternalToken } from "./ingest-router";

/**
 * Manual chunk removal (task 6.6, REQ-INGEST-6): supervisors remove chunks from
 * the dashboard. Auth is the internal token (the dashboard already verified the
 * JWT supervisor session upstream over the private network); the actor id is
 * forwarded by the dashboard via x-actor-id for the audit trail. Every removal
 * is audit-logged with PII-free meta BEFORE the delete runs.
 */
export interface RemovalDeps {
  removeChunk: (docId: string, chunkIndex: number) => Promise<{ deleted: number }>;
  insertAudit: (entry: AuditEntryInput) => Promise<void>;
  internalTokens: readonly string[];
}

export interface AuditEntryInput {
  actorType: ActorType;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonError(res: Response, status: number, code: string, detail: string): void {
  res.status(status).json({
    type: `https://api.chatcap.app/errors/${code}`,
    title: code,
    status,
    detail,
    code,
  });
}

/** Auth + audit + delete for DELETE /:docId/chunks/:chunkIndex.
 * Exported for direct unit testing with mock req/res. */
export function removeChunkHandler(deps: RemovalDeps): RequestHandler {
  return async (req, res) => {
    // Auth: dashboard proved it already authorized a supervisor; ingestion
    // still requires the internal token so it never trusts a network hop.
    if (!requireInternalToken(req, res, deps.internalTokens)) {
      return;
    }

    // why: Express types req.params as Record<string, string>; route params are
    // guaranteed strings for this path, so narrowing is safe here.
    const { docId, chunkIndex } = req.params as { docId: string; chunkIndex: string };
    const actorId = req.header("x-actor-id");

    if (!UUID_V4.test(docId)) {
      jsonError(res, 400, "validation_error", "docId must be a UUID.");
      return;
    }
    const idx = Number.parseInt(chunkIndex, 10);
    if (!Number.isFinite(idx) || idx < 0) {
      jsonError(res, 400, "validation_error", "chunkIndex must be a non-negative integer.");
      return;
    }

    await deps.insertAudit({
      actorType: "supervisor",
      actorId,
      action: "vector_chunk.removed",
      resourceType: "vector_chunk",
      resourceId: `${docId}:${idx}`,
      reason: "manual supervisor removal (REQ-INGEST-6)",
      meta: { docId, chunkIndex: idx },
    });

    const { deleted } = await deps.removeChunk(docId, idx);
    if (deleted === 0) {
      jsonError(res, 404, "not_found", `No chunk ${idx} in document ${docId}.`);
      return;
    }

    res.status(204).json({ status: "deleted", docId, chunkIndex: idx });
  };
}

/** Builds the express Router for manual removal. */
export function createRemovalRouter(deps: RemovalDeps): Router {
  const router = Router();
  router.delete("/:docId/chunks/:chunkIndex", removeChunkHandler(deps));
  return router;
}
