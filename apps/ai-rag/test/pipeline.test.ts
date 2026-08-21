import { describe, expect, test, vi, beforeEach } from "vitest";

import { createLogger } from "@chatcap/telemetry";
import type { NliResult, RetrievedChunk } from "@chatcap/shared-types";
import { RISK_LEVEL } from "@chatcap/shared-types";
import type { DbQueryable } from "@chatcap/db-schema";
import { searchVectorChunks } from "@chatcap/db-schema";

import { runRagPipeline, type PipelineDeps } from "../src/pipeline";
import {
  CRISIS_BASE_RESPONSE,
  SAFE_FALLBACK_BLOCKED,
  SAFE_FALLBACK_FLAGGED,
} from "../src/safety-text";
import type { RagProcessResponse } from "../src/process-response";

/**
 * Orchestrator + gate integration (task 3.5, REQ-RAG-4/5/6/7/8,
 * REQ-ALERT-1): classify → retrieve → generate → gate with emit/retry/yellow/
 * orange routing, PII-free alert events over pub-sub, and the full trace
 * returned for the supervisor dashboard.
 */

vi.mock("@chatcap/db-schema", async () => {
  const actual = await vi.importActual<typeof import("@chatcap/db-schema")>(
    "@chatcap/db-schema"
  );
  return {
    ...actual,
    assertVectorIndexPresent: vi.fn(async () => {}),
    searchVectorChunks: vi.fn(),
  };
});

const silentLogger = createLogger({ level: "silent", destination: { write: () => {} } });

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

const entailmentNli = (): Promise<NliResult> =>
  Promise.resolve({ verdict: "entailment", confidence: 0.99 });
const contradictionNli = (): Promise<NliResult> =>
  Promise.resolve({ verdict: "contradiction", confidence: 0.97 });

function makeDeps(overrides: Partial<PipelineDeps> = {}): {
  deps: PipelineDeps;
  publish: ReturnType<typeof vi.fn>;
} {
  const publish = vi.fn(async () => {});
  const deps: PipelineDeps = {
    client: {
      classify: vi.fn(async () => RISK_LEVEL.NORMAL),
      embed: vi.fn(async () => [0.1, 0.2, 0.3]),
      chat: vi.fn(async () => ({ content: "respuesta basada en el fragmento" })),
      nli: entailmentNli,
    },
    db: {} as DbQueryable,
    gate: { cosineEmit: 0.85, cosineRetry: 0.75, maxRetries: 1, nliEnabled: true },
    topK: 3,
    models: { chat: "gpt-4o", nli: "gpt-4o-mini", embedding: "text-embedding-3-small" },
    emitter: { publish },
    aiEmissionEnabled: true,
    logger: silentLogger,
    ...overrides,
  };
  return { deps, publish };
}

const input = { sessionId: "s1", message: "¿cómo calmo la ansiedad?" };

beforeEach(() => {
  vi.mocked(searchVectorChunks).mockResolvedValue([chunk(0.9)]);
});

describe("red short-circuit (REQ-RAG-7, REQ-ALERT-1)", () => {
  test("returns crisis text + red alert and never calls retrieval or generation", async () => {
    const { deps, publish } = makeDeps({
      client: {
        classify: vi.fn(async () => RISK_LEVEL.RED),
        embed: vi.fn(async () => [0.1]),
        chat: vi.fn(async () => ({ content: "nunca debe generarse" })),
        nli: async (): Promise<NliResult> => ({ verdict: "entailment", confidence: 1 }),
      },
    });

    const outcome = (await runRagPipeline(deps, input)) as Extract<
      RagProcessResponse,
      { kind: "crisis" }
    >;

    expect(outcome.kind).toBe("crisis");
    expect(outcome.fallbackText).toBe(CRISIS_BASE_RESPONSE);
    expect(outcome.trace.emitted).toBe(false);
    expect(outcome.trace.retrieval.chunks).toEqual([]);
    expect(outcome.trace.generation.temperature).toBe(0);
    expect(deps.client.embed).not.toHaveBeenCalled();
    expect(deps.client.chat).not.toHaveBeenCalled();

    // Red alert raised, PII-free: no message content, ids only.
    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]?.[0];
    expect(event.type).toBe("alert_raised");
    expect(event.payload).toMatchObject({
      sessionId: "s1",
      level: "red",
      category: "crisis",
      status: "open",
      traceId: outcome.trace.traceId,
    });
    const payloadJson = JSON.stringify(event.payload);
    expect(payloadJson).not.toContain("calmo");
    expect(payloadJson).not.toContain("mensaje");
  });
});

