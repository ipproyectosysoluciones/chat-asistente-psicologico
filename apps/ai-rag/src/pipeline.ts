import { randomUUID } from "node:crypto";

import type { Logger } from "@chatcap/telemetry";
import type {
  AlertEvent,
  AlertLevel,
  GateResult,
  GateThresholds,
  RagTrace,
  RetrievedChunk,
  RiskLevel,
} from "@chatcap/shared-types";
import {
  ALERT_STATUS,
  EVENT_TYPE,
  GATE_VERDICT,
  GUARDRAIL_LEVEL,
  NLI_VERDICT,
  RISK_LEVEL,
} from "@chatcap/shared-types";
import type { OpenAiClient } from "@chatcap/llm-client";
import type { EventEmitter, TelemetryEvent } from "@chatcap/telemetry";
import { evaluateCoherenceGate, scanGuardrail } from "@chatcap/validation";
import { EF_SEARCH, type DbQueryable } from "@chatcap/db-schema";

import { classifyRisk, routeByRisk } from "./classify";
import { retrieveChunks } from "./retrieve";
import { generateAnswer } from "./generate";
import {
  CRISIS_BASE_RESPONSE,
  SAFE_FALLBACK_BLOCKED,
  SAFE_FALLBACK_FLAGGED,
} from "./safety-text";
import type { RagProcessRequest } from "./process-request";
import type { RagProcessResponse } from "./process-response";
import { UpstreamDependencyError } from "./errors";

/**
 * RAG pipeline orchestrator (task 3.5): classify → retrieve → generate →
 * coherence gate, with emit/retry/yellow/orange routing (REQ-RAG-4/5/6) and
 * the red short-circuit to the crisis path (REQ-RAG-7, REQ-ALERT-1).
 *
 * Safety properties:
 * - Red risk never reaches generation: crisis text + red alert, no LLM call.
 * - Empty retrieval or disabled emission → blocked fallback, no generation.
 * - Alert events are PII-free by construction (ids only, no message content).
 * - The full trace (chunks + gate scores) is returned for the dashboard
 *   (REQ-RAG-8).
 */

/** Synthetic gate for paths where the gate is skipped (crisis/empty/disabled). */
const SKIPPED_GATE: GateResult = {
  verdict: GATE_VERDICT.ORANGE_BLOCK,
  cosine: 0,
  nli: { verdict: NLI_VERDICT.NEUTRAL, confidence: 0 },
  guardrail: { level: GUARDRAIL_LEVEL.NONE, deviationTerms: [], blocked: false },
  chunks: [],
};

export interface PipelineDeps {
  client: Pick<OpenAiClient, "classify" | "embed" | "chat" | "nli">;
  db: DbQueryable;
  gate: GateThresholds;
  topK: number;
  models: { chat: string; nli: string; embedding: string };
  emitter: EventEmitter;
  /** Kill switch: false → never emit LLM output (REQ-CHATBOT-2). */
  aiEmissionEnabled: boolean;
  logger: Logger;
}

