import { afterEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import type { Server } from "node:http";

import type { AlertRow, NewAuditEntry } from "@chatcap/db-schema";
import type { AlertStatus, Role } from "@chatcap/shared-types";
import { createLogger } from "@chatcap/telemetry";

import {
  createLifecycleRouter,
  type LifecycleDeps,
} from "../src/lifecycle-router";
import type { AlertLifecycleStore } from "../src/alert-lifecycle";

/**
 * Alert lifecycle endpoints (task 2.4, REQ-ALERT-6): acknowledge/resolve via
 * POST /alerts/:alertId/{acknowledge,resolve}. Internal-token auth, RBAC
 * preflight (supervisor/admin only, REQ-DASH-1), strict state machine
 * (open → acknowledged → resolved), audit rows per transition and per denial,
 * all PII-free.
 */

const TOKEN = "svc-internal-token";
const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";

function fakeAlert(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "alert-1",
    level: "red",
    category: "suicide",
    sessionId: "sess-1",
    status: "open",
    dedupeKey: "a".repeat(64),
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function fakeStore(
  alerts: Map<string, AlertRow>
): AlertLifecycleStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async findById(alertId) {
      calls.push(`find:${alertId}`);
      return alerts.get(alertId);
    },
    async acknowledge(alertId, actorId) {
      calls.push(`acknowledge:${alertId}:${actorId}`);
    },
    async resolve(alertId) {
      calls.push(`resolve:${alertId}`);
    },
  };
}

function makeDeps(
  store: AlertLifecycleStore,
  roles: Map<string, Role> = new Map([[ACTOR_ID, "supervisor"]]),
  entries: NewAuditEntry[] = []
): LifecycleDeps {
  return {
    logger: createLogger({ level: "silent" }),
    internalTokens: [TOKEN],
    store,
    findUserRole: async (userId) => roles.get(userId),
    audit: async (entry) => {
      entries.push(entry);
    },
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  servers.length = 0;
});

async function startServer(deps: LifecycleDeps): Promise<string> {
  const app: Express = express();
  app.use(createLifecycleRouter(deps));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function authHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", "x-internal-token": TOKEN, ...overrides };
}

describe("POST /alerts/:alertId/acknowledge", () => {
  it("acknowledges an open alert and audits the takeover (who/when/why)", async () => {
    const store = fakeStore(new Map([["alert-1", fakeAlert()]]));
    const entries: NewAuditEntry[] = [];
    const baseUrl = await startServer(makeDeps(store, new Map([[ACTOR_ID, "supervisor"]]), entries));

    const response = await fetch(`${baseUrl}/alerts/alert-1/acknowledge`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ actorId: ACTOR_ID, reason: "supervisor takeover" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "alert-1", status: "acknowledged" });
    expect(store.calls).toEqual(["find:alert-1", `acknowledge:alert-1:${ACTOR_ID}`]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      actorType: "supervisor",
      actorId: ACTOR_ID,
      action: "alert_acknowledged",
      resourceType: "alert",
      resourceId: "alert-1",
      reason: "supervisor takeover",
      meta: {
        level: "red",
        fromStatus: "open",
        toStatus: "acknowledged",
      },
    });
    // Audit payload stays PII-free: no session id, no message, no keyword.
    expect(JSON.stringify(entries[0])).not.toMatch(/sess-1|message|keyword|phone/);
  });

  it("records an admin actor when an admin acknowledges", async () => {
    const store = fakeStore(new Map([["alert-1", fakeAlert()]]));
    const entries: NewAuditEntry[] = [];
    const baseUrl = await startServer(
      makeDeps(store, new Map([[ACTOR_ID, "admin"]]), entries)
    );

    await fetch(`${baseUrl}/alerts/alert-1/acknowledge`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ actorId: ACTOR_ID }),
    });

    expect(entries[0]?.actorType).toBe("admin");
  });
});

