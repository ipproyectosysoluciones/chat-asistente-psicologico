import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * Integration test against a real pgvector/pgvector:pg16 container
 * (task 1.5 AC: `migrate up` on pg16+pgvector; HNSW index present).
 * Gated behind RUN_PG_INTEGRATION=1 so the default `pnpm test` stays
 * green without Docker.
 */
const RUN_INTEGRATION = process.env.RUN_PG_INTEGRATION === "1";

const run = RUN_INTEGRATION ? describe : describe.skip;
const CONTAINER_PREFIX = "chatcap-pg-test-";

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

run("pg integration: migrate up on pg16 + pgvector", () => {
  const containerName = `${CONTAINER_PREFIX}${process.pid}-${Date.now()}`;
  const port = 55432 + (process.pid % 1000);
  const databaseUrl = `postgres://chatcap:chatcap_test@127.0.0.1:${port}/chatcap_test`;

  async function dockerRun(args: string[]): Promise<void> {
    await execFileAsync("docker", args, { timeout: 120_000 });
  }

  async function waitForPg(attempts = 30): Promise<void> {
    let lastError: unknown;
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
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`pg container not ready: ${String(lastError)}`);
  }

  async function pgQuery(sqlText: string): Promise<{ rows: unknown[] }> {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      containerName,
      "psql",
      "-U",
      "chatcap",
      "-d",
      "chatcap_test",
      "-t",
      "-A",
      "-c",
      sqlText,
    ]);
    return { rows: stdout.split("\n").filter((line) => line.length > 0) };
  }

  beforeAll(async () => {
    if (!(await dockerAvailable())) {
      throw new Error("docker unavailable; RUN_PG_INTEGRATION requires docker");
    }
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
  }, 180_000);

  afterAll(async () => {
    try {
      await dockerRun(["rm", "-f", containerName]);
    } catch {
      // container may already be gone; cleanup is best-effort
    }
  });

  it("runs the migration and exposes all 13 tables", async () => {
    const { runMigrations } = await import("../src/migrate");
    await runMigrations({ databaseUrl, direction: "up" });

    const tables = await pgQuery(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
    );
    for (const table of [
      "legal_frameworks",
      "sessions",
      "consent_records",
      "qr_signatures",
      "key_versions",
      "alerts",
      "documents",
      "vector_chunks",
      "ingestion_jobs",
      "users",
      "otp_codes",
      "re_encryption_batches",
      "audit_logs",
    ]) {
      expect(tables.rows).toContain(table);
    }
  }, 60_000);

  it("has the HNSW index and the startup assertion passes", async () => {
    const { Pool } = await import("pg");
    const { assertVectorIndexPresent } = await import("../src/startup-assertions");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await expect(assertVectorIndexPresent(pool)).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  }, 30_000);

  it("supports a real vector insert + cosine search", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const embedding = Array.from({ length: 1536 }, () => Math.random() * 2 - 1);
      // pgvector text form is `[0.1,0.2,...]` — a JS array would be
      // serialized by node-postgres as a quoted array literal it can't parse.
      const vectorLiteral = `[${embedding.join(",")}]`;
      const docId = "00000000-0000-7000-8000-000000000001";
      const chunkId = "00000000-0000-7000-8000-000000000002";
      await pool.query(
        `INSERT INTO documents (id, title, source_url, source_type, language, legal_framework, status)
         VALUES ($1, 'test', 'https://example.test/doc', 'manual', 'es', 'AR', 'vectorized');`,
        [docId]
      );
      await pool.query(
        `INSERT INTO vector_chunks (id, doc_id, chunk_index, content, embedding, category, source, language, legal_framework)
         VALUES ($1, $2, 0, 'chunk de prueba', $3::vector, 'general', 'test', 'es', 'AR');`,
        [chunkId, docId, vectorLiteral]
      );
      const { rows } = await pool.query<{ content: string }>(
        `SELECT content FROM vector_chunks ORDER BY embedding <=> $1::vector LIMIT 1;`,
        [vectorLiteral]
      );
      expect(rows[0]?.content).toBe("chunk de prueba");
    } finally {
      await pool.end();
    }
  }, 30_000);

  it("guarded history/contact ALTERs run cleanly when tables are absent", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      // history/contacts do not exist at migration time in a fresh DB:
      // the guarded DO blocks must no-op instead of failing.
      const { rows } = await pool.query(
        `SELECT to_regclass('public.history') AS history, to_regclass('public.contacts') AS contacts;`
      );
      expect(rows[0]?.history).toBeNull();
      expect(rows[0]?.contacts).toBeNull();
    } finally {
      await pool.end();
    }
  }, 30_000);

  it("migrate down removes the schema objects", async () => {
    const { runMigrations } = await import("../src/migrate");
    await runMigrations({ databaseUrl, direction: "down" });
    const tables = await pgQuery(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
    );
    expect(tables.rows).not.toContain("sessions");
  }, 60_000);
});
