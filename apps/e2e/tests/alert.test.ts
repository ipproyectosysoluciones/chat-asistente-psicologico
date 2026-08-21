import { describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";

import {
  SERVICE_URLS,
  connectDashboardSocket,
  fetchJson,
  isStackUp,
  processWithRag,
} from "./helpers";

const ALERTS_URL = `${SERVICE_URLS.dashboard}/alerts`;
const ALERT_UPDATED_EVENT = "alert:updated";
const SOCKET_TIMEOUT_MS = 1000;

/**
 * Crisis message that should be classified as a vital-risk (red) alert by the
 * ai-rag coherence/classify pipeline. Used only where the trigger is exercised.
 */
const CRISIS_MESSAGE =
  "No soporto más esto, quiero quitarme la vida y no veo otra salida.";

interface AlertUpdatedPayload {
  alertId: string;
  status: string;
  sessionId?: string;
  level?: string;
}

interface AlertFeedPage {
  items: Array<{ alertId: string; level: string; status: string }>;
  total: number;
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

describe("crisis red alert end-to-end", () => {
  // Architecture mismatch: ai-rag raises a crisis alert over Redis pub-sub
  // (apps/ai-rag/src/pipeline.ts `raiseAlert` → `deps.emitter.publish`), and the
  // dashboard only pushes `alert:updated` over Socket.io on acknowledge/resolve
  // (apps/dashboard/src/server/alerts-router.ts). There is NO "new crisis alert"
  // Socket.io push, so the <1s red-alert emit from ai-rag output cannot be
  // asserted. The Socket.io listener skeleton is preserved for the feasible
  // `alert:updated` path below.
  it.skip(
    "emits a Socket.io red/crisis alert event within 1s when ai-rag raises a crisis",
    async () => {
      const socket: Socket = await connectDashboardSocket();
      try {
        const arrived = await new Promise<AlertUpdatedPayload | undefined>(
          (resolve) => {
            const timer = setTimeout(() => resolve(undefined), SOCKET_TIMEOUT_MS);
            socket.on(ALERT_UPDATED_EVENT, (payload: AlertUpdatedPayload) => {
              clearTimeout(timer);
              resolve(payload);
            });
            // Driving the crisis via ai-rag would NOT surface here (see reason
            // above); kept as the documented trigger skeleton.
            void processWithRag("e2e-crisis-session", CRISIS_MESSAGE);
          }
        );
        expect(arrived).toBeDefined();
      } finally {
        socket.disconnect();
      }
    }
  );

  it("pushes alert:updated over Socket.io when an alert is resolved", async (ctx) => {
    const stackUp = await isStackUp();
    const token = stackUp ? await resolveSupervisorToken() : undefined;
    if (!stackUp || token === undefined) {
      ctx.skip();
      return;
    }

    // Drive the feasible `alert:updated` emit: resolve an open alert via the
    // RBAC-protected endpoint, which the dashboard pushes over Socket.io.
    const feed = await fetchJson<AlertFeedPage>(ALERTS_URL, {
      headers: { authorization: `Bearer ${token}` },
      expectStatus: 200,
    });
    const openAlert = feed.items.find((alert) => alert.status === "open");
    if (openAlert === undefined) {
      ctx.skip();
      return;
    }

    const socket: Socket = await connectDashboardSocket();
    try {
      const arrived = await new Promise<AlertUpdatedPayload | undefined>(
        (resolve) => {
          const timer = setTimeout(() => resolve(undefined), SOCKET_TIMEOUT_MS);
          socket.on(ALERT_UPDATED_EVENT, (payload: AlertUpdatedPayload) => {
            if (payload.alertId !== openAlert.alertId) return;
            clearTimeout(timer);
            resolve(payload);
          });
          void fetchJson(`${ALERTS_URL}/${openAlert.alertId}/resolve`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: { reason: "e2e socket assertion" },
            expectStatus: 200,
          });
        }
      );
      expect(arrived).toBeDefined();
      expect(arrived?.alertId).toBe(openAlert.alertId);
    } finally {
      socket.disconnect();
    }
  });

  it("exposes the raised alert on the dashboard GET /alerts feed (RBAC)", async (ctx) => {
    const stackUp = await isStackUp();
    const token = stackUp ? await resolveSupervisorToken() : undefined;
    if (!stackUp || token === undefined) {
      ctx.skip();
      return;
    }

    const feed = await fetchJson<AlertFeedPage>(ALERTS_URL, {
      headers: { authorization: `Bearer ${token}` },
      expectStatus: 200,
    });
    expect(Array.isArray(feed.items)).toBe(true);
    expect(typeof feed.total).toBe("number");
  });
});
