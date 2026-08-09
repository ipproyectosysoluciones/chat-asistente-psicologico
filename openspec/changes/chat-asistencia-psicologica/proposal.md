# Proposal: Chat de Asistencia Psicológica — MVP (WhatsApp)

**Change**: `chat-asistencia-psicologica` | **Project**: `chat-asistente-psicologico` (GREENFIELD) | **Date**: 2026-08-09
**Launch market**: broad LatAm (Colombia, México, Chile, Argentina first; EEUU/UE compliance framework maintained)

---

## Intent

A WhatsApp-first mental-health **support and guidance** assistant (acompañamiento/orientación) for people living with anxiety, adjustment disorder, depression (all stages), bipolarity, and substance dependence. The mission is **safety-critical**: the AI supports and guides exclusively from curated clinical documents (GPC, OMS/mhGAP, NHS, NIMH, SAMHSA) — it MUST **never diagnose and never prescribe or recommend medication** (C1). Every emitted answer must pass a grounding gate (C2–C4); crisis and deviation signals raise 3-level alerts to a permanent human-in-the-loop supervisor (C5–C6). Health data is handled under a multi-jurisdiction privacy framework with AES-256 encryption, weekly key rotation, and dual persistence (C8–C12). The MVP proves this safety model on WhatsApp at pilot scale (C14–C16) with a clear migration path to the official Meta API before production at scale.

## Scope

### In Scope (MVP)
- WhatsApp chat bot: BuilderBot (Baileys provider, PostgreSQLDB adapter) — flows, consent, geolocation, crisis keywords, QR image in chat.
- RAG pipeline: OpenAI GPT-4o (temp 0) + GPT-4o-mini side-tasks (NLI, classification) + pgvector (HNSW) retrieval.
- Output validation: cosine ≥ 0.85 gate + NLI + role-deviation guardrail (orange-block / yellow-flag).
- 3-level alerting (red/orange/yellow) + supervisor push + crisis escalation protocol.
- Human-in-the-loop supervisor dashboard: dual chat view, RAG context injection, takeover, alert semaphore, vector explorer, key-rotation monitor, QR validator, audit logs, RBAC.
- Consent flow: checkbox → AES-256-CBC (backend Node `crypto`) → Base64 → QR image sent in chat; consent registry with terms version.
- Dual persistence: HC-registered (persistent, AES-256, exportable) vs anonymous (ephemeral, auto-purge 24–48h).
- Multi-jurisdiction privacy notice (6 frameworks) at session start; geolocation via IP (MaxMind/IPStack) + user confirmation; real-time location only in crisis.
- Weekly key rotation: key_version table, deferred re-encryption (30-min inactivity/session end), forced at 12h post-expiry, batches 100–500 with rollback + integrity hash, new QR gated by 6-digit OTP (10-min validity).
- Ingestion pipeline: blacklist filter (doses, drug names, posology), chunking 500–800 chars, embeddings, metadata (category/source/language/legal framework), re-vectorization.
- Delivery: pnpm monorepo, Docker, single PostgreSQL+pgvector + Redis, deployed on own VPS (pilot scale with headroom).

### Out of Scope (MVP)
- Telegram / Web / React Native channels (designed behind provider abstraction, later).
- Meta WABA full migration (documented migration gate, not executed in MVP).
- Advanced analytics, multi-tenant professional network, monetization.
- English-language content (Spanish-first; i18n metadata in schema only).
- SSO/enterprise auth for dashboard (env-based admin + RBAC roles).

## User Stories

| ID | Actor | Story |
|----|-------|-------|
| US-1 | Anonymous user | Start a support chat and receive the privacy notice for my jurisdiction (IP + confirmation) before any data is stored. |
| US-2 | Anonymous user | In crisis, receive immediate emergency guidance with local help lines; my session is escalated to a supervisor. |
| US-3 | Anonymous user | Have my conversation history automatically deleted within 24–48 hours. |
| US-4 | HC-registered patient | Consent to HC registration and receive a QR receipt image I can present at my clinic. |
| US-5 | HC-registered patient | Renew my QR after key rotation using a 6-digit OTP (10-min validity). |
| US-6 | HC-registered patient | Request my encrypted clinical history for my treating professional. |
| US-7 | Supervisor | Receive red alerts immediately and take over any chat (AI disabled; human replies through bot). |
| US-8 | Supervisor | Review orange-blocked outputs with the exact RAG context that grounded (or failed to ground) them. |
| US-9 | Supervisor | Validate a patient's QR and inspect the consent/signature chain. |
| US-10 | Admin | Monitor the 7-day key rotation countdown, 12h forced clock, and re-encryption progress per batch. |
| US-11 | Admin | View audit access logs and manage legal framework versions per country. |
| US-12 | Admin | Trigger re-vectorization and inspect the knowledge base ("zonas prohibidas" sweep + manual removal). |

