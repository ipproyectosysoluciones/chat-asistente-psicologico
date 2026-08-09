# Code Review Rules — Chat Asistente Psicológico

Mental-health chat assistant. This project handles **sensitive health data** (clinical histories, crisis alerts).
Security and privacy rules are HARD requirements, not suggestions.

## References

- SDD artifacts: `openspec/changes/` (proposal, spec, design, tasks)
- Shared conventions: `.atl/skill-registry.md`

---

## Critical Rules (ALL files)

REJECT if:

- Hardcoded secrets, credentials, API keys, tokens, or passwords in code or config
- `console.log` / `print()` of message content, PII, clinical data, or raw RAG chunks in production code
- Missing error handling (empty catch blocks, silent `catch (e) {}`)
- Data of anonymous users persisted without expiry logic (24–48 h cleanup contract)
- Any code path that lets the AI diagnose, prescribe, or recommend medication
- `any` type without `// @ts-expect-error` justification
- Plain-text storage of anything consent-related (MUST be AES-256 encrypted, Base64 + QR)
- Logging raw payloads from WhatsApp/Telegram webhooks (strip PII first)

REQUIRE:

- Descriptive variable and function names
- Error messages that help debugging
- Privacy notices / consent flow enforced at session start (per-country legal framework)
- TypeScript strict mode for all TS files
- Health-data fields encrypted at rest; keys versioned (`key_version`) and rotated (7-day cycle)
- Danger-zone guardrails: role-deviation words (`diagnóstico`, `receto`, medication terms) blocked at output layer

PREFER:

- Small, focused modules over large god-files
- Composition over inheritance
- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`)

---

## TypeScript

REJECT if:

- `any` type without explicit justification
- Missing return types on exported functions
- Type assertions (`as X`) without a comment explaining why
- `enum` → use `as const` objects
- Unused imports or variables
- `import * as X` where named imports are possible

REQUIRE:

- Discriminated unions for state machines (chat states, alert levels, user risk tiers)
- Explicit error types for service boundaries (chat-bot, ai-rag, dashboard, ingestion, notifications)

PREFER:

- `satisfies` over type assertions
- Named exports over default exports
- Strict null checks (no `!` non-null assertions unless proven)

---

## React (supervisor dashboard)

REJECT if:

- `import React` → use named imports (`import { useState }`)
- `useMemo`/`useCallback` without justification (React 19 Compiler handles this)
- Missing `"use client"` in client components where required
- Props drilling more than 2 levels deep
- Exposing supervisor-only data (chat logs, consent records) to unauthorized roles — check RBAC at every data fetch

REQUIRE:

- Accessibility basics: alt text on images, labels on inputs
- WebSocket (Socket.io) connections cleaned up on unmount
- Error states + loading states for every async view (alert feeds, chat dual view, key rotation monitor)

PREFER:

- Colocated files (component + test + styles in same directory)
- Semantic HTML (`<section>`, `<article>`) over generic `<div>`
- Recharts/D3 for visualization, theme tokens instead of hardcoded colors

---

## Node.js / BuilderBot (chat bot service)

REJECT if:

- Provider logic coupled to flow logic (BuilderBot three-pillar contract: Flow / Provider / Database must stay swappable)
- Webhook handlers without validation of the request source
- Blocking the event loop with crypto or embedding work (use worker threads / async)
- Re-encryption jobs that touch the full table at once — MUST batch (100–500 rows) with rollback + integrity hash
- Sending ungrounded LLM output to users (RAG grounding gate is mandatory before emission)

REQUIRE:

- `addAction` used for LLM/RAG, validation, DB writes, and media (QR) sends
- Coherence gate before emit: cosine similarity ≥ 0.85 vs source chunk, NLI check, orange-block on role deviation
- Alert escalation path for red-level risk (vital risk) that does not depend on WhatsApp alone
- Graceful reconnection for Baileys sessions (keep-alive, reconnect, session persistence)

PREFER:

- Provider abstraction so Baileys ↔ Meta swap is configuration-only
- `@builderbot/database-postgres` as the conversation-history sink

---

## PostgreSQL / pgvector

REJECT if:

- Migrations that drop or alter encrypted columns without key-version awareness
- Vector queries without HNSW index on embedding columns
- Raw SQL string interpolation with user input (use parameterized queries)

REQUIRE:

- `key_version` metadata on every encrypted row
- Chunk metadata (category, source, language, legal framework) on every vector row
- Blacklist-filtered content before vectorization (no dose terms, no drug names, no posology)
- Indexes on alert/status/date columns used by the supervisor dashboard

PREFER:

- Views or read models for dashboard queries over raw table scans
- `BYTEA`/`TEXT` for encrypted consent payloads with integrity hash

---

## Testing

REQUIRE:

- Tests for the coherence gate (grounded pass, ungrounded reject, role-deviation block)
- Tests for the alert escalation (red/orange/yellow) paths
- Tests for dual persistence: HC expiry logic vs anonymous cleanup (24–48 h)
- Tests for key rotation: re-encryption batches, forced 12 h path, rollback on failure
- Tests for consent flow: checkbox → AES-256 → Base64 → QR → OTP-gated renewal

PREFER:

- Vitest for TS/React; integration tests against a test PostgreSQL instance
- Test files excluded via `.gga` `EXCLUDE_PATTERNS` (already configured)

---

## Security & Compliance

REJECT if:

- Any code that bypasses the geolocation + user-confirmation legal framework selection
- Storing consent records without the version of the legal terms accepted
- Accessing encrypted records without audit logging (who/when/why)

REQUIRE:

- RBAC: anonymous, HC-registered patient, supervisor, admin — each with scoped permissions
- Audit logs for: QR validation, key access, takeover events, forced re-encryption
- OTP (6-digit, 10-min validity) before delivering a renewed QR

PREFER:

- NIST-aligned key management (weekly rotation, forward secrecy)
- Vault/KMS-style secret storage over env-var-only for production secrets

---

## Response Format

FIRST LINE must be exactly:
STATUS: PASSED
or
STATUS: FAILED

If FAILED, list: `file:line - rule violated - issue`
