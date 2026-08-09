# Exploration: Chat de Asistencia Psicológica (MVP)

**Change**: `chat-asistencia-psicologica`
**Project**: `chat-asistente-psicologico` (GREENFIELD — no source code, no package.json, no git repo yet)
**Date**: 2026-08-09
**Scope**: Explore-only. No proposal/spec/design/tasks were produced; no application code was written.

---

## 1. Product Domain and Safety-Critical Constraints

The product is a mental-health **support and guidance** chat assistant (WhatsApp first) for people living with anxiety disorder, adjustment disorder, depression (all stages), bipolarity, and substance dependence (licit and illicit). The system's sole purpose is **acompañamiento/orientación** — it MUST NEVER diagnose and NEVER prescribe or recommend medication.

### Non-negotiable client constraints (from the requirements document)

| # | Constraint | Requirement |
|---|-----------|-------------|
| C1 | **No diagnosis / no prescription** | Explicit negative-prompt engineering. Standard refusal for medication queries: *"No tengo facultad para recomendar ni ajustar medicación; consulte con su psiquiatra tratante."* |
| C2 | **RAG-only grounding** | The AI answers EXCLUSIVELY from retrieved clinical documents (GPC, OMS/mhGAP, NHS, NIMH, SAMHSA...). No free-form knowledge use. |
| C3 | **Temperature 0** | Deterministic, factual output. |
| C4 | **Coherence gate before emission** | Cosine-similarity check between generated answer and the source chunk (threshold ≈ 0.85 similarity; distance > 0.15 → incoherence alert). NLI for logical contradiction. |
| C5 | **3-level alerting** | Red (vital risk: self-harm, overdose, suicidal ideation) → immediate emergency response + push to supervisor; Orange (role deviation: "diagnóstico", "receto", "padeces", drug terms) → BLOCK output for human review; Yellow (incoherence/hallucination) → flagged log for review. |
| C6 | **Permanent human-in-the-loop** | Supervisor can "Takeover" any chat; logs reviewed constantly; bot only becomes less supervised once proven. |
| C7 | **Content curation before vectorization** | Blacklist filter (dose terms, "mg/día", posología, drug names like Fluoxetina/Litio/Sertralina) + chunking (≈500–800 chars) + metadata tagging (category, source). "Zonas prohibidas" sweep + manual removal in dashboard. |
| C8 | **Dual persistence** | HC (clinical-history) users: persistent logs, AES-256 encrypted, exportable to HC. Anonymous users: ephemeral identifier, auto-delete 24–48h (trigger/cron). |
| C9 | **Multi-jurisdiction privacy** | Colombia Ley 1581/Res. 1995, México LFPDPPP, EEUU HIPAA, UE RGPD, Argentina Ley 25.326, Chile Ley 19.628. Privacy notice shown at session start; geolocation by IP (IPStack/MaxMind) + user confirmation (VPN mitigation); real-time location only in crisis. |
| C10 | **Consent → AES-256 → QR** | Checkbox consent → backend AES-256-CBC (Node `crypto`) → Base64 → QR image sent DIRECTLY in chat (node-qrcode). Backend-side only. |
| C11 | **Weekly key rotation** | Key lifecycle 7 days (forward secrecy). Re-encryption in low-traffic window, waiting for 30-min inactivity or session end; FORCED at 12h post-expiry; silent (latency risk accepted); batches of 100–500 rows; worker thread; rollback + integrity hash per batch. |
| C12 | **New QR per rotation** | Each re-encryption issues a new QR; delivery gated by 6-digit OTP (10-min validity). Old signature archived, chain of trust maintained. |
| C13 | **Internal dashboard only** | React (Vite) + Node/Express + Socket.io + Recharts/D3. Dual chat view, RAG context injection, takeover, alert semaphore, vector explorer, key-rotation monitor, QR validator, audit access logs. |
| C14 | **Channels** | WhatsApp via BuilderBot first (pilot); Telegram, Web, React Native short-term. |
| C15 | **AI models** | OpenAI GPT-4o (main conversational), GPT-4o-mini (cheaper side-tasks: classification, NLI, sentiment). |
| C16 | **Deployment** | VPS, pilot scale with headroom to scale. |

---

## 2. BuilderBot Framework Verification

