import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "../src/schema";

/**
 * Dashboard service config (phase 5, REQ-DASH-1/3): JWT TTL for the
 * supervisor session and the dashboard → chat-bot ingest path. Fields are
 * optional (defaults keep the shared schema backwards-compatible); the
 * ingest token cross-check mirrors CHATBOT_INTERNAL_TOKEN.
 */

function baseEnv(): Record<string, string> {
  return {
    DATABASE_URL: "postgres://u:p@localhost:5432/d",
    REDIS_URL: "redis://localhost:6379",
    OPENAI_API_KEY: "sk-test",
    CRYPTO_MASTER_SECRET: "m".repeat(32),
    JWT_SECRET: "j".repeat(32),
    QR_KEY: "q".repeat(32),
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD_HASH: "hash-bcrypt",
    X_INTERNAL_TOKENS: "token-a,token-b",
    CHATBOT_INTERNAL_TOKEN: "token-a",
    CONTACT_KEY_SALT: "pepper".padEnd(16, "x"),
  };
}

describe("dashboard config (design §6.2)", () => {
  it("defaults the JWT TTL to 15 minutes and the ingest path to chat-bot", () => {
    const config = loadConfig(baseEnv());
    expect(config.dashboard.jwtTtlMinutes).toBe(15);
    expect(config.dashboard.chatbotBaseUrl).toBe("http://chat-bot:3000");
    expect(config.dashboard.chatbotInternalToken).toBe("");
  });

  it("reads explicit dashboard env overrides", () => {
    const config = loadConfig({
      ...baseEnv(),
      DASHBOARD_JWT_TTL_MINUTES: "30",
      DASHBOARD_CHATBOT_BASE_URL: "http://127.0.0.1:3001",
      DASHBOARD_CHATBOT_INTERNAL_TOKEN: "token-b",
    });
    expect(config.dashboard.jwtTtlMinutes).toBe(30);
    expect(config.dashboard.chatbotBaseUrl).toBe("http://127.0.0.1:3001");
    expect(config.dashboard.chatbotInternalToken).toBe("token-b");
  });

  it("rejects a dashboard ingest token that is not in X_INTERNAL_TOKENS", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        DASHBOARD_CHATBOT_INTERNAL_TOKEN: "not-in-allowlist",
      })
    ).toThrow(ConfigError);
  });
});
