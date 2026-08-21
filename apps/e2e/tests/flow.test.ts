import { describe, it, expect, beforeAll } from "vitest";
import {
  isStackUp,
  processWithRag,
  connectDashboardSocket,
  SERVICE_URLS,
} from "./helpers";

/**
 * Phase 7.3 — MAIN flow smoke test.
 *
 * Full path under test: user-message → RAG retrieval → coherence gate →
 * emit/persist. Because the live compose stack may be absent, the live steps
 * early-return (graceful skip) when the stack is not reachable; the real
 * request/assertion skeletons stay in place for the CI job that runs with the
 * stack up.
 *
 * Known gaps (handled by other workers, NOT here):
 *  - alert / crisis escalation
 *  - supervisor takeover
 *  - consent flow
 *  - HC/anonymous purge
 *  - key rotation
 */

// A stable, non-PII session id for the smoke run.
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SAMPLE_MESSAGE = "Hola, necesito hablar con alguien sobre ansiedad.";

// Liveness is resolved in beforeAll (no top-level await, so `vitest list`
// can still collect this file). Live steps early-return when this is false.
let stackUp = false;

beforeAll(async () => {
  stackUp = await isStackUp();
}, 120_000);

describe("Phase 7.3 — MAIN flow: user-message → RAG → gate → emit/persist", () => {
  it.skip(
    "injects a user message via the chat-bot inbound webhook",
    async () => {
      /**
       * SKIPPED ON PURPOSE.
       *
       * There is currently NO public inbound user-message webhook in
       * `apps/chat-bot`. The Meta provider's `onEvent` is a stub
       * (`apps/chat-bot/src/provider/meta.ts`) and the real inbound webhook
       * "lands with the flow slice (task 4.6)". The only internal surface is
       * `POST /internal/messages/ingest` (`apps/chat-bot/src/ingest.ts`), which
       * is supervisor-reply ingestion guarded by `x-internal-token` — not the
       * end-user inbound path, and it would require forging an internal token.
       *
       * When task 4.6 ships the verified webhook, replace this skeleton:
       *
       *   await fetchJson(`${SERVICE_URLS.chatbot}/webhook`, {
       *     method: "POST",
       *     headers: { "x-meta-signature": "<verified>" },
       *     body: { from: "+000000000", text: SAMPLE_MESSAGE },
       *     expectStatus: 200,
       *   });
       */
      expect.unreachable("webhook path not implemented yet (task 4.6)");
    }
  );

  it(
    "processes the message through ai-rag and returns a gated response",
    async () => {
      if (!stackUp) {
        console.warn(
          "[e2e:flow] ai-rag step skipped — compose stack not reachable."
        );
        return;
      }

      const outcome = (await processWithRag(
        SESSION_ID,
        SAMPLE_MESSAGE
      )) as {
        kind: "emitted" | "flagged" | "blocked" | "crisis";
        trace?: {
          gate?: { verdict: string; cosine: number };
        };
        answer?: string;
        fallbackText?: string;
      };

      // Gate returns a discriminated union; the kind is the contract.
      expect(["emitted", "flagged", "blocked", "crisis"]).toContain(
        outcome.kind
      );

      // The coherence gate must have produced a trace with a score.
      expect(outcome.trace).toBeDefined();
      expect(outcome.trace?.gate).toBeDefined();
      const gate = outcome.trace!.gate!;
      expect(typeof gate.verdict).toBe("string");
      expect(gate.verdict.length).toBeGreaterThan(0);
      // cosine similarity is the gate score, bounded 0..1.
      expect(typeof gate.cosine).toBe("number");
      expect(gate.cosine).toBeGreaterThanOrEqual(0);
      expect(gate.cosine).toBeLessThanOrEqual(1);

      // An emitted/flagged answer must carry text; blocked/crisis carry a
      // safe fallback so the user is never left without a response.
      if (outcome.kind === "emitted" || outcome.kind === "flagged") {
        expect(typeof outcome.answer).toBe("string");
        expect((outcome.answer ?? "").length).toBeGreaterThan(0);
      } else {
        expect(typeof outcome.fallbackText).toBe("string");
        expect((outcome.fallbackText ?? "").length).toBeGreaterThan(0);
      }
    },
    60_000
  );

  it(
    "dashboard Socket.io surface is reachable (emit channel)",
    async () => {
      if (!stackUp) {
        console.warn(
          "[e2e:flow] dashboard socket step skipped — compose stack not reachable."
        );
        return;
      }

      // The dashboard broadcasts supervisor-facing events via
      // `io?.emit(event, payload)` (apps/dashboard/src/server/index.ts).
      // No auth middleware is wired on the socket, so we only assert the
      // connection opens — proving the emit channel is live.
      const socket = await connectDashboardSocket("/");
      expect(socket.connected).toBe(true);
      socket.disconnect();
      expect(socket.connected).toBe(false);
    },
    30_000
  );

  it.skip(
    "persists the processed message/trace and surfaces it on the dashboard",
    async () => {
      /**
       * SKIPPED ON PURPOSE (persistence requires chat-bot round-trip + RBAC).
       *
       * Why:
       *  - Calling ai-rag directly (above) only returns the trace; the chat-bot
       *    is what persists the message + RagTrace into the DB. The end-user
       *    inbound path that triggers that persist is not implemented (task
       *  4.6), so there is nothing to read back yet.
       *  - The dashboard read endpoint `GET /chats/:sessionId`
       *    (apps/dashboard/src/server/chats-router.ts) requires a supervisor/
       *    admin JWT (`authenticate` + `authorize` RBAC). An unauthenticated
       *    e2e runner has no such token.
       *
       * When wired, the assertion skeleton is:
       *
       *   const auth = { Authorization: `Bearer ${SUPERVISOR_JWT}` };
       *   const detail = await fetchJson(
       *     `${SERVICE_URLS.dashboard}/chats/${SESSION_ID}`,
       *     { headers: auth, expectStatus: 200 }
       *   );
       *   expect(detail.session.id).toBe(SESSION_ID);
       *   expect(Array.isArray(detail.messages)).toBe(true);
       *   expect(Array.isArray(detail.ragTraces)).toBe(true);
       *   expect(detail.ragTraces.some((t) => t.sessionId === SESSION_ID))
       *     .toBe(true);
       */
      expect.unreachable(
        "persistence read needs chat-bot inbound (task 4.6) + supervisor JWT"
      );
    }
  );
});