describe("emit path (REQ-RAG-4)", () => {
  test("emits the grounded answer with full trace when the gate passes", async () => {
    const { deps, publish } = makeDeps();

    const outcome = (await runRagPipeline(deps, input)) as Extract<
      RagProcessResponse,
      { kind: "emitted" }
    >;

    expect(outcome.kind).toBe("emitted");
    expect(outcome.answer).toBe("respuesta basada en el fragmento");
    expect(outcome.trace.emitted).toBe(true);
    expect(outcome.trace.gate.verdict).toBe("emit");
    expect(outcome.trace.gate.cosine).toBe(0.9);
    expect(outcome.trace.retrieval.chunks).toHaveLength(1);
    expect(outcome.trace.retrieval.chunks[0]?.source).toBe("manual-bienestar.pdf");
    expect(outcome.trace.classification.risk).toBe("normal");
    // No alert on the clean emit path.
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("orange block path (REQ-RAG-6)", () => {
  test("role-deviation wording blocks emission regardless of cosine and raises an orange alert", async () => {
    const { deps, publish } = makeDeps({
      client: {
        classify: vi.fn(async () => RISK_LEVEL.ORANGE),
        embed: vi.fn(async () => [0.1]),
        chat: vi.fn(async () => ({ content: "te receto clonazepam para dormir" })),
        nli: entailmentNli,
      },
    });

    const outcome = (await runRagPipeline(deps, input)) as Extract<
      RagProcessResponse,
      { kind: "blocked" }
    >;

    expect(outcome.kind).toBe("blocked");
    expect(outcome.fallbackText).toBe(SAFE_FALLBACK_BLOCKED);
    expect(outcome.trace.emitted).toBe(false);
    expect(outcome.trace.gate.verdict).toBe("orange_block");
    expect(outcome.trace.gate.guardrail.blocked).toBe(true);
    expect(outcome.trace.gate.guardrail.deviationTerms).toContain("receto");

    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]?.[0];
    expect(event.payload).toMatchObject({ level: "orange", category: "role_deviation" });
  });
});

describe("retry → yellow flag path (REQ-RAG-4/5)", () => {
  test("borderline coherence regenerates once, then yellow-flags for review", async () => {
    vi.mocked(searchVectorChunks).mockResolvedValue([chunk(0.8)]);
    const { deps, publish } = makeDeps();

    const outcome = (await runRagPipeline(deps, input)) as Extract<
      RagProcessResponse,
      { kind: "flagged" }
    >;

    expect(outcome.kind).toBe("flagged");
    expect(outcome.answer).toBe("respuesta basada en el fragmento");
    expect(outcome.fallbackText).toBe(SAFE_FALLBACK_FLAGGED);
    expect(outcome.trace.emitted).toBe(false);
    expect(outcome.trace.gate.verdict).toBe("yellow_flag");
    expect(deps.client.chat).toHaveBeenCalledTimes(2);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0].payload).toMatchObject({
      level: "yellow",
      category: "borderline",
    });
  });

  test("NLI contradiction blocks immediately, even inside the retry band (REQ-RAG-5)", async () => {
    vi.mocked(searchVectorChunks).mockResolvedValue([chunk(0.8)]);
    const { deps, publish } = makeDeps({
      client: {
        classify: vi.fn(async () => RISK_LEVEL.NORMAL),
        embed: vi.fn(async () => [0.1]),
        chat: vi.fn(async () => ({ content: "respuesta basada en el fragmento" })),
        nli: contradictionNli,
      },
    });

    const outcome = (await runRagPipeline(deps, input)) as Extract<
      RagProcessResponse,
      { kind: "blocked" }
    >;

    expect(outcome.kind).toBe("blocked");
    expect(outcome.trace.gate.verdict).toBe("orange_block");
    expect(outcome.trace.gate.nli.verdict).toBe("contradiction");
    // Contradiction blocks on the first evaluation — no retry is spent.
    expect(deps.client.chat).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0].payload).toMatchObject({ level: "orange" });
  });
});

describe("blocked short-circuits (safe by construction)", () => {
  test("empty retrieval blocks with the safe fallback and no alert", async () => {
    vi.mocked(searchVectorChunks).mockResolvedValue([]);
    const { deps, publish } = makeDeps();

    const outcome = (await runRagPipeline(deps, input)) as Extract<
      RagProcessResponse,
      { kind: "blocked" }
    >;

    expect(outcome.kind).toBe("blocked");
    expect(outcome.fallbackText).toBe(SAFE_FALLBACK_BLOCKED);
    expect(deps.client.chat).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  test("emission kill switch blocks without calling the LLM (REQ-CHATBOT-2)", async () => {
    const { deps, publish } = makeDeps({ aiEmissionEnabled: false });

    const outcome = (await runRagPipeline(deps, input)) as Extract<
      RagProcessResponse,
      { kind: "blocked" }
    >;

    expect(outcome.kind).toBe("blocked");
    expect(outcome.fallbackText).toBe(SAFE_FALLBACK_BLOCKED);
    expect(deps.client.chat).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("trace metadata for the dashboard (REQ-RAG-8)", () => {
  test("flagged trace carries the exact chunks and gate scores", async () => {
    vi.mocked(searchVectorChunks).mockResolvedValue([chunk(0.8)]);
    const { deps } = makeDeps();

    const outcome = (await runRagPipeline(deps, input)) as Extract<
      RagProcessResponse,
      { kind: "flagged" }
    >;
    const trace = outcome.trace;

    expect(trace.retrieval.chunks).toEqual([chunk(0.8)]);
    expect(trace.retrieval.model).toBe("text-embedding-3-small");
    expect(trace.retrieval.hnsw.efSearch).toBe(40);
    expect(trace.gate.cosine).toBe(0.8);
    expect(trace.gate.nli.confidence).toBe(0.99);
    expect(trace.generation.model).toBe("gpt-4o");
    expect(trace.generation.temperature).toBe(0);
    expect(trace.generation.promptCharCount).toBeGreaterThan(0);
    expect(trace.latencyMs).toBeGreaterThanOrEqual(0);
    expect(trace.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