export async function runRagPipeline(
  deps: PipelineDeps,
  input: RagProcessRequest
): Promise<RagProcessResponse> {
  const startedAt = Date.now();
  const traceId = randomUUID();
  const createdAt = new Date().toISOString();

  // 1. Risk classification drives routing BEFORE retrieval (design §2.2).
  const risk = await classifyRisk(
    { client: deps.client, logger: deps.logger },
    input.message
  );

  const decision = routeByRisk(risk);
  if (decision.action === "short_circuit") {
    // Red (vital risk): crisis path, no retrieval, no generation, red alert.
    await raiseAlert(deps, {
      sessionId: input.sessionId,
      level: RISK_LEVEL.RED,
      category: "crisis",
      traceId,
    });
    return {
      kind: "crisis",
      fallbackText: CRISIS_BASE_RESPONSE,
      trace: buildTrace(deps, {
        traceId,
        sessionId: input.sessionId,
        risk,
        emitted: false,
        createdAt,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  // 2. Retrieval (metadata-attributed top-k, HNSW asserted inside).
  const chunks = await retrieveChunks(
    { client: deps.client, db: deps.db, topK: deps.topK, logger: deps.logger },
    input.message
  );
  if (chunks.length === 0) {
    // No grounding material: nothing safe to generate (REQ-RAG-1/4).
    return {
      kind: "blocked",
      fallbackText: SAFE_FALLBACK_BLOCKED,
      trace: buildTrace(deps, {
        traceId,
        sessionId: input.sessionId,
        risk,
        emitted: false,
        retrievalChunks: [],
        createdAt,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  // 3. Emission kill switch — never send LLM output when disabled.
  if (!deps.aiEmissionEnabled) {
    return {
      kind: "blocked",
      fallbackText: SAFE_FALLBACK_BLOCKED,
      trace: buildTrace(deps, {
        traceId,
        sessionId: input.sessionId,
        risk,
        emitted: false,
        retrievalChunks: chunks,
        createdAt,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  // 4. Generate (temperature 0 enforced by llm-client), then gate with one
  //    bounded retry (maxRetries from config, REQ-RAG-4).
  let answer = (
    await generateAnswer({ client: deps.client }, chunks, input.message)
  ).content;
  let gate = await runGate(deps, answer, chunks, false);
  if (gate.verdict === GATE_VERDICT.RETRY && deps.gate.maxRetries > 0) {
    answer = (
      await generateAnswer({ client: deps.client }, chunks, input.message)
    ).content;
    gate = await runGate(deps, answer, chunks, true);
  }

  // 5. Route the final verdict (emit / yellow / orange).
  const promptCharCount = answer.length;
  if (gate.verdict === GATE_VERDICT.EMIT) {
    return {
      kind: "emitted",
      answer,
      trace: buildTrace(deps, {
        traceId,
        sessionId: input.sessionId,
        risk,
        emitted: true,
        retrievalChunks: chunks,
        generation: { promptCharCount },
        gate,
        createdAt,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  if (gate.verdict === GATE_VERDICT.YELLOW_FLAG) {
    await raiseAlert(deps, {
      sessionId: input.sessionId,
      level: RISK_LEVEL.YELLOW,
      category: "borderline",
      traceId,
    });
    return {
      kind: "flagged",
      answer,
      fallbackText: SAFE_FALLBACK_FLAGGED,
      trace: buildTrace(deps, {
        traceId,
        sessionId: input.sessionId,
        risk,
        emitted: false,
        retrievalChunks: chunks,
        generation: { promptCharCount },
        gate,
        createdAt,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }

  // ORANGE_BLOCK (also the residual RETRY when maxRetries is exhausted):
  // role-deviation / NLI contradiction / low coherence → nothing emitted.
  await raiseAlert(deps, {
    sessionId: input.sessionId,
    level: RISK_LEVEL.ORANGE,
    category: gate.guardrail.blocked ? "role_deviation" : "incoherence",
    traceId,
  });
  return {
    kind: "blocked",
    fallbackText: SAFE_FALLBACK_BLOCKED,
    trace: buildTrace(deps, {
      traceId,
      sessionId: input.sessionId,
      risk,
      emitted: false,
      retrievalChunks: chunks,
      generation: { promptCharCount },
      gate,
      createdAt,
      latencyMs: Date.now() - startedAt,
    }),
  };
}

/** Runs the coherence gate with NLI wrapped as an upstream boundary. */
async function runGate(
  deps: PipelineDeps,
  answer: string,
  chunks: RetrievedChunk[],
  isRetry: boolean
): Promise<GateResult> {
  const guardrail = scanGuardrail(answer);
  return evaluateCoherenceGate({
    answer,
    chunks,
    nli: { verdict: NLI_VERDICT.NEUTRAL, confidence: 0 },
    guardrail,
    thresholds: deps.gate,
    isRetry,
    nliProvider: async (a, c) => {
      try {
        return await deps.client.nli(a, c);
      } catch (cause) {
        throw new UpstreamDependencyError(
          `NLI validation failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        );
      }
    },
  });
}

interface BuildTraceParts {
  traceId: string;
  sessionId: string;
  risk: RiskLevel;
  emitted: boolean;
  retrievalChunks?: RetrievedChunk[];
  generation?: { promptCharCount: number };
  gate?: GateResult;
  createdAt: string;
  latencyMs: number;
}

function buildTrace(deps: PipelineDeps, parts: BuildTraceParts): RagTrace {
  return {
    traceId: parts.traceId,
    sessionId: parts.sessionId,
    risk: parts.risk,
    classification: {
      model: deps.models.nli,
      risk: parts.risk,
      // The classify side-task returns only the level; confidence is
      // recorded deterministically (the model exposes no score yet).
      confidence: 1,
    },
    retrieval: {
      model: deps.models.embedding,
      topK: deps.topK,
      hnsw: { efSearch: EF_SEARCH },
      chunks: parts.retrievalChunks ?? [],
    },
    generation: {
      model: deps.models.chat,
      temperature: 0,
      ...(parts.generation ? { promptCharCount: parts.generation.promptCharCount } : {}),
    },
    gate: parts.gate ?? SKIPPED_GATE,
    emitted: parts.emitted,
    latencyMs: parts.latencyMs,
    createdAt: parts.createdAt,
  };
}

/** Raises a PII-free alert event over Redis pub-sub (REQ-ALERT-1/6). */
async function raiseAlert(
  deps: PipelineDeps,
  input: {
    sessionId: string;
    level: AlertLevel;
    category: string;
    traceId: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const payload: AlertEvent = {
    alertId: randomUUID(),
    sessionId: input.sessionId,
    level: input.level,
    category: input.category,
    // Per-session dedupe key: the notifications service owns the window.
    dedupeKey: `${input.sessionId}:${input.level}`,
    status: ALERT_STATUS.OPEN,
    createdAt: now,
    traceId: input.traceId,
  };
  const event: TelemetryEvent = {
    type: EVENT_TYPE.ALERT_RAISED,
    payload,
    occurredAt: now,
  };
  await deps.emitter.publish(event);
}
