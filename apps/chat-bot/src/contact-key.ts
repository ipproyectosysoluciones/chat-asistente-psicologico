import { createHash } from "node:crypto";

/**
 * Anonymize a raw contact identifier into a stable session key
 * (REQ-CHATBOT-1, design §4.1): SHA-256(identifier || pepper). The raw
 * phone/waid must never reach storage or logs — only this digest is persisted
 * as `contact_key_anon`. The pepper (`CONTACT_KEY_SALT`, min 16 chars) makes
 * the digest non-reversible against a phone-number dictionary.
 */
export function hashContactKey(identifier: string, salt: string): string {
  return createHash("sha256")
    .update(`${identifier}::${salt}`)
    .digest("hex");
}
