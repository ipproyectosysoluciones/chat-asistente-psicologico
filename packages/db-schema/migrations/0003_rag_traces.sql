-- Up Migration
-- rag_traces: exact RAG grounding trace per chat (task 5.2, REQ-DASH-2/9).
-- Holds curated clinical chunks + gate scores — no user PII, no phone, no raw
-- payload (REQ-DASH-8). Written by the chat-bot emission addAction via
-- saveRagTrace; read by the dashboard dual chat view (flagged-answer review).

CREATE TABLE rag_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions (id),
  trace jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rag_traces_session_created
  ON rag_traces (session_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS rag_traces;
