# Tasks: Chat de Asistencia Psicológica — MVP (WhatsApp)

**Change**: `chat-asistencia-psicologica` | **Project**: `chat-asistente-psicologico` (GREENFIELD) | **Date**: 2026-08-09
**Inputs**: `proposal.md`, 7 specs (`openspec/specs/*/spec.md`), `design.md`. Rollout order per design §13.2: scaffold → shared packages → notifications → ai-rag → chat-bot → dashboard → ingestion. `config.yaml` tasks rules applied (phases, hierarchical numbering, session-sized).

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~15,000 (range 12,000–18,000) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 8 chained PRs (see Work Units) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending — user must choose stacked-to-main vs feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

> Greenfield 5-service monorepo: even the smallest standalone slice exceeds 400 authored lines. Mitigation: feature-branch-chain so each child diff stays focused, and review by package/app subdirectory within each PR. Tests + docs ship with code (work-unit-commits).

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Scaffold + shared-types + config + telemetry (~1,100 lines) | PR 1 | `pnpm -r typecheck && pnpm --filter "./packages/shared-types" --filter "./packages/config" --filter "./packages/telemetry" test` | N/A — pure TS, vitest unit only | `git revert` scaffold commit; nothing consumes it yet |
| 2 | db-schema migrations + repositories (~2,100 lines) | PR 2 | `pnpm --filter db-schema test` | `pgvector/pgvector:pg16` test container | Revert migration commits; no app depends yet |
| 3 | crypto-keys core + rotation + OTP/QR (~1,700 lines) | PR 3 | `pnpm --filter crypto-keys test` | test PG + worker_thread integration | Revert; keys are new, no rows yet |
| 4 | llm-client + validation gates (~1,100 lines) | PR 4 | `pnpm --filter validation test && pnpm --filter llm-client test` | mock OpenAI + golden fixtures | Revert; gates not wired into services yet |
| 5 | notifications + ai-rag services (~2,500 lines) | PR 5 | `pnpm --filter notifications test && pnpm --filter ai-rag test` | compose postgres + redis, OpenAI mock | Revert; chat-bot not yet wired to ai-rag |
| 6 | chat-bot BuilderBot service (~2,700 lines) | PR 6 | `pnpm --filter chat-bot test` | compose stack + mock Baileys provider | Revert; dashboard takeover not yet wired |
| 7 | dashboard supervisor console (~2,600 lines) | PR 7 | `pnpm --filter dashboard test` | compose + Vite build | Revert; standalone UI over same API |
| 8 | ingestion + deployment + seed + e2e + docs (~2,300 lines) | PR 8 | `pnpm -r test && docker compose up -d --build && pnpm e2e` | full compose stack | Revert; per-service image tags roll back on VPS |

### Commit boundaries (work-unit-commits pattern: tests + docs with code)

One conventional commit per package/app slice, e.g. `feat(db-schema): pgvector migrations`, `feat(crypto-keys): AES-256-CBC encryptor`, `test(crypto-keys): fixed-vector round-trip`, `docs(ops): rollback runbook`. No unit merges without its focused tests green.

## Phase 1: Foundation & Shared Packages