**Verified** against official docs (builderbot.app, mintlify docs, DeepWiki, npm registry, GitHub).

### Three-pillar architecture — CONFIRMED
`createBot({ flow, provider, database })` wires exactly three pillars; it returns `{ httpServer, provider, ... }`.

| Pillar | Mechanism | Verified detail |
|--------|-----------|-----------------|
| **Flow** | `createFlow([...])` of flows built with `addKeyword([...])` → `.addAnswer()` / `.addAction()` | `addAction(async (ctx, { provider, flowDynamic, state }) => {...})` is the extension point for custom logic (LLM/RAG calls, validations, DB writes, send media/QR). `EVENTS` (e.g. `EVENTS.MEDIA`) available. |
| **Provider** | `createProvider(ProviderClass, config)` — adapter per channel | Baileys (`@builderbot/provider-baileys`, unofficial WhatsApp Web WebSocket, QR/pairing code auth, default port 3008); Meta (`@builderbot/provider-meta`, official WABA REST + webhooks: `jwtToken`, `numberId`, `verifyToken`, `version`); plus Telegram/Twilio/Instagram/etc. Providers emit events: `ready`, `message`, `auth_failure`, `notice`, `tokens_updated`, `require_action`. |
| **Database** | Adapter passed to `createBot` | `MemoryDB` (dev), `PostgreSQLDB` (`@builderbot/database-postgres`), plus JSON/Mongo/MySQL adapters. All implement the same `IDatabase` contract. |

### PostgreSQLDB adapter — CONFIRMED (`@builderbot/database-postgres`)
```ts
import { PostgreSQLDB } from '@builderbot/database-postgres'
const adapterDB = new PostgreSQLDB({ host, user, database, password, port: 5432 })
```
- Uses `pg` (v8.11+); auto-creates `contact` + `history` tables and stored procedures on first connection (auto-migration).
- Contact management with JSONB custom fields (`saveContact`, `getContact`).
- Store `save_or_update_history_and_contact` (atomic upsert) — suitable as the conversation-history sink for the supervisor dashboard.

### Built-in HTTP server — CONFIRMED
- `createBot` returns `httpServer`; call `httpServer(+PORT)` to start it (REST/webhook surface).
- Providers such as Meta expose a webhook endpoint on that server (must be publicly reachable in production); custom routes can be added; a custom HTTP server can also be used and webhook handling invoked manually (e.g. Chatwoot plugin pattern `handleWebhook(bot, req.body)`).
- `@builderbot/manager` adds a REST API (`/api/flows` CRUD, dynamic bot management) and multi-bot lifecycle — optional, useful later for scaling tenants.

### Baileys vs Meta provider — tradeoffs for this project

| Dimension | Baileys (`@builderbot/provider-baileys`) | Meta (`@builderbot/provider-meta`) |
|-----------|------------------------------------------|-------------------------------------|
| Status | Unofficial (WhatsApp Web protocol) | Official WhatsApp Business API (WABA) |
| Auth | QR / pairing code (linked device) | Permanent token + webhook verification |
| Approval | None | Meta Business verification + phone number registration |
| Ban risk | Real (number is a linked device) | None (sanctioned API) |
| Outbound any time | Yes — can message user outside any window | **No** — 24h customer-service window; outside it only approved templates (critical for crisis follow-up!) |
| Templates / OTP / analytics | No | Yes |
| Rich UI (buttons/lists) | Partial/limited compatibility | Full (buttons, lists, templates, flows) |
| Cost | Free (resource cost: RAM/store growth) | Per-conversation pricing (free tier: 1000 customer-initiated + 250 bot-initiated conv/month) |
| Latency/QoS | Depends on socket health, receipts limited | ~5s p99 goal, delivery statuses, 99.9% uptime goal |
| Resource tuning | `experimentalStore: true`, `timeRelease: 10800000` (cleanup every 3h), selective monitoring | N/A (cloud-hosted) |
| Compliance | Not endorsed by WhatsApp — weak position for a health product | Strong position for HIPAA/RGPD-grade operations |

**Pilot recommendation**: Baileys on a dedicated throwaway number for the pilot (fast, free, outbound-anytime supports crisis flows, matches `Delivery: ask-on-risk`), with a **planned migration path to Meta** before production at scale. The Meta provider swap is mostly configuration (same `IProvider` interface) — flows and DB do not change.

