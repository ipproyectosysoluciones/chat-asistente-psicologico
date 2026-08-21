import { findUserRole, insertAuditEntry } from "@chatcap/db-schema";
import { loadConfig } from "@chatcap/config";
import { createLogger } from "@chatcap/telemetry";
import Redis from "ioredis";
import { Pool } from "pg";
import { Server } from "socket.io";

import { createApp } from "./app";
import { fromAppConfig, throttleWindowMsFor } from "./config";
import { IoredisSubscriber } from "./redis-subscriber";
import { parseTelemetryMessage } from "./telemetry-parser";
import { parseRaiseAlertRequest } from "./raise-alert";
import { routeAlert } from "./alert-router";
import { pgAlertStore, pgAlertLifecycleStore } from "./alert-store";
import { RedisThrottleStore } from "./throttle";
import { buildPushPayload } from "./push-payload";
import { pushAlertWithFallback } from "./alert-pusher";
import { SocketIoPushChannel, attachSupervisorRoom } from "./socket-push";
import { HttpFallbackChannel } from "./http-fallback";
import type { PushChannel } from "./push-channel";

/**
 * Composition root (tasks 2.1–2.3): validates env via the shared config
 * package, wires pg/redis, boots the HTTP app, attaches the Socket.io alert
 * push, subscribes to the alert channel and routes events end to end:
 * telemetry event → dedupe/throttle (router) → Socket.io push → fallback →
 * audit. Untested by design — all logic lives in tested modules; this file
 * only glues them.
 */

const config = fromAppConfig(loadConfig());
const logger = createLogger({ level: config.logLevel });

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
const subscriberRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });

const subscriber = new IoredisSubscriber(subscriberRedis, (error) => {
  logger.error("alert subscriber handler failed", { error: String(error) });
});

const app = createApp({
  logger,
  readiness: {
    database: {
      check: async () => {
        await pool.query("SELECT 1");
      },
    },
    redis: {
      check: async () => {
        await redis.ping();
      },
    },
  },
  // Alert lifecycle endpoints (task 2.4, REQ-ALERT-6): supervisor/admin
  // acknowledge/resolve with RBAC preflight and who/when/why audit.
  lifecycle: {
    logger,
    internalTokens: config.internalTokens,
    store: pgAlertLifecycleStore(pool),
    findUserRole: (userId) => findUserRole(pool, userId),
    audit: async (entry) => {
      await insertAuditEntry(pool, entry);
    },
  },
});

const server = app.listen(config.port, () => {
  logger.info("notifications service listening", { port: config.port });
});

// Alert push: Socket.io to the supervisor dashboard, with the configured
// HTTP/Telegram fallback when delivery cannot be confirmed (REQ-ALERT-4).
// The room is gated by the internal-token handshake and CORS is same-origin
// unless DASHBOARD_ORIGIN is configured.
const io = new Server(server, {
  cors: {
    origin: config.dashboardOrigin === "" ? false : config.dashboardOrigin,
  },
});
attachSupervisorRoom(io, config.internalTokens);

const pushChannels: PushChannel[] = [new SocketIoPushChannel(io)];
if (config.fallbackPushUrl !== "") {
  pushChannels.push(new HttpFallbackChannel(config.fallbackPushUrl));
}

void subscriber
  .subscribe("telemetry:alert_raised", async (raw) => {
    const event = parseTelemetryMessage(raw);
    if (event === undefined) {
      logger.error("dropped malformed telemetry message", {});
      return;
    }
    const request = parseRaiseAlertRequest(event.payload);
    if (request === undefined) {
      logger.error("dropped malformed alert_raised payload", {
        occurredAt: event.occurredAt,
      });
      return;
    }
    await routeAlert(
      {
        alerts: pgAlertStore(pool),
        throttle: new RedisThrottleStore(redis),
        throttleWindowMs: throttleWindowMsFor(config),
        notify: async (routed) => {
          if (routed.kind === "throttled") {
            return;
          }
          await pushAlertWithFallback(
            {
              channels: pushChannels,
              audit: async (entry) => {
                await insertAuditEntry(pool, entry);
              },
              logger,
            },
            buildPushPayload(routed.alert, routed.kind)
          );
        },
      },
      request
    );
  })
  .catch((error: unknown) => {
    logger.error("failed to subscribe to alert channel", {
      error: String(error),
    });
  });

async function shutdown(signal: string): Promise<void> {
  logger.info("shutting down", { signal });
  server.close();
  await subscriber.close();
  await redis.quit();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
