import type { AlertLevel } from "@chatcap/shared-types";
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
  /** Fallback push endpoint (REQ-ALERT-4); empty = not configured. */
  fallbackPushUrl: string;
  /** Allowed Socket.io origin for the dashboard; empty = same-origin only. */
  dashboardOrigin: string;
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
    fallbackPushUrl: config.fallbackPushUrl,
    dashboardOrigin: config.dashboardOrigin,
  };
}

/**
 * Per-level throttle window in milliseconds (task 2.2): the unit the Redis
 * throttle store operates in. Red repeats are gated for 60s, orange 5min,
 * yellow 15min by default — env-overridable via ALERT_THROTTLE_*_SECONDS.
 */
export function throttleWindowMsFor(
  config: NotificationsConfig
): (level: AlertLevel) => number {
  return (level) => {
    switch (level) {
      case "red":
        return config.alertThrottle.redSeconds * 1000;
      case "orange":
        return config.alertThrottle.orangeSeconds * 1000;
      case "yellow":
        return config.alertThrottle.yellowSeconds * 1000;
    }
  };
}
