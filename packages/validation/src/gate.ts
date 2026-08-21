import {
  GATE_VERDICT,
  NLI_VERDICT,
  type GateResult,
  type GateThresholds,
  type GateVerdict,
  type NliResult,
  type RetrievedChunk,
} from "@chatcap/shared-types";

/**
 * Default gate thresholds — calibrated (Phase 8.2): `cosineEmit` 0.85 is the
 * emit floor, `cosineRetry` 0.75 is the orange/block floor. Cosine in
 * [0.75, 0.85) triggers a bounded retry (yellow_flag once retried); below
 * 0.75 blocks (orange). Mirrors the `@chatcap/config` env defaults
 * (GATE_COSINE_EMIT=0.85, GATE_COSINE_RETRY=0.75). Do not change these values
 * without re-running the Phase 8.2 calibration + smoke test.
 */
export const GATE_VERDICT_DEFAULTS: GateThresholds = {
  cosineEmit: 0.85,
  cosineRetry: 0.75,
  maxRetries: 1,
  nliEnabled: true,
};

export interface DecideGateInput {
  cosine: number;
  isRetry: boolean;
  thresholds: GateThresholds;
}

/**
 * Pure band decision (REQ-RAG-4): cosine ≥ emit → emit; [retry, emit) →
 * retry unless already retried, then yellow_flag; < retry → orange_block.
 */
export function decideGateVerdict(input: DecideGateInput): GateVerdict {
  const { cosine, isRetry, thresholds } = input;
  if (cosine >= thresholds.cosineEmit) {
    return GATE_VERDICT.EMIT;
  }
  if (cosine >= thresholds.cosineRetry) {
    return isRetry ? GATE_VERDICT.YELLOW_FLAG : GATE_VERDICT.RETRY;
  }
  return GATE_VERDICT.ORANGE_BLOCK;
}

/** NLI side-task seam: the RAG pipeline wires the real LLM client here. */
export type NliProvider = (answer: string, chunkText: string) => Promise<NliResult>;

export interface EvaluateGateInput {
  answer: string;
  /** Retrieved chunks; the highest `score` drives the cosine (REQ-RAG-3). */
  chunks: RetrievedChunk[];
  nli: NliResult;
  guardrail: GateResult["guardrail"];
  thresholds: GateThresholds;
  isRetry: boolean;
  nliProvider: NliProvider;
}

function bestChunk(chunks: RetrievedChunk[]): RetrievedChunk {
  if (chunks.length === 0) {
    throw new Error("Coherence gate requires at least one retrieved chunk");
  }
  // Non-empty guard above keeps the reduce result defined without a cast;
  // ties keep the first chunk encountered.
  return chunks.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best
  );
}

/**
 * Full coherence gate (REQ-RAG-4/5/6): cosine from the best retrieved chunk,
 * NLI contradiction check (unless disabled), and the role-deviation
 * guardrail. Orange guardrail or NLI contradiction block regardless of
 * cosine. Returns the complete GateResult as the grounding trace for the
 * supervisor dashboard (REQ-RAG-8).
 */
export async function evaluateCoherenceGate(
  input: EvaluateGateInput
): Promise<GateResult> {
  const { answer, chunks, nli, guardrail, thresholds, isRetry, nliProvider } = input;
  const best = bestChunk(chunks);
  const cosine = best.score;

  const nliResult = thresholds.nliEnabled
    ? await nliProvider(answer, best.content)
    : nli;

  const nliContradicts = nliResult.verdict === NLI_VERDICT.CONTRADICTION;
  const guardrailBlocks = guardrail.blocked;
  const guardrailFlags = guardrail.level === "yellow";

  let verdict: GateVerdict;
  if (nliContradicts || guardrailBlocks) {
    verdict = GATE_VERDICT.ORANGE_BLOCK;
  } else if (guardrailFlags) {
    // Borderline wording is yellow-flagged for review, not emitted silently
    // (REQ-RAG-6).
    verdict = GATE_VERDICT.YELLOW_FLAG;
  } else {
    verdict = decideGateVerdict({ cosine, isRetry, thresholds });
  }

  return {
    verdict,
    cosine,
    nli: nliResult,
    guardrail,
    chunks,
  };
}
