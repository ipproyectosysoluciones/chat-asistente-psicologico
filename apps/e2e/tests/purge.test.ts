import { describe, it, expect, beforeAll } from "vitest";
import { isStackUp } from "./helpers";

/**
 * Phase 7.3 — ANONYMOUS PURGE e2e (24–48h cleanup contract).
 *
 * The purge job (apps/chat-bot/src/purge.ts → runAnonymousPurge →
 * purgeAnonymousSessions in @chatcap/db-schema) removes anonymous sessions
 * whose `purgeAt` is in the past, batched 100–500 rows, leaving HC rows
 * untouched (WHERE persistence_class = 'anonymous'). It is scheduled daily via
 * node-cron (DEFAULT_PURGE_SCHEDULE = "0 3 * * *", wired in
 * apps/chat-bot/src/index.ts).
 *
 * There is NO HTTP endpoint for the purge in chat-bot or ingestion, and e2e has
 * no DB handle (db-schema is not a dependency of this package). Per the task
 * contract the detailed live assertion is `it.skip`'d with the full skeleton
 * (see below). A non-skipped smoke `it` is kept so the file is still collected
 * by `vitest list` and gates gracefully when no e2e handle is available.
 */

let stackUp = false;
beforeAll(async () => {
  stackUp = await isStackUp();
}, 120_000);

describe("Phase 7.3 — ANONYMOUS PURGE: 24–48h cleanup contract", () => {
  it(
    "anonymous purge contract: expired rows removed, HC untouched (graceful skip when no e2e handle)",
    async () => {
      if (!stackUp) {
        console.warn(
          "[e2e:purge] purge step skipped — stack not reachable (no e2e DB/trigger handle)."
        );
        return;
      }
      // When a DB handle + purge trigger become available (or an internal
      // `/internal/purge/anonymous` endpoint is exposed), replace the early
      // return with the skeleton documented in the skipped test below. Until
      // then the live assertion cannot run from e2e.
      console.warn(
        "[e2e:purge] stack up but no purge trigger exposed to e2e — skipping live assertion."
      );
    },
    60_000
  );

  it.skip(
    "purges expired anonymous sessions and leaves HC rows untouched",
    async () => {
      /**
       * SKIPPED ON PURPOSE — no e2e handle to the purge job or the DB.
       *
       * When this package gains a db-schema handle + a purge trigger (or an
       * internal `/internal/purge/anonymous` endpoint is exposed), the real
       * skeleton is:
       *
       *   // 1. Seed an expired anonymous record (purgeAt in the past).
       *   const before = await countSessions({
       *     persistenceClass: "anonymous",
       *     purgeBefore: now,
       *   });
       *
       *   // 2. Invoke the purge job (bounded 100–500 batches; HC untouched).
       *   const counts = await runAnonymousPurge({ db, logger });
       *   expect(counts.purgedSessions).toBeGreaterThan(0);
       *
       *   // 3. Assert the expired row is gone.
       *   const after = await countSessions({
       *     persistenceClass: "anonymous",
       *     purgeBefore: now,
       *   });
       *   expect(after).toBe(before - counts.purgedSessions);
       *
       *   // 4. HC records must remain (REQ-CONSENT-5 / REQ-CHATBOT-9).
       *   const hc = await countSessions({ persistenceClass: "hc_registered" });
       *   expect(hc).toBe(hcBefore);
       */
      expect.unreachable(
        "purge needs a DB handle / internal trigger not exposed to e2e"
      );
    }
  );
});
