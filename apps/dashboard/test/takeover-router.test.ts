import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

import { createLogger } from "@chatcap/telemetry";
import type { NewAuditEntry } from "@chatcap/db-schema";
import type { DashboardUser } from "@chatcap/db-schema";
import type { ChatTakeoverEvent, Role, Session } from "@chatcap/shared-types";

import { createApp, type AppDeps } from "../src/server/app";
import type { AuditWriter } from "../src/server/auth/middleware";
import { signAccessToken } from "../src/server/auth/jwt";

/**
 * Takeover/release router (task 5.3, REQ-DASH-3 / design §3.1): POST
 * /chats/{id}/takeover flips ai_state to takeover (AI off per chat) and POST
 * /chats/{id}/release resumes AI. Supervisor/admin only; RBAC denials are
 * audit-logged (REQ-DASH-1) and successful flips are audit-logged (REQ-DASH-8)
 * and pushed over the injected Socket.io emit (live supervisor sync).
 */

const secret = "s".repeat(32);
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

async function signIn(role: Role): Promise<string> {
  return signAccessToken(
    { secret, ttlSeconds: 900 },
    { sub: "user-1", role }
  );
}

function sessionOf(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    contactKeyAnon: "anon-1",
    persistenceClass: "anonymous",
    consentState: "accepted",
    aiState: "auto",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Harness {
  deps: AppDeps;
  auditEntries: NewAuditEntry[];
  emitted: ChatTakeoverEvent[];
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
  session: Session | undefined,
  role: Role = "supervisor"
): Harness {
  const sessions = new Map<string, Session>();
  if (session !== undefined) {
    sessions.set(session.id, session);
  }
  const users = {
    findByEmail: async () => undefined,
    findById: async () => dashboardUser("user-1", role),
  };
  const auditEntries: NewAuditEntry[] = [];
  const emitted: ChatTakeoverEvent[] = [];
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
      getSession: async (id) => sessions.get(id),
      listMessages: async () => [],
      listRagTraces: async () => [],
      findOpenAlertLevel: async () => undefined,
    },
    takeover: {
      jwt: { secret, ttlSeconds: 900 },
      users,
      audit,
      sessions: {
        getSession: async (id) => sessions.get(id),
        setAiState: async (id, aiState) => {
          const current = sessions.get(id);
          if (current === undefined) {
            throw new Error(`missing session ${id}`);
          }
          const updated: Session = { ...current, aiState };
          sessions.set(id, updated);
          return updated;
        },
      },
      emit: (event, payload) => {
        expect(event).toBe("chat:takeover");
        emitted.push(payload);
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

async function post(path: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });
}

describe("takeover/release (task 5.3, REQ-DASH-3)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const { deps } = makeDeps(sessionOf());
    const app = createApp(deps);
    await listen(app);
    const response = await post(`/chats/${SESSION_ID}/takeover`);
    expect(response.status).toBe(401);
  });

  it("denies non-supervisor roles with 403 and audit-logs the denial", async () => {
    const { deps, auditEntries } = makeDeps(sessionOf(), "patient");
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("patient");
    const response = await post(`/chats/${SESSION_ID}/takeover`, token);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden" });
    expect(
      auditEntries.some((e) => e.action === "dashboard_takeover_denied")
    ).toBe(true);
  });

  it("returns 404 for an unknown session", async () => {
    const { deps } = makeDeps(undefined);
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await post(`/chats/${SESSION_ID}/takeover`, token);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("takeover flips ai_state, audit-logs and emits the live event", async () => {
    const { deps, auditEntries, emitted } = makeDeps(sessionOf());
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await post(`/chats/${SESSION_ID}/takeover`, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      chatId: SESSION_ID,
      aiState: "takeover",
      takenOverBy: "user-1",
    });
    const audit = auditEntries.find((e) => e.action === "chat_takeover");
    expect(audit).toBeDefined();
    expect(audit?.resourceId).toBe(SESSION_ID);
    expect(audit?.meta).toMatchObject({
      requestedAction: "takeover",
      actorId: "user-1",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      sessionId: SESSION_ID,
      aiState: "takeover",
      actorId: "user-1",
    });
  });

  it("returns 409 on double takeover", async () => {
    const { deps } = makeDeps(sessionOf({ aiState: "takeover" }));
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await post(`/chats/${SESSION_ID}/takeover`, token);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "conflict" });
  });

  it("release resumes AI and emits the auto event", async () => {
    const { deps, auditEntries, emitted } = makeDeps(
      sessionOf({ aiState: "takeover" })
    );
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await post(`/chats/${SESSION_ID}/release`, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      chatId: SESSION_ID,
      aiState: "auto",
      releasedBy: "user-1",
    });
    expect(auditEntries.some((e) => e.action === "chat_release")).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ sessionId: SESSION_ID, aiState: "auto" });
  });

  it("returns 409 when releasing a session already in auto", async () => {
    const { deps } = makeDeps(sessionOf());
    const app = createApp(deps);
    await listen(app);
    const token = await signIn("supervisor");
    const response = await post(`/chats/${SESSION_ID}/release`, token);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "conflict" });
  });
});