## Functional Requirements (mapped from constraints C1–C16)

| FR | Constraint | Requirement |
|----|-----------|-------------|
| FR-1 | C1 | Negative prompt + output-layer guardrail: never diagnose, prescribe, or recommend medication. Standard refusal for medication queries: *"No tengo facultad para recomendar ni ajustar medicación; consulte con su psiquiatra tratante."* |
| FR-2 | C2 | Answers generated EXCLUSIVELY from retrieved chunks (RAG-only); no free-form knowledge. Chunk metadata (category, source, language, legal framework) mandatory on every vector row. |
| FR-3 | C3 | GPT-4o temperature 0 for all user-facing generation. |
| FR-4 | C4 | Coherence gate before any emission: cosine ≥ 0.85 vs source chunk + NLI contradiction check. Gate failure → never emit. |
| FR-5 | C5 | 3-level alerts: red (vital risk) → immediate crisis response + supervisor push; orange (role deviation terms) → BLOCK emission, human review; yellow (incoherence) → flagged log for review. |
| FR-6 | C6 | Permanent human-in-the-loop: supervisor takeover (AI off per chat), constant log review, bot trust grows only with evidence. |
| FR-7 | C7 | Pre-vectorization curation: blacklist filter, chunking 500–800 chars, metadata tagging; "zonas prohibidas" sweep + manual removal in dashboard. |
| FR-8 | C8 | Dual persistence: HC = persistent AES-256 encrypted, exportable; anonymous = ephemeral ID, auto-purge 24–48h (cron/trigger). |
| FR-9 | C9 | Privacy notice at session start per geolocated jurisdiction (Colombia 1581/Res.1995, México LFPDPPP, EEUU HIPAA, UE RGPD, Argentina 25.326, Chile 19.628); IP geolocation + user confirmation (VPN mitigation); real-time location only in crisis. |
| FR-10 | C10 | Consent: checkbox → AES-256-CBC backend (Node `crypto`) → Base64 → QR image sent directly in chat (node-qrcode); consent registry row with terms version. Backend-only crypto. |
| FR-11 | C11 | Weekly rotation (7-day key lifecycle, forward secrecy); re-encryption in low-traffic window at 30-min inactivity/session end; FORCED at 12h post-expiry; silent (latency risk accepted); batches 100–500; worker thread; per-batch rollback + integrity hash. |
| FR-12 | C12 | New QR per rotation; delivery gated by 6-digit OTP (10-min validity); old signature archived; chain of trust maintained. |
| FR-13 | C13 | Internal dashboard: React (Vite) + Node/Express + Socket.io + Recharts/D3; dual chat view, RAG context, takeover, alert semaphore, vector explorer, key monitor, QR validator, audit access logs. |
| FR-14 | C14 | WhatsApp via BuilderBot first (Baileys); Telegram/Web/React Native swappable behind `IProvider`. |
| FR-15 | C15 | GPT-4o (conversational), GPT-4o-mini (classification, NLI, sentiment). |
| FR-16 | C16 | VPS deployment, pilot scale with headroom to scale. |

## Non-Functional Requirements

| Area | Requirement |
|------|-------------|
| Security | AES-256 at rest (health data, consent), TLS 1.2+ in transit; keys versioned (`key_version`) + weekly rotation; RBAC (anonymous/patient/supervisor/admin); audit logs for QR validation, key access, takeover, forced re-encryption; no secrets in code/config (env + Vault-style storage); no PII in logs (webhook payloads stripped). |
| Privacy/Compliance | Privacy notice + consent enforced at session start per jurisdiction; consent registry stores terms version; dual persistence with 24–48h anonymous cleanup contract; data classification HC vs ephemeral. |
| Performance | Red-alert supervisor push < 1s (Socket.io); crisis reply target < 5s best-effort via WhatsApp; normal Q&A p95 < 8s; validation overhead ≤ 1.5s; re-encryption batches 100–500 rows in low-traffic window, forced deadline 12h. |
| Reliability | Baileys keep-alive + auto-reconnect + session persistence; degraded mode: if RAG/gates unavailable → AI off, human-only replies; alert fallback channel (dashboard/Telegram) on WhatsApp failure; batch rollback on re-encryption failure; DB backups. |
| Observability | Structured PII-stripped logs; gate-failure counters; alert SLA metrics; rotation progress; re-encryption health; telemetry events to dashboard. |

