import { loadConfig } from "@chatcap/config";
import { createLogger } from "@chatcap/telemetry";
import { assertVectorIndexPresent } from "@chatcap/db-schema";
import Redis from "ioredis";
import { Pool } from "pg";

import { createApp } from "./app";
import { fromAppConfig } from "./config";
import { runBootChecks } from "./boot";

/**
 * Composition root (task 3.1 scaffold): validates env via the shared config
 * package, wires pg/redis, asserts the HNSW vector index before accepting
 * queries (REQ-RAG-2), and boots the HTTP app. The RAG pipeline itself is
 * wired here in task 3.5 (classify → retrieve → generate → gate); until then
 * the service serves health/readiness only. Untested by design — all logic
 * lives in tested modules; this file only glues them.
 */

const config = fromAppConfig(loadConfig());
const logger = createLogger({ level: config.logLevel });

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });

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
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
