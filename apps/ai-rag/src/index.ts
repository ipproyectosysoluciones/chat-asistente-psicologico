import { loadConfig } from "@chatcap/config";
import { createLogger, RedisEventEmitter } from "@chatcap/telemetry";
import { assertVectorIndexPresent } from "@chatcap/db-schema";
import { OpenAiClient } from "@chatcap/llm-client";
import Redis from "ioredis";
import { Pool } from "pg";

import { createApp } from "./app";
import { fromAppConfig } from "./config";
import { runBootChecks } from "./boot";
import { runRagPipeline } from "./pipeline";

/**
 * Composition root (task 3.1/3.5): validates env via the shared config
 * package, wires pg/redis, asserts the HNSW vector index before accepting
 * queries (REQ-RAG-2), and boots the HTTP app with the full RAG pipeline
 * (classify → retrieve → generate → gate). Untested by design — all logic
 * lives in tested modules; this file only glues them.
 */

const config = fromAppConfig(loadConfig());
const logger = createLogger({ level: config.logLevel });

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });

// Dependency error handlers: log and keep serving in degraded mode — the
// readiness probe reports not-ready so traffic is routed away.
pool.on("error", (error) => {
  logger.error("postgres pool error", { error: String(error) });
});
redis.on("error", (error) => {
  logger.error("redis error", { error: String(error) });
});

// Alert/trace events go over Redis pub-sub (design §2.2); a failing publish
// is logged, never allowed to take the chat response down.
const emitter = new RedisEventEmitter(redis, (error) => {
  logger.error("telemetry publish failed", { error: String(error) });
});

const client = OpenAiClient.create({
  openAiApiKey: config.openAiApiKey,
  chatModel: config.llm.chatModel,
  nliModel: config.llm.nliModel,
  embeddingModel: config.llm.embeddingModel,
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
  rag: {
    logger,
    internalTokens: config.internalTokens,
    pipeline: (input) =>
      runRagPipeline(
        {
          client,
          db: pool,
          gate: config.gate,
          topK: config.rag.topK,
          models: {
            chat: config.llm.chatModel,
            nli: config.llm.nliModel,
            embedding: config.llm.embeddingModel,
          },
          emitter,
          aiEmissionEnabled: config.aiEmissionEnabled,
          logger,
        },
        input
      ),
  },
});

void runBootChecks({
  logger,
  assertIndex: () => assertVectorIndexPresent(pool),
})
  .then(() => {
    app.listen(config.port, () => {
      logger.info("ai-rag service listening", { port: config.port });
    });
  })
  .catch((error: unknown) => {
    logger.error("ai-rag boot failed; refusing to serve queries", {
      error: String(error),
    });
    process.exit(1);
  });

async function shutdown(signal: string): Promise<void> {
  logger.info("shutting down", { signal });
  await redis.quit();
  await pool.end();
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