### How a RAG/LLM layer hooks into flows — CONFIRMED
The AI/RAG layer does NOT replace BuilderBot. It plugs into flow callbacks:

```
user msg → provider 'message' → flow match (keyword/EVENTS) → addAction(async (ctx, {...}) => {
    → emit typing indicator
    → call ai-rag-service (REST or internal): classify risk → retrieve chunks (pgvector) → GPT-4o temp 0 → validate (cosine + NLI + guardrails)
    → red/orange? → block/route to supervisor, notify alert service
    → else flowDynamic(answer, { options })  // emit grounded answer
    → persist conversation (PostgreSQLDB) + emit telemetry to dashboard (Socket.io/Redis pub-sub)
})
```

---

## 3. Reference Architecture — MVP Component Split

Confirmed decisions driving the split: PostgreSQL+pgvector RAG, OpenAI GPT-4o (+mini), human-in-the-loop dashboard (React/Vite + Node/Express + Socket.io + Recharts), WhatsApp via BuilderBot first, VPS, pilot scale with headroom, geolocation IP+user confirmation, AES-256 backend consent with weekly key rotation and QR image output.

### Services (5)

```
                        ┌──────────────────────────┐
   WhatsApp (Baileys)──▶│ 1. chat-bot-service      │
   Telegram (later) ───▶│    BuilderBot: flows,    │
   Web/React Native ───▶│    provider, PostgreSQLDB│
                        └──────┬───────┬───────────┘
                               │ REST  │ events (Redis pub-sub / Socket.io)
                       ┌───────▼───┐   └──────────▶┌───────────────────────────┐
                       │ 2. ai-rag │◀──────────────│ 3. supervisor-dashboard   │
                       │   service │               │    React/Vite + Express + │
                       │ GPT-4o/mini│               │    Socket.io + Recharts   │
                       │ pgvector  │               │    takeover/alert/RAG view │
                       └───────┬───┘               └─────────────▲─────────────┘
                               │                                  │ push/notify
                       ┌───────▼───┐                     ┌────────┴──────────┐
                       │ PostgreSQL│                     │ 5. notification-  │
                       │ + pgvector│                     │    alert-service  │
                       │ (shared)  │                     └───────────────────┘
                       └───────▲───┘
                               │ docs → chunks → embeddings
                       ┌───────┴───┐
                       │ 4. ingestion-pipeline │
                       │ clean/blacklist/chunk │
                       └──────────────────────┘
```

| # | Service | Responsibility | Key stack |
|---|---------|----------------|-----------|
| 1 | **chat-bot-service** | BuilderBot host: WhatsApp provider (Baileys pilot), conversation flows, consent flow (checkbox → AES-256-CBC → Base64 → QR image direct), OTP validation for QR renewal, geolocation confirm flow (IP + user confirmation), crisis keyword detection, ephemeral 24–48h purge for anonymous users, built-in HTTP server (webhooks/REST) | Node/TS, `@builderbot/bot`, `@builderbot/provider-baileys`, `@builderbot/database-postgres`, node-qrcode, Node `crypto` |
| 2 | **ai-rag-service** | Risk classification (red/orange/yellow), pgvector retrieval (HNSW), GPT-4o (temp 0) generation grounded ONLY on retrieved chunks, GPT-4o-mini for NLI/sentiment/classification, output validation pipeline (cosine similarity ≥ 0.85 gate, NLI contradiction, role-deviation guardrails), source/trace metadata returned for dashboard | Node/TS, OpenAI SDK, `pgvector`, cosine/NLI validators |
| 3 | **supervisor-dashboard** | Internal-only admin: dual chat view + RAG context injection, Takeover (disable AI on a chat, human replies through bot), alert semaphore (red/orange/yellow list), hallucination score visualization, vector/knowledge explorer + re-vectorization, key-rotation monitor (7-day countdown, 12h forced clock, migration progress), QR validation scanner, audit/access logs, Legal & Compliance panel | React + Vite, Node/Express, Socket.io, Recharts/D3 |
| 4 | **ingestion-pipeline** | Document curation: blacklist filtering (doses, drug names), chunking 500–800 chars, embedding generation, metadata tagging (category/source), pgvector upsert, re-vectorization triggers | Node/TS or Python worker, pgvector |
| 5 | **notification-alert-service** | Push alerts to supervisors (red: immediate; orange/yellow: queued), crisis escalation protocol (emergency response template + human notification), low-latency delivery via Socket.io to dashboard + fallback channel; alert dedupe/throttle | Node/TS, Socket.io/Redis pub-sub, BullMQ optional |

