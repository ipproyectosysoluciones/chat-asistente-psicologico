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
 *
 * WS-C: phone detection uses a linear O(n) scan (no backtracking regex) to
 * prevent ReDoS on attacker-controlled input. Email detection uses a
 * non-overlapping linear regex.
 */

const REDACTED = "[REDACTED]";
const PHONE_TAG = "[PHONE]";
const EMAIL_TAG = "[EMAIL]";

/**
 * ReDoS-safe email regex (WS-C). Two properties prevent catastrophic
 * backtracking:
 *  - No `%` in the local-part class, so a `%`-repetitive input is never
 *    greedily consumed then backtracked.
 *  - Single quantifier per segment, separated by literal `.` — no nested
 *    overlapping quantifiers. The optional TLD group starts with a literal
 *    `.`, so its `*` cannot collide with the preceding label/TLD.
 * Matches: user@example.com, a.b+c@sub.example.co.ar, etc.
 */
const EMAIL_RE =
  /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}(\.[A-Za-z]{2,})*/g;

/** Keys whose whole value is PII (WhatsApp webhook identity/message fields). */
const PII_KEY_RE =
  /(^|[_ .-])(wa_id|pushname|notify_name|notifyname|phone_number|phonenumber|mobile|cell(phone)?|email_address|email|from|to_number|body|text|caption|message|content|payload)([_ .-]|$)/i;

/** True when a key names a PII value (value is fully redacted). */
export function isPiiKey(key: string): boolean {
  return PII_KEY_RE.test(key);
}

/**
 * Checks whether a digit-only string represents a phone number.
 * Must be 8–15 digits after stripping non-digit characters.
 */
export function isPhone(s: string): boolean {
  const digits = s.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

/** Type guard for plain record objects (narrows after typeof checks). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Single-digit test (plain comparison — no regex, no ReDoS surface). */
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/**
 * Characters that can appear inside a phone number run. Implemented as a plain
 * membership check (NOT a regex) so CodeQL's `js/polynomial-redos` has no regex
 * to flag — the linear scan is genuinely backtracking-free.
 */
function isPhoneChar(c: string): boolean {
  return (
    isDigit(c) ||
    c === "+" ||
    c === "-" ||
    c === "." ||
    c === "(" ||
    c === ")" ||
    c === "[" ||
    c === "]" ||
    c === " " ||
    c === "\t" ||
    c === "\n" ||
    c === "\r"
  );
}

/**
 * Linear phone scan (WS-C): walks the string once, identifying runs of
 * phone-like characters starting from a `+` or digit. O(n) with no
 * backtracking. Trailing non-digit characters are excluded from the
 * matched run so surrounding whitespace is preserved (parity with the
 * old regex `\+?\d[\d\s().-]{6,}\d`).
 */
function redactPhones(s: string): string {
  let result = "";
  let i = 0;

  while (i < s.length) {
    // Only start a phone run at '+' or a digit (not at a space/parens/dash)
    if (s[i] === "+" || isDigit(s[i]!)) {
      const start = i;
      // Consume forward while we see phone-like characters
      while (i < s.length && isPhoneChar(s[i]!)) {
        i++;
      }
      // Trim trailing non-digit characters (spaces, dashes, parens, dots)
      let end = i;
      while (end > start && !isDigit(s[end - 1]!)) {
        end--;
      }
      const run = s.slice(start, end);
      if (isPhone(run)) {
        result += PHONE_TAG;
      } else {
        result += run;
      }
      // Emit trailing chars that were trimmed (spaces, dashes, etc.)
      if (end < i) {
        result += s.slice(end, i);
      }
    } else {
      result += s[i];
      i++;
    }
  }

  return result;
}

/** Pattern-level redaction of a plain string (phones and emails). */
export function redactPii(value: string): string {
  // Email first (non-overlapping), then linear phone scan
  return redactPhones(value.replace(EMAIL_RE, EMAIL_TAG));
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
