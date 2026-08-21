/**
 * Char-aware text chunking (task 6.3, REQ-INGEST-2).
 *
 * Strategy: greedily fill a buffer up to `maxChars`, breaking at the LAST
 * sentence boundary (".", "?", "!", "—") found within the window that also
 * leaves at least `minChars` for the chunk being closed. If no boundary
 * qualifies, hard-cut at `maxChars`. The final chunk is always flushed.
 *
 * NO whitespace normalization: `chunks.join("") === text` must hold (the chunker
 * is a pure slicer; embedding input is the text, whitespace is preserved).
 */

export interface ChunkOptions {
  maxChars: number;
  minChars: number;
}

// Sentence-terminating punctuation. We cut immediately AFTER the matched char
// so the following whitespace belongs to the next chunk (preserves all chars).
const PUNCT_REGEX = /[.?!—]/g;

/**
 * Splits `text` into chunks respecting sentence boundaries where possible.
 * Returns exactly the slices such that `chunks.join("") === text`.
 */
export function chunkText(text: string, maxChars: number, minChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= maxChars) {
      chunks.push(text.slice(cursor));
      break;
    }

    const windowEnd = cursor + maxChars;
    let cut = -1;

    // Walk every punctuation mark at or before `windowEnd` and keep the last
    // one whose resulting chunk length is >= minChars.
    PUNCT_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PUNCT_REGEX.exec(text)) !== null) {
      const punctIndex = match.index;
      if (punctIndex >= windowEnd) {
        break;
      }
      const potential = punctIndex + 1; // cut AFTER the punctuation char
      if (potential - cursor >= minChars) {
        cut = potential;
      }
    }

    if (cut === -1) {
      // No boundary satisfied the minimum within the window: hard-cut.
      cut = windowEnd;
    }

    chunks.push(text.slice(cursor, cut));
    cursor = cut;
  }

  return chunks;
}
