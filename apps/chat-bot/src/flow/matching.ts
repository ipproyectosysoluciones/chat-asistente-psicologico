/**
 * Shared text matchers (task 4.4): extracted from the jurisdiction flow so
 * the consent flow reuses the SAME refusal/confirmation semantics — the
 * negation-wins rule must apply to consent acceptance too (REQ-CONSENT-2/3).
 * A "no estoy de acuerdo" / "no acepto" is a refusal, never consent.
 */

/** Accent-insensitive lowercase normalization for matching user replies. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Token-boundary match: `si` inside "sindrome" must NOT confirm. */
export function hasPhrase(input: string, phrase: string): boolean {
  const words = tokenize(input);
  const phraseWords = tokenize(phrase);
  if (phraseWords.length === 0) {
    return false;
  }
  return words.some((_, i) =>
    phraseWords.every((word, j) => words[i + j] === word)
  );
}

/** Normalized substring check (e.g. UNKNOWN_PHRASES in the jurisdiction flow). */
export function containsPhrase(input: string, phrase: string): boolean {
  return normalizeText(input).includes(normalizeText(phrase));
}

/**
 * Negation-wins check (REQ-CONSENT-1/6): a refusal when the FIRST token is a
 * negation word ("no", "nop", "tampoco"). Token-based so punctuation cannot
 * bypass it — "no, acepto" and "no. quiero" are refusals, never consent.
 * Being conservative (defaulting to refusal) is the safe direction in a
 * consent flow.
 */
export function isNegated(body: string): boolean {
  const [first] = normalizeText(body)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return first === "no" || first === "nop" || first === "tampoco";
}

/**
 * Affirmation when ANY of the phrases matches on token boundaries AND the
 * reply is not negated. Negation always wins over affirmation.
 */
export function isAffirmation(body: string, phrases: string[]): boolean {
  const normalized = normalizeText(body);
  if (isNegated(normalized)) {
    return false;
  }
  return phrases.some((phrase) => hasPhrase(normalized, phrase));
}
