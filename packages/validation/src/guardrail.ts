import { GUARDRAIL_LEVEL, type GuardrailLevel, type GuardrailResult } from "@chatcap/shared-types";

/**
 * Role-deviation terms that MUST block emission (REQ-RAG-6): diagnosing,
 * prescribing, and medication-adjacent wording. Matching is
 * case-insensitive and word-boundary aware so "recomiendo" never trips
 * "receto".
 */
const ORANGE_TERMS = ["diagnóstico", "diagnostico", "receto", "padeces"] as const;

/**
 * Drug/dose vocabulary: the blacklist used BEFORE vectorization (no dose
 * terms, no drug names, no posology reach the embeddings) and AGAIN at the
 * output guardrail. Exported so content filtering reuses the same source of
 * truth.
 */
export const DRUG_TERMS = new Set<string>([
  "clonazepam",
  "lorazepam",
  "alprazolam",
  "diazepam",
  "fluoxetina",
  "sertralina",
  "escitalopram",
  "clozapina",
  "risperidona",
  "olanzapina",
  "quetiapina",
  "litio",
  "amitriptilina",
]);

export const DOSE_TERMS = new Set<string>(["mg", "mcg", "gr", "dosis", "posología", "posologia"]);

/** Full blacklist: drug names + dose terms + posology phrasing. */
export const BLACKLIST_TERMS: ReadonlySet<string> = new Set<string>([
  ...DRUG_TERMS,
  ...DOSE_TERMS,
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTermRegex(term: string): RegExp {
  return new RegExp(`(^|\\W)${escapeRegExp(term)}(\\W|$)`, "i");
}

/**
 * Scans a generated answer for role-deviation wording (REQ-RAG-6).
 *
 * - orange terms (diagnosing/prescribing/medication) → `orange`, blocked.
 * - no deviation → `none`, safe to emit (subject to the cosine/NLI gate).
 *
 * Borderline phrasing that is not in the hard blocklist stays unblocked; the
 * yellow-flag path is decided by the gate on retry exhaustion, not here.
 */
export function scanGuardrail(answer: string): GuardrailResult {
  const text = answer.trim();
  if (text.length === 0) {
    return { level: GUARDRAIL_LEVEL.NONE, deviationTerms: [], blocked: false };
  }

  const deviationTerms: string[] = [];
  for (const term of ORANGE_TERMS) {
    if (buildTermRegex(term).test(text)) {
      deviationTerms.push(term);
    }
  }

  // The blacklist applies to drug/dose vocabulary anywhere in the answer.
  for (const term of BLACKLIST_TERMS) {
    if (buildTermRegex(term).test(text)) {
      deviationTerms.push(term);
    }
  }

  if (deviationTerms.length > 0) {
    return {
      level: GUARDRAIL_LEVEL.ORANGE,
      deviationTerms: [...new Set(deviationTerms)],
      blocked: true,
    };
  }

  return { level: GUARDRAIL_LEVEL.NONE, deviationTerms: [], blocked: false };
}

export type { GuardrailLevel, GuardrailResult };
