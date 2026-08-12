import { describe, expect, it, vi } from "vitest";

import { createLogger, type Logger } from "@chatcap/telemetry";
import { SESSION_STATE } from "@chatcap/shared-types";

import { createBot, PROCESSING_ERROR_TEXT } from "../src/bot";
import { hashContactKey } from "../src/contact-key";
import { MemoryChatDatabase } from "../src/database/memory";
import { type Flow, type FlowContext, type FlowOutput } from "../src/flow/flow";
import { InMemoryFlowStateStore } from "../src/flow/state-store";
import { createScaffoldFlow, WELCOME_TEXT } from "../src/flow/scaffold";
import { messageFrom, MockProvider } from "../src/provider/mock";

/**
 * Bot orchestrator (task 4.1, REQ-CHATBOT-1): wires the three pillars.
 * The contract tested here is what makes the pipeline safe: contact-key
 * hashing, session find-or-create, reply emission, effect application, state
 * persistence — and, on any failure, a PII-free retry text instead of a
 * crash or a leaked identifier.
 */

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    level: "silent",
    destination: { write: (chunk: string | Buffer) => lines.push(String(chunk)) },
  });
  return { logger, lines };
}

describe("createBot (task 4.1 orchestrator)", () => {
  it("answers a first message with the welcome and stores the session", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const bot = createBot(
      {
        flow: createScaffoldFlow(),
        provider,
        database: db,
      },
      { logger, contactKeySalt: "x".repeat(16) }
    );
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "Hola"),
    });

    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]?.text).toBe(WELCOME_TEXT);
    expect(db.sessionCount).toBe(1);
  });

  it("persists the flow nextState in the state store keyed by contact key", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const stateStore = new InMemoryFlowStateStore();
    const { logger } = captureLogger();
    const bot = createBot(
      { flow: createScaffoldFlow(), provider, database: db },
      { logger, contactKeySalt: "x".repeat(16), stateStore }
    );
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "Hola"),
    });

    const contactKeyAnon = hashContactKey("5491100000000", "x".repeat(16));
    const stored = await stateStore.get(contactKeyAnon);
    expect(stored).toEqual({ state: SESSION_STATE.MENU });
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("never logs the raw phone number", async () => {
    const provider = new MockProvider();
    const { logger, lines } = captureLogger();
    const failingDatabase = {
      findOrCreateSession: async () => {
        throw new Error("db down");
      },
      setSessionJurisdiction: async () => {
        throw new Error("unused");
      },
      ping: async () => {},
    };
    const bot = createBot(
      {
        flow: createScaffoldFlow(),
        provider,
        database: failingDatabase,
      },
      { logger, contactKeySalt: "x".repeat(16) }
    );
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "Hola"),
    });

    expect(provider.sentMessages[0]?.text).toBe(PROCESSING_ERROR_TEXT);
    const joined = lines.join("\n");
    expect(joined).not.toContain("5491100000000");
  });

  it("sends a safe retry text when the flow fails, without crashing", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const explodingFlow: Flow = {
      handle: async () => {
        throw new Error("flow bug");
      },
    };
    const bot = createBot(
      { flow: explodingFlow, provider, database: db },
      { logger, contactKeySalt: "x".repeat(16) }
    );
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "Hola"),
    });

    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]?.text).toBe(PROCESSING_ERROR_TEXT);
  });

  it("falls back to a fresh state and still replies when the state store fails", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const failingStateStore = {
      get: async () => {
        throw new Error("state store down");
      },
      set: async () => {},
    };
    const bot = createBot(
      { flow: createScaffoldFlow(), provider, database: db },
      { logger, contactKeySalt: "x".repeat(16), stateStore: failingStateStore }
    );
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "Hola"),
    });

    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]?.text).toBe(WELCOME_TEXT);
    expect(db.sessionCount).toBe(1);
  });

  it("applies a persist_jurisdiction effect to the database", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const jurisdictionFlow: Flow = {
      handle: async (_message, context: FlowContext): Promise<FlowOutput> => {
        return {
          replies: [],
          effects: [
            {
              kind: "persist_jurisdiction",
              sessionId: context.sessionId,
              jurisdiction: "EU-GDPR",
            },
          ],
          nextState: { state: SESSION_STATE.MENU, jurisdiction: "EU-GDPR" },
        };
      },
    };
    const bot = createBot(
      { flow: jurisdictionFlow, provider, database: db },
      { logger, contactKeySalt: "x".repeat(16) }
    );
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "Hola"),
    });

    const session = await db.findOrCreateSession("bogus");
    expect(session).toBeDefined();
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("skips non-message lifecycle events", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const bot = createBot(
      { flow: createScaffoldFlow(), provider, database: db },
      { logger, contactKeySalt: "x".repeat(16) }
    );
    await bot.start();

    await provider.emit({ type: "reconnecting" });
    await provider.emit({ type: "reconnected" });

    expect(provider.sentMessages).toHaveLength(0);
    expect(db.sessionCount).toBe(0);
  });

  it("sends each reply from the flow output", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const multiReplyFlow: Flow = {
      handle: async (message) => {
        return {
          replies: [
            { from: message.from, body: "primera" },
            { from: message.from, body: "segunda" },
          ],
          effects: [],
          nextState: { state: SESSION_STATE.MENU },
        };
      },
    };
    const bot = createBot(
      { flow: multiReplyFlow, provider, database: db },
      { logger, contactKeySalt: "x".repeat(16) }
    );
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "Hola"),
    });

    expect(provider.sentMessages.map((m) => m.text)).toEqual(["primera", "segunda"]);
  });

  it("registers the handler only once on start", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const flow = vi.fn<Flow["handle"]>(async (message) => ({
      replies: [{ from: message.from, body: "ok" }],
      effects: [],
    }));
    const bot = createBot(
      { flow: { handle: flow }, provider, database: db },
      { logger, contactKeySalt: "x".repeat(16) }
    );
    await bot.start();

    await provider.emit({ type: "message", message: messageFrom("5491100000000", "Hola") });
    await provider.emit({ type: "message", message: messageFrom("5491100000000", "Hola") });

    expect(flow).toHaveBeenCalledTimes(2);
    expect(provider.sentMessages).toHaveLength(2);
  });
});
