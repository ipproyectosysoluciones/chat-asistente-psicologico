import { describe, expect, test } from "vitest";

import type { AppConfig } from "@chatcap/config";

import { fromAppConfig, type ChatBotConfig } from "../src/config";

/**
 * Service-local config wiring (task 4.1): the chat-bot derives its config
 * from the shared zod-validated AppConfig — no local env parsing, so boot
 * fails fast with the shared ConfigError when a var is missing.
 */

function baseConfig(): AppConfig {
  return {
    env: "test",
    port: 3120,
    logLevel: "info",
    databaseUrl: "postgres://chatcap:test@localhost:5432/chatcap_test",
    redisUrl: "redis://localhost:6379",
    openAiApiKey: "sk-test",
    aiEmissionEnabled: true,
    llm: {
      chatModel: "gpt-4o",
      nliModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
    },
    gate: {
      cosineEmit: 0.85,
      cosineRetry: 0.75,
      maxRetries: 1,
      nliEnabled: true,
    },
    geo: {
      provider: "none",
    },
    cryptoMasterSecret: "x".repeat(64),
    jwtSecret: "x".repeat(64),
    qrKey: "x".repeat(64),
    adminEmail: "admin@example.com",
    adminPasswordHash: "hash",
    internalTokens: ["token-a", "token-b"],
    alertThrottle: { redSeconds: 60, orangeSeconds: 300, yellowSeconds: 900 },
    fallbackPushUrl: "",
    dashboardOrigin: "",
    rag: { topK: 5 },
    dashboard: {
      jwtTtlMinutes: 15,
      chatbotBaseUrl: "http://chat-bot:3000",
      chatbotInternalToken: "",
    },
    chatbot: {
      provider: "baileys",
      baileysSessionDir: "",
      aiRagBaseUrl: "http://ai-rag:3000",
      internalToken: "token-b",
      contactKeySalt: "x".repeat(16),
    },
  };
}

describe("fromAppConfig (task 4.1 config wiring)", () => {
  test("maps shared AppConfig fields the bot needs", () => {
    const config: ChatBotConfig = fromAppConfig(baseConfig());

    expect(config.env).toBe("test");
    expect(config.port).toBe(3120);
    expect(config.logLevel).toBe("info");
    expect(config.databaseUrl).toBe(
      "postgres://chatcap:test@localhost:5432/chatcap_test"
    );
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.chatbot).toEqual({
      provider: "baileys",
      baileysSessionDir: "",
      aiRagBaseUrl: "http://ai-rag:3000",
      internalToken: "token-b",
      contactKeySalt: "x".repeat(16),
    });
  });

  test("exposes the geo provider selection for jurisdiction onboarding", () => {
    const config = fromAppConfig(baseConfig());
    expect(config.geo.provider).toBe("none");
  });
});
