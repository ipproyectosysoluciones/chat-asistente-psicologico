import { afterEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import type { Server } from "node:http";

import type { NewAuditEntry } from "@chatcap/db-schema";

import {
  createAuthenticate,
  createAuthorize,
  createAuditMiddleware,
  type AuditWriter,
  type AuthenticateDeps,
} from "../src/server/auth/middleware";
import type { JwtConfig } from "../src/server/auth/jwt";
import { signAccessToken } from "../src/server/auth/jwt";

/**
 * Middleware chain (design §3.3, REQ-DASH-1): authenticate → authorize(role)
 * → optional audit. Every RBAC denial is audit-logged (supervisor denied an
 * admin action) with who/when/why; the audit middleware records successful
 * access to encrypted/chat data and stays silent on 4xx/5xx.
 */

const JWT: JwtConfig = { secret: "j".repeat(32), ttlSeconds: 900 };
const ADMIN = "00000000-0000-7000-8000-0000000000aa";
const SUPERVISOR = "00000000-0000-7000-8000-0000000000bb";

function adminToken(): string {
  return signAccessToken(JWT, { sub: ADMIN, role: "admin" });
}
function supervisorToken(): string {
  return signAccessToken(JWT, { sub: SUPERVISOR, role: "supervisor" });
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

function authDeps(): AuthenticateDeps {
  return {
    jwt: JWT,
    async findUserById(id) {
      if (id === ADMIN || id === SUPERVISOR) {
        return { id, role: id === ADMIN ? "admin" : "supervisor" };
      }
      return null;
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

async function startServer(app: Express): Promise<string> {
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

describe("authenticate middleware", () => {
  it("sets the principal for a valid token and passes through", async () => {
    const seen: Array<string | undefined> = [];
    const app: Express = express();
    app.get("/p", createAuthenticate(authDeps()), (req, res) => {
      seen.push(req.principal?.userId);
      res.status(200).json({ ok: true });
    });
    const baseUrl = await startServer(app);

    const response = await fetch(`${baseUrl}/p`, { headers: bearer(adminToken()) });
    expect(response.status).toBe(200);
    expect(seen).toEqual([ADMIN]);
  });

  it("rejects a request without an Authorization header (401)", async () => {
    const app: Express = express();
    app.get("/p", createAuthenticate(authDeps()), (_req, res) => res.status(200).end());
    const baseUrl = await startServer(app);

    const response = await fetch(`${baseUrl}/p`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });

  it("rejects an invalid/expired token (401, no downstream call)", async () => {
    const called: unknown[] = [];
    const app: Express = express();
    app.get("/p", createAuthenticate(authDeps()), (_req, res) => {
      called.push(1);
      res.status(200).end();
    });
    const baseUrl = await startServer(app);

    const response = await fetch(`${baseUrl}/p`, {
      headers: bearer("garbage.token.value"),
    });
    expect(response.status).toBe(401);
    expect(called).toEqual([]);
  });
});

describe("authorize middleware", () => {
  it("allows a supervisor on supervisor-scoped routes", async () => {
    const audit = recordingAudit();
    const app: Express = express();
    app.get(
      "/chats",
      createAuthenticate(authDeps()),
      createAuthorize({
        allowedRoles: ["supervisor", "admin"],
        deniedAction: "dashboard_chats_denied",
        resourceType: "chat",
        audit,
      }),
      (_req, res) => res.status(200).json({ ok: true })
    );
    const baseUrl = await startServer(app);

    const response = await fetch(`${baseUrl}/chats`, {
      headers: bearer(supervisorToken()),
    });
    expect(response.status).toBe(200);
    expect(audit.entries).toEqual([]);
  });

  it("denies a supervisor an admin-only action and audit-logs the denial", async () => {
    const audit = recordingAudit();
    const app: Express = express();
    app.get(
      "/keys",
      createAuthenticate(authDeps()),
      createAuthorize({
        allowedRoles: ["admin"],
        deniedAction: "dashboard_keys_denied",
        resourceType: "key",
        audit,
      }),
      (_req, res) => res.status(200).json({ ok: true })
    );
    const baseUrl = await startServer(app);

    const response = await fetch(`${baseUrl}/keys`, {
      headers: bearer(supervisorToken()),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actorType: "system",
      actorId: SUPERVISOR,
      action: "dashboard_keys_denied",
      resourceType: "key",
      reason: "insufficient_role",
      meta: { reason: "insufficient_role", requestedAction: "dashboard_keys_denied" },
    });
  });

  it("denies a missing principal with 401 (authenticate must run first)", async () => {
    const audit = recordingAudit();
    const app: Express = express();
    app.get(
      "/chats",
      createAuthorize({
        allowedRoles: ["supervisor", "admin"],
        deniedAction: "dashboard_chats_denied",
        resourceType: "chat",
        audit,
      }),
      (_req, res) => res.status(200).json({ ok: true })
    );
    const baseUrl = await startServer(app);

    const response = await fetch(`${baseUrl}/chats`);
    expect(response.status).toBe(401);
    expect(audit.entries).toEqual([]);
  });
});

describe("audit middleware", () => {
  it("records successful access with the acting principal", async () => {
    const audit = recordingAudit();
    const app: Express = express();
    app.get(
      "/chats/:id",
      createAuthenticate(authDeps()),
      createAuditMiddleware({
        action: "chat_access",
        resourceType: "chat",
        resourceId: (req) => String(req.params.id),
        audit,
      }),
      (_req, res) => res.status(200).json({ ok: true })
    );
    const baseUrl = await startServer(app);

    const response = await fetch(`${baseUrl}/chats/chat-1`, {
      headers: bearer(supervisorToken()),
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actorType: "supervisor",
      actorId: SUPERVISOR,
      action: "chat_access",
      resourceType: "chat",
      resourceId: "chat-1",
    });
  });

  it("does not record an audit entry for error responses", async () => {
    const audit = recordingAudit();
    const app: Express = express();
    app.get(
      "/chats/:id",
      createAuthenticate(authDeps()),
      createAuditMiddleware({
        action: "chat_access",
        resourceType: "chat",
        resourceId: (req) => String(req.params.id),
        audit,
      }),
      (_req, res) => res.status(404).json({ code: "not_found" })
    );
    const baseUrl = await startServer(app);

    await fetch(`${baseUrl}/chats/missing`, { headers: bearer(adminToken()) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(audit.entries).toEqual([]);
  });
});
