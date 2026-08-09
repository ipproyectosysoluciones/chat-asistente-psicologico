import { describe, expect, test } from "vitest";

import { ConfigError, EnvKeyProvider, loadConfig, type AppConfig } from "../src/index";
import type { KeyProvider } from "../src/index";

const MIN = "x".repeat(64);

function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    OPENAI_API_KEY: "sk-test",
    CRYPTO_MASTER_SECRET: MIN,
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD_HASH: "$2b$12$abcdefghijklmnopqrstuv",
    JWT_SECRET: MIN,
    QR_KEY: MIN,
    X_INTERNAL_TOKENS: "token-a,token-b",
    ...overrides,
  };
}

function expectConfigError(env: Record<string, string>, expectedVar: string): void {
  try {
    loadConfig(env);
    expect.unreachable(`loadConfig should have thrown for ${expectedVar}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain(expectedVar);
    expect(message).toMatch(/DATABASE_URL|REDIS_URL|CRYPTO_MASTER_SECRET|JWT_SECRET|QR_KEY|OPENAI_API_KEY|ADMIN_|X_INTERNAL_TOKENS|AI_EMISSION_ENABLED|GATE_|GEOIP/);
  }
}

describe("loadConfig: fail-fast on missing/invalid required vars", () => {
  test("missing DATABASE_URL fails with a clear message naming the var", () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    expectConfigError(env, "DATABASE_URL");
  });

  test("missing REDIS_URL fails with the var name", () => {
    const env = validEnv();
    delete env.REDIS_URL;
    expectConfigError(env, "REDIS_URL");
  });

  test("missing OPENAI_API_KEY fails with the var name", () => {
    const env = validEnv();
    delete env.OPENAI_API_KEY;
    expectConfigError(env, "OPENAI_API_KEY");
  });

  test("missing CRYPTO_MASTER_SECRET fails with the var name", () => {
    const env = validEnv();
    delete env.CRYPTO_MASTER_SECRET;
    expectConfigError(env, "CRYPTO_MASTER_SECRET");
  });

  test("short CRYPTO_MASTER_SECRET (< 32 chars) fails", () => {
    expectConfigError(validEnv({ CRYPTO_MASTER_SECRET: "tooshort" }), "CRYPTO_MASTER_SECRET");
  });

  test("missing X_INTERNAL_TOKENS fails with the var name", () => {
    const env = validEnv();
    delete env.X_INTERNAL_TOKENS;
    expectConfigError(env, "X_INTERNAL_TOKENS");
  });

  test("non-boolean AI_EMISSION_ENABLED fails", () => {
    expectConfigError(validEnv({ AI_EMISSION_ENABLED: "yes" }), "AI_EMISSION_ENABLED");
  });

  test("invalid ADMIN_EMAIL fails", () => {
    expectConfigError(validEnv({ ADMIN_EMAIL: "not-an-email" }), "ADMIN_EMAIL");
  });

  test("out-of-range gate threshold fails", () => {
    expectConfigError(validEnv({ GATE_COSINE_EMIT: "1.7" }), "GATE_COSINE_EMIT");
  });

  test("emit threshold not greater than retry threshold fails", () => {
    expectConfigError(
      validEnv({ GATE_COSINE_EMIT: "0.70", GATE_COSINE_RETRY: "0.75" }),
      "GATE_COSINE_EMIT"
    );
  });

  test("invalid GEOIP_PROVIDER fails", () => {
    expectConfigError(validEnv({ GEOIP_PROVIDER: "google" }), "GEOIP_PROVIDER");
  });
});

describe("loadConfig: valid env parses with defaults", () => {
  test("parses a complete env into an AppConfig", () => {
    const config: AppConfig = loadConfig(validEnv());
    expect(config.databaseUrl).toBe("postgres://u:p@localhost:5432/db");
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.openAiApiKey).toBe("sk-test");
    expect(config.cryptoMasterSecret).toBe(MIN);
    expect(config.internalTokens).toEqual(["token-a", "token-b"]);
  });

  test("gate thresholds default to 0.85/0.75/1 with NLI enabled", () => {
    const config = loadConfig(validEnv());
    expect(config.gate.cosineEmit).toBe(0.85);
    expect(config.gate.cosineRetry).toBe(0.75);
    expect(config.gate.maxRetries).toBe(1);
    expect(config.gate.nliEnabled).toBe(true);
  });

  test("explicit gate thresholds are honored", () => {
    const config = loadConfig(
      validEnv({
        GATE_COSINE_EMIT: "0.9",
        GATE_COSINE_RETRY: "0.8",
        GATE_MAX_RETRIES: "2",
        GATE_NLI_ENABLED: "false",
      })
    );
    expect(config.gate.cosineEmit).toBe(0.9);
    expect(config.gate.cosineRetry).toBe(0.8);
    expect(config.gate.maxRetries).toBe(2);
    expect(config.gate.nliEnabled).toBe(false);
  });

  test("AI_EMISSION_ENABLED defaults true and parses false", () => {
    expect(loadConfig(validEnv()).aiEmissionEnabled).toBe(true);
    expect(loadConfig(validEnv({ AI_EMISSION_ENABLED: "false" })).aiEmissionEnabled).toBe(false);
  });

  test("internal tokens are trimmed and empties dropped", () => {
    const config = loadConfig(validEnv({ X_INTERNAL_TOKENS: " a , b ,, c " }));
    expect(config.internalTokens).toEqual(["a", "b", "c"]);
  });

  test("LLM models default to gpt-4o / gpt-4o-mini / text-embedding-3-small", () => {
    const config = loadConfig(validEnv());
    expect(config.llm.chatModel).toBe("gpt-4o");
    expect(config.llm.nliModel).toBe("gpt-4o-mini");
    expect(config.llm.embeddingModel).toBe("text-embedding-3-small");
  });

  test("LLM models are overridable via env (model swap config-only)", () => {
    const config = loadConfig(
      validEnv({
        LLM_CHAT_MODEL: "gpt-4o-mini",
        LLM_NLI_MODEL: "gpt-4.1-mini",
        EMBEDDING_MODEL: "text-embedding-3-large",
      })
    );
    expect(config.llm.chatModel).toBe("gpt-4o-mini");
    expect(config.llm.nliModel).toBe("gpt-4.1-mini");
    expect(config.llm.embeddingModel).toBe("text-embedding-3-large");
  });

  test("geo provider defaults to none with empty keys", () => {
    const config = loadConfig(validEnv());
    expect(config.geo.provider).toBe("none");
  });

  test("geo provider accepts maxmind with a db path", () => {
    const config = loadConfig(validEnv({ GEOIP_PROVIDER: "maxmind", MAXMIND_DB_PATH: "/data/GeoLite2.mmdb" }));
    expect(config.geo.provider).toBe("maxmind");
    expect(config.geo.maxmindDbPath).toBe("/data/GeoLite2.mmdb");
  });
});

describe("KeyProvider: EnvKeyProvider pilot implementation", () => {
  test("returns the master secret as a Buffer", async () => {
    const provider: KeyProvider = new EnvKeyProvider(MIN);
    const secret = await provider.getMasterSecret();
    expect(secret).toBeInstanceOf(Buffer);
    expect(secret.toString("utf8")).toBe(MIN);
  });

  test("round-trips the exact bytes of the configured secret", async () => {
    const provider = new EnvKeyProvider("s3cr3t-value-0123456789abcdef");
    const secret = await provider.getMasterSecret();
    expect(secret.equals(Buffer.from("s3cr3t-value-0123456789abcdef", "utf8"))).toBe(true);
  });
});
