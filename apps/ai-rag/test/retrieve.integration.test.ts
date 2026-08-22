import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { createLogger } from "@chatcap/telemetry";
import { runMigrations, VectorIndexMissingError } from "@chatcap/db-schema";

import { retrieveChunks } from "../src/retrieve";

const execFileAsync = promisify(execFile);

/**
 * Retrieval integration suite (task 3.3 AC) against a real pgvector
 * container: metadata-attributed top-k retrieval through retrieveChunks and
 * the fail-loud missing-index path (REQ-RAG-2). Gated behind
 * RUN_PG_INTEGRATION=1 — skipped by default, exactly like the db-schema
 * repository integration suite.
 */
const RUN_INTEGRATION = process.env.RUN_PG_INTEGRATION === "1";
const run = RUN_INTEGRATION ? describe : describe.skip;

const port = 57432 + (process.pid % 700);
const databaseUrl = `postgres://chatcap:chatcap_test@127.0.0.1:${port}/chatcap_test`;
const containerName = `chatcap-airag-retrieve-${process.pid}-${Date.now()}`;

async function dockerRun(args: string[]): Promise<void> {
  await execFileAsync("docker", args, { timeout: 120_000 });
}

async function waitForPg(attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const { stdout } = await execFileAsync("docker", [
        "exec",
        containerName,
        "pg_isready",
        "-U",
        "chatcap",
        "-d",
        "chatcap_test",
      ]);
      if (stdout.includes("accepting connections")) {
        return;
      }
    } catch {
      // container still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("pg container not ready");
}

/** Builds a 1536-dim vector literal from the leading components (rest zeroed). */
function vecLiteral(components: number[]): string {
  const padded = [
    ...components,
    ...new Array<number>(1536 - components.length).fill(0),
  ];
  return `[${padded.join(",")}]`;
}

/** Parses a vector literal back into a number[] (what the embed API returns). */
function parseVector(literal: string): number[] {
  return literal
    .slice(1, -1)
    .split(",")
    .map((component) => Number(component));
}

const silentLogger = createLogger({
  level: "silent",
  destination: { write: () => {} },
});

// Query spans three axes so chunk cosines are distinct (single-hot vectors
// along the same axis are all collinear with the query → identical cosines).
const QUERY_VEC = [1, 0.5, 0.25];
const CHUNK_A_VEC = [1, 0, 0]; // cos ≈ 0.873 (best)
const CHUNK_B_VEC = [0, 1, 0]; // cos ≈ 0.436
const CHUNK_C_VEC = [0, 0, 1]; // cos ≈ 0.218

run("retrieveChunks vs test PG (task 3.3 AC)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await dockerRun([
      "run",
      "-d",
      "--name",
      containerName,
      "-e",
      "POSTGRES_USER=chatcap",
      "-e",
      "POSTGRES_PASSWORD=chatcap_test",
      "-e",
      "POSTGRES_DB=chatcap_test",
      "-p",
      `127.0.0.1:${port}:5432`,
      "pgvector/pgvector:pg16",
    ]);
    await waitForPg();
    await runMigrations({ databaseUrl, direction: "up" });
    pool = new Pool({ connectionString: databaseUrl, max: 5 });

    // Seed a document + three chunks with distinct cosine alignment to the
    // query: A strongest (0.873), B medium (0.436), C weakest (0.218).
    await pool.query(
      `INSERT INTO documents (id, title, source_url, source_type, language, legal_framework, status)
       VALUES
         ('00000000-0000-7000-8000-0000000000d1', 'Manual Bienestar', 'https://internal/manual.pdf', 'pdf', 'es', 'ar_2024', 'vectorized'),
         ('00000000-0000-7000-8000-0000000000d2', 'Guía Sueño', 'https://internal/sueno.pdf', 'pdf', 'es', 'ar_2024', 'vectorized');`
    );
    await pool.query(
      `INSERT INTO vector_chunks (doc_id, chunk_index, content, embedding, category, source, language, legal_framework)
       VALUES
         ('00000000-0000-7000-8000-0000000000d1', 0, 'técnicas de respiración para la ansiedad', '${vecLiteral(CHUNK_A_VEC)}', 'técnicas', 'manual-bienestar.pdf', 'es', 'ar_2024'),
         ('00000000-0000-7000-8000-0000000000d2', 0, 'rutina de sueño saludable', '${vecLiteral(CHUNK_B_VEC)}', 'hábitos', 'guia-suenno.pdf', 'es', 'ar_2024'),
         ('00000000-0000-7000-8000-0000000000d2', 1, 'evitar cafeína después de las 16', '${vecLiteral(CHUNK_C_VEC)}', 'hábitos', 'guia-suenno.pdf', 'es', 'ar_2024');`
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    try {
      await dockerRun(["rm", "-f", containerName]);
    } catch {
      // best-effort cleanup
    }
  });

  it("returns metadata-attributed top-k ordered by similarity", async () => {
    const client = { embed: vi.fn(async () => parseVector(vecLiteral(QUERY_VEC))) };

    const chunks = await retrieveChunks(
      { client, db: pool, topK: 2, logger: silentLogger },
      "cómo calmar la ansiedad"
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      content: "técnicas de respiración para la ansiedad",
      category: "técnicas",
      source: "manual-bienestar.pdf",
      language: "es",
      legalFramework: "ar_2024",
    });
    // Metadata attribution (REQ-RAG-3) on every hit.
    for (const chunk of chunks) {
      expect(chunk.chunkId).not.toBe("");
      expect(chunk.docId).not.toBe("");
      expect(chunk.score).toBeGreaterThan(0);
      expect(chunk.score).toBeLessThanOrEqual(1);
    }
    // Ordering: best match first.
    const [first, second] = chunks;
    if (first === undefined || second === undefined) {
      throw new Error("expected two chunks");
    }
    expect(first.score).toBeGreaterThan(second.score);
  });

  it("fails loudly with VectorIndexMissingError when the HNSW index is dropped", async () => {
    await pool.query("DROP INDEX IF EXISTS idx_vector_chunks_embedding_hnsw;");
    const client = { embed: vi.fn(async () => [0.5]) };

    await expect(
      retrieveChunks({ client, db: pool, topK: 2, logger: silentLogger }, "hola")
    ).rejects.toThrow(VectorIndexMissingError);

    // Restore the index for any later assertions in the same run.
    await pool.query(
      "CREATE INDEX idx_vector_chunks_embedding_hnsw ON vector_chunks USING hnsw (embedding vector_cosine_ops);"
    );
  });
});
