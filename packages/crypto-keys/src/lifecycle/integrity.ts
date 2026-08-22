import { createHmac } from "node:crypto";

import {
  HMAC_KEY_LENGTH,
  deriveKey,
} from "../core/derive";

/**
 * Batch integrity (REQ-KEY-4): every re-encrypted row gets a keyed row hash
 * and the batch carries a keyed hash over all rows — canonical order, so the
 * hash is independent of processing order. The integrity key is derived from
 * the master secret in its own HKDF domain (never stored, never logged).
 */

export const HKDF_INFO_INTEGRITY = "chatcap-batch-integrity-v1";
const INTEGRITY_SALT = Buffer.from("chatcap-batch-integrity-salt-v1", "utf8");

export function deriveIntegrityKey(masterSecret: Buffer): Buffer {
  return deriveKey(masterSecret, INTEGRITY_SALT, HKDF_INFO_INTEGRITY, HMAC_KEY_LENGTH);
}

/** Length-prefix binding: unambiguous concatenation of canonical fields. */
function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}

export interface RowHashInput {
  rowId: string;
  keyTo: number;
  encodedPayload: Buffer;
}

/** Per-row hash: binds row identity, target version and ciphertext. */
export function rowIntegrityHash(
  integrityKey: Buffer,
  rowId: string,
  keyTo: number,
  encodedPayload: Buffer
): Buffer {
  const version = Buffer.alloc(4);
  version.writeUInt32BE(keyTo);
  return createHmac("sha256", integrityKey)
    .update(lengthPrefixed(rowId))
    .update(version)
    .update(encodedPayload)
    .digest();
}

export interface BatchRowHash {
  rowId: string;
  hash: Buffer;
}

/**
 * Batch hash over all row hashes, sorted by rowId so the digest does not
 * depend on processing order. Any corrupted/omitted/duplicated row changes
 * the digest.
 */
export function batchIntegrityHash(
  integrityKey: Buffer,
  rows: readonly BatchRowHash[]
): Buffer {
  const sorted = [...rows].sort((a, b) => a.rowId.localeCompare(b.rowId));
  const hmac = createHmac("sha256", integrityKey);
  for (const row of sorted) {
    hmac.update(lengthPrefixed(row.rowId)).update(row.hash);
  }
  return hmac.digest();
}
