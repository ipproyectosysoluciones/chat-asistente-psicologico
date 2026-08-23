import { Router, type Response } from "express";
import { z } from "zod";

import type { RetrievedChunk, Role } from "@chatcap/shared-types";

import { PROBLEM_BASE, problemResponse } from "./errors";
import {
  createAuthenticate,
  createAuthorize,
  type AuditWriter,
} from "./auth/middleware";
import type { JwtConfig } from "./auth/jwt";
import type { AuthUsers } from "./auth/auth-router";
import {
  createCriticalRateLimit,
  type RateLimiterMemory,
} from "./middleware/rate-limit";

/**
 * Vectors router (task 5.5 core, REQ-DASH-RAG-7): supervisor / admin manual
 * re-ranking surface over the vector store. GET /vectors/search re-embeds the
 * free-text query and runs a cosine search (REQ-RAG-3 grounding trace), while
 * DELETE /vectors/documents/:docId/chunks/:chunkIndex lets a supervisor strip a
 * single chunk from a document — the first manual "remove from context" lever
 * for the orange-flag review flow (REQ-RAG-8). Supervisor/admin only — RBAC
 * denials are audit-logged (REQ-DASH-1).
 *
 * Destructive writes are pre-write audit-logged (REQ-DASH-8) with who/when/why
 * BEFORE the repository call so a successful removal is never untraceable; a
 * failed audit write is best-effort and must never block the delete or turn it
 * into a 500 (AGENTS.md). The repository + embed ports are injected (narrow
 * interfaces, like ChatsRepository) so the router stays unit-testable and the
 * composition root binds them to pgvector + the AI-RAG embedder later.
 *
 * Mounted BEFORE the chats router (mirroring alerts) so `/api/v1/vectors*`
 * never hits the /chats-wide auth gate.
 */

/** Read-side options mirrored from the HTTP query (category is singular here;
 *  the db-schema adapter maps it to `categories` when wired in index.ts). */
export interface VectorSearchOptions {
  limit?: number;
  category?: string;
  language?: string;
  legalFramework?: string;
}

export interface VectorsRepository {
  searchByEmbedding(
    embedding: number[],
    options: VectorSearchOptions
  ): Promise<RetrievedChunk[]>;
  deleteChunk(docId: string, chunkIndex: number): Promise<boolean>;
}

export interface EmbedPort {
  embed(text: string): Promise<number[]>;
}

export interface VectorsRouterDeps {
  jwt: JwtConfig;
  users: AuthUsers;
  audit: AuditWriter;
  vectors: VectorsRepository;
  embed: EmbedPort;
  /** Shared rate limiter for critical mutating endpoints (design §B5). */
  rateLimiter?: RateLimiterMemory;
}

const VECTOR_ROLES: Role[] = ["supervisor", "admin"];
const VECTOR_RESOURCE_TYPE = "vector_chunk";
const VECTOR_DENIED_ACTION = "vectors_access_denied";
const VECTOR_ACTION_REMOVED = "vector_chunk_removed";

