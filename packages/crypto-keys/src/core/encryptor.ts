import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { KeyProvider } from "@chatcap/config";
import type { EncryptedPayload } from "@chatcap/shared-types";

import {
  AES_KEY_LENGTH,
  HKDF_INFO_AES,
  HKDF_INFO_HMAC,
  HMAC_KEY_LENGTH,
  IV_LENGTH,
  deriveKey,
} from "./derive";
import type { KeyMaterialProvider } from "./key-material";

/**
 * AES-256-CBC encrypt-then-MAC (REQ-KEY-1, REQ-CONSENT-3/4, design §6.1).
 * The HMAC covers iv || ciphertext; verification is constant-time; derived
 * keys exist only on the call stack, never stored or logged.
 */
export interface Encryptor {
  encrypt(plaintext: Buffer, keyVersion: number): Promise<EncryptedPayload>;
  decrypt(payload: EncryptedPayload): Promise<Buffer>;
}

/** Raised when the HMAC does not match (tampered or corrupted data). */
export class HmacVerificationError extends Error {
  readonly code = "hmac_verification_failed" as const;

  constructor(keyVersion: number) {
    super(
      `HMAC verification failed for payload with key_version ${keyVersion} (tampered or corrupted data)`
    );
    this.name = "HmacVerificationError";
  }
}

/** Node `crypto` implementation of the Encryptor interface. */
export class AesCbcEncryptor implements Encryptor {
  constructor(
    private readonly masterKeyProvider: KeyProvider,
    private readonly keyMaterial: KeyMaterialProvider
  ) {}

  private async derive(
    master: Buffer,
    salt: Buffer
  ): Promise<{ aesKey: Buffer; hmacKey: Buffer }> {
    const aesKey = deriveKey(master, salt, HKDF_INFO_AES, AES_KEY_LENGTH);
    const hmacKey = deriveKey(master, salt, HKDF_INFO_HMAC, HMAC_KEY_LENGTH);
    return { aesKey, hmacKey };
  }

  async encrypt(
    plaintext: Buffer,
    keyVersion: number
  ): Promise<EncryptedPayload> {
    const master = await this.masterKeyProvider.getMasterSecret();
    const salt = await this.keyMaterial.getSalt(keyVersion);
    const { aesKey, hmacKey } = await this.derive(master, salt);

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-cbc", aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const hmac = createHmac("sha256", hmacKey).update(iv).update(ciphertext).digest();

    return { keyVersion, iv, ciphertext, hmac };
  }

  async decrypt(payload: EncryptedPayload): Promise<Buffer> {
    const master = await this.masterKeyProvider.getMasterSecret();
    const salt = await this.keyMaterial.getSalt(payload.keyVersion);
    const { aesKey, hmacKey } = await this.derive(master, salt);

    const expected = createHmac("sha256", hmacKey)
      .update(payload.iv)
      .update(payload.ciphertext)
      .digest();
    if (
      expected.length !== payload.hmac.length ||
      !timingSafeEqual(expected, payload.hmac)
    ) {
      throw new HmacVerificationError(payload.keyVersion);
    }

    const decipher = createDecipheriv("aes-256-cbc", aesKey, payload.iv);
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  }
}
