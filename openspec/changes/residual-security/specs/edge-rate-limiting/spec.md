# Edge Rate Limiting Specification

## Purpose

This specification defines the rate-limiting behavior at the infrastructure edge (Caddy) and application layer (Express middleware) to protect against brute-force attacks, credential stuffing, and abuse of critical mutating endpoints in the psychological chat assistant dashboard.

---

## Requirements

### Requirement: Global IP-Based Rate Limit at Caddy Edge

The system **MUST** enforce a global rate limit on all incoming HTTP requests at the Caddy reverse proxy layer, keyed by client IP address.

The limit **SHALL** be configurable via environment variable with a default of 100 requests per 10 seconds per IP.

The system **MUST** return HTTP 429 (Too Many Requests) with a `Retry-After` header (seconds until reset) when the limit is exceeded.

Health check endpoints (`/healthz`, `/readyz`) **MUST** be exempt from the global Caddy rate limit to ensure load balancer probes remain functional under load.

#### Scenario: Normal traffic within limit

- GIVEN a client IP has made 50 requests in the last 10 seconds
- WHEN the client makes a request to any dashboard endpoint
- THEN the request **MUST** be proxied normally with HTTP 200/appropriate response
- AND no `Retry-After` header **SHALL** be present

#### Scenario: Limit exceeded triggers 429

- GIVEN a client IP has made 100 requests in the last 10 seconds
- WHEN the client makes request #101 to any dashboard endpoint
- THEN the system **MUST** respond with HTTP 429
- AND the response **MUST** include a `Retry-After` header with seconds until the sliding window resets
- AND the request **MUST NOT** reach the downstream dashboard service

#### Scenario: Health endpoints exempt from global limit

- GIVEN a client IP has made 200 requests in the last 10 seconds (exceeding global limit)
- WHEN the client requests `/healthz` or `/readyz`
- THEN the request **MUST** be proxied normally with HTTP 200
- AND the response **MUST NOT** include `Retry-After`

#### Scenario: Rate limit configurable via environment

- GIVEN the environment variable `RATE_LIMIT_REQUESTS` is set to `200`
- AND `RATE_LIMIT_WINDOW` is set to `30s`
- WHEN Caddy reloads configuration
- THEN the global limit **SHALL** be 200 requests per 30 seconds per IP

---

### Requirement: Per-User Rate Limit on Critical Mutating Endpoints

The system **MUST** enforce an additional per-user rate limit on the following critical mutating endpoints, keyed by authenticated user ID (JWT `sub` claim):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/login` | POST | Credential verification — brute-force target |
| `/chats/:sessionId/takeover` | POST | Supervisor session takeover — state-changing |
| `/chats/:sessionId/release` | POST | Supervisor session release — state-changing |
| `/api/v1/keys/rotation/rotate` | POST | Admin key rotation — destructive admin action |
| `/api/v1/vectors/documents/:docId/chunks/:chunkIndex` | DELETE | Vector chunk deletion — destructive |
| `/api/v1/legal-frameworks` | POST | Legal framework publish — admin-only mutate |

The per-user limit **SHALL** default to 20 requests per 60 seconds per user and **MUST** be configurable via environment variables.

The system **MUST** return HTTP 429 with `Retry-After` when the per-user limit is exceeded.

Requests from unauthenticated contexts to these endpoints **MUST** be rejected by the auth middleware before rate limiting applies (separate concern).

#### Scenario: Authenticated user within per-user limit

- GIVEN user `user-123` has made 5 requests to `/auth/login` in the last 60 seconds
- WHEN the user submits a login attempt
- THEN the request **MUST** be processed normally
- AND no rate-limit headers **SHALL** indicate limit approach

#### Scenario: Per-user limit exceeded on login endpoint

- GIVEN user `user-123` has made 20 login attempts in the last 60 seconds
- WHEN the user submits login attempt #21
- THEN the system **MUST** respond with HTTP 429
- AND the response **MUST** include `Retry-After` header
- AND the login attempt **MUST NOT** reach the authentication handler

#### Scenario: Per-user limit scoped to user, not IP

- GIVEN user `user-123` has made 20 takeover requests in 60 seconds (limit reached)
- AND user `user-456` has made 0 takeover requests
- WHEN user `user-456` requests takeover
- THEN user `user-456` **MUST** be allowed (separate counter)
- AND user `user-123` **MUST** still receive 429

#### Scenario: Per-user limit configurable via environment

- GIVEN `RATE_LIMIT_CRITICAL_REQUESTS` = `50`
- AND `RATE_LIMIT_CRITICAL_WINDOW` = `120s`
- WHEN the dashboard service starts
- THEN the critical endpoint limit **SHALL** be 50 requests per 120 seconds per user

---

### Requirement: Rate Limit Headers on All Responses

The system **SHOULD** include rate-limit informational headers on successful responses for observability:

- `X-RateLimit-Limit`: maximum requests allowed in window
- `X-RateLimit-Remaining`: requests remaining in current window
- `X-RateLimit-Reset`: Unix timestamp when window resets

#### Scenario: Successful response includes rate-limit headers

- GIVEN a request is processed within limits
- WHEN the response is sent
- THEN the response **SHOULD** include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

### Requirement: No Rate Limiting on Read-Only Safe Endpoints

The following read-only endpoints **MUST NOT** have the Express per-user rate limit applied (they remain under Caddy global IP limit only):

- `/auth/me` (GET) — session validation
- `/api/v1/keys/rotation` (GET) — key status read
- `/api/v1/vectors/search` (GET) — vector search
- `/api/v1/qr/validate` (GET) — QR validity probe
- `/api/v1/audit` (GET) — audit log read
- `/api/v1/legal-frameworks` (GET) — framework list
- `/chats` (GET), `/chats/:sessionId` (GET) — chat history read

#### Scenario: Read endpoints bypass per-user limiter

- GIVEN user `user-123` has exceeded per-user critical limit
- WHEN the user requests `/api/v1/vectors/search`
- THEN the request **MUST** be processed (Caddy global limit still applies)
- AND the per-user critical limiter **MUST NOT** block it

---

## Notes on Behavior-Preserving Workstreams (WS-A, WS-C)

The following workstreams are **behavior-preserving** and do **not** require delta specifications:

- **WS-A (Dependency Upgrades)**: `glob@11.1.0+` via `pnpm.overrides`, `uuid@11.1.1+` major bump. These are transitive dependency updates with no observable behavior change to requirements. Regression tests in apply/verify phase only.
- **WS-C (ReDoS Fix in `redactor.ts`)**: Linear phone parsing + non-backtracking email regex replaces vulnerable patterns. The PII redaction behavior (what is redacted) remains identical; only the algorithm changes. Parity tests in apply/verify phase only.

These are documented here for traceability but produce no spec artifacts.