import type { Pool } from "pg";

/**
 * Startup assertion (design §4.2, REQ-RAG-2): the vector service must NEVER
 * serve silently without its HNSW index — fail loudly instead. Checked at
 * ai-rag boot before accepting queries.
 */
export class VectorIndexMissingError extends Error {
  readonly code = "VECTOR_INDEX_MISSING" as const;

  constructor() {
    super(
      "HNSW index 'idx_vector_chunks_embedding_hnsw' is missing on vector_chunks. " +
        "Run migrations (`pnpm --filter @chatcap/db-schema` + `runMigrations`) before boot."
    );
    this.name = "VectorIndexMissingError";
  }
}

const HNSW_INDEX_NAME = "idx_vector_chunks_embedding_hnsw";

export async function assertVectorIndexPresent(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ indexname: string | null }>(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = $1
        AND indexdef ILIKE '%hnsw%';`,
    [HNSW_INDEX_NAME]
  );
  if (rows[0] === undefined) {
    throw new VectorIndexMissingError();
  }
}
