import { z } from "zod";

import type { GateThresholds } from "@chatcap/shared-types";

/**
 * Zod-validated environment schema (design §6.2). Every variable required by
 * the pilot is declared here so boot fails fast with a precise message.
 * Values in `.env.example` are placeholders only — no secrets in code.
 */

const booleanFromEnv = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((value) => value === "true");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    OPENAI_API_KEY: z.string().min(1),
    AI_EMISSION_ENABLED: booleanFromEnv("true"),

    // Model swap is configuration-only (design §8, proposal assumption 6):
    // the main chat model is ALWAYS used at temperature 0 (REQ-RAG-1), the
    // NLI/classification model is the cheap side-task model (REQ-RAG-7).
    LLM_CHAT_MODEL: z.string().min(1).default("gpt-4o"),
    LLM_NLI_MODEL: z.string().min(1).default("gpt-4o-mini"),
    EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),

    // Master key material: min 32 chars; keys are DERIVED from this, never stored.
    CRYPTO_MASTER_SECRET: z.string().min(32),
    JWT_SECRET: z.string().min(32),
    QR_KEY: z.string().min(32),

    ADMIN_EMAIL: z.email(),
    ADMIN_PASSWORD_HASH: z.string().min(1),

    // Service-to-service auth over the private Docker network.
    X_INTERNAL_TOKENS: z
      .string()
      .min(1)
      .transform((value) =>
        value
          .split(",")
          .map((token) => token.trim())
          .filter((token) => token.length > 0)
      ),

    // Coherence-gate thresholds (calibrated on pilot data during verify).
    GATE_COSINE_EMIT: z.coerce.number().min(0).max(1).default(0.85),
    GATE_COSINE_RETRY: z.coerce.number().min(0).max(1).default(0.75),
    GATE_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
    GATE_NLI_ENABLED: booleanFromEnv("true"),

    // RAG pipeline tuning: top-k chunks retrieved per query by the ai-rag
    // service. Calibrated during verify (design §5.1); default 5.
    RAG_TOP_K: z.coerce.number().int().min(1).max(50).default(5),

    // Alert push throttle windows per severity (REQ-ALERT-5): repeats within
    // the window are deduplicated/throttled, not pushed again.
    ALERT_THROTTLE_RED_SECONDS: z.coerce.number().int().positive().default(60),
    ALERT_THROTTLE_ORANGE_SECONDS: z.coerce.number().int().positive().default(300),
    ALERT_THROTTLE_YELLOW_SECONDS: z.coerce.number().int().positive().default(900),

    // Fallback alert push endpoint (REQ-ALERT-4): when the Socket.io push
    // cannot be confirmed, the PII-stripped payload is POSTed here (Telegram
    // bot API or internal webhook). Empty = no fallback configured.
    FALLBACK_PUSH_URL: z.string().default(""),

    // Allowed origin for the supervisor dashboard's Socket.io connections.
    // Empty = same-origin only (CORS disabled) — the pilot serves dashboard
    // and notifications behind the same Caddy TLS origin.
    DASHBOARD_ORIGIN: z.string().default(""),

    // Geolocation: maxmind | ipstack | none (none = conservative default).
    GEOIP_PROVIDER: z.enum(["maxmind", "ipstack", "none"]).default("none"),
    MAXMIND_DB_PATH: z.string().default(""),
    IPSTACK_API_KEY: z.string().default(""),
  })
  .superRefine((data, ctx) => {
    if (data.GATE_COSINE_EMIT <= data.GATE_COSINE_RETRY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GATE_COSINE_EMIT"],
        message: `GATE_COSINE_EMIT (${data.GATE_COSINE_EMIT}) must be greater than GATE_COSINE_RETRY (${data.GATE_COSINE_RETRY})`,
      });
    }
  });

export type ParsedEnv = z.infer<typeof envSchema>;

export interface ConfigIssue {
  path: string;
  message: string;
}

/** Thrown by `loadConfig` when the environment is incomplete or invalid. */
export class ConfigError extends Error {
  readonly code = "CONFIG_ERROR" as const;
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
    super(`Invalid environment configuration. Fix the following before boot:\n${lines.join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface AppConfig {
  env: "development" | "production" | "test";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  port: number;
  databaseUrl: string;
  redisUrl: string;
  openAiApiKey: string;
  aiEmissionEnabled: boolean;
  cryptoMasterSecret: string;
  jwtSecret: string;
  qrKey: string;
  adminEmail: string;
  adminPasswordHash: string;
  internalTokens: string[];
  gate: GateThresholds;
  llm: {
    chatModel: string;
    nliModel: string;
    embeddingModel: string;
  };
  geo: {
    provider: "maxmind" | "ipstack" | "none";
    maxmindDbPath?: string;
    ipstackApiKey?: string;
  };
  alertThrottle: {
    redSeconds: number;
    orangeSeconds: number;
    yellowSeconds: number;
  };
  fallbackPushUrl: string;
  /** Allowed Socket.io origin; empty = same-origin only. */
  dashboardOrigin: string;
  /** RAG pipeline tuning (ai-rag service, task 3.1): top-k retrieval depth. */
  rag: {
    topK: number;
  };
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
    throw new ConfigError(issues);
  }

  const parsed = result.data;
  return {
    env: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    openAiApiKey: parsed.OPENAI_API_KEY,
    aiEmissionEnabled: parsed.AI_EMISSION_ENABLED,
    cryptoMasterSecret: parsed.CRYPTO_MASTER_SECRET,
    jwtSecret: parsed.JWT_SECRET,
    qrKey: parsed.QR_KEY,
    adminEmail: parsed.ADMIN_EMAIL,
    adminPasswordHash: parsed.ADMIN_PASSWORD_HASH,
    internalTokens: parsed.X_INTERNAL_TOKENS,
    gate: {
      cosineEmit: parsed.GATE_COSINE_EMIT,
      cosineRetry: parsed.GATE_COSINE_RETRY,
      maxRetries: parsed.GATE_MAX_RETRIES,
      nliEnabled: parsed.GATE_NLI_ENABLED,
    },
    llm: {
      chatModel: parsed.LLM_CHAT_MODEL,
      nliModel: parsed.LLM_NLI_MODEL,
      embeddingModel: parsed.EMBEDDING_MODEL,
    },
    geo: {
      provider: parsed.GEOIP_PROVIDER,
      maxmindDbPath: parsed.MAXMIND_DB_PATH || undefined,
      ipstackApiKey: parsed.IPSTACK_API_KEY || undefined,
    },
    alertThrottle: {
      redSeconds: parsed.ALERT_THROTTLE_RED_SECONDS,
      orangeSeconds: parsed.ALERT_THROTTLE_ORANGE_SECONDS,
      yellowSeconds: parsed.ALERT_THROTTLE_YELLOW_SECONDS,
    },
    fallbackPushUrl: parsed.FALLBACK_PUSH_URL,
    dashboardOrigin: parsed.DASHBOARD_ORIGIN,
    rag: { topK: parsed.RAG_TOP_K },
  };
}
