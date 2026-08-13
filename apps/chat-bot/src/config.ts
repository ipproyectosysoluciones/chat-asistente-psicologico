import type { AppConfig } from "@chatcap/config";

/**
 * chat-bot service config, derived from the shared zod-validated AppConfig
 * (task 4.1 config wiring). No service-local env parsing: boot fails fast
 * with the shared ConfigError when a var is missing.
 */

export interface ChatBotConfig {
  env: "development" | "production" | "test";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl: string;
  redisUrl: string;
  /** Emission kill switch (AI_EMISSION_ENABLED): false → human-only. */
  aiEmissionEnabled: boolean;
  chatbot: {
    provider: "baileys" | "meta";
    baileysSessionDir: string;
    metaAccessToken?: string;
    metaPhoneNumberId?: string;
    aiRagBaseUrl: string;
    internalToken: string;
    contactKeySalt: string;
  };
  geo: {
    provider: "maxmind" | "ipstack" | "none";
    maxmindDbPath?: string;
    ipstackApiKey?: string;
  };
}

export function fromAppConfig(config: AppConfig): ChatBotConfig {
  return {
    env: config.env,
    port: config.port,
    logLevel: config.logLevel,
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    aiEmissionEnabled: config.aiEmissionEnabled,
    chatbot: {
      provider: config.chatbot.provider,
      baileysSessionDir: config.chatbot.baileysSessionDir,
      metaAccessToken: config.chatbot.metaAccessToken,
      metaPhoneNumberId: config.chatbot.metaPhoneNumberId,
      aiRagBaseUrl: config.chatbot.aiRagBaseUrl,
      internalToken: config.chatbot.internalToken,
      contactKeySalt: config.chatbot.contactKeySalt,
    },
    geo: {
      provider: config.geo.provider,
      maxmindDbPath: config.geo.maxmindDbPath,
      ipstackApiKey: config.geo.ipstackApiKey,
    },
  };
}
