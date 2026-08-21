import type { AppConfig } from "@chatcap/config";

/**
 * Ingestion service config, derived from the shared zod-validated AppConfig
 * (task 6.1 config wiring). Ingestion is internal: no supervisor-facing JWT
 * endpoints — service-to-service auth is the x-internal-token (shared
 * X_INTERNAL_TOKENS). No service-local env parsing: boot fails fast with the
 * shared ConfigError when a var is incomplete.
 */
export interface IngestionConfig {
  env: "development" | "production" | "test";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl: string;
  internalTokens: readonly string[];
  embeddingModel: string;
  chatModel: string;
  nliModel: string;
  openAiApiKey: string;
  /** Hard cap per chunk passed to the embedding model (token-aware chunking). */
  chunkMaxChars: number;
  chunkMinChars: number;
}

export function fromAppConfig(config: AppConfig): IngestionConfig {
  return {
    env: config.env,
    port: config.port,
    logLevel: config.logLevel,
    databaseUrl: config.databaseUrl,
    internalTokens: config.internalTokens,
    embeddingModel: config.llm.embeddingModel,
    chatModel: config.llm.chatModel,
    nliModel: config.llm.nliModel,
    openAiApiKey: config.openAiApiKey,
    chunkMaxChars: 800,
    chunkMinChars: 500,
  };
}
