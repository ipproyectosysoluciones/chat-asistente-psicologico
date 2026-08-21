import type { RetrievedChunk } from "@chatcap/shared-types";

import type { DbQueryable, QueryResultRow } from "./db";

/**
 * Vector chunk search (REQ-RAG-2): parameterized cosine search over the HNSW
 * index, with the per-query `hnsw.ef_search = 40` tuning and mandatory chunk
 * metadata attached to every hit (REQ-RAG-3). `SET` is connection-scoped —
 * the caller must pass a dedicated client (pool.connect()) so the tuning
 * never leaks across pooled connections.
 */

export interface VectorSearchOptions {
  limit?: number;
  categories?: string[];
  language?: string;
  legalFramework?: string;
}

interface ChunkHitRow extends QueryResultRow {
  id: string;
  doc_id: string;
  chunk_index: number;
  content: string;
  category: string;
  source: string;
  language: string;
  legal_framework: string;
  similarity: number;
}

export const EF_SEARCH = 40;

export async function searchVectorChunks(
  db: DbQueryable,
  embedding: number[],
  options: VectorSearchOptions = {}
): Promise<RetrievedChunk[]> {
  const limit = clamp(options.limit ?? 10, 1, 50);
  const vectorLiteral = `[${embedding.join(",")}]`;

  await db.query(`SET hnsw.ef_search = ${EF_SEARCH};`);
  const result = await db.query<ChunkHitRow>(
    `SELECT id, doc_id, chunk_index, content, category, source, language,
            legal_framework, 1 - (embedding <=> $1::vector) AS similarity
       FROM vector_chunks
      WHERE ($2::text[] IS NULL OR category = ANY($2))
        AND ($3::text IS NULL OR language = $3)
        AND ($4::text IS NULL OR legal_framework = $4)
      ORDER BY embedding <=> $1::vector
      LIMIT $5;`,
    [
      vectorLiteral,
      options.categories?.length ? options.categories : null,
      options.language ?? null,
      options.legalFramework ?? null,
      limit,
    ]
  );

  return result.rows.map((row) => ({
    chunkId: row.id,
    docId: row.doc_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    category: row.category,
    source: row.source,
    language: row.language,
    legalFramework: row.legal_framework,
    score: row.similarity,
  }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
