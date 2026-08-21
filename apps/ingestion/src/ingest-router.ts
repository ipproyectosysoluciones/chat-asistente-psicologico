import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { Router } from "express";
import type { RequestHandler, Response } from "express";

import { z } from "zod";

import type { Logger } from "@chatcap/telemetry";

import { filterBlacklist } from "./blacklist";
import { chunkText } from "./chunker";

/**
 * Ingestion pipeline ports + handler (task 6.2/6.3/6.4, REQ-INGEST-1..6).
 * Defines ONLY the dependency ports and the request handler — no db-schema
 * imports, so the router stays unit-testable with mocks. The composition root
 * (index.ts) injects PgVectorStore.
 */

/** Prohibited-zone sweep hit (REQ-INGEST-6). */
export interface ProhibitedHit {
  chunkId: string;
  docId: string;
  score: number;
  alertId: string;
  alertLevel: "red" | "orange";
}

/** One chunk → embedding + full metadata (REQ-INGEST-4). */
export interface UpsertInput {
  /** Owning document (curation stage creates it; idempotency key on re-vec). */
  docId: string;
  /** Position within the document — unique per (docId, chunkIndex). */
  chunkIndex: number;
  chunk: string;
  embedding: number[];
  category: string;
  source: string;
  language: string;
  legalFramework: string;
  /** Audit-friendly extra context (counts, flags) — JSON-b text. */
  metadata: Record<string, string | number | boolean>;
}

export interface UpsertResult {
  inserted: number;
  blacklistedChars: number;
}

export interface IngestionDeps {
  logger: Logger;
  /** Embeds each chunk string → embedding vectors. Returns one per chunk. */
  embed: (chunks: string[]) => Promise<number[][]>;
  /** Persists embeddings + metadata; idempotent by (docId, chunkIndex). */
  upsertVectorChunks: (input: UpsertInput[]) => Promise<UpsertResult>;
  /** Prohibited-zone sweep: similar chunks linked to an active alert. */
  searchVectorChunks: (
    embedding: number[],
    categories: string[]
  ) => Promise<ProhibitedHit[]>;
  /** Re-vectorize a document: delete stale chunks + re-upsert (REQ-INGEST-5). */
  revectorizeDocument: (docId: string) => Promise<{ deleted: number }>;
  /** Open-alert count for capacity-aware backoff (REQ-INGEST-4 note). */
  listAlerts: () => Promise<{ count: number }>;
  internalTokens: readonly string[];
  chunkMinChars: number;
  chunkMaxChars: number;
}

/** Cosine-similarity floor above which a chunk is a prohibited-zone collision
 * (design §6.4, calibrated 0.9 — well above the 0.85 emit gate so ingestion
 * only rejects true near-duplicates already under review). */
export const PROHIBITED_THRESHOLD = 0.9;

const PROBLEM_BASE = "https://api.chatcap.app/errors";

function jsonError(res: Response, status: number, code: string, detail: string): void {
  res.status(status).json({
    type: `${PROBLEM_BASE}/${code}`,
    title: code,
    status,
    detail,
    code,
  });
}

function tokensEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Auth guard: service-to-service token (one of X_INTERNAL_TOKENS). */
export function requireInternalToken(
  req: { header: (name: string) => string | undefined },
  res: Response,
  internalTokens: readonly string[]
): boolean {
  const token = req.header("x-internal-token");
  if (
    typeof token === "string" &&
    internalTokens.some((expected) => tokensEqual(token, expected))
  ) {
    return true;
  }
  jsonError(res, 401, "unauthorized", "A valid internal service token is required.");
  return false;
}

const DocumentSchema = z.object({
  text: z.string().min(1, "text is required"),
  category: z.string().min(1, "category is required"),
  source: z.string().min(1, "source is required"),
  language: z.string().min(2, "language is required (ISO code)"),
  legalFramework: z.string().min(1, "legalFramework is required"),
  docId: z.string().uuid().optional(),
  sourceUrl: z.string().url().optional(),
  title: z.string().optional(),
});

