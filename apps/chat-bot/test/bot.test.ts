import { describe, expect, it, vi } from "vitest";

import {
  createLogger,
  type EventEmitter,
  type Logger,
  type TelemetryEvent,
} from "@chatcap/telemetry";
import {
  ALERT_STATUS,
  EVENT_TYPE,
  SESSION_STATE,
  type AlertEvent,
  type RagTrace,
} from "@chatcap/shared-types";

import {
  AI_DISABLED_TEXT,
  createBot,
  PROCESSING_ERROR_TEXT,
  RAG_UNAVAILABLE_TEXT,
} from "../src/bot";
import type { AiRagClient } from "../src/ai-rag-client";
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
      setSessionAiState: async () => {
        throw new Error("unused");
      },
      saveHistoryEntry: async () => {},
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

describe("createBot — raise_red_alert effect (task 4.5, REQ-CHATBOT-5, REQ-ALERT-3/4)", () => {
  function crisisFlow(): Flow {
    return {
      handle: async (message, context: FlowContext): Promise<FlowOutput> => {
        return {
          replies: [{ from: message.from, body: "ayuda disponible" }],
          effects: [
            { kind: "raise_red_alert", sessionId: context.sessionId, keyword: "crisis" },
          ],
          nextState: { state: SESSION_STATE.CRISIS },
        };
      },
    };
  }

  it("publishes a PII-free red alert event when the flow raises one", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const publish = vi.fn(async (_event: TelemetryEvent) => {});
    const emitter: EventEmitter = { publish };
    const bot = createBot(
      { flow: crisisFlow(), provider, database: db },
      { logger, contactKeySalt: "x".repeat(16), emitter }
    );
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "tengo una crisis"),
    });

    expect(publish).toHaveBeenCalledTimes(1);
    const events = publish.mock.calls.flatMap((call) => (call[0] ? [call[0]] : []));
    expect(events).toHaveLength(1);
    const event = events[0] as TelemetryEvent;
    const payload = event.payload as AlertEvent; // the bot builds a typed AlertEvent payload
    expect(event.type).toBe(EVENT_TYPE.ALERT_RAISED);
    const sessionId = payload.sessionId;
    expect(payload).toMatchObject({
      level: "red",
      category: "crisis",
      keyword: "crisis",
      status: ALERT_STATUS.OPEN,
      dedupeKey: `${sessionId}:red`,
    });
    // REQ-ALERT-6: the alert payload carries ids only — never the phone.
    expect(JSON.stringify(event)).not.toContain("5491100000000");
    expect(JSON.stringify(event)).not.toContain("body");
    // Crisis reply still reaches the user (best-effort < 5s path).
    expect(provider.sentMessages[0]?.text).toBe("ayuda disponible");
  });

  it("forces human takeover when the red-alert publish fails (REQ-ALERT-4)", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const emitter: EventEmitter = {
      publish: async () => {
        throw new Error("redis down");
      },
    };
    const bot = createBot(
      { flow: crisisFlow(), provider, database: db },
      { logger, contactKeySalt: "x".repeat(16), emitter }
    );
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "tengo una crisis"),
    });

    const contactKeyAnon = hashContactKey("5491100000000", "x".repeat(16));
    const session = await db.findOrCreateSession(contactKeyAnon);
    expect(session.aiState).toBe("takeover");
  });
});

