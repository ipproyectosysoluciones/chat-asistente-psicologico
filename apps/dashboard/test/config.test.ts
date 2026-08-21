import { describe, expect, it } from "vitest";

import { loadConfig } from "@chatcap/config";

import { fromAppConfig } from "../src/server/config";

/**
 * Dashboard config (task 5.1): derived from the shared AppConfig like the
 * notifications service — no service-local env parsing, boot fails fast
 * through the shared ConfigError.
 */

describe("fromAppConfig", () => {
  it("derives the dashboard config from the shared AppConfig", () => {
    const app = loadConfig({
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
      DASHBOARD_JWT_TTL_MINUTES: "30",
      DASHBOARD_CHATBOT_BASE_URL: "http://chat-bot:3000",
      DASHBOARD_CHATBOT_INTERNAL_TOKEN: "token-b",
    });
    const config = fromAppConfig(app);

    expect(config.env).toBe("development");
    expect(config.databaseUrl).toBe("postgres://u:p@localhost:5432/d");
    expect(config.jwt).toEqual({ secret: "j".repeat(32), ttlSeconds: 1800 });
    expect(config.admin).toEqual({
      email: "admin@example.com",
      passwordHash: "hash-bcrypt",
    });
    expect(config.chatbot).toEqual({
      baseUrl: "http://chat-bot:3000",
      internalToken: "token-b",
    });
  });
});