type ValidatedDocument = z.infer<typeof DocumentSchema>;

export function documentHandler(deps: IngestionDeps): RequestHandler {
  const {
    logger,
    embed,
    upsertVectorChunks,
    searchVectorChunks,
    internalTokens,
    chunkMinChars,
    chunkMaxChars,
  } = deps;

  return async (req, res) => {
    if (!requireInternalToken(req, res, internalTokens)) {
      return;
    }

    const parsed = DocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => i.message)
        .join("; ")
        .slice(0, 200);
      jsonError(res, 400, "validation_error", detail || "Invalid document.");
      return;
    }
    const doc: ValidatedDocument = parsed.data;

    const cleaned = filterBlacklist(doc.text);
    logger.info("ingestion: document filtered", {
      blacklisted: cleaned.blacklisted,
      hits: cleaned.hits.length,
    });

    const embeddable = cleaned.allowed;
    if (embeddable.length < chunkMinChars) {
      jsonError(
        res,
        422,
        "payload_too_short",
        `Document is ${embeddable.length} chars after filtering; minimum ${chunkMinChars}.`
      );
      return;
    }

    // Re-vectorization (REQ-INGEST-5): if a docId is supplied, purge its stale
    // chunks first so re-ingest does not duplicate the corpus.
    if (doc.docId) {
      const { deleted } = await deps.revectorizeDocument(doc.docId);
      if (deleted > 0) {
        logger.info("ingestion: re-vectorize purged stale chunks", { docId: doc.docId, deleted });
      }
    }

    const chunks = chunkText(embeddable, chunkMaxChars, chunkMinChars);
    if (chunks.length === 0) {
      jsonError(res, 422, "empty_document", "No chunkable content after filtering.");
      return;
    }

    const embeddings = await embed(chunks);
    if (embeddings.length !== chunks.length) {
      logger.error("ingestion: embed count mismatch", new Error("embeddings.length != chunks.length"));
      jsonError(res, 500, "internal_error", "Embedding count mismatch.");
      return;
    }

    // Prohibited-zone sweep (REQ-INGEST-6): reject before upserting if any
    // chunk collides with content under active red/orange review.
    for (let i = 0; i < embeddings.length; i++) {
      const hits = await searchVectorChunks(embeddings[i]!, [doc.category]);
      for (const hit of hits) {
        if (hit.score >= PROHIBITED_THRESHOLD) {
          jsonError(
            res,
            409,
            "prohibited_collision",
            `Chunk ${i} collides with alert ${hit.alertId} (${hit.alertLevel}, score ${hit.score.toFixed(3)}).`
          );
          return;
        }
      }
    }

    const docId = doc.docId ?? randomUUID();
    const upsertInput: UpsertInput[] = chunks.map((chunk, i) => ({
      docId,
      chunkIndex: i,
      chunk,
      embedding: embeddings[i]!,
      category: doc.category,
      source: doc.source,
      language: doc.language,
      legalFramework: doc.legalFramework,
      metadata: {
        blacklistedChars: cleaned.hits.length,
        filtered: cleaned.blacklisted,
        sourceUrl: doc.sourceUrl ?? "",
        title: doc.title ?? "",
      },
    }));

    const result = await upsertVectorChunks(upsertInput);
    logger.info("ingestion: document upserted", {
      docId,
      chunks: chunks.length,
      vectors: result.inserted,
      blacklistedChars: result.blacklistedChars,
    });

    res.status(202).json({
      status: "accepted",
      docId,
      chunks: chunks.length,
      vectors: result.inserted,
      blacklisted: cleaned.blacklisted,
    });
  };
}

/** Builds the express Router mounting auth + POST /documents. */
export function createIngestionRouter(deps: IngestionDeps): Router {
  const router = Router();
  router.post("/documents", documentHandler(deps));
  return router;
}
