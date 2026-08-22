import { describe, expect, test } from "vitest";

import {
  GATE_VERDICT_DEFAULTS,
  decideGateVerdict,
  evaluateCoherenceGate,
} from "@chatcap/validation";
import type {
  GateThresholds,
  GuardrailResult,
  RetrievedChunk,
} from "@chatcap/shared-types";

/**
 * Phase 8.2 coherence-gate smoke (calibrated 0.85 emit / 0.75 orange/block).
 * No external network: the NLI provider is mocked to resolve immediately.
 * The latency check exercises the real gate-only path (`evaluateCoherenceGate`)
 * end to end; the band checks lock the calibrated decisions via the pure
 * `decideGateVerdict` (REQ-RAG-4/5/6).
 */

const thresholds: GateThresholds = GATE_VERDICT_DEFAULTS;

const chunk = (score: number): RetrievedChunk => ({
  chunkId: `chunk-${score}`,
  docId: "doc-1",
  chunkIndex: 0,
  content: "la respiración diafragmática reduce la ansiedad",
  category: "técnicas",
  source: "manual-bienestar.pdf",
  language: "es",
  legalFramework: "ar_2024",
  score,
});

const cleanGuardrail: GuardrailResult = {
  level: "none",
  deviationTerms: [],
  blocked: false,
};

const instantNli = async () => ({
  verdict: "entailment" as const,
  confidence: 0.99,
});

describe("coherence gate — latency smoke (gate-only path)", () => {
  test("emit path resolves well under the 1000ms bound with a mocked NLI provider", async () => {
    const start = performance.now();
    const result = await evaluateCoherenceGate({
      answer: "respuesta basada en el fragmento",
      chunks: [chunk(0.9)],
      nli: { verdict: "neutral", confidence: 0 },
      guardrail: cleanGuardrail,
      thresholds,
      isRetry: false,
      nliProvider: instantNli,
    });
    const elapsed = performance.now() - start;

    expect(result.verdict).toBe("emit");
    expect(result.cosine).toBe(0.9);
    // Gate-only path (mocked NLI) must stay well within budget.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("coherence gate — calibrated band decisions (Phase 8.2)", () => {
  test("emit floor: cosine >= 0.85 emits", () => {
    expect(
      decideGateVerdict({ cosine: 0.85, isRetry: false, thresholds })
    ).toBe("emit");
    expect(
      decideGateVerdict({ cosine: 0.9, isRetry: false, thresholds })
    ).toBe("emit");
  });

  test("retry/yellow band: 0.75 <= cosine < 0.85 retries, then yellow-flags", () => {
    expect(
      decideGateVerdict({ cosine: 0.75, isRetry: false, thresholds })
    ).toBe("retry");
    expect(
      decideGateVerdict({ cosine: 0.8, isRetry: false, thresholds })
    ).toBe("retry");
    expect(
      decideGateVerdict({ cosine: 0.8, isRetry: true, thresholds })
    ).toBe("yellow_flag");
  });

  test("orange/block floor: cosine < 0.75 blocks", () => {
    expect(
      decideGateVerdict({ cosine: 0.74, isRetry: false, thresholds })
    ).toBe("orange_block");
    expect(
      decideGateVerdict({ cosine: 0.7, isRetry: false, thresholds })
    ).toBe("orange_block");
  });
});
