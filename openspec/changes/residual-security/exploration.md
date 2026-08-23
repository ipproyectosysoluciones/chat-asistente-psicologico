# Exploration: residual-security

## Current State

This exploration documents residual security debt from merged SDD phases (#56, #57) that was not addressed in those changes. Three distinct issues are investigated:

1. **Dependency vulnerabilities** in `pnpm-lock.yaml` (glob, uuid)
2. **Missing rate-limiting** at the Caddy edge for dashboard API routers
3. **ReDoS vulnerability** in `packages/telemetry/src/redactor.ts` regex patterns

---

## Item 1: Dependency Vulnerabilities in pnpm-lock.yaml

### 1.1 glob@11.0.3 — Command Injection via CLI

| Field | Value |
|-------|-------|
| **Advisory ID** | GHSA-5j98-mcp5-4vw2 |
| **CVE** | CVE-2025-64756 |
| **Severity** | High (CVSS 3.1: 7.5 — AV:N/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:H) |
| **Current version** | 11.0.3 |
| **Affected range** | >=11.0.0 <11.1.0 (also >=10.2.0 <10.5.0) |
| **Patched versions** | 11.1.0, 10.5.0, 12.0.0 |
| **Target version** | **11.1.0+** (or 12.x) |
| **Dependency type** | **Transitive** — pulled in via `tinyglobby@0.2.17` (devDependency of build tooling) |
| **Blast radius** | **CLI-only** — the vulnerability is in `src/bin.mts` where `glob -c/--cmd` executes matched filenames with `shell: true`. The core library API (`glob()`, `globSync()`, streams/iterators) is **not affected**. |
| **Exploit condition** | Requires: (a) running the glob CLI with `-c/--cmd`, (b) attacker-controlled filenames with shell metacharacters (e.g., `$(rm -rf /)`), (c) POSIX shell. Not exploitable via normal library usage. |
| **Recommendation** | Upgrade `tinyglobby` to a version that depends on `glob@>=11.1.0`, or pin `glob` to `11.1.0` via `pnpm.overrides`. Since this is a dev-only transitive dep and the CLI is not used in production, risk is **low but should be fixed** for CI hygiene. |

**References**
- <https://github.com/isaacs/node-glob/security/advisories/GHSA-5j98-mcp5-4vw2>
- <https://nvd.nist.gov/vuln/detail/CVE-2025-64756>

---

### 1.2 uuid@8.3.2 — Missing Buffer Bounds Check in v3/v5/v6

| Field | Value |
|-------|-------|
| **Advisory ID** | GHSA-w5hq-g745-h8pq |
| **CVE** | CVE-2026-41907 |
| **Severity** | Moderate (CVSS 3.1: 7.5 — NVD rates High; GitHub rates Moderate) |
| **Current version** | 8.3.2 |
| **Affected range** | <11.1.1, 12.0.0, 13.0.0 |
| **Patched versions** | 11.1.1, 12.0.1, 13.0.1 |
| **Target version** | **11.1.1+** (requires major version bump; no 8.x/9.x/10.x patch exists) |
| **Dependency type** | **Transitive** — pulled in by multiple packages (e.g., `@chatcap/crypto-keys`, `@chatcap/db-schema`, builderbot ecosystem) |
| **Blast radius** | **Library API** — `v3()`, `v5()`, `v6()` accept external `buf` + `offset` but lack bounds checks. `v4()`, `v1()`, `v7()` correctly throw `RangeError`. Silent partial writes can produce malformed UUIDs without error. If caller-controlled offsets/buffer sizes are exposed, this becomes a logic flaw. |
| **Exploit condition** | Application calls `v3()`/`v5()`/`v6()` with undersized buffer or large offset. In this codebase, direct usage of these specific UUID versions is unlikely (v4/v7 are standard), but transitive exposure exists. |
| **Recommendation** | **Major version upgrade to uuid@11.1.1+** across the monorepo. This is a breaking change (ESM-only in v11+). Audit all `uuid` imports for v3/v5/v6 usage. If v4/v7 only, the upgrade is safer. Use `pnpm.overrides` to force the upgrade if direct deps allow. |

**References**
- <https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq>
- <https://nvd.nist.gov/vuln/detail/CVE-2026-41907>

---

## Item 2: Rate-Limiting at Caddy Edge (Issue #58)

### 2.1 Caddyfile Analysis

**Current Caddyfile** (`/Caddyfile`): 44 lines, **no `rate_limit` directive anywhere**.

```caddy
# Route precedence (handle is mutually exclusive, first match wins):
#   1. /api/v1/rag/process and /internal/*  -> ai-rag:4003
#   2. /api/v1/documents*                    -> ingestion:4004
#   3. /webhook*                             -> chat-bot:4001
#   4. everything else (dashboard UI + API)  -> dashboard:3000

(route) {
  handle /api/v1/rag/process { reverse_proxy ai-rag:4003 }
  handle /internal/* { reverse_proxy ai-rag:4003 }
  handle /api/v1/documents* { reverse_proxy ingestion:4004 }
  handle /webhook* { reverse_proxy chat-bot:4001 }
  handle { reverse_proxy dashboard:3000 }
}
:80 { import route }
:443 { tls internal; import route }
```

**Gap**: All 13 dashboard API routers (see below) are proxied through the catch-all `handle { reverse_proxy dashboard:3000 }` with **zero rate limiting**. WhatsApp webhook (`/webhook*`) and AI-RAG/ingestion routes also lack rate limiting.

---

### 2.2 Dashboard Routers (13 routers identified by CodeQL)

All mounted in `apps/dashboard/src/server/app.ts` under the catch-all route. Each requires per-route or global rate limiting.

| # | Router File | Base Path(s) | Auth | RBAC | Notes |
|---|-------------|--------------|------|------|-------|
| 1 | `auth/auth-router.ts` | `/auth/login` (POST), `/auth/me` (GET) | JWT | — | Credential endpoint — **critical for brute-force protection** |
| 2 | `takeover-router.ts` | `/chats/:sessionId/takeover` (POST), `/chats/:sessionId/release` (POST) | JWT | Supervisor+Admin | State-changing — **critical** |
| 3 | `alerts-router.ts` | `/alerts` (GET), `/alerts/:id/acknowledge` (POST), `/alerts/:id/resolve` (POST) | JWT | Supervisor+Admin | Alert lifecycle — state-changing |
| 4 | `keys-router.ts` | `/api/v1/keys/rotation` (GET), `/api/v1/keys/rotation/rotate` (POST) | JWT | View: Sup+Admin, Mutate: Admin | Key rotation — **admin-only mutate critical** |
| 5 | `vectors-router.ts` | `/api/v1/vectors/search` (GET), `/api/v1/vectors/documents/:docId/chunks/:chunkIndex` (DELETE) | JWT | Supervisor+Admin | Destructive DELETE — **critical** |
| 6 | `qr-router.ts` | `/api/v1/qr/validate` (GET) | JWT | Supervisor+Admin | Read-only validity probe |
| 7 | `audit-router.ts` | `/api/v1/audit` (GET) | JWT | Supervisor+Admin | Audit log read |
| 8 | `frameworks-router.ts` | `/api/v1/legal-frameworks` (GET), `/api/v1/legal-frameworks` (POST) | JWT | View: Sup+Admin, Mutate: Admin | Terms publish — **admin-only mutate critical** |
| 9 | `chats-router.ts` | `/chats` (GET), `/chats/:sessionId` (GET) | JWT | Supervisor+Admin | Chat content access — **PII-sensitive** |
| 10 | `app.ts` (health) | `/healthz` (GET), `/readyz` (GET) | — | — | Public probes — **DoS surface** |
| 11 | `static.ts` | `/` (SPA), `/assets/*` | — | — | Static serving — low risk but high volume |
| 12 | `auth/middleware.ts` | (internal — JWT verify) | — | — | Not a route, but auth gate |
| 13 | `alert-subscriber.ts` | (internal — Redis pub/sub) | — | — | Not an HTTP route |

**Caddy coverage**: **None**. All 13 routers fall under the catch-all `handle { reverse_proxy dashboard:3000 }`.

---

### 2.3 False-Positive Test Files (8 files)

CodeQL `missing-rate-limiting` queries flag test files as unprotected routes. These are **false positives** — tests run in-process, not behind Caddy.

| Test File | Why False Positive |
|-----------|-------------------|
| `alerts-router.test.ts` | Unit tests for alerts router; no HTTP server |
| `app.test.ts` | Tests `createApp()` factory in-memory |
| `auth-middleware.test.ts` | Tests JWT middleware logic |
| `auth-router.test.ts` | Unit tests for auth router |
| `chats-router.test.ts` | Unit tests for chats router |
| `jwt.test.ts` | Tests JWT sign/verify utilities |
| `password.test.ts` | Tests bcrypt password hashing |
| `static.test.ts` | Tests static file serving middleware |
| `takeover-router.test.ts` | Unit tests for takeover router |
| `config.test.ts` | Tests config validation |

**Count**: 10 test files total, 8 are router/middleware unit tests (the 2 others — `config.test.ts`, `password.test.ts` — are utility tests). The CodeQL query likely flags all 10; 8 are router-related.

---

### 2.4 Rate-Limiting Recommendations

| Approach | Pros | Cons | Effort |
|----------|------|------|--------|
| **Caddy `rate_limit` global + per-route overrides** | Centralized, zero app changes, handles all 13 routers + webhooks | Limited granularity (IP-based), no user-context | Low |
| **Express-rate-limit middleware per router** | Per-user/role limits, integrates with auth principal | Code changes in 9 routers, maintenance burden | Medium |
| **Hybrid: Caddy global (IP) + Express critical endpoints (user)** | Defense in depth, protects auth/state-changing heavily | Two layers to configure | Medium |
| **Arcjet / Cloudflare WAF (if public domain)** | Bot detection, advanced rules | External dependency, cost | High |

**Recommended**: **Hybrid** — Caddy global IP-based rate limit (e.g., 100 req/10s per IP) + Express `rate-limiter-flexible` on critical mutating endpoints (auth login, takeover, key rotation, vector DELETE, framework publish) keyed by authenticated user ID. This covers unauthenticated DoS and authenticated abuse.

---

## Item 3: ReDoS in `packages/telemetry/src/redactor.ts:43`

### 3.1 Vulnerable Patterns

```typescript
// Line 23
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

// Line 25
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
```

### 3.2 Why Polynomial ReDoS

| Regex | Catastrophic Input | Mechanism |
|-------|-------------------|-----------|
| `EMAIL_RE` | `a@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!` | `[A-Za-z0-9.-]+` backtracks exponentially trying to match the final `\.[A-Za-z]{2,}` against the `!` |
| `PHONE_RE` | `+111111111111111111111111111111` | `[\d\s().-]{6,}` consumes all digits, then final `\d` fails, engine backtracks one char at a time |

**Input source**: User chat messages (`body`, `text`, `caption` fields from WhatsApp webhook) — **fully attacker-controlled**.

**Call chain**: Webhook → `chat-bot` → `redactPiiObject()` → `redactPiiValue()` → `redactPii()` → `.replace(EMAIL_RE)` → `.replace(PHONE_RE)`.

**Impact**: A single malicious message can block the event loop for seconds/minutes, DoS-ing the chat-bot process. Since `chat-bot` is single-threaded Node.js, this affects all concurrent sessions.

---

### 3.3 Fix Approaches

| Approach | Description | Pros | Cons | Effort |
|----------|-------------|------|------|--------|
| **Linear regex rewrite** | Replace with non-backtracking patterns (e.g., email: `^[^@\s]+@[^@\s]+\.[^@\s]+$` without quantifier nesting; phone: digit-counting loop) | Zero deps, fast, predictable | Manual audit needed, may miss edge cases | Low |
| **`regexpp` / `safe-regex` + timeout** | Wrap `.replace()` with `setTimeout` guard or use `regexpp` AST to validate patterns | Catches future regressions | Adds dependency, timeout is band-aid | Low |
| **`email-regex-safe` / `phone-regex` libs** | Purpose-built safe patterns (often using RE2-compatible syntax) | Battle-tested, maintained | Extra deps, bundle size | Low |
| **Manual parsing (no regex)** | Split on `@`, validate parts; phone: strip non-digits, check length | **Fully linear, no ReDoS possible** | More code, must match current behavior exactly | Medium |

**Recommended**: **Manual parsing for phone + linear email regex**.

- **Phone**: `function isPhone(s: string) { const digits = s.replace(/\D/g, ''); return digits.length >= 8 && digits.length <= 15; }` — O(n), no regex.
- **Email**: Use a linear pattern without nested quantifiers: `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/` — no backtracking on invalid TLD.

This eliminates ReDoS entirely with minimal code change and zero new dependencies.

---

## Summary of Recommendations

| Item | Priority | Action |
|------|----------|--------|
| **glob@11.0.3** | Low (dev-only, CLI-only) | Override to `glob@11.1.0` via `pnpm.overrides`; upgrade `tinyglobby` |
| **uuid@8.3.2** | **High** (transitive, library API) | Plan major upgrade to `uuid@11.1.1+`; audit v3/v5/v6 usage |
| **Caddy rate limiting** | **High** (public edge exposure) | Add global `rate_limit` in Caddy + Express middleware on 5 critical mutating endpoints |
| **ReDoS in redactor** | **Critical** (user input, DoS vector) | Replace regexes with manual parsing (phone) + linear regex (email) |

---

## Ready for Proposal

**Yes**. All three items have clear advisory IDs, version targets, blast radius analysis, and fix approaches. The orchestrator should create an SDD proposal for `residual-security` covering:

1. Dependency upgrades (glob, uuid) — `chore(deps): security upgrades`
2. Caddy rate limiting + Express middleware — `feat(security): rate limiting`
3. ReDoS fix in telemetry redactor — `fix(security): ReDoS in PII redactor`

Each can be a separate task or grouped as a security sprint.