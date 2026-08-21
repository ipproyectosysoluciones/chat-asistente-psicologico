import { insertAuditEntry } from "@chatcap/db-schema";
import { loadConfig } from "@chatcap/config";
import { createLogger } from "@chatcap/telemetry";
import { OpenAiClient } from "@chatcap/llm-client";
import { Pool } from "pg";

import { createApp } from "./app";
import { fromAppConfig } from "./config";
import { embedMany } from "./embedder";
import type { IngestionDeps } from "./ingest-router";
import type { RemovalDeps } from "./removal-router";
import { PgVectorStore } from "./vector-store";

/**
 * Composition root (task 6.1/6.3/6.4/6.6): wires config, pg pool, OpenAiClient,
 * the ingestion router and the manual-removal router. Untested by design — all
 * logic lives in tested modules.
 */

const config = fromAppConfig(loadConfig());
const logger = createLogger({ level: config.logLevel });

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
const vectorStore = new PgVectorStore(pool);
const openAi = OpenAiClient.create({
  openAiApiKey: config.openAiApiKey,
  chatModel: config.chatModel,
  nliModel: config.nliModel,
  embeddingModel: config.embeddingModel,
});

const ingestionDeps: IngestionDeps = {
  logger,
  embed: (chunks) => embedMany(openAi, chunks),
  upsertVectorChunks: (input) => vectorStore.upsertVectorChunks(input),
  searchVectorChunks: (embedding, categories) => vectorStore.searchVectorChunks(embedding, categories),
  revectorizeDocument: (docId) => vectorStore.revectorizeDocument(docId),
  listAlerts: async () => {
    const res = await pool.query("SELECT count(*)::int AS count FROM alerts WHERE status = 'open';");
    return { count: Number(res.rows[0]?.count ?? 0) };
  },
  internalTokens: config.internalTokens,
  chunkMinChars: config.chunkMinChars,
  chunkMaxChars: config.chunkMaxChars,
};

const removalDeps: RemovalDeps = {
  internalTokens: config.internalTokens,
  removeChunk: (docId, chunkIndex) => vectorStore.removeChunk(docId, chunkIndex),
  insertAudit: async (entry) => {
    await insertAuditEntry(pool, {
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      reason: entry.reason,
      meta: entry.meta,
    });
  },
};

const app = createApp({
  logger,
  internalTokens: config.internalTokens,
  ingestion: ingestionDeps,
  removal: removalDeps,
  readiness: {
    database: {
      check: async () => {
        const client = await pool.connect();
        try {
          await client.query("SELECT 1");
        } finally {
          client.release();
        }
      },
    },
  },
});

app.listen(config.port, () => {
  logger.info("ingestion service listening", { port: config.port });
});
