import type { AppConfig } from "@chatcap/config";

/**
 * Notifications service config, derived from the shared zod-validated
 * AppConfig (task 2.1 config wiring). No service-local env parsing: boot
 * fails fast with the shared ConfigError when a var is missing.
 */

export interface NotificationsConfig {
  env: "development" | "production" | "test";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl: string;
  redisUrl: string;
  internalTokens: string[];
  alertThrottle: {
    redSeconds: number;
    orangeSeconds: number;
    yellowSeconds: number;
  };
}

export function fromAppConfig(config: AppConfig): NotificationsConfig {
  return {
    env: config.env,
    port: config.port,
    logLevel: config.logLevel,
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    internalTokens: config.internalTokens,
    alertThrottle: {
      redSeconds: config.alertThrottle.redSeconds,
      orangeSeconds: config.alertThrottle.orangeSeconds,
      yellowSeconds: config.alertThrottle.yellowSeconds,
    },
  };
}
