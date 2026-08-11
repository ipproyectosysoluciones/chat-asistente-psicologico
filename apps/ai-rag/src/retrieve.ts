import type { Logger } from "@chatcap/telemetry";
import type { RetrievedChunk } from "@chatcap/shared-types";
import type { OpenAiClient } from "@chatcap/llm-client";
import {
  assertVectorIndexPresent,
  searchVectorChunks,
  type DbQueryable,
} from "@chatcap/db-schema";

import { UpstreamDependencyError } from "./errors";

/**
 * Retrieval (task 3.3, REQ-RAG-2/3): embed the query with
 * text-embedding-3-small, then run the pgvector HNSW top-k search. Every hit
 * carries its chunk metadata (category/source/language/legal_framework).
 * The HNSW index is asserted BEFORE embedding — a missing index fails loudly
 * (VectorIndexMissingError → router 502) instead of wasting an OpenAI call
 * and silently degrading. The search itself lives in @chatcap/db-schema so
 * SQL and ef_search tuning stay in one source of truth.
 */

export interface RetrieveDeps {
  client: Pick<OpenAiClient, "embed">;
  db: DbQueryable;
  topK: number;
  logger: Logger;
}

export async function retrieveChunks(
  deps: RetrieveDeps,
  message: string
): Promise<RetrievedChunk[]> {
  // REQ-RAG-2: never accept queries without the HNSW index.
  await assertVectorIndexPresent(deps.db);

  let embedding: number[];
  try {
    embedding = await deps.client.embed(message);
  } catch (cause) {
    throw new UpstreamDependencyError(
      `query embedding failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }

  return searchVectorChunks(deps.db, embedding, { limit: deps.topK });
}