## Capabilities (contract for sdd-spec)

> `openspec/specs/` is empty (greenfield) → all capabilities are **New**; each becomes `openspec/specs/<name>/spec.md`.

### New Capabilities
- `chat-bot-whatsapp`: BuilderBot flows, Baileys provider, message lifecycle, consent/geo/crisis-keyword flows, QR media send, PostgreSQLDB sink, anonymous purge trigger.
- `ai-rag-pipeline`: pgvector (HNSW) retrieval, GPT-4o temp-0 generation grounded on chunks only, cosine ≥ 0.85 gate, NLI check, role-deviation guardrail, source/trace metadata.
- `alert-escalation`: red/orange/yellow detection & routing, supervisor push, crisis escalation protocol, dedupe/throttle, fallback channel.
- `supervisor-dashboard`: dual chat view + RAG context, takeover, alert semaphore, vector explorer, key-rotation monitor, QR validator, audit/access logs, RBAC.
- `consent-and-privacy`: jurisdiction selection (IP + confirmation), per-country privacy notice, consent AES-256 → Base64 → QR, consent registry, dual persistence (HC vs anonymous 24–48h).
- `key-rotation`: key_version lifecycle, weekly rotation, deferred/forced re-encryption (batches + rollback + integrity hash), OTP-gated QR renewal, signature chain.
- `ingestion-curation`: blacklist filtering, chunking 500–800, embeddings, metadata tagging, pgvector upsert, re-vectorization.

### Modified Capabilities
- None (greenfield).

## Approach

**pnpm monorepo** (single source of truth for safety-critical shared packages) + **5 services** on one VPS for the pilot (Docker; per-service systemd/containers later):

```
apps/    chat-bot (BuilderBot+Baileys+PostgreSQLDB) · ai-rag (GPT-4o/mini+pgvector+gates)
         dashboard (React/Vite+Express+Socket.io) · ingestion (blacklist/chunk/embed)
         notifications (alert push/queue/escalation)
packages/ shared-types · db (pg+pgvector+migrations) · crypto-keys (AES-256+rotation+worker)
         llm-client · rag-core (retrieval+cosine+NLI+guardrails) · config (zod env) · telemetry
```

Flow: user msg → flow match → `addAction` → risk classify → retrieve chunks (pgvector) → GPT-4o temp 0 → validate (cosine ≥ 0.85 + NLI + guardrail) → red/orange → block/route to supervisor + notify → else emit grounded answer → persist (PostgreSQLDB) → telemetry to dashboard.

**Key decisions (with rationale)**

| Decision | Choice | Rationale |
|----------|--------|-----------|
| WhatsApp provider | **Baileys for pilot**; Meta migration gate before production at scale | Fast, free, **outbound-anytime** (critical for crisis follow-up vs Meta 24h window); provider swap is config-only (same `IProvider`); dedicated throwaway number limits ban risk |
| Generation | GPT-4o, temp 0, RAG-only | Deterministic, factual, grounded exclusively in curated docs (C1–C3) |
| Coherence gate | cosine ≥ 0.85 emit; 0.75–0.85 retry-once then yellow-flag; < 0.75 or NLI contradiction → **orange-block** (no emission, human review) | Emission without grounding = safety incident (R2) |
| Role deviation | Orange-block: "diagnóstico", "receto", "padeces", drug/dose terms at output layer; yellow-flag for borderline wording | C5: deviation is blocked, not emitted |
| Vector store | pgvector (HNSW) in single PostgreSQL | One DB for RAG + conversations + consent + keys + alerts (client-confirmed) |
| Realtime | Socket.io + Redis pub-sub | Red/orange alert latency must be near-instant (C13) |
| Crypto | Shared `crypto-keys` package from day one | Rotation/re-encryption/QR/OTP are entangled with chat flows; one source of truth |

## Assumptions & Open Decisions (proposal question round — auto mode)

Defaults assumed; none block the spec phase.

