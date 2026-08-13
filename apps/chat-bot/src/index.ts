import { loadConfig } from "@chatcap/config";
import { createLogger, RedisEventEmitter } from "@chatcap/telemetry";
import { Pool } from "pg";
import Redis from "ioredis";

import { HttpAiRagClient } from "./ai-rag-client";
import { createApp } from "./app";
import { createBot } from "./bot";
import { fromAppConfig } from "./config";
import { PostgresChatDatabase } from "./database/postgres";
import { createCrisisFlow } from "./flow/crisis";
import { createJurisdictionFlow } from "./flow/jurisdiction";
import { createMenuFlow } from "./flow/menu";
import { createSessionFlow } from "./flow/session";
import { createTopicFlow } from "./flow/topic";
import { createGeoResolver } from "./geo/factory";
import { createProvider } from "./provider/factory";
import { createPurgeCron } from "./purge";

/**
 * Composition root (task 4.1): validates env via the shared config package,
 * wires pg + provider + flow + ai-rag client, and boots the bot. Untested by
 * design — all logic lives in tested modules; this file only glues them.
 * In test/local-dev set CHATBOT_PROVIDER=mock to run without a WhatsApp
 * session.
 */

const config = fromAppConfig(loadConfig());
const logger = createLogger({ level: config.logLevel });

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on("error", (error) => {
  logger.error("postgres pool error", { error: String(error) });
});

const aiRag = new HttpAiRagClient({
  baseUrl: config.chatbot.aiRagBaseUrl,
  internalToken: config.chatbot.internalToken,
});

// PII-free alert events over Redis pub-sub (design §2.2, task 4.5). A
// failing publish must never drop a crisis response silently — the emitter
// surfaces the error so the bot falls back to human takeover.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
const emitter = new RedisEventEmitter(redis, (error) => {
  logger.error("telemetry publish failed", { error: String(error) });
});

const app = createApp({
  logger,
  readiness: {
    database: {
      check: async () => {
        await pool.query("SELECT 1");
      },
    },
    aiRag: {
      check: async () => {
        if (!(await aiRag.health())) {
          throw new Error("ai-rag unhealthy");
        }
      },
    },
  },
});

// Anonymous purge job (task 4.8, REQ-CHATBOT-9): 24–48 h cleanup contract via
// the db-schema batched purge repository; HC rows are untouched.
const purgeCron = createPurgeCron({ db: pool, logger });

const bot = createBot(
  {
    flow: createSessionFlow({
      menu: createMenuFlow(),
      crisis: createCrisisFlow(),
      jurisdiction: createJurisdictionFlow({
        geoResolver: createGeoResolver(config.geo),
      }),
      topic: createTopicFlow(),
    }),
    provider: createProvider({
      provider: config.chatbot.provider,
      baileysSessionDir: config.chatbot.baileysSessionDir,
      metaAccessToken: config.chatbot.metaAccessToken,
      metaPhoneNumberId: config.chatbot.metaPhoneNumberId,
      useMock: config.env === "test",
    }),
    database: new PostgresChatDatabase(pool),
  },
  {
    logger,
    contactKeySalt: config.chatbot.contactKeySalt,
    emitter,
    aiRag,
    aiEmissionEnabled: config.aiEmissionEnabled,
  }
);

async function boot(): Promise<void> {
  await bot.start();
  purgeCron.start();
  app.listen(config.port, () => {
    logger.info("chat-bot service listening", { port: config.port });
  });
}

boot().catch((error: unknown) => {
  logger.error("chat-bot boot failed; refusing to serve", {
    error: String(error),
  });
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  logger.info("shutting down", { signal });
  purgeCron.stop();
  await bot.stop();
  await pool.end();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").catch((error: unknown) => {
    logger.error("shutdown failed", { error: String(error) });
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  void shutdown("SIGINT").catch((error: unknown) => {
    logger.error("shutdown failed", { error: String(error) });
    process.exit(1);
  });
});
