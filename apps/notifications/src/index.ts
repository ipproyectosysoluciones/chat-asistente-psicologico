import { loadConfig } from "@chatcap/config";
import { createLogger } from "@chatcap/telemetry";
import Redis from "ioredis";
import { Pool } from "pg";

import { createApp } from "./app";
import { fromAppConfig } from "./config";
import { IoredisSubscriber } from "./redis-subscriber";
import { parseTelemetryMessage } from "./telemetry-parser";

/**
 * Composition root (task 2.1 app entry): validates env via the shared config
 * package, wires pg/redis, boots the HTTP app and subscribes to the alert
 * channel. Untested by design — all logic lives in tested modules; this file
 * only glues them. Alert routing consumes `event.payload` from task 2.2 on.
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
});

const server = app.listen(config.port, () => {
  logger.info("notifications service listening", { port: config.port });
});

void subscriber
  .subscribe("telemetry:alert_raised", async (raw) => {
    const event = parseTelemetryMessage(raw);
    if (event === undefined) {
      logger.error("dropped malformed telemetry message", {});
      return;
    }
    logger.debug("received alert event", {
      type: event.type,
      occurredAt: event.occurredAt,
    });
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