describe("POST /alerts/:alertId/resolve", () => {
  it("resolves an acknowledged alert and audits it", async () => {
    const store = fakeStore(
      new Map([["alert-1", fakeAlert({ status: "acknowledged" as AlertStatus })]] )
    );
    const entries: NewAuditEntry[] = [];
    const baseUrl = await startServer(makeDeps(store, new Map([[ACTOR_ID, "supervisor"]]), entries));

    const response = await fetch(`${baseUrl}/alerts/alert-1/resolve`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ actorId: ACTOR_ID, reason: "crisis handled" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "alert-1", status: "resolved" });
    expect(store.calls).toEqual(["find:alert-1", "resolve:alert-1"]);
    expect(entries[0]?.action).toBe("alert_resolved");
    expect(entries[0]?.meta).toEqual({
      level: "red",
      fromStatus: "acknowledged",
      toStatus: "resolved",
    });
  });
});

describe("guardrails (auth, RBAC, state machine)", () => {
  it("rejects a request without the internal token (401, no audit)", async () => {
    const store = fakeStore(new Map([["alert-1", fakeAlert()]]));
    const entries: NewAuditEntry[] = [];
    const baseUrl = await startServer(makeDeps(store, new Map(), entries));

    const response = await fetch(`${baseUrl}/alerts/alert-1/acknowledge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: ACTOR_ID }),
    });

    expect(response.status).toBe(401);
    expect(entries).toEqual([]);
  });

  it("rejects a request with a wrong internal token (401)", async () => {
    const store = fakeStore(new Map([["alert-1", fakeAlert()]]));
    const entries: NewAuditEntry[] = [];
    const baseUrl = await startServer(makeDeps(store, new Map(), entries));

    const response = await fetch(`${baseUrl}/alerts/alert-1/acknowledge`, {
      method: "POST",
      headers: authHeaders({ "x-internal-token": "wrong" }),
      body: JSON.stringify({ actorId: ACTOR_ID }),
    });

    expect(response.status).toBe(401);
  });

  it("denies actors without supervisor/admin role (403, denial audited)", async () => {
    const store = fakeStore(new Map([["alert-1", fakeAlert()]]));
    const entries: NewAuditEntry[] = [];
    const baseUrl = await startServer(makeDeps(store, new Map(), entries));

    const response = await fetch(`${baseUrl}/alerts/alert-1/acknowledge`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ actorId: ACTOR_ID }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
    expect(store.calls).toEqual([]); // preflight before touching alert data
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorType: "system",
      actorId: ACTOR_ID,
      action: "alert_lifecycle_denied",
      resourceType: "alert",
      meta: { reason: "insufficient_role", requestedAction: "acknowledge" },
    });
  });

  it("returns 404 for an unknown alert", async () => {
    const store = fakeStore(new Map());
    const entries: NewAuditEntry[] = [];
    const baseUrl = await startServer(makeDeps(store, new Map([[ACTOR_ID, "supervisor"]]), entries));

    const response = await fetch(`${baseUrl}/alerts/nope/acknowledge`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ actorId: ACTOR_ID }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("rejects an invalid transition with 409 (denial audited)", async () => {
    const store = fakeStore(new Map([["alert-1", fakeAlert()]])); // still open
    const entries: NewAuditEntry[] = [];
    const baseUrl = await startServer(makeDeps(store, new Map([[ACTOR_ID, "supervisor"]]), entries));

    const response = await fetch(`${baseUrl}/alerts/alert-1/resolve`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ actorId: ACTOR_ID }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "conflict" });
    expect(store.calls).toEqual(["find:alert-1"]); // no mutation attempted
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "alert_lifecycle_denied",
      meta: {
        reason: "invalid_transition",
        requestedAction: "resolve",
        fromStatus: "open",
      },
    });
  });

  it("rejects a malformed body with 400 (validation_error)", async () => {
    const store = fakeStore(new Map([["alert-1", fakeAlert()]]));
    const entries: NewAuditEntry[] = [];
    const baseUrl = await startServer(makeDeps(store, new Map([[ACTOR_ID, "supervisor"]]), entries));

    const response = await fetch(`${baseUrl}/alerts/alert-1/acknowledge`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reason: "no actor id" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
    expect(entries).toEqual([]);
  });

  it("rejects an actorId that is not a uuid with 400", async () => {
    const store = fakeStore(new Map([["alert-1", fakeAlert()]]));
    const entries: NewAuditEntry[] = [];
    const baseUrl = await startServer(makeDeps(store, new Map([[ACTOR_ID, "supervisor"]]), entries));

    const response = await fetch(`${baseUrl}/alerts/alert-1/acknowledge`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ actorId: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(entries).toEqual([]);
  });
});
