import { hkdfSync } from "node:crypto";

/**
 * HKDF-SHA256 per-version derivation (REQ-KEY-1, design §6.1).
 * key_K = HKDF-SHA256(master_secret, salt_K, info). The master secret and the
 * derived keys are never stored or logged — only the per-version salt lives in
 * key_versions, so old keys stay derivable during the dual-read transition
 * (REQ-KEY-8). Two info strings keep the AES key and the MAC key in separate
 * key domains.
 */

export const HKDF_INFO_AES = "chatcap-aes-256-cbc-v1";
export const HKDF_INFO_HMAC = "chatcap-hmac-sha256-v1";
export const AES_KEY_LENGTH = 32;
export const HMAC_KEY_LENGTH = 32;
export const IV_LENGTH = 16;
export const HMAC_LENGTH = 32;
export const SALT_LENGTH = 32;

/** Derive `length` bytes of key material for the given info domain. */
export function deriveKey(
  masterSecret: Buffer,
  salt: Buffer,
  info: string,
  length: number
): Buffer {
  // hkdfSync returns ArrayBuffer on Node >= 26; Buffer.from normalizes either.
  return Buffer.from(hkdfSync("sha256", masterSecret, salt, info, length));
}