### Shared infrastructure
- **PostgreSQL 15+** with `pgvector` (HNSW index) — single shared DB for RAG vectors, conversations (BuilderBot `history`/`contact`), HC records, consent registry, key versioning, alert logs.
- **Redis** — pub/sub bridge for real-time dashboard events, OTP cache, alert queues, ephemeral session state.
- **Crypto/key-management module** (shared package): AES-256-CBC encryption, key table with `key_version`, weekly rotation scheduler, deferred re-encryption queue (30-min inactivity / session end), forced re-encryption at 12h, batch 100–500 with rollback + integrity hash, worker-thread execution.
- **Reverse proxy + TLS** (Caddy/Nginx) in front of chat-bot HTTP server and dashboard; VPS with resource headroom (pilot → scale).

### Cross-cutting flows worth designing early
1. **Crisis flow (red)**: keyword/classifier detects risk → bot immediately sends crisis-support message (grounded + local emergency lines by geolocation) → alert-service pushes supervisor → dashboard red flag → optional live-location request → takeover available.
2. **Consent flow**: new user → privacy notice by geolocated jurisdiction → checkbox consent → backend AES-256-CBC → Base64 → QR image to chat → consent registry row.
3. **Key rotation flow**: T+7d → new key N+1 → per-user re-encryption at inactivity/session end → 12h forced deadline → new QR gated by 6-digit OTP → old signature archived.
4. **Human takeover**: supervisor clicks Takeover → chat-bot-service disables AI on that chat → supervisor messages go through provider → AI resumes on release.

---

## 4. Top 5 Technical Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| R1 | **Baileys unofficial WhatsApp** — ban risk, session fragility, QoS/receipts limited, not compliance-friendly for a health product | **High** | Dedicated throwaway pilot number; `experimentalStore: true` + `timeRelease` + selective event monitoring; session persistence + auto-reconnect; design flows behind the `IProvider` interface so a Meta swap is config-only; plan Meta migration gate before production at scale |
| R2 | **LLM hallucination control** — a hallucinated "diagnosis" or drug advice is a safety incident, not a bug | **Critical** | Multi-layer pipeline: temp 0 + RAG-only grounding + cosine similarity ≥ 0.85 gate + NLI contradiction check + role-deviation guardrail that BLOCKS emission (orange) + supervised review of all blocked outputs + alert on every gate failure; never emit without passing the grounding gate |
| R3 | **Health-data compliance** (HIPAA, RGPD, Ley 1581, LFPDPPP, Ley 25.326, Ley 19.628) — multi-jurisdiction, sensitive-data handling, dual persistence, breach liability | **High** | Data classification (HC persistent vs anonymous ephemeral 24–48h auto-purge), AES-256 at rest + TLS in transit, consent registry with QR receipts, role-based access + anonymized phone in dashboard, audit logs, per-country privacy notice at session start, legal review before launch |
| R4 | **Key rotation & re-encryption complexity** — 7-day cycle, deferred by inactivity, 12h forced, batching, rollback, OTP + new QR per rotation; failure = data unreadable or service interruption | **High** | Key versioning table, worker-thread re-encryption, batch 100–500 with per-batch integrity hash + rollback, dry-run + monitoring, dashboard countdown/forced-clock monitors, maintain old key during transition (dual-read), silent operation accepted per client |
| R5 | **WhatsApp message latency for crisis alerts** — red-alert responses must reach the user quickly; Baileys socket health and (future) Meta 24h-window/template constraints can delay outbound | **High** | Keep-alive + reconnect monitoring on Baileys; outbound-anytime capability favors Baileys for pilot crisis flows; supervisor push via Socket.io (near-instant, independent of WhatsApp); alert timeout → fallback channel (Telegram/Web) and escalation to human; document Meta template pre-approval requirement for crisis templates before migrating |

---

## 5. Suggested Monorepo Structure (Greenfield)