- [x] 1.1 Scaffold pnpm monorepo — root `pnpm-workspace.yaml`, `package.json` (scripts: typecheck/test/build via `pnpm -r`), `tsconfig.base.json` (strict, project refs), `.gitignore`, `.env.example` (placeholders, no secrets), verify `.gga`; REQ-CHATBOT-1 (pillar-isolation baseline); deps: none; AC: `pnpm install && pnpm -r typecheck` green on empty workspace; tests: N/A (config only).
- [x] 1.2 `packages/shared-types` — domain types (Role, AlertLevel, PersistenceClass, AiState, ConsentState, GateResult, EncryptedPayload, ApiErrorBody RFC 7807, AccessTokenClaims, AlertEvent, RAG trace); `as const` objects, no enum; REQ-RAG-8, REQ-ALERT-1, REQ-KEY-8; deps: none; AC: strict compile + no-`enum` lint; tests: vitest type smoke.
- [x] 1.3 `packages/config` — zod env schema (DATABASE_URL, REDIS_URL, OPENAI_API_KEY, CRYPTO_MASTER_SECRET, ADMIN_EMAIL/PASSWORD_HASH, JWT_SECRET, QR_KEY, AI_EMISSION_ENABLED, gate thresholds, X_INTERNAL_TOKENS, geo keys) + `KeyProvider` interface + `EnvKeyProvider`; REQ-KEY-1 (material never stored), REQ-KEY-8; AC: boot fails fast with clear message on missing var; tests: vitest zod cases.
- [x] 1.4 `packages/telemetry` — pino structured logger, PII redactor (regex + allowlist), Redis pub-sub emitter; REQ-DASH-8, REQ-ALERT-6 (PII-stripped); AC: redactor strips phone + webhook payload patterns; tests: vitest redactor corpus.
- [x] 1.5 `packages/db-schema` migrations — 13 tables (legal_frameworks, sessions, consent_records, qr_signatures, key_versions, alerts, documents, vector_chunks, ingestion_jobs, users, otp_codes, re_encryption_batches, audit_logs) + pgvector HNSW (`idx_vector_chunks_embedding_hnsw`, m=16, ef_construction=64) + dashboard indexes + history/contact extra columns (persistence_class, key_version, purge_at); node-pg-migrate; REQ-KEY-1, REQ-RAG-2, REQ-CONSENT-4, REQ-DASH-6, REQ-INGEST-3; deps: 1.2, 1.3; AC: `migrate up` on pg16+pgvector; HNSW index present (startup-assertion test); tests: vitest + test PG container.
- [x] 1.6 `packages/db-schema` repositories — sessions, consent, alerts (dedupe query), audit, keys, chunks (parameterized vector search, `SET hnsw.ef_search = 40`), re-encryption batches, purge job (batched DELETE 100–500, `persistence_class='anonymous'`, `purge_at <= NOW()`); REQ-RAG-2, REQ-ALERT-5, REQ-CONSENT-5, REQ-KEY-4; deps: 1.5; AC: integration tests vs test PG — retrieval metadata, dedupe, purge bounds, batch queries; tests: vitest + test PG.
- [x] 1.7 `packages/crypto-keys` core — AES-256-CBC encrypt-then-MAC (`base64(iv || ct || hmac)` BYTEA), HKDF-SHA256 per-version key derivation (master + salt), Encryptor/KeyProvider, dual-read decrypt by row key_version; REQ-CONSENT-3/4, REQ-KEY-1/8; deps: 1.3; AC: round-trip + tamper → HMAC fail + dual-read; tests: vitest fixed vectors.
- [x] 1.8 `packages/crypto-keys` lifecycle — key_versions mgmt (create active N+1, retire, expires_at + forced_rotation_due_at), weekly rotation scheduler (low-traffic window), re-encryption `worker_thread` (batches 100–500, per-batch txn + integrity hash + rollback), forced 12h job, audit hooks; REQ-KEY-1..5, REQ-KEY-8; deps: 1.6, 1.7; AC: batch success + hash-mismatch rollback; event loop not blocked; tests: vitest + test PG integration.
- [x] 1.9 `packages/crypto-keys` OTP + QR — OTP service (6-digit, 10-min TTL, hashed, 5-attempt lockout), QR sign/verify (HMAC canonical payload, archive old signature → chain of trust); REQ-KEY-6/7, REQ-DASH-7; deps: 1.7, 1.3; AC: expired OTP refuses QR; tampered QR fails with reason; tests: vitest.
- [x] 1.10 `packages/llm-client` — OpenAI wrapper (gpt-4o temp 0 chat, gpt-4o-mini NLI/classify, text-embedding-3-small); model swap config-only; REQ-RAG-1/7; deps: 1.3; AC: request builder asserts temperature 0 (mock transport); tests: vitest.
- [x] 1.11 `packages/validation` — coherence gate (cosine >= 0.85 emit / 0.75–0.85 retry→yellow / < 0.75 orange), NLI client (contradiction blocks regardless of cosine), role-deviation guardrail (diagnóstico/receto/padeces/drug-dose → orange, borderline → yellow), blacklist term set; REQ-RAG-4/5/6, REQ-INGEST-1; deps: 1.10, 1.2; AC: RED tests — pass/retry/block/deviation with golden fixtures; tests: vitest golden.

