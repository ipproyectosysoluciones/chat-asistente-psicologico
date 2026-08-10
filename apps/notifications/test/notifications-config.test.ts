import { describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "@chatcap/config";

import { fromAppConfig, type NotificationsConfig } from "../src/config";

/**
 * Config wiring (task 2.1 AC): the notifications service derives its own
 * config from the shared zod-validated AppConfig so boot fails fast on a
 * missing var and no service-local env parsing can drift.
 */
function fullEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "debug",
    PORT: "4010",
    DATABASE_URL: "postgres://chatcap:secret@127.0.0.1:5432/chatcap",
    REDIS_URL: "redis://127.0.0.1:6379",
    OPENAI_API_KEY: "sk-test-123",
    CRYPTO_MASTER_SECRET: "master-secret-that-is-longer-than-32-chars",
    JWT_SECRET: "jwt-secret-that-is-longer-than-32-chars",
    QR_KEY: "qr-key-that-is-longer-than-32-chars",
    ADMIN_EMAIL: "admin@chatcap.test",
    ADMIN_PASSWORD_HASH: "hash-test",
    X_INTERNAL_TOKENS: "notif-token-a, notif-token-b",
    ...overrides,
  };
}

describe("fromAppConfig (config wiring)", () => {
  it("maps port, urls, tokens and log level from the validated env", () => {
    const appConfig: AppConfig = loadConfig(fullEnv());
    const config: NotificationsConfig = fromAppConfig(appConfig);
    expect(config).toEqual({
      env: "test",
      port: 4010,
      logLevel: "debug",
      databaseUrl: "postgres://chatcap:secret@127.0.0.1:5432/chatcap",
      redisUrl: "redis://127.0.0.1:6379",
      internalTokens: ["notif-token-a", "notif-token-b"],
    });
  });

  it("uses the default port when PORT is absent", () => {
    const appConfig: AppConfig = loadConfig(fullEnv({ PORT: "3000" }));
    const config: NotificationsConfig = fromAppConfig(appConfig);
    expect(config.port).toBe(3000);
  });
});