Recommendation: **single pnpm workspace monorepo** (pnpm 11.1.1 available) — one repo, typed shared packages, consistent tooling, easy CI. Alternative: multi-repo (see Approaches).

```
chat-asistente-psicologico/
├── pnpm-workspace.yaml
├── package.json                     # root: scripts, dev tooling (tsx, eslint, vitest)
├── tsconfig.base.json
├── docker-compose.yml               # local: postgres+pgvector, redis
├── openspec/                        # SDD artifacts (this change + future)
└── apps/
    ├── chat-bot/                    # service 1 — BuilderBot (flows, provider, consent, QR, geo)
    ├── ai-rag/                      # service 2 — RAG orchestration, GPT-4o/mini, validation
    ├── dashboard/                   # service 3 — React/Vite frontend + Express/Socket.io backend
    ├── ingestion/                   # service 4 — document cleaning, chunking, embeddings
    └── notifications/               # service 5 — alert push/queue, escalation
└── packages/
    ├── shared-types/                # domain types: Conversation, User, Alert, ConsentRecord, KeyVersion
    ├── db/                          # pg client, pgvector helpers, migrations (node-pg-migrate), repositories
    ├── crypto-keys/                 # AES-256-CBC, key versioning, rotation scheduler, re-encryption worker
    ├── llm-client/                  # OpenAI client wrapper (gpt-4o/mini, temp 0), embeddings
    ├── rag-core/                    # retrieval, chunking, cosine gate, NLI, guardrails
    ├── config/                      # env schema (zod), secrets loading
    └── telemetry/                   # structured logging, dashboard event emitter (Redis pub-sub)
```

Rationale: services are independently deployable on the VPS (per-service systemd units or containers) but share `packages/*` for the safety-critical logic (crypto, guardrails, types) so there is ONE source of truth for the pieces that can cause a safety incident. The monorepo keeps cross-cutting changes (schema, guardrail policy) atomic across services.

---

## Approaches Considered

| Decision | Option A | Option B | Verdict |
|----------|----------|----------|---------|
| WhatsApp provider | **Baileys first** — fast, free, outbound-anytime (crisis-friendly), config-only Meta migration later | Meta first — compliant, stable, but approval friction + 24h window hurts crisis follow-up at pilot | **A** for pilot (ask-on-risk); document Meta as production gate |
| Service topology | **5 services** (chat-bot, ai-rag, dashboard, ingestion, notifications) | Monolith — fewer moving parts, but alert latency, re-encryption isolation, and dashboard blast radius suffer | **5 services**; chat-bot + ai-rag can be co-deployed initially on one VPS for pilot simplicity |
| Repo layout | **pnpm monorepo** (apps + packages) | Multi-repo — independent teams/CI but duplicated safety-critical code and cross-repo drift | **Monorepo**; revisit only if teams diverge |
| Embedding/retrieval | **pgvector HNSW** (confirmed) | Dedicated vector DB (Pinecone/Weaviate) — extra infra, breaks single-DB simplicity | pgvector (client-confirmed) |
| Dashboard realtime | **Socket.io + Redis pub-sub** | Polling REST — simpler, but alert latency for red/orange unacceptably slow | Socket.io (client-confirmed) |

---

## Recommendation

Proceed to **proposal** with: pnpm monorepo + 5 services on a single VPS for the pilot; Baileys on a dedicated number as the pilot WhatsApp provider with a documented Meta migration gate; pgvector (HNSW) as the single Postgres-backed store for both RAG and conversation data; the 3-gate output validation pipeline (cosine ≥ 0.85, NLI, role guardrail) as the non-negotiable core of the ai-rag service; crypto/key module as a shared package from day one (rotation + deferred/forced re-encryption + QR/OTP are deeply entangled with the chat flows).

## Ready for Proposal
**Yes** — requirements are fully documented (757-line client document + prior requirements analysis in Engram), the BuilderBot integration path is verified against official docs, and the architecture/risks above give `sdd-propose` enough to define scope, approach, and rollback. Orchestrator should tell the user: the exploration is complete and confirms BuilderBot supports the needed integration; the biggest decisions to lock in the proposal are (1) Baileys-for-pilot with Meta migration gate, and (2) the exact validation gate thresholds/behaviors for orange-block vs yellow-flag.
