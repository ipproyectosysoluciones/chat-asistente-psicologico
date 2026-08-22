import { describe, expect, test, vi } from "vitest";

import { createLogger } from "@chatcap/telemetry";
import type { DbQueryable, QueryResultRow } from "@chatcap/db-schema";
import { VectorIndexMissingError } from "@chatcap/db-schema";

import { retrieveChunks } from "../src/retrieve";
import { UpstreamDependencyError } from "../src/errors";

/**
 * Retrieval (task 3.3, REQ-RAG-2/3): embed the query (text-embedding-3-small)
 * then run the pgvector HNSW top-k search with chunk metadata attached.
 * The HNSW index is asserted before embedding — a missing index fails loudly
 * instead of spending an OpenAI call and silently degrading (REQ-RAG-2).
 */

const silentLogger = createLogger({ level: "silent", destination: { write: () => {} } });

interface CapturedQuery {
  text: string;
  values: unknown[];
}

/** Fake DbQueryable that dispatches on SQL shape and captures calls. */
function fakeDb(options: {
  indexPresent?: boolean;
  hitRows?: Array<QueryResultRow & { id: string }>;
}): { db: DbQueryable; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const db: DbQueryable = {
    async query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (text.includes("pg_indexes")) {
        const rows =
          options.indexPresent === false
            ? []
            : [{ indexname: "idx_vector_chunks_embedding_hnsw" }];
        // Rows are structurally compatible with T at runtime; the double
        // conversion satisfies strict TS for the generic query contract.
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      if (text.includes("SET hnsw.ef_search")) {
        return { rows: [] as unknown as T[], rowCount: null };
      }
      if (text.includes("FROM vector_chunks")) {
        const rows = options.hitRows ?? [];
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      throw new Error(`fakeDb: unexpected query: ${text.slice(0, 80)}`);
    },
  };
  return { db, queries };
}

const hitRows = [
  {
    id: "chunk-1",
    doc_id: "doc-1",
    chunk_index: 3,
    content: "técnicas de respiración para la ansiedad",
    category: "técnicas",
    source: "manual-bienestar.pdf",
    language: "es",
    legal_framework: "ar_2024",
    similarity: 0.93,
  },
  {
    id: "chunk-2",
    doc_id: "doc-2",
    chunk_index: 0,
    content: "rutina de sueño saludable",
    category: "hábitos",
    source: "guia-suenno.pdf",
    language: "es",
    legal_framework: "ar_2024",
    similarity: 0.87,
  },
];

describe("retrieveChunks", () => {
  test("returns metadata-attributed top-k chunks ordered by similarity", async () => {
    const { db } = fakeDb({ hitRows });
    const client = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) };

    const chunks = await retrieveChunks(
      { client, db, topK: 5, logger: silentLogger },
      "cómo calmar la ansiedad"
    );

    expect(client.embed).toHaveBeenCalledWith("cómo calmar la ansiedad");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({
      chunkId: "chunk-1",
      docId: "doc-1",
      chunkIndex: 3,
      content: "técnicas de respiración para la ansiedad",
      category: "técnicas",
      source: "manual-bienestar.pdf",
      language: "es",
      legalFramework: "ar_2024",
      score: 0.93,
    });
    const second = chunks[1];
    if (second === undefined) {
      throw new Error("expected at least two chunks");
    }
    expect(second.chunkId).toBe("chunk-2");
    // Descending similarity: the best chunk is first.
    const first = chunks[0];
    expect(first?.score ?? 0).toBeGreaterThan(second.score);
    // Every chunk carries the mandatory metadata (REQ-RAG-3).
    for (const chunk of chunks) {
      expect(chunk.category).not.toBe("");
      expect(chunk.source).not.toBe("");
      expect(chunk.language).not.toBe("");
      expect(chunk.legalFramework).not.toBe("");
    }
  });

  test("passes the configured topK as the retrieval limit", async () => {
    const { db, queries } = fakeDb({ hitRows });
    const client = { embed: vi.fn(async () => [0.1]) };

    await retrieveChunks({ client, db, topK: 3, logger: silentLogger }, "hola");

    const vectorQuery = queries.find((q) => q.text.includes("FROM vector_chunks"));
    if (vectorQuery === undefined) {
      throw new Error("expected a vector_chunks query");
    }
    expect(vectorQuery.text).toMatch(/LIMIT \$\d+/);
    // Last bound parameter is the limit.
    expect(vectorQuery.values.at(-1)).toBe(3);
  });

  test("fails loudly with VectorIndexMissingError when the HNSW index is missing", async () => {
    const { db } = fakeDb({ indexPresent: false });
    const client = { embed: vi.fn(async () => [0.1]) };

    await expect(
      retrieveChunks({ client, db, topK: 5, logger: silentLogger }, "hola")
    ).rejects.toThrow(VectorIndexMissingError);
    // Fail-fast: the embed call is NOT spent when the index is missing.
    expect(client.embed).not.toHaveBeenCalled();
  });

  test("wraps embedding failures in UpstreamDependencyError", async () => {
    const { db } = fakeDb({});
    const client = {
      embed: vi.fn(async () => {
        throw new Error("embeddings api 429");
      }),
    };

    await expect(
      retrieveChunks({ client, db, topK: 5, logger: silentLogger }, "hola")
    ).rejects.toThrow(UpstreamDependencyError);
  });
});