const searchQuerySchema = z.object({
  q: z.string().min(1),
  category: z.string().optional(),
  language: z.string().optional(),
  framework: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const chunkParamsSchema = z.object({
  docId: z.uuid(),
  chunkIndex: z.coerce.number().int().min(0),
});

function validationError(res: Response, detail: string): void {
  problemResponse(res, {
    type: `${PROBLEM_BASE}/validation_error`,
    title: "Validation Error",
    status: 400,
    detail,
    code: "validation_error",
  });
}

function unauthorized(res: Response): void {
  problemResponse(res, {
    type: `${PROBLEM_BASE}/unauthorized`,
    title: "Unauthorized",
    status: 401,
    detail: "A valid session is required.",
    code: "unauthorized",
  });
}

function notFound(res: Response): void {
  problemResponse(res, {
    type: `${PROBLEM_BASE}/not_found`,
    title: "Not Found",
    status: 404,
    detail: "The vector chunk does not exist.",
    code: "not_found",
  });
}

export function createVectorsRouter(deps: VectorsRouterDeps): Router {
  const router = Router();
  const authenticate = createAuthenticate({
    jwt: deps.jwt,
    findUserById: async (id) => {
      const user = await deps.users.findById(id);
      if (user === undefined) {
        return null;
      }
      return { id: user.id, role: user.role };
    },
  });
  const authorize = createAuthorize({
    allowedRoles: VECTOR_ROLES,
    deniedAction: VECTOR_DENIED_ACTION,
    resourceType: VECTOR_RESOURCE_TYPE,
    audit: deps.audit,
  });

  const deleteRateLimit = deps.rateLimiter
    ? createCriticalRateLimit(
        deps.rateLimiter,
        (req) => req.principal?.userId ?? req.ip ?? "unknown"
      )
    : null;

  const deleteChain = deleteRateLimit
    ? [authenticate, deleteRateLimit, authorize]
    : [authenticate, authorize];

  const searchRateLimit = deps.rateLimiter
    ? createCriticalRateLimit(
        deps.rateLimiter,
        (req) => req.principal?.userId ?? req.ip ?? "unknown"
      )
    : null;

  const searchChain = searchRateLimit
    ? [authenticate, searchRateLimit, authorize]
    : [authenticate, authorize];

  // GET /search — re-embeds the free-text query (expensive AI-RAG call), so it
  // is rate-limited per user; the Caddy global limit is the outer backstop
  // (design §B5). Without this, CodeQL flags the authorized route as unmetered.
  router.use("/api/v1/vectors/search", ...searchChain);

  // DELETE /chunks — destructive, rate-limited per user
  router.use(
    "/api/v1/vectors/documents/:docId/chunks/:chunkIndex",
    ...deleteChain
  );

  router.get("/api/v1/vectors/search", async (req, res) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      validationError(
        res,
        "q must be a non-empty string; limit an integer between 1 and 50."
      );
      return;
    }
    const { q, category, language, framework, limit } = parsed.data;
    try {
      const embedding = await deps.embed.embed(q);
      const chunks = await deps.vectors.searchByEmbedding(embedding, {
        limit,
        category,
        language,
        legalFramework: framework,
      });
      res.status(200).json({ chunks, query: q, count: chunks.length });
    } catch {
      // A downstream embed/vector failure (timeout, pgvector unavailable) is
      // surfaced as RFC 7807 rather than leaked — no PII, no internals.
      problemResponse(res, {
        type: `${PROBLEM_BASE}/upstream_failed`,
        title: "Upstream Failed",
        status: 500,
        detail: "Vector search could not be completed.",
        code: "upstream_failed",
      });
    }
  });

  router.delete(
    "/api/v1/vectors/documents/:docId/chunks/:chunkIndex",
    async (req, res) => {
      const parsed = chunkParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        validationError(
          res,
          "docId must be a valid UUID; chunkIndex a non-negative integer."
        );
        return;
      }
      const { docId, chunkIndex } = parsed.data;
      const principal = req.principal;
      if (principal === undefined) {
        unauthorized(res);
        return;
      }

      // Pre-write audit: record the intent BEFORE the destructive call so the
      // action is traceable even if the delete itself fails. Best-effort: a
      // failed audit write must never block the removal or 500 the request.
      await deps.audit
        .write({
          actorType: principal.role,
          actorId: principal.userId,
          action: VECTOR_ACTION_REMOVED,
          resourceType: VECTOR_RESOURCE_TYPE,
          resourceId: `${docId}:${chunkIndex}`,
          meta: { docId, chunkIndex },
        })
        .catch(() => {
          /* audit is best-effort — never blocks the destructive write */
        });

      const deleted = await deps.vectors.deleteChunk(docId, chunkIndex);
      if (!deleted) {
        notFound(res);
        return;
      }
      res.status(204).send();
    }
  );

  return router;
}
