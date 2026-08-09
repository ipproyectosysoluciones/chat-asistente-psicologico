-- Up Migration
-- chat-asistencia-psicologica initial schema (design §4).
-- Naming: snake_case, plural tables, created_at/updated_at everywhere.
-- Encrypted columns are BYTEA; every encrypted row carries key_version
-- (REQ-KEY-1) and an integrity hash. Status columns use CHECK constraints
-- aligned with the shared-types `as const` value sets.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- core reference tables
-- ---------------------------------------------------------------------------

CREATE TABLE legal_frameworks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code text NOT NULL,
  framework_code text NOT NULL UNIQUE,
  notice_text text NOT NULL,
  terms_version integer NOT NULL,
  effective_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE key_versions (
  key_version integer PRIMARY KEY,
  algorithm text NOT NULL DEFAULT 'aes-256-cbc-hkdf-sha256',
  salt text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired', 'expired', 'compromised')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  forced_rotation_due_at timestamptz
);

-- ---------------------------------------------------------------------------
-- chat sessions (dual persistence)
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_key_anon text NOT NULL,
  jurisdiction text NOT NULL DEFAULT 'AR',
  persistence_class text NOT NULL DEFAULT 'anonymous'
    CHECK (persistence_class IN ('anonymous', 'hc')),
  consent_state text NOT NULL DEFAULT 'notice_shown'
    CHECK (consent_state IN ('notice_shown', 'accepted', 'renewed', 'revoked')),
  ai_state text NOT NULL DEFAULT 'auto'
    CHECK (ai_state IN ('auto', 'takeover')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  purge_at timestamptz
);

CREATE TABLE consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions (id),
  jurisdiction text NOT NULL,
  terms_version integer NOT NULL,
  key_version integer NOT NULL,
  encrypted_payload bytea NOT NULL,
  integrity_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE qr_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id uuid NOT NULL REFERENCES consent_records (id),
  key_version integer NOT NULL,
  signature text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('supervisor', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- alerts (REQ-ALERT-5 dedupe, REQ-ALERT-6 lifecycle)
-- ---------------------------------------------------------------------------

CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level text NOT NULL CHECK (level IN ('red', 'orange', 'yellow')),
  category text NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions (id),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved')),
  dedupe_key text NOT NULL,
  acknowledged_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- ---------------------------------------------------------------------------
-- ingestion: curated clinical content (no user PII, REQ-INGEST-4)
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  source_url text NOT NULL,
  source_type text NOT NULL,
  language text NOT NULL,
  legal_framework text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'vectorized', 'blacklisted', 'failed')),
  blacklist_hits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vector_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id uuid NOT NULL REFERENCES documents (id),
  chunk_index integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536) NOT NULL,
  category text NOT NULL,
  source text NOT NULL,
  language text NOT NULL,
  legal_framework text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  chunks_total integer NOT NULL DEFAULT 0,
  chunks_done integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- OTP + re-encryption bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id uuid NOT NULL REFERENCES consent_records (id),
  otp_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'expired', 'locked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE re_encryption_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_from integer NOT NULL REFERENCES key_versions (key_version),
  key_to integer NOT NULL REFERENCES key_versions (key_version),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'verified', 'rolled_back')),
  rows_count integer NOT NULL DEFAULT 0,
  integrity_hash text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- audit (REQ-DASH-8: non-PII meta only)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  reason text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- BuilderBot-owned tables: add dual-persistence columns (guarded; the tables
-- are created by @builderbot/database-postgres on first connect, so they may
-- not exist at migration time).  REQ-CONSENT-5, REQ-KEY-1.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.history') IS NOT NULL THEN
    ALTER TABLE public.history
      ADD COLUMN IF NOT EXISTS persistence_class text,
      ADD COLUMN IF NOT EXISTS key_version integer,
      ADD COLUMN IF NOT EXISTS purge_at timestamptz;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.contacts') IS NOT NULL THEN
    ALTER TABLE public.contacts
      ADD COLUMN IF NOT EXISTS persistence_class text,
      ADD COLUMN IF NOT EXISTS key_version integer,
      ADD COLUMN IF NOT EXISTS purge_at timestamptz;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- pgvector HNSW (design §4.2, REQ-RAG-2)
-- ---------------------------------------------------------------------------

CREATE INDEX idx_vector_chunks_embedding_hnsw
  ON vector_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------------
-- dashboard indexes (design §4.3, REQ-DASH-6) + re-encryption scan index
-- ---------------------------------------------------------------------------

CREATE INDEX idx_alerts_level_status_created ON alerts (level, status, created_at DESC);
CREATE INDEX idx_alerts_session ON alerts (session_id);
CREATE INDEX idx_alerts_dedupe_key ON alerts (dedupe_key);
CREATE INDEX idx_sessions_state_last_activity ON sessions (ai_state, last_activity_at DESC);
CREATE INDEX idx_sessions_purge ON sessions (purge_at) WHERE persistence_class = 'anonymous';
CREATE INDEX idx_consent_records_session ON consent_records (session_id);
CREATE INDEX idx_consent_records_key_version ON consent_records (key_version) WHERE active;
CREATE INDEX idx_qr_signatures_consent ON qr_signatures (consent_id, created_at DESC);
CREATE INDEX idx_vector_chunks_doc ON vector_chunks (doc_id, chunk_index);
CREATE INDEX idx_ingestion_jobs_status ON ingestion_jobs (status, created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX idx_otp_codes_consent ON otp_codes (consent_id, status);

-- history indexes are also guarded: they depend on the BuilderBot columns.
DO $$
BEGIN
  IF to_regclass('public.history') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'history' AND column_name = 'purge_at'
     )
  THEN
    CREATE INDEX idx_history_session_created ON history (session_id, created_at DESC);
    CREATE INDEX idx_history_purge ON history (purge_at) WHERE persistence_class = 'anonymous';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance (mutable tables)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_legal_frameworks_updated
  BEFORE UPDATE ON legal_frameworks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_key_versions_updated
  BEFORE UPDATE ON key_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sessions_updated
  BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_consent_records_updated
  BEFORE UPDATE ON consent_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_qr_signatures_updated
  BEFORE UPDATE ON qr_signatures FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_alerts_updated
  BEFORE UPDATE ON alerts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_documents_updated
  BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_vector_chunks_updated
  BEFORE UPDATE ON vector_chunks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_ingestion_jobs_updated
  BEFORE UPDATE ON ingestion_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_otp_codes_updated
  BEFORE UPDATE ON otp_codes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_re_encryption_batches_updated
  BEFORE UPDATE ON re_encryption_batches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_logs_updated
  BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS re_encryption_batches CASCADE;
DROP TABLE IF EXISTS otp_codes CASCADE;
DROP TABLE IF EXISTS ingestion_jobs CASCADE;
DROP TABLE IF EXISTS vector_chunks CASCADE;
DROP TABLE IF EXISTS documents CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS qr_signatures CASCADE;
DROP TABLE IF EXISTS consent_records CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS key_versions CASCADE;
DROP TABLE IF EXISTS legal_frameworks CASCADE;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
