import { describe, expect, test } from "vitest";

import {
  GATE_VERDICT_DEFAULTS,
  decideGateVerdict,
  evaluateCoherenceGate,
  type NliProvider,
} from "../src/index";
import type { GateResult, GuardrailResult, NliResult, RetrievedChunk } from "@chatcap/shared-types";

const thresholds = GATE_VERDICT_DEFAULTS; // cosineEmit 0.85, cosineRetry 0.75, maxRetries 1

function chunk(score: number): RetrievedChunk {
  return {
    chunkId: `c-${score}`,
    docId: "doc-1",
    chunkIndex: 0,
    content: "source chunk",
    category: "clinical",
    source: "manual",
    language: "es",
    legalFramework: "es-ley-41-2002",
    score,
  };
}

const NO_GUARDRAIL: GuardrailResult = {
  level: "none",
  deviationTerms: [],
  blocked: false,
};

const NO_NLI: NliResult = { verdict: "entailment", confidence: 0.99 };

function providerReturning(result: NliResult): NliProvider {
  return async () => result;
}

describe("decideGateVerdict bands (REQ-RAG-4)", () => {
  test("cosine >= 0.85 emits", () => {
    expect(decideGateVerdict({ cosine: 0.85, isRetry: false, thresholds })).toBe("emit");
    expect(decideGateVerdict({ cosine: 0.999, isRetry: true, thresholds })).toBe("emit");
  });

  test("cosine in [0.75, 0.85) retries once, then yellow-flags on the retry", () => {
    expect(decideGateVerdict({ cosine: 0.75, isRetry: false, thresholds })).toBe("retry");
    expect(decideGateVerdict({ cosine: 0.8, isRetry: false, thresholds })).toBe("retry");
    expect(decideGateVerdict({ cosine: 0.75, isRetry: true, thresholds })).toBe(
      "yellow_flag"
    );
    expect(decideGateVerdict({ cosine: 0.8499, isRetry: true, thresholds })).toBe(
      "yellow_flag"
    );
  });

  test("cosine < 0.75 orange-blocks regardless of retry state", () => {
    expect(decideGateVerdict({ cosine: 0.7499, isRetry: false, thresholds })).toBe(
      "orange_block"
    );
    expect(decideGateVerdict({ cosine: 0.5, isRetry: true, thresholds })).toBe(
      "orange_block"
    );
  });

  test("thresholds defaults match the calibrated env defaults", () => {
    expect(GATE_VERDICT_DEFAULTS).toMatchObject({
      cosineEmit: 0.85,
      cosineRetry: 0.75,
      maxRetries: 1,
      nliEnabled: true,
    });
  });
});

