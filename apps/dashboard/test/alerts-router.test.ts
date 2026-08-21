import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { createLogger } from "@chatcap/telemetry";
import type { AlertRow, DashboardUser, NewAuditEntry } from "@chatcap/db-schema";
import type { Role } from "@chatcap/shared-types";

import { createApp, type AppDeps } from "../src/server/app";
import type { AuditWriter } from "../src/server/auth/middleware";
import { signAccessToken } from "../src/server/auth/jwt";

/**
 * Alerts router (task 5.4, REQ-DASH-4 / design §3.1): GET /alerts serves the
 * live feed and POST /alerts/{id}/acknowledge|resolve drive the lifecycle.
 * Supervisor/admin only; RBAC denials are audit-logged (REQ-DASH-1) and every
 * state change is audit-logged (REQ-DASH-8) and pushed over the injected
 * Socket.io emitter as `alert:updated` (live supervisor sync).
 */

const secret = "s".repeat(32);
const ALERT_ID = "22222222-2222-7222-8222-222222222222";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

async function signIn(role: Role): Promise<string> {
  return signAccessToken(
    { secret, ttlSeconds: 900 },
    { sub: "user-1", role }
  );
}

function alertRowOf(status: AlertRow["status"]): AlertRow {
  return {
    id: ALERT_ID,
    level: "red",
    category: "suicide",
    sessionId: SESSION_ID,
    status,
    dedupeKey: "k1",
    acknowledgedBy: status === "acknowledged" ? "user-1" : undefined,
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z",
    resolvedAt: status === "resolved" ? "2026-08-14T12:10:00.000Z" : undefined,
  };
}

interface Harness {
  deps: AppDeps;
  auditEntries: NewAuditEntry[];
  emitted: Array<{ event: string; payload: AlertRow }>;
}

