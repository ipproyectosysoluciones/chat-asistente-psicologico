import type { GateThresholds } from "@chatcap/shared-types";
import type { AppConfig } from "@chatcap/config";

/**
 * ai-rag service config, derived from the shared zod-validated AppConfig
 * (task 3.1 config wiring). No service-local env parsing: boot fails fast
 * with the shared ConfigError when a var is missing.
 */

export interface AiRagConfig {
  env: "development" | "production" | "test";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl: string;
  redisUrl: string;
  internalTokens: string[];
  openAiApiKey: string;
  /** Kill switch: when false the pipeline never emits LLM output (REQ-CHATBOT-2). */
  aiEmissionEnabled: boolean;
  llm: {
    chatModel: string;
    nliModel: string;
    embeddingModel: string;
  };
  gate: GateThresholds;
  rag: {
    /** Top-k chunks retrieved per query (REQ-RAG-2/3). */
    topK: number;
  };
}

export function fromAppConfig(config: AppConfig): AiRagConfig {
  return {
    env: config.env,
    port: config.port,
    logLevel: config.logLevel,
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    internalTokens: config.internalTokens,
    openAiApiKey: config.openAiApiKey,
    aiEmissionEnabled: config.aiEmissionEnabled,
    llm: {
      chatModel: config.llm.chatModel,
      nliModel: config.llm.nliModel,
      embeddingModel: config.llm.embeddingModel,
    },
    gate: {
      cosineEmit: config.gate.cosineEmit,
      cosineRetry: config.gate.cosineRetry,
      maxRetries: config.gate.maxRetries,
      nliEnabled: config.gate.nliEnabled,
    },
    rag: {
      topK: config.rag.topK,
    },
  };
}
