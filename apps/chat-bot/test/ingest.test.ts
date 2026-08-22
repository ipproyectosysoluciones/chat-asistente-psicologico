import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { createLogger } from "@chatcap/telemetry";

import { createApp, type AppDeps } from "../src/app";
import { MemoryChatDatabase } from "../src/database/memory";
import { MockProvider } from "../src/provider/mock";

/**
 * Supervisor-reply ingest (task 5.3, REQ-DASH-3): POST /internal/messages/ingest
 * is the chat-bot-side injection point the dashboard calls when a supervisor
 * answers a chat under takeover. Gating is defense-in-depth — the dashboard
 * flips ai_state, but the chat-bot re-checks it before persisting/sending.
 * The body text is clinical content, so failures are logged PII-free: the
 * session id, never the message.
 */

const silentLogger = createLogger({
  level: "silent",
  destination: { write: () => {} },
});

const INTERNAL_TOKEN = "test-internal-token";

function makeApp(
  database: MemoryChatDatabase,
  provider: MockProvider
): AppDeps {
  return {
    logger: silentLogger,
    readiness: {
      database: { check: async () => {} },
      aiRag: { check: async () => {} },
    },
    ingest: {
      logger: silentLogger,
      internalTokens: [INTERNAL_TOKEN],
      pillars: { database, provider },
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

async function listen(deps: AppDeps): Promise<string> {
  const app = createApp(deps);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function ingest(
  baseUrl: string,
  body: unknown,
  token: string | undefined
): Promise<Response> {
  return fetch(`${baseUrl}/internal/messages/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { "x-internal-token": token }),
    },
    body: JSON.stringify(body),
  });
}

describe("createApp — /internal/messages/ingest (task 5.3, REQ-DASH-3)", () => {
  it("rejects requests without a valid internal token", async () => {
    const db = new MemoryChatDatabase();
    const provider = new MockProvider();
    const baseUrl = await listen(makeApp(db, provider));

    const missing = await ingest(baseUrl, { sessionId: "x", text: "hola" }, undefined);
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({ code: "unauthorized" });

    const wrong = await ingest(baseUrl, { sessionId: "x", text: "hola" }, "nope");
    expect(wrong.status).toBe(401);
  });

  it("rejects an invalid body with a validation problem", async () => {
    const db = new MemoryChatDatabase();
    const provider = new MockProvider();
    const baseUrl = await listen(makeApp(db, provider));

    const response = await ingest(baseUrl, { text: "hola" }, INTERNAL_TOKEN);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_error",
    });
  });

  it("returns 404 for an unknown session", async () => {
    const db = new MemoryChatDatabase();
    const provider = new MockProvider();
    const baseUrl = await listen(makeApp(db, provider));

    const response = await ingest(
      baseUrl,
      { sessionId: "00000000-0000-4000-8000-000000000000", text: "hola" },
      INTERNAL_TOKEN
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("returns 409 when the session is not under takeover", async () => {
    const db = new MemoryChatDatabase();
    const provider = new MockProvider();
    const session = await db.findOrCreateSession("anon-1");
    const baseUrl = await listen(makeApp(db, provider));

    const response = await ingest(baseUrl, { sessionId: session.id, text: "hola" }, INTERNAL_TOKEN);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "conflict" });
    expect(provider.sentMessages).toHaveLength(0);
    expect(db.history).toHaveLength(0);
  });

  it("persists the supervisor reply and sends it when the session is under takeover", async () => {
    const db = new MemoryChatDatabase();
    const session = await db.findOrCreateSession("anon-1");
    db.seedContactPhone(session.id, "+5491100000000");
    const provider = new MockProvider();
    await db.setSessionAiState(session.id, "takeover");
    const baseUrl = await listen(makeApp(db, provider));

    const response = await ingest(
      baseUrl,
      { sessionId: session.id, text: "Te leo. Contame qué pasó." },
      INTERNAL_TOKEN
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(provider.sentMessages).toEqual([
      { to: "+5491100000000", text: "Te leo. Contame qué pasó." },
    ]);
    expect(db.history.map((entry) => entry.sender)).toEqual(["bot"]);
    expect(db.history[0]?.text).toBe("Te leo. Contame qué pasó.");
    expect(db.history[0]?.sessionId).toBe(session.id);
  });

  it("returns 500 with a PII-free log when the contact phone cannot be resolved", async () => {
    const db = new MemoryChatDatabase();
    const provider = new MockProvider();
    const session = await db.findOrCreateSession("anon-1");
    await db.setSessionAiState(session.id, "takeover");
    const baseUrl = await listen(makeApp(db, provider));

    const response = await ingest(baseUrl, { sessionId: session.id, text: "hola" }, INTERNAL_TOKEN);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: "internal_error",
    });
    expect(provider.sentMessages).toHaveLength(0);
  });
});
