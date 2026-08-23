# Proposal: residual-security

## Intent

Close three residual security gaps from merged SDD phases (#56, #57): (1) vulnerable transitive deps `glob@11.0.3` (command injection) and `uuid@8.3.2` (buffer bounds), (2) no rate limiting at the Caddy edge for 13 dashboard routers, (3) ReDoS in `packages/telemetry/src/redactor.ts` over attacker-controlled chat input. All map to advisories with patched targets.

## Scope

### In Scope
- **WS-A (deps):** `pnpm.overrides` for `glob@11.1.0+`; major bump `uuid@11.1.1+` (ESM-only), audit v3/v5/v6 usage.
- **WS-B (rate-limit):** global Caddy `rate_limit` (IP-based) + Express `rate-limiter-flexible` on 5 critical mutating endpoints (auth/login, takeover, key rotation, vector DELETE, framework publish), keyed by user id.
- **WS-C (ReDoS):** replace `PHONE_RE`/`EMAIL_RE` with linear phone parsing + non-backtracking email regex in `redactor.ts`.

### Out of Scope
- WAF/bot-protection (Arcjet/Cloudflare) — deferred, infra-owner decision.
- Per-route Caddy overrides beyond global + Express critical set.
- Re-keying/secret rotation unrelated to this advisory set.

## Capabilities

> Contract with sdd-spec. Specs dir is empty (no prior capabilities).

### New Capabilities
- `edge-rate-limiting`: IP-level limit at Caddy + per-user limit on critical mutating dashboard endpoints; brute-force and abuse protection.

### Modified Capabilities
- None (ReDoS fix and dep upgrades are behavior-preserving/internal; no requirement-level change).

## Approach

- **WS-A:** Add `pnpm.overrides: { glob: ">=11.1.0", uuid: ">=11.1.1" }` in root `package.json`; run `pnpm install`; `grep -r` for `uuid/v3|v5|v6` and replace with `v4`/`v7`. Verify `pnpm-lock.yaml` resolved versions.
- **WS-B:** Add `rate_limit` to `:80`/`:443` site blocks in `/Caddyfile`; add `rate-limiter-flexible` `RateLimiterMemory` in `apps/dashboard/src/server/middleware/rate-limit.ts`, mounted on the 5 routers. Public probes (`/healthz`, `/readyz`) keep Caddy-only limit.
- **WS-C:** `redactPiiValue()` uses `isPhone(s)` (strip `\D`, length 8–15, O(n)) and email test `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`; no nested quantifiers.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `package.json` (root) | Modified | `pnpm.overrides` glob/uuid |
| `/Caddyfile` | Modified | global `rate_limit` block |
| `apps/dashboard/src/server/middleware/rate-limit.ts` | New | Express limiter |
| `apps/dashboard/src/server/{takeover,keys,vectors,frameworks,auth}*` | Modified | limiter mount |
| `packages/telemetry/src/redactor.ts` | Modified | linear phone/email |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| uuid v11 ESM-only breaks CJS importer | Med | Audit imports; codemod to v4/v7; build green |
| Caddy limit too strict → 429s | Med | Start generous (100/10s/IP); watch logs |
| ReDoS rewrite misses PII | Low | Keep parity tests vs old regex |

## Rollback Plan
- WS-A: revert `pnpm.overrides` + lockfile; `pnpm install`.
- WS-B: remove `rate_limit` from Caddyfile + unmount middleware; reload Caddy.
- WS-C: `git revert` `redactor.ts`; covered by tests.

## Dependencies
- pnpm catalog; Caddy reload access; `rate-limiter-flexible` new dep (dashboard).

## Success Criteria
- [ ] `pnpm-lock.yaml` resolves `glob>=11.1.0` and `uuid>=11.1.1`
- [ ] Caddy `rate_limit` active; 5 endpoints return 429 past bound (test)
- [ ] `redactor.test.ts` linear-input tests pass; no catastrophic backtracking fixture
- [ ] CodeQL `missing-rate-limiting` + `unsafe-regexp` clean; `pnpm test` green; PRs ≤400 lines/phase
