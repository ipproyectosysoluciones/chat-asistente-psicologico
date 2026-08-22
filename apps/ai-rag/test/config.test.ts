import { describe, expect, test } from "vitest";

import type { AppConfig } from "@chatcap/config";

import { fromAppConfig, type AiRagConfig } from "../src/config";

/**
 * Service-local config wiring (task 3.1): the ai-rag service derives its
 * config from the shared zod-validated AppConfig — no local env parsing so
 * boot fails fast with the shared ConfigError when a var is missing.
 */

function baseConfig(): AppConfig {
  return {
    env: "test",
    port: 3110,
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

describe("fromAppConfig (task 3.1 config wiring)", () => {
  test("maps shared AppConfig fields the pipeline needs", () => {
    const config: AiRagConfig = fromAppConfig(baseConfig());

    expect(config.env).toBe("test");
    expect(config.port).toBe(3110);
    expect(config.logLevel).toBe("info");
    expect(config.databaseUrl).toBe(
      "postgres://chatcap:test@localhost:5432/chatcap_test"
    );
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.openAiApiKey).toBe("sk-test");
    expect(config.internalTokens).toEqual(["token-a", "token-b"]);
    expect(config.gate).toEqual({
      cosineEmit: 0.85,
      cosineRetry: 0.75,
      maxRetries: 1,
      nliEnabled: true,
    });
    expect(config.llm).toEqual({
      chatModel: "gpt-4o",
      nliModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
    });
    expect(config.rag).toEqual({ topK: 5 });
  });
});
