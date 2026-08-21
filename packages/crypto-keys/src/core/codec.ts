import type { EncryptedPayload } from "@chatcap/shared-types";

import { HMAC_LENGTH, IV_LENGTH } from "./derive";

/**
 * Canonical storage envelope (design §6.1): `iv || ciphertext || hmac`,
 * base64 in TEXT contexts, raw bytes in BYTEA columns. The HMAC covers IV and
 * ciphertext (encrypt-then-MAC); the codec is deliberately transparent —
 * integrity is owned by the HMAC layer in decrypt, not by the codec.
 */

export class EnvelopeError extends Error {
  readonly code = "envelope_malformed" as const;

  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** Raw BYTEA representation: iv || ciphertext || hmac. */
export function encodePayload(payload: EncryptedPayload): Buffer {
  return Buffer.concat([payload.iv, payload.ciphertext, payload.hmac]);
}

/** Split a raw BYTEA envelope back into its typed components. */
export function decodePayload(
  keyVersion: number,
  encoded: Buffer
): EncryptedPayload {
  const minimumLength = IV_LENGTH + HMAC_LENGTH + 1;
  if (encoded.length < minimumLength) {
    throw new EnvelopeError(
      `Encrypted envelope too short (${encoded.length} bytes); expected iv(16) + ciphertext + hmac(32)`
    );
  }
  const iv = Buffer.from(encoded.subarray(0, IV_LENGTH));
  const ciphertext = Buffer.from(
    encoded.subarray(IV_LENGTH, encoded.length - HMAC_LENGTH)
  );
  const hmac = Buffer.from(encoded.subarray(encoded.length - HMAC_LENGTH));
  return { keyVersion, iv, ciphertext, hmac };
}

/** Base64 text form of the envelope (e.g. consent payload over the wire). */
export function serializePayload(payload: EncryptedPayload): string {
  return encodePayload(payload).toString("base64");
}

/** Parse a base64 envelope back into typed components. */
export function parsePayload(
  keyVersion: number,
  serialized: string
): EncryptedPayload {
  return decodePayload(keyVersion, Buffer.from(serialized, "base64"));
}