function dashboardUser(id: string, role: Role): DashboardUser {
  return {
    id,
    email: `${id}@example.com`,
    passwordHash: "x",
    // safe: controlled test role; the router reads it verbatim for RBAC.
    role: role as "supervisor" | "admin",
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function makeDeps(
  store: Map<string, AlertRow>,
  role: Role = "supervisor"
): Harness {
  const users = {
    findByEmail: async () => undefined,
    findById: async () => dashboardUser("user-1", role),
  };
  const auditEntries: NewAuditEntry[] = [];
  const emitted: Array<{ event: string; payload: AlertRow }> = [];
  const audit: AuditWriter = {
    write: async (entry) => {
      auditEntries.push(entry);
    },
  };
  const deps: AppDeps = {
    logger: createLogger({ level: "silent", destination: { write: () => {} } }),
    jwt: { secret, ttlSeconds: 900 },
    users,
    audit,
    chats: {
      listChats: async () => ({ items: [], total: 0 }),
      getSession: async () => undefined,
      listMessages: async () => [],
      listRagTraces: async () => [],
      findOpenAlertLevel: async () => undefined,
    },
    alerts: {
      jwt: { secret, ttlSeconds: 900 },
      users,
      audit,
      alerts: {
        listAlerts: async ({ limit, offset }) => ({
          items: [...store.values()].slice(offset, offset + limit),
          total: store.size,
        }),
        findById: async (id) => store.get(id),
        acknowledge: async (id, actorId) => {
          const current = store.get(id);
          if (current !== undefined) {
            store.set(id, {
              ...current,
              status: "acknowledged",
              acknowledgedBy: actorId,
              updatedAt: "2026-08-14T12:05:00.000Z",
            });
          }
        },
        resolve: async (id) => {
          const current = store.get(id);
          if (current !== undefined) {
            store.set(id, {
              ...current,
              status: "resolved",
              resolvedAt: "2026-08-14T12:10:00.000Z",
              updatedAt: "2026-08-14T12:10:00.000Z",
            });
          }
        },
      },
      emit: (event, payload) => {
        emitted.push({ event, payload });
      },
    },
    readiness: {
      database: { check: async () => {} },
      chatbot: { check: async () => {} },
    },
  };
  return { deps, auditEntries, emitted };
}

let server: Server | undefined;
let baseUrl: string;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function listen(app: Express): Promise<string> {
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  return baseUrl;
}

async function request(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {}
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

describe("alerts router (task 5.4, REQ-DASH-4)", () => {
  it("rejects unauthenticated feed requests with 401", async () => {
    const { deps } = makeDeps(new Map());
    const app = createApp(deps);
    await listen(app);
    const response = await request("/alerts");
    expect(response.status).toBe(401);
  });

  it("denies non-supervisor roles with 403 and audit-logs the denial", async () => {
    const { deps, auditEntries } = makeDeps(new Map(), "patient");
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("patient");
    const response = await request("/alerts", { token });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden" });
    expect(
      auditEntries.some((e) => e.action === "dashboard_alerts_denied")
    ).toBe(true);
  });

  it("GET /alerts returns the paginated feed", async () => {
    const store = new Map([[ALERT_ID, alertRowOf("open")]]);
    const { deps } = makeDeps(store);
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await request("/alerts?limit=20&offset=0", { token });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: AlertRow[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ id: ALERT_ID, level: "red" });
  });

  it("GET /alerts rejects an out-of-range limit with 400", async () => {
    const { deps } = makeDeps(new Map());
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await request("/alerts?limit=0", { token });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_error",
    });
  });

  it("acknowledge transitions open → acknowledged, audit-logs and emits alert:updated", async () => {
    const store = new Map([[ALERT_ID, alertRowOf("open")]]);
    const { deps, auditEntries, emitted } = makeDeps(store);
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await request(`/alerts/${ALERT_ID}/acknowledge`, {
      method: "POST",
      token,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: ALERT_ID,
      status: "acknowledged",
      acknowledgedBy: "user-1",
    });
    const audit = auditEntries.find((e) => e.action === "alert_acknowledged");
    expect(audit).toBeDefined();
    expect(audit?.resourceId).toBe(ALERT_ID);
    expect(audit?.meta).toMatchObject({
      requestedAction: "acknowledge",
      actorId: "user-1",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: "alert:updated",
      payload: { id: ALERT_ID, status: "acknowledged" },
    });
  });

  it("acknowledge returns 404 for an unknown alert", async () => {
    const { deps } = makeDeps(new Map());
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await request(`/alerts/${ALERT_ID}/acknowledge`, {
      method: "POST",
      token,
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("acknowledge returns 409 for a non-open alert", async () => {
    const store = new Map([[ALERT_ID, alertRowOf("acknowledged")]]);
    const { deps } = makeDeps(store);
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await request(`/alerts/${ALERT_ID}/acknowledge`, {
      method: "POST",
      token,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "conflict" });
  });

  it("resolve transitions to resolved, audit-logs the reason and emits alert:updated", async () => {
    const store = new Map([[ALERT_ID, alertRowOf("acknowledged")]]);
    const { deps, auditEntries, emitted } = makeDeps(store);
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await request(`/alerts/${ALERT_ID}/resolve`, {
      method: "POST",
      token,
      body: { reason: "Derivado a red de apoyo." },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: ALERT_ID,
      status: "resolved",
    });
    const audit = auditEntries.find((e) => e.action === "alert_resolved");
    expect(audit).toBeDefined();
    expect(audit?.meta).toMatchObject({
      requestedAction: "resolve",
      reason: "Derivado a red de apoyo.",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: "alert:updated",
      payload: { id: ALERT_ID, status: "resolved" },
    });
  });

  it("resolve returns 409 when already resolved", async () => {
    const store = new Map([[ALERT_ID, alertRowOf("resolved")]]);
    const { deps } = makeDeps(store);
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await request(`/alerts/${ALERT_ID}/resolve`, {
      method: "POST",
      token,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "conflict" });
  });

  it("resolve rejects an oversized reason with 400", async () => {
    const store = new Map([[ALERT_ID, alertRowOf("open")]]);
    const { deps } = makeDeps(store);
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await request(`/alerts/${ALERT_ID}/resolve`, {
      method: "POST",
      token,
      body: { reason: "x".repeat(501) },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_error",
    });
  });

  it("rejects a malformed alert id with 400", async () => {
    const { deps } = makeDeps(new Map());
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await request("/alerts/not-a-uuid/acknowledge", {
      method: "POST",
      token,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_error",
    });
  });
});