## Phase 2: Notifications Service

- [x] 2.1 Scaffold — app entry, `/healthz` `/readyz`, config wiring, Redis pub-sub subscriber; REQ-ALERT-1; deps: 1.2–1.4, 1.6; AC: healthz green; tests: vitest boot.
- [x] 2.2 Alert routing + dedupe/throttle — level routing, `dedupe_key = sha256(level || session_id || category || keyword)`, one-open-alert semantics, throttle windows; REQ-ALERT-1/5; deps: 2.1; AC: repeated crisis keyword → single open alert, follow-ups update it; tests: vitest + test PG.
- [x] 2.3 Socket.io push + fallback — emit to dashboard, red push < 1s, fallback channel (Telegram/Web) on push failure, PII-stripped logs; REQ-ALERT-2/4/6; deps: 2.2, 1.4; AC: latency harness < 1s; push-failure → fallback attempted + audit row; tests: vitest + Socket.io client harness.
- [x] 2.4 Alert lifecycle endpoints + audit — acknowledge/resolve transitions (`open → acknowledged → resolved`), audit rows (who/when/why, no PII); REQ-ALERT-6; deps: 2.2, 1.6; AC: state-machine tests; tests: vitest + test PG.

## Phase 3: ai-rag Service

- [x] 3.1 Scaffold — `POST /internal/rag/process` (X-Internal-Token), healthz, config, shared-types wiring; REQ-RAG-2 (HNSW startup assertion); deps: 1.2–1.6, 1.10, 1.11; AC: POST bad input → RFC 7807 problem+json; tests: vitest.
- [x] 3.2 Risk classification — GPT-4o-mini classify red/orange/yellow/normal driving routing before retrieval; REQ-RAG-7; deps: 3.1, 1.10; AC: mock classify → routing decision; tests: vitest.
- [x] 3.3 Retrieval — embed query (text-embedding-3-small) → pgvector HNSW top-k with metadata (category/source/language/framework); REQ-RAG-2/3; deps: 3.1, 1.6, 1.10; AC: metadata-attributed top-k; missing index → fail loudly; tests: vitest + test PG.
- [x] 3.4 Generation — GPT-4o temp 0, RAG-only prompt (chunks only), medication standard-refusal path; REQ-RAG-1; deps: 3.3, 1.10; AC: prompt contains only chunk context; temp 0 asserted; tests: vitest (mock).
- [x] 3.5 Orchestrator + gate integration — classify → retrieve → generate → gate; emit/retry/orange/yellow routing; trace metadata (chunks + gate scores) for dashboard; raise alert events via pub-sub (notifications contract); REQ-RAG-4/5/8, REQ-ALERT-1; deps: 3.2–3.4, 1.11; AC: gate pass/block/borderline integration tests; trace returned; tests: vitest + test PG + Redis.

## Phase 4: chat-bot Service (BuilderBot)

