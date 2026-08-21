import { describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";

import {
  SERVICE_URLS,
  connectDashboardSocket,
  fetchJson,
  isStackUp,
} from "./helpers";

const TAKEOVER_EVENT = "chat:takeover";
const SOCKET_TIMEOUT_MS = 1000;

interface TakeoverResponse {
  chatId: string;
  aiState: string;
  takenOverBy: string;
  takenOverAt: string;
}

interface TakeoverEventPayload {
  sessionId: string;
  aiState: string;
  actorId: string;
  occurredAt: string;
}

/**
 * Resolve a supervisor RBAC token for the dashboard: prefer an explicit JWT
 * from the environment, otherwise log in via the dashboard auth endpoint.
 * Returns `undefined` when neither path is configured (the supervisor path is
 * unavailable in e2e and the test must `it.skip`).
 */
async function resolveSupervisorToken(): Promise<string | undefined> {
  const fromEnv = process.env.SUPERVISOR_JWT;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const email = process.env.SUPERVISOR_EMAIL;
  const password = process.env.SUPERVISOR_PASSWORD;
  if (email === undefined || password === undefined) {
    return undefined;
  }
  const res = await fetchJson<{ token: string }>(
    `${SERVICE_URLS.dashboard}/auth/login`,
    { method: "POST", body: { email, password }, expectStatus: 200 }
  );
  return res.token;
}

describe("supervisor chat takeover end-to-end", () => {
  it("flips the chat to takeover state and emits a chat:takeover Socket.io event", async (ctx) => {
    const stackUp = await isStackUp();
    const token = stackUp ? await resolveSupervisorToken() : undefined;
    const sessionId = process.env.TAKEOVER_SESSION_ID;
    if (!stackUp || token === undefined || sessionId === undefined) {
      // No live stack, no supervisor RBAC token, or no target session: the
      // supervisor takeover path is unavailable in e2e. The endpoint-call and
      // Socket.io listener skeleton below is preserved for the live run.
      ctx.skip();
      return;
    }

    // Attach the listener BEFORE the takeover POST so we catch the emit that
    // the dashboard fires on the AI-state flip (apps/dashboard/src/server/
    // takeover-router.ts → io?.emit("chat:takeover", ...)).
    const socket: Socket = await connectDashboardSocket();
    const waitForEvent = new Promise<TakeoverEventPayload | undefined>(
      (resolve) => {
        const timer = setTimeout(() => resolve(undefined), SOCKET_TIMEOUT_MS);
        socket.on(TAKEOVER_EVENT, (payload: TakeoverEventPayload) => {
          if (payload.sessionId !== sessionId) return;
          clearTimeout(timer);
          resolve(payload);
        });
      }
    );

    try {
      const response = await fetchJson<TakeoverResponse>(
        `${SERVICE_URLS.dashboard}/chats/${sessionId}/takeover`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          expectStatus: 200,
        }
      );
      expect(response.aiState).toBe("takeover");
      expect(response.chatId).toBe(sessionId);

      const arrived = await waitForEvent;
      expect(arrived).toBeDefined();
      expect(arrived?.aiState).toBe("takeover");
      expect(arrived?.sessionId).toBe(sessionId);
    } finally {
      socket.disconnect();
      // Best-effort release so the session is not left under takeover.
      await fetchJson(
        `${SERVICE_URLS.dashboard}/chats/${sessionId}/release`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }
      ).catch(() => undefined);
    }
  });
});
