import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../migrations/0001_initial_schema.sql", import.meta.url)
);
const sql = readFileSync(migrationPath, "utf8");

const EXPECTED_TABLES = [
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
];

describe("migration 0001: structure (design §4)", () => {
  it("defines all 13 tables from the ERD", () => {
    for (const table of EXPECTED_TABLES) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
  });

  it("enables the pgvector extension", () => {
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/i);
  });

  it("creates the HNSW index with m=16 ef_construction=64", () => {
    expect(sql).toMatch(/idx_vector_chunks_embedding_hnsw/);
    expect(sql).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
    expect(sql).toMatch(/m = 16/);
    expect(sql).toMatch(/ef_construction = 64/);
  });

  it("declares vector(1536) for text-embedding-3-small", () => {
    expect(sql).toMatch(/embedding\s+vector\(1536\)/i);
  });

  it("ships a down migration", () => {
    expect(sql).toContain("-- Down Migration");
  });
});

describe("migration 0001: security & privacy invariants (AGENTS.md)", () => {
  it("encrypted consent payload is BYTEA with integrity hash + key_version", () => {
    expect(sql).toMatch(/encrypted_payload\s+bytea/i);
    expect(sql).toMatch(/integrity_hash\s+text/i);
    expect(sql).toMatch(/key_version\s+integer/i);
  });

  it("key_versions holds metadata only (salt, no key material)", () => {
    expect(sql).toMatch(/CREATE TABLE key_versions/);
    expect(sql).toMatch(/salt\s+text/i);
    expect(sql).not.toMatch(/key_versions[\s\S]{0,400}master/i);
  });

  it("sessions carry dual-persistence columns (persistence_class, purge_at)", () => {
    expect(sql).toMatch(/persistence_class\s+text/i);
    expect(sql).toMatch(/purge_at\s+timestamptz/i);
  });

  it("adds history/contact extra columns via guarded to_regclass blocks", () => {
    expect(sql).toMatch(/to_regclass\('public\.history'\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS persistence_class/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS key_version/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS purge_at/);
  });

  it("enforces closed status value sets with CHECK constraints", () => {
    expect(sql).toMatch(/persistence_class IN \('anonymous', 'hc'\)/);
    expect(sql).toMatch(/level IN \('red', 'orange', 'yellow'\)/);
    expect(sql).toMatch(/status IN \('open', 'acknowledged', 'resolved'\)/);
    expect(sql).toMatch(/status IN \('active', 'retired', 'expired', 'compromised'\)/);
  });

  it("alerts dedupe key supports one-open-alert semantics", () => {
    expect(sql).toMatch(/dedupe_key\s+text/i);
  });

  it("otp_codes store hash-only with attempts cap", () => {
    expect(sql).toMatch(/otp_hash\s+text/i);
    expect(sql).toMatch(/attempts\s+integer/i);
    expect(sql).toMatch(/expires_at\s+timestamptz/i);
  });

  it("audit_logs meta is jsonb (non-PII detail only)", () => {
    expect(sql).toMatch(/meta\s+jsonb/i);
  });
});

describe("migration 0001: dashboard indexes (design §4.3, REQ-DASH-6)", () => {
  it("indexes alerts by level/status/created_at and by session", () => {
    expect(sql).toMatch(/idx_alerts_level_status_created/);
    expect(sql).toMatch(/idx_alerts_session/);
  });

  it("indexes sessions for dashboard + anonymous purge", () => {
    expect(sql).toMatch(/idx_sessions_state_last_activity/);
    expect(sql).toMatch(/idx_sessions_purge/);
    expect(sql).toMatch(/WHERE persistence_class = 'anonymous'/);
  });

  it("indexes history for session view + purge (guarded)", () => {
    expect(sql).toMatch(/idx_history_session_created/);
    expect(sql).toMatch(/idx_history_purge/);
  });

  it("indexes consent by key_version for re-encryption scans (REQ-KEY-4)", () => {
    expect(sql).toMatch(/idx_consent_records_key_version/);
  });
});