1. **Gate thresholds**: cosine ≥ 0.85 (emit) / 0.75–0.85 retry→yellow / < 0.75 → orange-block. *Open*: calibrate on pilot data during design/verify.
2. **Crisis keyword list**: derived from OMS/mhGAP + reviewed by a mental-health professional during ingestion curation. *Open*: source list final sign-off.
3. **Emergency phone lines** per jurisdiction: loaded by geolocation; validated before launch.
4. **OTP delivery**: via WhatsApp message from the bot (Baileys).
5. **Latency targets**: red push < 1s; crisis reply < 5s best-effort; Q&A p95 < 8s.
6. **Embedding model**: `text-embedding-3-small` default (cost); swap to `-large` is config-only.
7. **Queueing**: Redis pub-sub + BullMQ optional for alert queues.
8. **Dashboard auth**: env-based admin + RBAC roles; SSO deferred.
9. **Data residency**: single VPS region (LatAm, e.g. Colombia/México) for pilot; legal review before scale-out/EEUU-UE operations.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/chat-bot/` | New | BuilderBot flows, provider, consent/geo/QR, crisis detection, PostgreSQLDB sink |
| `apps/ai-rag/` | New | Retrieval, generation, validation gates, guardrails |
| `apps/dashboard/` | New | Supervisor UI + Express/Socket.io backend |
| `apps/ingestion/` | New | Blacklist, chunking, embeddings, re-vectorization |
| `apps/notifications/` | New | Alert push, escalation, dedupe |
| `packages/*` | New | shared-types, db, crypto-keys, llm-client, rag-core, config, telemetry |
| `openspec/specs/*` | New | 7 capability specs (see Capabilities) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Baileys ban/session fragility (health product on unofficial API) | High | Dedicated pilot number; `experimentalStore` + `timeRelease` + reconnect/session persistence; Meta migration gate documented before production |
| Hallucinated diagnosis/drug advice = safety incident | Critical | temp 0 + RAG-only + cosine ≥ 0.85 + NLI + orange-block guardrail; never emit ungated; all gate failures reviewed |
| Multi-jurisdiction compliance breach (6 frameworks) | High | Notice at session start, consent registry + QR receipts, AES-256 + rotation, RBAC, audit logs, anonymized phone in dashboard, legal review pre-launch |
| Key rotation/re-encryption failure → unreadable data or outage | High | Key versioning, dual-read during transition, worker-thread batches with rollback + integrity hash, dashboard monitors, silent operation accepted |
| Crisis message latency (WhatsApp + Baileys QoS) | High | Keep-alive/reconnect; dashboard push < 1s independent of WhatsApp; fallback channel + human escalation; Meta template pre-approval before migrating |

## Rollback Plan

- **Emission safety**: kill switch per chat/service — disable AI emission, route to human-only replies; feature-flag gates off → bot offline, not ungrounded.
- **Re-encryption**: per-batch rollback on integrity-hash failure; keep previous key active during transition (dual-read) until all rows migrated + verified.
- **Consent/QR**: OTP expiry invalidates QR; re-issue from consent registry; old signature archived for chain of trust.
- **Baileys**: re-pair QR/pairing code on session loss; swap provider to Meta = config change only (flows/DB untouched).
- **Data**: nightly DB backups; restore point before each rotation window.
- **Git**: conventional commits behind GGA hook; revert commits if schema/guardrail change misbehaves.
- **Infra**: Docker images tagged per service; roll back image on VPS.

## Dependencies

- OpenAI API (GPT-4o, GPT-4o-mini, embeddings) — keys via env/Vault, no hardcoding.
- `@builderbot/bot`, `@builderbot/provider-baileys`, `@builderbot/database-postgres` (verified against official docs).
- PostgreSQL 15+ with `pgvector` (HNSW) + Redis 7.
- MaxMind/IPStack geolocation.
- node-qrcode, Node `crypto`, `pg`, Socket.io, Recharts/D3, zod.
- Legal review of privacy notices for 6 jurisdictions before launch (external).

## Success Criteria

- [ ] Consent flow end-to-end: checkbox → AES-256-CBC → Base64 → QR image in chat → registry row with terms version.
- [ ] Coherence gate passes grounded answers, blocks ungrounded (cosine < 0.75) and role-deviation outputs — unit-tested.
- [ ] Red-alert escalation reaches supervisor dashboard in < 1s; crisis reply < 5s best-effort.
- [ ] Anonymous conversations purged within 24–48h; HC histories persist AES-256 encrypted.
- [ ] Weekly rotation completes: 100% rows re-encrypted (or forced path at 12h) with per-batch rollback verified; new QR delivered via OTP.
- [ ] Privacy notice shown per geolocated jurisdiction before data storage; consent never bypassable.
- [ ] Supervisor takeover works per chat (AI disabled; human replies through bot).
- [ ] Zero `any` (with justification), strict TS, no console.log of PII, no hardcoded secrets (AGENTS.md rules).