- [x] 4.1 Scaffold — `createBot({ flow, provider, database })` with Baileys + PostgreSQLDB adapter, three-pillar separation, healthz, X-Internal-Token client for ai-rag; REQ-CHATBOT-1/7; deps: 1.2–1.7, 1.10, 1.11; AC: boots in test mode; provider swap config-only; tests: vitest.
- [x] 4.2 Welcome/menu flow — welcome + menu (topics/privacy/crisis), menu keyword re-entry, no data stored yet; REQ-CHATBOT-3/4; deps: 4.1; AC: first-contact + re-entry flow tests; tests: vitest flow harness.
- [x] 4.3 Geolocation + jurisdiction — IP geolocation (MaxMind/IPStack) propose jurisdiction, user confirmation, VPN discrepancy log (PII-stripped), conservative default for unknown; REQ-CONSENT-1/6; deps: 4.2, 1.3; AC: confirmed / VPN / unknown-jurisdiction tests; tests: vitest.
- [x] 4.4 Privacy/consent flow — notice per jurisdiction (6 frameworks + default) before any support topic; checkbox → crypto-keys encrypt → Base64 → node-qrcode → QR media via addAction → consent registry row (terms_version, jurisdiction, key_version, integrity_hash); REQ-CONSENT-2/3/4, REQ-CHATBOT-4/6; deps: 4.3, 1.7, 1.9; AC: consent e2e against test DB; nothing persisted pre-consent; tests: vitest + test PG.
- [x] 4.5 Crisis flow — crisis keywords (OMS/mhGAP config list) → immediate crisis response with local lines by geolocation + raise red alert (pub-sub), < 5s best-effort; REQ-CHATBOT-5, REQ-ALERT-3; deps: 4.4, 2.2; AC: keyword → red alert event + crisis text; tests: vitest + Redis.
- [x] 4.6 Message lifecycle addAction — RAG via `POST /internal/rag/process` inside addAction; gate pass → flowDynamic grounded answer; persist to PostgreSQLDB sink; degraded mode on ai-rag down → human-only (AI_EMISSION_ENABLED kill switch); REQ-CHATBOT-2/7; deps: 4.1, 3.5; AC: grounded-emission + kill-switch tests; tests: vitest + test PG.
- [x] 4.7 Session persistence + graceful reconnect — Baileys session persistence, keep-alive, auto-reconnect on auth_failure, re-pair QR surface + supervisor fallback notify; REQ-CHATBOT-8; deps: 4.1, 2.3; AC: reconnect handler tests (mock provider events); tests: vitest.
- [x] 4.8 Anonymous purge cron — node-cron purge job (24–48h contract via db-schema purge repository); HC untouched; REQ-CHATBOT-9, REQ-CONSENT-5; deps: 4.1, 1.6; AC: purge-window bounds + HC-untouched tests; tests: vitest + test PG.
- [x] 4.9 HC export + OTP/QR renewal (chat-side) — export decrypted history (audit-logged), OTP request/verify (10-min TTL, 5 attempts), QR renew with archived signature; REQ-CONSENT-5, REQ-KEY-6/7, REQ-DASH-8; deps: 4.4, 1.9; AC: export audit + expired-OTP-refuses-QR tests; tests: vitest + test PG.

## Phase 5: dashboard Service

- [x] 5.1 Scaffold + auth — Vite React 19 + Express 5 + Socket.io; JWT login/me, middleware chain authenticate → authorize → audit; env-bootstrapped admin; REQ-DASH-1; deps: 1.2–1.6; AC: supervisor denied admin action + denial audit-logged; tests: vitest.
- [x] 5.2 Dual chat view + RAG context — paginated chats (anonymized IDs), chat detail with user/bot messages + RAG trace (chunks, gate scores, alert level); loading/error states; REQ-DASH-2/9; deps: 5.1, 3.5 (trace contract); AC: flagged-answer review scenario; tests: vitest + component tests.
- [x] 5.3 Takeover/release — POST takeover (ai_state=takeover, AI off), supervisor replies via `/messages/ingest` internal, release resumes AI, 409 on double takeover, audit-logged; REQ-DASH-3; deps: 5.1, 4.6; AC: takeover session + release scenarios; tests: vitest + test PG.
- [x] 5.4 Alert semaphore — Socket.io live feed, per-alert details, acknowledge/resolve wired to notifications, < 1s display, error/retry states, WS cleanup on unmount; REQ-DASH-4/9; deps: 5.1, 2.3/2.4; AC: red alert appears < 1s (harness); tests: vitest + Socket.io client harness.
- [ ] 5.5 Vector explorer + re-vectorization — semantic + metadata search, chunk detail, manual removal (audit-logged), re-vectorization trigger (admin); REQ-DASH-5, REQ-INGEST-5/6; deps: 5.1, 6.3/6.4 (API contract); AC: manual removal → chunk deleted + audit row; tests: vitest + test PG.
- [x] 5.6 Key-rotation monitor — 7-day countdown, 12h forced clock, per-batch progress via Socket.io, manual rotate (dry-run first, admin, audit); REQ-DASH-6; deps: 5.1, 1.8; AC: forced clock visible; batch progress events; tests: vitest + Socket.io harness.
- [x] 5.7 QR validator — validate QR + chain (consent record, terms_version, key_version, signature chain); tampered/expired → failure with reason; audit-logged; REQ-DASH-7; deps: 5.1, 1.9; AC: valid + tampered scenarios; tests: vitest + test PG.
- [x] 5.8 Audit panel + legal frameworks mgmt — audit log query (PII-stripped, filters), frameworks list + publish new terms version (admin); REQ-DASH-8, REQ-CONSENT-6; deps: 5.1, 7.2 (seed); AC: audit query shows no PII; publish flow; tests: vitest + test PG.

