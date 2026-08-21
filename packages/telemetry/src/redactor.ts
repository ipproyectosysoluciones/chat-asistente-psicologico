/**
 * PII redactor (design §2.2, REQ-ALERT-6, REQ-DASH-8).
 *
 * Two layers, privacy-first (over-redaction is the safe failure mode):
 *  1. KEY-level: values under known PII keys (wa_id, from, body, ...) are
 *     replaced entirely by `[REDACTED]` — webhook payloads are never logged.
 *  2. VALUE-level: every other string is scanned for phone/email patterns and
 *     the matches are replaced by `[PHONE]`/`[EMAIL]`.
 *
 * Trace/entity ids (traceId, sessionId, alertId, ...) stay on the allowlist:
 * their values survive unless they themselves contain a phone/email pattern.
 */

const REDACTED = "[REDACTED]";
const PHONE_TAG = "[PHONE]";
const EMAIL_TAG = "[EMAIL]";

/**
 * Phone-ish: optional leading +, 8+ digits with separators (space, dot, dash,
 * parentheses). Requires at least 8 digits total so years/counts ("2026 in 10
 * days") are untouched.
 */
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Keys whose whole value is PII (WhatsApp webhook identity/message fields). */
const PII_KEY_RE =
  /(^|[_ .-])(wa_id|pushname|notify_name|notifyname|phone_number|phonenumber|mobile|cell(phone)?|email_address|email|from|to_number|body|text|caption|message|content|payload)([_ .-]|$)/i;

/** True when a key names a PII value (value is fully redacted). */
export function isPiiKey(key: string): boolean {
  return PII_KEY_RE.test(key);
}

/** Type guard for plain record objects (narrows after typeof checks). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Pattern-level redaction of a plain string (phones and emails). */
export function redactPii(value: string): string {
  return value
    .replace(EMAIL_RE, EMAIL_TAG)
    .replace(PHONE_RE, PHONE_TAG);
}

/** Redacts a single value given its key: full redaction for PII keys. */
export function redactPiiValue(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    if (isPiiKey(key)) {
      return REDACTED;
    }
    return redactPii(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPiiValue(item, key));
  }
  if (isRecord(value)) {
    return redactPiiObject(value);
  }
  return value;
}

/** Deep-clones an object with all strings redacted; input is never mutated. */
export function redactPiiObject(
  input: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = redactPiiValue(value, key);
  }
  return output;
}
