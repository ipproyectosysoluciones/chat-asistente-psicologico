import type { AppConfig } from "@chatcap/config";

/**
 * Dashboard service config, derived from the shared zod-validated AppConfig
 * (task 5.1 config wiring). No service-local env parsing: boot fails fast
 * with the shared ConfigError when a var is missing.
 */

export interface DashboardConfig {
  env: "development" | "production" | "test";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl: string;
  jwt: {
    secret: string;
    /** Access-token TTL in seconds (design §3.3, 15-min pilot default). */
    ttlSeconds: number;
  };
  admin: {
    email: string;
    passwordHash: string;
  };
  internalTokens: string[];
  chatbot: {
    baseUrl: string;
    /** Token for chat-bot's /messages/ingest; "" = ingest disabled. */
    internalToken: string;
  };
  /** Allowed Socket.io origin; empty = same-origin only. */
  dashboardOrigin: string;
}

export function fromAppConfig(config: AppConfig): DashboardConfig {
  return {
    env: config.env,
    port: config.port,
    logLevel: config.logLevel,
    databaseUrl: config.databaseUrl,
    jwt: {
      secret: config.jwtSecret,
      ttlSeconds: config.dashboard.jwtTtlMinutes * 60,
    },
    admin: {
      email: config.adminEmail,
      passwordHash: config.adminPasswordHash,
    },
    internalTokens: config.internalTokens,
    chatbot: {
      baseUrl: config.dashboard.chatbotBaseUrl,
      internalToken: config.dashboard.chatbotInternalToken,
    },
    dashboardOrigin: config.dashboardOrigin,
  };
}