describe("evaluateCoherenceGate (REQ-RAG-4/5/6)", () => {
  test("emit path: best chunk cosine above threshold, NLI entailment, no guardrail", async () => {
    const result: GateResult = await evaluateCoherenceGate({
      answer: "respuesta",
      chunks: [chunk(0.9)],
      nli: NO_NLI,
      guardrail: NO_GUARDRAIL,
      thresholds,
      isRetry: false,
      nliProvider: providerReturning(NO_NLI),
    });

    expect(result.verdict).toBe("emit");
    expect(result.cosine).toBeCloseTo(0.9, 5); // best retrieval score, not recomputed
    expect(result.guardrail.blocked).toBe(false);
    expect(result.chunks).toHaveLength(1);
  });

  test("emission is blocked when the best chunk cosine < 0.75 even without guardrail", async () => {
    const result: GateResult = await evaluateCoherenceGate({
      answer: "respuesta",
      chunks: [chunk(0.5)],
      nli: NO_NLI,
      guardrail: NO_GUARDRAIL,
      thresholds,
      isRetry: false,
      nliProvider: providerReturning(NO_NLI),
    });

    expect(result.verdict).toBe("orange_block");
  });

  test("an NLI contradiction blocks emission regardless of cosine (REQ-RAG-5)", async () => {
    const result: GateResult = await evaluateCoherenceGate({
      answer: "respuesta",
      chunks: [chunk(0.95)],
      nli: { verdict: "contradiction", confidence: 0.9 },
      guardrail: NO_GUARDRAIL,
      thresholds,
      isRetry: false,
      nliProvider: providerReturning({ verdict: "contradiction", confidence: 0.9 }),
    });

    expect(result.verdict).toBe("orange_block");
  });

  test("the NLI provider is called with answer and the best chunk text", async () => {
    let seen: { answer: string; chunk: string } | undefined;
    const provider: NliProvider = async (answer, chunkText) => {
      seen = { answer, chunk: chunkText };
      return NO_NLI;
    };

    await evaluateCoherenceGate({
      answer: "hola",
      chunks: [chunk(0.9)],
      nli: NO_NLI,
      guardrail: NO_GUARDRAIL,
      thresholds,
      isRetry: false,
      nliProvider: provider,
    });

    expect(seen).toEqual({ answer: "hola", chunk: "source chunk" });
  });

  test("orange guardrail forces orange_block even with perfect cosine (REQ-RAG-6)", async () => {
    const result: GateResult = await evaluateCoherenceGate({
      answer: "te receto medicación",
      chunks: [chunk(0.95)],
      nli: NO_NLI,
      guardrail: { level: "orange", deviationTerms: ["receto"], blocked: true },
      thresholds,
      isRetry: false,
      nliProvider: providerReturning(NO_NLI),
    });

    expect(result.verdict).toBe("orange_block");
  });

  test("yellow guardrail forces yellow_flag in the retry band", async () => {
    const result: GateResult = await evaluateCoherenceGate({
      answer: "quizás padeces algo",
      chunks: [chunk(0.8)],
      nli: NO_NLI,
      guardrail: { level: "yellow", deviationTerms: ["padeces"], blocked: false },
      thresholds,
      isRetry: false,
      nliProvider: providerReturning(NO_NLI),
    });

    expect(result.verdict).toBe("yellow_flag");
  });

  test("nliEnabled=false skips the NLI provider and cannot block (bypass path)", async () => {
    const result: GateResult = await evaluateCoherenceGate({
      answer: "respuesta",
      chunks: [chunk(0.9)],
      nli: NO_NLI,
      guardrail: NO_GUARDRAIL,
      thresholds: { ...thresholds, nliEnabled: false },
      isRetry: false,
      nliProvider: providerReturning({ verdict: "contradiction", confidence: 0.99 }),
    });

    expect(result.verdict).toBe("emit");
  });

  test("the returned GateResult carries the exact chunks and guardrail for tracing (REQ-RAG-8)", async () => {
    const usedChunk = chunk(0.92);
    const result: GateResult = await evaluateCoherenceGate({
      answer: "respuesta",
      chunks: [usedChunk],
      nli: NO_NLI,
      guardrail: NO_GUARDRAIL,
      thresholds,
      isRetry: false,
      nliProvider: providerReturning(NO_NLI),
    });

    expect(result.chunks).toEqual([usedChunk]);
    expect(result.guardrail).toEqual(NO_GUARDRAIL);
    expect(result.nli).toEqual(NO_NLI);
  });

  test("retry band emits yellow_flag only after maxRetries exhaustion", async () => {
    const result: GateResult = await evaluateCoherenceGate({
      answer: "respuesta",
      chunks: [chunk(0.8)],
      nli: NO_NLI,
      guardrail: NO_GUARDRAIL,
      thresholds,
      isRetry: true,
      nliProvider: providerReturning(NO_NLI),
    });

    expect(result.verdict).toBe("yellow_flag");
  });

  test("the best chunk (highest score) drives the cosine", async () => {
    const result: GateResult = await evaluateCoherenceGate({
      answer: "respuesta",
      chunks: [chunk(0.5), chunk(0.9)],
      nli: NO_NLI,
      guardrail: NO_GUARDRAIL,
      thresholds,
      isRetry: false,
      nliProvider: providerReturning(NO_NLI),
    });

    expect(result.cosine).toBeCloseTo(0.9, 5);
    expect(result.verdict).toBe("emit");
  });
});