## Phase 6: ingestion Service

- [x] 6.1 Scaffold — healthz, config, admin JWT auth wiring, job-rows writer; REQ-INGEST-3; deps: 1.2–1.6; AC: healthz; tests: vitest boot.
- [x] 6.2 Blacklist filter + chunking — blacklist (doses, drug names: Fluoxetina/Litio/Sertralina, posology) before vectorization; chunk 500–800 chars respecting paragraphs; short passages merged, never dropped; REQ-INGEST-1/2; deps: 6.1, 1.11 (blacklist terms); AC: blacklisted content rejected + clean content passes; chunk bounds; tests: vitest.
- [x] 6.3 Embed + upsert — embed chunks (text-embedding-3-small), idempotent pgvector upsert, metadata tagging (category/source/language/framework); REQ-INGEST-3/4; deps: 6.2, 1.6, 1.10; AC: idempotent upsert (no dup) + metadata-complete row; tests: vitest + test PG.
- [x] 6.4 Re-vectorization + prohibited-zones sweep — re-vectorize doc (idempotent, stale-row cleanup), sweep flags prohibited chunk → alert, scheduled runs; REQ-INGEST-5/6; deps: 6.3, 2.2; AC: manual re-vectorization + sweep-flag tests; tests: vitest + test PG.

## Phase 7: Integration, Deployment & Seed

- [x] 7.1 `docker-compose.yml` + 5 Dockerfiles + `Caddyfile` — services, postgres:16-pgvector, redis:7, caddy TLS; healthchecks on /healthz, depends_on gates, restart policy; REQ-CHATBOT-8 (keep-alive infra); AC: `docker compose config` valid; all containers healthz green; tests: compose smoke.
- [x] 7.2 Seed data + admin bootstrap — 6 legal frameworks + conservative default (terms_version), first key_version, admin bootstrap from env; REQ-CONSENT-6, REQ-KEY-1; deps: 1.5, 1.8; AC: seed idempotent + bootstrap creates admin; tests: vitest + test PG.
- [x] 7.3 End-to-end smoke suite — user msg → RAG → gate → emit/persist; red alert → Socket.io < 1s; takeover; consent QR; purge; rotation; REQ: all; deps: all services; AC: full-stack e2e green against compose; tests: vitest e2e (Playwright deferred per design §12).
- [x] 7.4 Ops docs + backups — README runbook, env schema, nightly `pg_dump --format=custom` + restore point before rotation, rollback runbook (kill switch, image rollback); AC: docs cover kill switch + rotation rollback; tests: N/A (docs).

## Phase 8: Hardening & Cross-cutting Verification

- [x] 8.1 Gate threshold calibration + latency checks — tune 0.75/0.85 on pilot corpus, assert red push < 1s, crisis < 5s, Q&A p95 < 8s; REQ-ALERT-2/3, REQ-RAG-4; AC: calibration report + latency smoke green; tests: vitest perf harness.
- [x] 8.2 AGENTS.md compliance sweep — zero `any` (with `@ts-expect-error` justification), no console.log of PII, no hardcoded secrets, strict TS, no `enum`; AC: grep/tsc gates pass; tests: CI lint job.
