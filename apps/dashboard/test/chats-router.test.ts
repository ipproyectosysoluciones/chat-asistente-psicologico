import { afterEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import type { Server } from "node:http";

import type { NewAuditEntry, DashboardUser } from "@chatcap/db-schema";
import type {
  DashboardMessage,
  RagTrace,
  Role,
  Session,
} from "@chatcap/shared-types";

import {
  createChatsRouter,
  type ChatsRepository,
  type ChatsRouterDeps,
} from "../src/server/chats-router";
import type { JwtConfig } from "../src/server/auth/jwt";
import { signAccessToken } from "../src/server/auth/jwt";
import type { AuditWriter } from "../src/server/auth/middleware";

/**
 * Chats router (task 5.2, REQ-DASH-2/9): paginated chat list with anonymized
 * identifiers and the dual chat view (messages + RAG grounding traces + open
 * alert level). Supervisor/admin only; RBAC denials are audit-logged
 * (REQ-DASH-1) and successful detail access is audit-logged (REQ-DASH-8).
 */

const JWT: JwtConfig = { secret: "j".repeat(32), ttlSeconds: 900 };
const SUPERVISOR = "00000000-0000-7000-8000-0000000000bb";
const ADMIN = "00000000-0000-7000-8000-0000000000aa";
const PATIENT = "00000000-0000-7000-8000-0000000000cc";
const SESSION = "11111111-1111-7111-8111-111111111111";

function supervisorToken(): string {
  return signAccessToken(JWT, { sub: SUPERVISOR, role: "supervisor" });
}
function patientToken(): string {
  return signAccessToken(JWT, { sub: PATIENT, role: "patient" });
}

function recordingAudit(): AuditWriter & { entries: NewAuditEntry[] } {
  const entries: NewAuditEntry[] = [];
  return {
    entries,
    async write(entry) {
      entries.push(entry);
    },
  };
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

function sessionFixture(): Session {
  return {
    id: SESSION,
    contactKeyAnon: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    jurisdiction: "CO",
    persistenceClass: "anonymous",
    consentState: "notice_shown",
    aiState: "auto",
    createdAt: "2026-08-14T00:00:00.000Z",
    lastActivityAt: "2026-08-14T12:00:00.000Z",
  };
}

function messageFixtures(): DashboardMessage[] {
  return [
    {
      id: "m1",
      sessionId: SESSION,
      sender: "user",
      text: "Estoy muy ansioso.",
      encrypted: false,
      createdAt: "2026-08-14T11:00:00.000Z",
    },
    {
      id: "m2",
      sessionId: SESSION,
      sender: "bot",
      text: "Probemos una técnica de respiración.",
      encrypted: false,
      createdAt: "2026-08-14T11:01:00.000Z",
    },
  ];
}

function ragTraceFixture(): RagTrace {
  return {
    traceId: "trace-1",
    sessionId: SESSION,
    risk: "orange",
    classification: { model: "gpt-4o-mini", risk: "orange", confidence: 0.9 },
    retrieval: {
      model: "text-embedding-3-small",
      topK: 1,
      hnsw: { efSearch: 40 },
      chunks: [],
    },
    generation: { model: "gpt-4o", temperature: 0 },
    gate: {
      verdict: "orange_block",
      cosine: 0.71,
      nli: { verdict: "neutral", confidence: 0.8 },
      guardrail: {
        level: "orange",
        deviationTerms: ["diagnóstico"],
        blocked: true,
      },
      chunks: [
        {
          chunkId: "chunk-1",
          docId: "doc-1",
          chunkIndex: 0,
          content: "Técnica de respiración para la ansiedad.",
          category: "psicoeducacion",
          source: "guia-ansiedad",
          language: "es",
          legalFramework: "CO",
          score: 0.71,
        },
      ],
    },
    emitted: false,
    createdAt: "2026-08-14T11:59:00.000Z",
  };
}

interface MakeDepsOverrides {
  listChats?: ChatsRepository["listChats"];
  getSession?: ChatsRepository["getSession"];
  listMessages?: ChatsRepository["listMessages"];
  listRagTraces?: ChatsRepository["listRagTraces"];
  findOpenAlertLevel?: ChatsRepository["findOpenAlertLevel"];
  users?: DashboardUser[];
}

function makeDeps(overrides: MakeDepsOverrides = {}): {
  deps: ChatsRouterDeps;
  audit: AuditWriter & { entries: NewAuditEntry[] };
} {
  const audit = recordingAudit();
  const users = overrides.users ?? [
    dashboardUser(SUPERVISOR, "supervisor"),
    dashboardUser(ADMIN, "admin"),
    dashboardUser(PATIENT, "patient"),
  ];
  const byId = new Map(users.map((user) => [user.id, user]));
  return {
    audit,
    deps: {
      jwt: JWT,
      users: {
        async findByEmail() {
          return undefined;
        },
        async findById(id) {
          return byId.get(id);
        },
      },
      audit,
      chats: {
        async listChats(options) {
          return { items: [], total: 0, ...options };
        },
        async getSession() {
          return undefined;
        },
        async listMessages() {
          return [];
        },
        async listRagTraces() {
          return [];
        },
        async findOpenAlertLevel() {
          return undefined;
        },
        ...overrides,
      },
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

async function startServer(deps: ChatsRouterDeps): Promise<string> {
  const app: Express = express();
  app.use(express.json());
  app.use(createChatsRouter(deps));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("GET /chats", () => {
  it("returns the paginated chat list for a supervisor with default pagination", async () => {
    const { deps, audit } = makeDeps({
      listChats: async (options) => ({
        items: [
          {
            sessionId: SESSION,
            contactKeyAnon: "a1b2c3d4e5f6a1b2",
            jurisdiction: "CO",
            persistenceClass: "anonymous" as const,
            aiState: "auto" as const,
            lastActivityAt: "2026-08-14T12:00:00.000Z",
            messageCount: 3,
            openAlertLevel: "red" as const,
          },
        ],
        total: 1,
        ...options,
      }),
    });
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats`, {
      headers: bearer(supervisorToken()),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          sessionId: SESSION,
          contactKeyAnon: "a1b2c3d4e5f6a1b2",
          jurisdiction: "CO",
          persistenceClass: "anonymous",
          aiState: "auto",
          lastActivityAt: "2026-08-14T12:00:00.000Z",
          messageCount: 3,
          openAlertLevel: "red",
        },
      ],
      total: 1,
    });
    expect(audit.entries).toEqual([]);
  });

  it("forwards explicit limit/offset to the repository", async () => {
    const seen: Array<{ limit: number; offset: number }> = [];
    const { deps } = makeDeps({
      listChats: async (options) => {
        seen.push(options);
        return { items: [], total: 0 };
      },
    });
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats?limit=50&offset=40`, {
      headers: bearer(supervisorToken()),
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ limit: 50, offset: 40 }]);
  });

  it("rejects a request without a token with 401", async () => {
    const { deps } = makeDeps();
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });

  it("rejects a non-authorized role with 403 and audit-logs the denial", async () => {
    const { deps, audit } = makeDeps();
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats`, {
      headers: bearer(patientToken()),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actorType: "system",
      actorId: PATIENT,
      action: "dashboard_chats_denied",
      resourceType: "chat",
      reason: "insufficient_role",
    });
  });

  it("rejects a limit above the 100 cap with 400", async () => {
    const { deps } = makeDeps();
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats?limit=101`, {
      headers: bearer(supervisorToken()),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
  });

  it("rejects a non-integer limit with 400", async () => {
    const { deps } = makeDeps();
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats?limit=abc`, {
      headers: bearer(supervisorToken()),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
  });

  it("rejects a negative offset with 400", async () => {
    const { deps } = makeDeps();
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats?offset=-1`, {
      headers: bearer(supervisorToken()),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
  });
});

describe("GET /chats/:sessionId", () => {
  it("assembles the dual chat detail (messages, RAG traces, alert level)", async () => {
    const { deps } = makeDeps({
      getSession: async () => sessionFixture(),
      listMessages: async () => messageFixtures(),
      listRagTraces: async () => [ragTraceFixture()],
      findOpenAlertLevel: async () => "orange",
    });
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats/${SESSION}`, {
      headers: bearer(supervisorToken()),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: Session;
      messages: DashboardMessage[];
      ragTraces: RagTrace[];
      alertLevel?: string;
    };
    expect(body.session.id).toBe(SESSION);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({ sender: "user", text: "Estoy muy ansioso." });
    expect(body.ragTraces).toHaveLength(1);
    expect(body.ragTraces[0]!.gate.verdict).toBe("orange_block");
    expect(body.alertLevel).toBe("orange");
  });

  it("omits alertLevel when the chat has no open alert", async () => {
    const { deps } = makeDeps({
      getSession: async () => sessionFixture(),
      listMessages: async () => [],
      listRagTraces: async () => [],
    });
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats/${SESSION}`, {
      headers: bearer(supervisorToken()),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("alertLevel");
    expect(body.messages).toEqual([]);
    expect(body.ragTraces).toEqual([]);
  });

  it("audit-logs successful chat detail access", async () => {
    const { deps, audit } = makeDeps({
      getSession: async () => sessionFixture(),
      listMessages: async () => messageFixtures(),
    });
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats/${SESSION}`, {
      headers: bearer(supervisorToken()),
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actorType: "supervisor",
      actorId: SUPERVISOR,
      action: "chat_detail_access",
      resourceType: "chat",
      resourceId: SESSION,
    });
  });

  it("returns 404 for an unknown session", async () => {
    const { deps } = makeDeps({
      getSession: async () => undefined,
    });
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats/${SESSION}`, {
      headers: bearer(supervisorToken()),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("returns 400 for a malformed sessionId", async () => {
    const { deps } = makeDeps();
    const baseUrl = await startServer(deps);

    const response = await fetch(`${baseUrl}/chats/not-a-uuid`, {
      headers: bearer(supervisorToken()),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
  });
});
