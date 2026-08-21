import { BLACKLIST_TERMS } from "@chatcap/validation";

/**
 * Blacklist filter (task 6.2, REQ-INGEST-1): removes dose terms, drug names
 * and posology phrasing from a document's text BEFORE chunking/embedding.
 * Reuses the same BLACKLIST_TERMS source of truth as the output guardrail so
 * ingestion and emission can never drift. Logs only counts + term names — never
 * matched text, since documents are clinical-adjacent.
 */

export interface BlacklistHit {
  /** The blacklisted term that matched. */
  term: string;
  /** Character offset of the match start in the original text. */
  start: number;
}

export interface FilterResult {
  /** Text with blacklisted spans replaced by a single space, then collapsed. */
  allowed: string;
  /** Every blacklisted term found, with position (one entry per occurrence). */
  hits: BlacklistHit[];
  blacklisted: boolean;
}

/** Word-boundary aware, case-insensitive regex per term. The term sits in
 * capture group 2 so we can compute its exact span. */
function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)(${escaped})(\\W|$)`, "gi");
}

/**
 * Scans `text` for blacklisted terms. Returns the allowed text (blacklisted
 * spans redacted to a single space, whitespace collapsed) and the hit list.
 */
export function filterBlacklist(text: string): FilterResult {
  const hits: BlacklistHit[] = [];
  const spans: Array<{ start: number; end: number }> = [];

  for (const term of BLACKLIST_TERMS) {
    const regex = termRegex(term);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const prefix = match[1] ?? "";
      const matchedTerm = match[2] ?? "";
      const termStart = match.index + prefix.length;
      const termEnd = termStart + matchedTerm.length;
      spans.push({ start: termStart, end: termEnd });
      hits.push({ term, start: termStart });
    }
  }

  return {
    allowed: redactSpans(text, spans),
    hits,
    blacklisted: hits.length > 0,
  };
}

/** Replace each [start,end) span with a single space, then collapse whitespace. */
function redactSpans(text: string, spans: Array<{ start: number; end: number }>): string {
  if (spans.length === 0) {
    return text.trim();
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) {
        last.end = span.end;
      }
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }

  let out = "";
  let cursor = 0;
  for (const span of merged) {
    out += text.slice(cursor, span.start);
    out += " ";
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out.replace(/\s+/g, " ").trim();
}
