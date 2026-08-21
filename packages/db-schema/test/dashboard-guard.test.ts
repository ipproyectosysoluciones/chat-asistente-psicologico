import { describe, expect, it } from "vitest";

import { isRagTrace } from "../src/repositories/dashboard";

/**
 * Runtime guard for `rag_traces.trace` jsonb (task 5.2): untrusted DB
 * content is validated before exposure to the dashboard — the guard is the
 * safety boundary, so its shape checks are unit-tested here.
 */

function sampleTrace(): unknown {
  return {
    traceId: "trace-1",
    sessionId: "sess-1",
    risk: "orange",
    classification: { model: "gpt-4o-mini", risk: "orange", confidence: 0.9 },
    retrieval: {
      model: "text-embedding-3-small",
      topK: 5,
      hnsw: { efSearch: 64 },
      chunks: [],
    },
    generation: { model: "gpt-4o", temperature: 0 },
    gate: {
      verdict: "orange_block",
      cosine: 0.71,
      nli: { verdict: "contradiction", confidence: 0.8 },
      guardrail: { level: "none", deviationTerms: [], blocked: false },
      chunks: [],
    },
    emitted: false,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("isRagTrace", () => {
  it("accepts a well-formed trace", () => {
    expect(isRagTrace(sampleTrace())).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isRagTrace(null)).toBe(false);
    expect(isRagTrace("trace")).toBe(false);
    expect(isRagTrace(42)).toBe(false);
  });

  it("rejects traces without a string traceId or sessionId", () => {
    const trace = sampleTrace() as Record<string, unknown>;
    trace.traceId = 42;
    expect(isRagTrace(trace)).toBe(false);
    trace.traceId = "trace-1";
    trace.sessionId = undefined;
    expect(isRagTrace(trace)).toBe(false);
  });

  it("rejects unknown risk levels", () => {
    const trace = sampleTrace() as Record<string, unknown>;
    trace.risk = "purple";
    expect(isRagTrace(trace)).toBe(false);
  });

  it("rejects traces without a numeric gate.cosine or gate.chunks", () => {
    const trace = sampleTrace() as Record<string, unknown>;
    const gate = trace.gate as Record<string, unknown>;
    gate.cosine = "high";
    expect(isRagTrace(trace)).toBe(false);
    gate.cosine = 0.71;
    delete gate.chunks;
    expect(isRagTrace(trace)).toBe(false);
  });

  it("rejects traces with a null gate", () => {
    const trace = sampleTrace() as Record<string, unknown>;
    trace.gate = null;
    expect(isRagTrace(trace)).toBe(false);
  });
});
