import type { AppConfig } from "./schema";

/**
 * Abstraction over where master key material comes from (design §6.2, ADR-005).
 * `EnvKeyProvider` is the pilot implementation; production swaps in a
 * Vault/KMS-backed provider — configuration-only change.
 *
 * Key material is NEVER stored: per-version keys are derived from the master
 * secret via HKDF-SHA256 with the per-version salt (REQ-KEY-1).
 */
export interface KeyProvider {
  getMasterSecret(): Promise<Buffer>;
}

/** Pilot implementation: reads the master secret from the validated env. */
export class EnvKeyProvider implements KeyProvider {
  private readonly masterSecret: string;

  constructor(masterSecret: string) {
    this.masterSecret = masterSecret;
  }

  async getMasterSecret(): Promise<Buffer> {
    return Buffer.from(this.masterSecret, "utf8");
  }
}

/** Convenience factory wired from a validated AppConfig. */
export function envKeyProviderFromConfig(config: AppConfig): EnvKeyProvider {
  return new EnvKeyProvider(config.cryptoMasterSecret);
}
