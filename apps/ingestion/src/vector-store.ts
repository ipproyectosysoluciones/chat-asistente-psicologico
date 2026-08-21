import type { DbQueryable } from "@chatcap/db-schema";

import type { ProhibitedHit, UpsertInput } from "./ingest-router";
import { PROHIBITED_THRESHOLD } from "./ingest-router";

/** 100-row batch ceiling (REQ-INGEST-3 re-encryption batch rule of thumb). */
const BATCH_SIZE = 100;

export class PgVectorStore {
  constructor(private readonly db: DbQueryable) {}

  async upsertVectorChunks(input: UpsertInput[]): Promise<{ inserted: number; blacklistedChars: number }> {
    if (input.length === 0) {
      return { inserted: 0, blacklistedChars: 0 };
    }
    let inserted = 0;
    for (let i = 0; i < input.length; i += BATCH_SIZE) {
      const batch = input.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const tuples: string[] = [];
      let idx = 1;
      for (const row of batch) {
        const vec = `[${row.embedding.join(",")}]`;
        tuples.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8})`);
        values.push(row.docId, row.chunkIndex, row.chunk, vec, row.category, row.source, row.language, row.legalFramework, JSON.stringify(row.metadata ?? {}));
        idx += 9;
      }
      const sql = `INSERT INTO vector_chunks
        (doc_id, chunk_index, content, embedding, category, source, language, legal_framework, metadata)
        VALUES ${tuples.join(", ")}
        ON CONFLICT (doc_id, chunk_index) DO UPDATE
        SET content = EXCLUDED.content, embedding = EXCLUDED.embedding,
            category = EXCLUDED.category, source = EXCLUDED.source,
            language = EXCLUDED.language, legal_framework = EXCLUDED.legal_framework,
            updated_at = now();`;
      await this.db.query(sql, values);
      inserted += batch.length;
    }
    return { inserted, blacklistedChars: 0 };
  }

  async revectorizeDocument(docId: string): Promise<{ deleted: number }> {
    const res = await this.db.query(`DELETE FROM vector_chunks WHERE doc_id = $1 RETURNING id;`, [docId]);
    return { deleted: res.rowCount ?? 0 };
  }

  async removeChunk(docId: string, chunkIndex: number): Promise<{ deleted: number }> {
    const res = await this.db.query(`DELETE FROM vector_chunks WHERE doc_id = $1 AND chunk_index = $2 RETURNING id;`, [docId, chunkIndex]);
    return { deleted: res.rowCount ?? 0 };
  }

  async searchVectorChunks(embedding: number[], categories: string[]): Promise<ProhibitedHit[]> {
    const vec = `[${embedding.join(",")}]`;
    const res = await this.db.query<{ id: string; doc_id: string; score: number; alert_id: string | null; alert_level: string | null }>(
      `SET local hnsw.ef_search = 40;
       SELECT vc.id, vc.doc_id, 1 - (vc.embedding <=> $1::vector) AS score,
              a.id AS alert_id, a.level AS alert_level
         FROM vector_chunks vc
         LEFT JOIN alerts a ON a.category = vc.category AND a.status = 'open' AND a.level IN ('red','orange')
         WHERE (1 - (vc.embedding <=> $1::vector)) >= $2
           AND ($3::text[] IS NULL OR vc.category = ANY($3))
         ORDER BY vc.embedding <=> $1::vector LIMIT 5;`,
      [vec, PROHIBITED_THRESHOLD, categories.length ? categories : null]
    );
    return res.rows
      .filter(
        (row): row is (typeof row & { alert_id: string; alert_level: "red" | "orange" }) =>
          row.alert_id !== null && (row.alert_level === "red" || row.alert_level === "orange")
      )
      .map((row) => ({
        chunkId: row.id,
        docId: row.doc_id,
        score: row.score,
        alertId: row.alert_id,
        alertLevel: row.alert_level,
      }));
  }
}
