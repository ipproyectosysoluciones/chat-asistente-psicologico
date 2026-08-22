import { describe, expect, it, vi } from "vitest";

import {
  createLogger,
  type EventEmitter,
  type Logger,
  type TelemetryEvent,
} from "@chatcap/telemetry";
import { ALERT_LEVEL, EVENT_TYPE } from "@chatcap/shared-types";
import type { AlertEvent } from "@chatcap/shared-types";

import { createBot } from "../src/bot";
import { MemoryChatDatabase } from "../src/database/memory";
import { createScaffoldFlow } from "../src/flow/scaffold";
import { messageFrom, MockProvider } from "../src/provider/mock";

/**
 * Reconnect + auth-failure handling (task 4.7, REQ-CHATBOT-8): the
 * orchestrator reacts to provider lifecycle events — auto-reconnect resumes
 * message processing, and an unrecoverable `auth_failure` notifies the
 * supervisor through the fallback channel (notifications service) so
 * escalation never depends on the WhatsApp channel that just died.
 */

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    destination: { write: (chunk: string | Buffer) => lines.push(String(chunk)) },
  });
  return { logger, lines };
}

interface PublishedAlert {
  type: string;
  payload: Record<string, unknown>;
}

function captureEmitter(): { emitter: EventEmitter; published: PublishedAlert[] } {
  const published: PublishedAlert[] = [];
  const emitter: EventEmitter = {
    publish: vi.fn(async (event: TelemetryEvent) => {
      published.push({
        type: event.type,
        payload: event.payload as Record<string, unknown>,
      });
    }),
  };
  return { emitter, published };
}

function makeBot(overrides: {
  emitter?: EventEmitter;
  logger?: Logger;
} = {}) {
  const provider = new MockProvider();
  const db = new MemoryChatDatabase();
  const { logger } = overrides.logger === undefined ? captureLogger() : { logger: overrides.logger };
  const bot = createBot(
    { flow: createScaffoldFlow(), provider, database: db },
    {
      logger,
      contactKeySalt: "x".repeat(16),
      emitter: overrides.emitter,
    }
  );
  return { bot, provider, db, logger };
}

describe("createBot reconnect handling (task 4.7, REQ-CHATBOT-8)", () => {
  it("notifies the supervisor via the fallback channel on auth_failure", async () => {
    const { emitter, published } = captureEmitter();
    const { bot, provider } = makeBot({ emitter });
    await bot.start();

    await provider.emit({ type: "auth_failure", reason: "logged out" });

    expect(published).toHaveLength(1);
    const alert = published[0] as PublishedAlert | undefined;
    expect(alert?.type).toBe(EVENT_TYPE.ALERT_RAISED);
    const payload = alert?.payload as Partial<AlertEvent>;
    expect(payload.level).toBe(ALERT_LEVEL.ORANGE);
    expect(payload.category).toBe("session");
    expect(payload.keyword).toBe("auth_failure");
    expect(payload.sessionId).toBe("provider:mock");
    expect(JSON.stringify(payload)).not.toMatch(/5491|message|body/);
  });

  it("logs loudly instead of crashing when no emitter is configured", async () => {
    const { logger, lines } = captureLogger();
    const { bot, provider } = makeBot({ logger });
    await bot.start();

    await expect(provider.emit({ type: "auth_failure" })).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("auth_failure");
  });

  it("logs loudly when the fallback publish fails and never throws", async () => {
    const failing: EventEmitter = {
      publish: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const { logger, lines } = captureLogger();
    const { bot, provider } = makeBot({ emitter: failing, logger });
    await bot.start();

    await expect(provider.emit({ type: "auth_failure" })).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("auth_failure");
  });

  it("resumes message processing after a reconnect cycle", async () => {
    const { bot, provider, db } = makeBot();
    await bot.start();

    await provider.emit({ type: "reconnecting" });
    await provider.emit({ type: "reconnected" });

    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "Hola"),
    });

    expect(provider.sentMessages.length).toBeGreaterThan(0);
    expect(db.sessionCount).toBe(1);
  });

  it("never buffers or loses an in-flight message across reconnects", async () => {
    const { bot, provider, db } = makeBot();
    await bot.start();

    await provider.emit({ type: "reconnecting" });
    await provider.emit({
      type: "message",
      message: messageFrom("5491100000000", "Hola"),
    });
    await provider.emit({ type: "reconnected" });

    expect(provider.sentMessages.length).toBeGreaterThan(0);
    expect(db.sessionCount).toBe(1);
  });
});