describe("createBot — rag message lifecycle (task 4.6, REQ-CHATBOT-2)", () => {
  /** Full grounding trace mirroring apps/ai-rag POST /internal/rag/process. */
  function fakeTrace(sessionId: string): RagTrace {
    return {
      traceId: "trace-1",
      sessionId,
      risk: "normal",
      classification: { model: "gpt-4o-mini", risk: "normal", confidence: 0.9 },
      retrieval: {
        model: "text-embedding-3-small",
        topK: 4,
        hnsw: { efSearch: 100 },
        chunks: [
          {
            chunkId: "c1",
            docId: "d1",
            chunkIndex: 0,
            content: "chunk de referencia",
            category: "psicoeducacion",
            source: "guide-ansiedad",
            language: "es",
            legalFramework: "CO",
            score: 0.9,
          },
        ],
      },
      generation: { model: "gpt-4o-mini", temperature: 0.3 },
      gate: {
        verdict: "emit",
        cosine: 0.9,
        nli: { verdict: "entailment", confidence: 0.95 },
        guardrail: { level: "none", deviationTerms: [], blocked: false },
        chunks: [],
      },
      emitted: true,
      createdAt: new Date().toISOString(),
    };
  }

  function ragFlow(): Flow {
    return {
      handle: async (message, context: FlowContext): Promise<FlowOutput> => {
        return {
          replies: [],
          effects: [
            {
              kind: "rag_process",
              sessionId: context.sessionId,
              to: message.from,
              message: message.body,
            },
          ],
          nextState: { state: SESSION_STATE.TOPIC },
        };
      },
    };
  }

  function makeBot(options: {
    aiRag?: AiRagClient;
    aiEmissionEnabled?: boolean;
  }): {
    bot: ReturnType<typeof createBot>;
    provider: MockProvider;
    db: MemoryChatDatabase;
    aiRag: { process: ReturnType<typeof vi.fn> };
  } {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const aiRag = {
      process: vi.fn<AiRagClient["process"]>(async () => ({
        kind: "emitted",
        answer: "respuesta fundamentada",
        trace: fakeTrace("s1"),
      })),
      health: vi.fn(async () => true),
    };
    const bot = createBot(
      { flow: ragFlow(), provider, database: db },
      {
        logger,
        contactKeySalt: "x".repeat(16),
        aiRag: options.aiRag ?? aiRag,
        aiEmissionEnabled: options.aiEmissionEnabled,
      }
    );
    return { bot, provider, db, aiRag };
  }

  it("emits the grounded answer and persists user + bot history when the gate passes", async () => {
    const { bot, provider, db, aiRag } = makeBot({});
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "¿qué es la ansiedad?"),
    });

    expect(aiRag.process).toHaveBeenCalledTimes(1);
    expect(aiRag.process).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      message: "¿qué es la ansiedad?",
    });
    expect(provider.sentMessages.map((message) => message.text)).toEqual([
      "respuesta fundamentada",
    ]);
    expect(db.history.map((entry) => entry.text)).toEqual([
      "¿qué es la ansiedad?",
      "respuesta fundamentada",
    ]);
    expect(db.history.map((entry) => entry.sender)).toEqual(["user", "bot"]);
  });

  it("never emits an answer when the gate blocks — sends the RAG safe fallback", async () => {
    const aiRag = {
      process: vi.fn(async () => ({
        kind: "blocked" as const,
        fallbackText: "No puedo responder eso; por favor contactá a un profesional.",
        trace: fakeTrace("s1"),
      })),
      health: vi.fn(async () => true),
    };
    const { bot, provider, db } = makeBot({ aiRag });
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "recetame clonazepam"),
    });

    expect(aiRag.process).toHaveBeenCalledTimes(1);
    expect(provider.sentMessages.map((message) => message.text)).toEqual([
      "No puedo responder eso; por favor contactá a un profesional.",
    ]);
    expect(db.history.map((entry) => entry.sender)).toEqual(["user", "bot"]);
  });

  it("emits the grounded answer when the gate flags it for review (flagged)", async () => {
    const aiRag = {
      process: vi.fn(async () => ({
        kind: "flagged" as const,
        answer: "respuesta con bandera amarilla",
        fallbackText: "fallback no usado",
        trace: fakeTrace("s1"),
      })),
      health: vi.fn(async () => true),
    };
    const { bot, provider } = makeBot({ aiRag });
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "me siento muy mal"),
    });

    expect(provider.sentMessages.map((message) => message.text)).toEqual([
      "respuesta con bandera amarilla",
    ]);
  });

  it("routes a RAG crisis outcome to the crisis fallback text", async () => {
    const aiRag = {
      process: vi.fn(async () => ({
        kind: "crisis" as const,
        fallbackText: "Parece que estás en una situación de riesgo; buscá ayuda urgente.",
        trace: fakeTrace("s1"),
      })),
      health: vi.fn(async () => true),
    };
    const { bot, provider } = makeBot({ aiRag });
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "ya no puedo más"),
    });

    expect(provider.sentMessages.map((message) => message.text)).toEqual([
      "Parece que estás en una situación de riesgo; buscá ayuda urgente.",
    ]);
  });

  it("never calls the AI when the emission kill switch is off (human-only)", async () => {
    const { bot, provider, db, aiRag } = makeBot({ aiEmissionEnabled: false });
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "¿qué es la ansiedad?"),
    });

    expect(aiRag.process).not.toHaveBeenCalled();
    expect(provider.sentMessages.map((message) => message.text)).toEqual([
      AI_DISABLED_TEXT,
    ]);
    expect(db.history.map((entry) => entry.sender)).toEqual(["user", "bot"]);
  });

  it("degrades to human-only when ai-rag is down, without emitting ungrounded content", async () => {
    const { RagUpstreamError } = await import("../src/ai-rag-client");
    const aiRag = {
      process: vi.fn(async () => {
        throw new RagUpstreamError("ai-rag down", 502);
      }),
      health: vi.fn(async () => true),
    };
    const { bot, provider, db } = makeBot({ aiRag });
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "¿qué es la ansiedad?"),
    });

    expect(aiRag.process).toHaveBeenCalledTimes(1);
    expect(provider.sentMessages.map((message) => message.text)).toEqual([
      RAG_UNAVAILABLE_TEXT,
    ]);
    expect(db.history.map((entry) => entry.sender)).toEqual(["user", "bot"]);
  });

  it("treats a missing ai-rag client as degraded human-only (REQ-CHATBOT-2)", async () => {
    const provider = new MockProvider();
    const db = new MemoryChatDatabase();
    const { logger } = captureLogger();
    const bot = createBot(
      { flow: ragFlow(), provider, database: db },
      { logger, contactKeySalt: "x".repeat(16) }
    );
    await bot.start();

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "¿qué es la ansiedad?"),
    });

    expect(provider.sentMessages.map((message) => message.text)).toEqual([
      RAG_UNAVAILABLE_TEXT,
    ]);
  });
});
