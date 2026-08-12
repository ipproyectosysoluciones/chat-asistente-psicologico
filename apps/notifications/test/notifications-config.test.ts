import { describe, expect, it } from "vitest";

import type { AlertLevel } from "@chatcap/shared-types";
import { loadConfig, type AppConfig } from "@chatcap/config";

import { fromAppConfig, throttleWindowMsFor, type NotificationsConfig } from "../src/config";

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
    CHATBOT_INTERNAL_TOKEN: "notif-token-b",
    CONTACT_KEY_SALT: "x".repeat(16),
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
      alertThrottle: { redSeconds: 60, orangeSeconds: 300, yellowSeconds: 900 },
      fallbackPushUrl: "",
      dashboardOrigin: "",
    });
  });

  it("uses the default port when PORT is absent", () => {
    const appConfig: AppConfig = loadConfig(fullEnv({ PORT: "3000" }));
    const config: NotificationsConfig = fromAppConfig(appConfig);
    expect(config.port).toBe(3000);
  });

  it("maps per-level throttle windows from the shared config", () => {
    const appConfig: AppConfig = loadConfig(
      fullEnv({
        ALERT_THROTTLE_RED_SECONDS: "45",
        ALERT_THROTTLE_ORANGE_SECONDS: "240",
        ALERT_THROTTLE_YELLOW_SECONDS: "720",
      })
    );
    const config: NotificationsConfig = fromAppConfig(appConfig);
    expect(config.alertThrottle).toEqual({
      redSeconds: 45,
      orangeSeconds: 240,
      yellowSeconds: 720,
    });
  });

  it("maps the fallback push URL (empty when unset)", () => {
    const withoutUrl = fromAppConfig(loadConfig(fullEnv()));
    expect(withoutUrl.fallbackPushUrl).toBe("");

    const withUrl = fromAppConfig(
      loadConfig(fullEnv({ FALLBACK_PUSH_URL: "https://hooks.example.test/alert" }))
    );
    expect(withUrl.fallbackPushUrl).toBe("https://hooks.example.test/alert");
  });

  it("maps the dashboard Socket.io origin (empty = same-origin only)", () => {
    expect(fromAppConfig(loadConfig(fullEnv())).dashboardOrigin).toBe("");

    const withOrigin = fromAppConfig(
      loadConfig(fullEnv({ DASHBOARD_ORIGIN: "https://dashboard.example.test" }))
    );
    expect(withOrigin.dashboardOrigin).toBe("https://dashboard.example.test");
  });
});

describe("throttleWindowMsFor", () => {
  it("maps each level to its throttle window in milliseconds", () => {
    const config = fromAppConfig(
      loadConfig(fullEnv({ ALERT_THROTTLE_RED_SECONDS: "45" }))
    );
    const windowMs = throttleWindowMsFor(config);
    expect(windowMs("red" as AlertLevel)).toBe(45_000);
    expect(windowMs("orange" as AlertLevel)).toBe(300_000);
    expect(windowMs("yellow" as AlertLevel)).toBe(900_000);
  });
});
