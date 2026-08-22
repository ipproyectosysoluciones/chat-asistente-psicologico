import type { Logger } from "@chatcap/telemetry";
import type { RiskLevel } from "@chatcap/shared-types";
import { RISK_LEVEL } from "@chatcap/shared-types";
import type { OpenAiClient } from "@chatcap/llm-client";

import { UpstreamDependencyError } from "./errors";

/**
 * Risk classification (task 3.2, REQ-RAG-7): GPT-4o-mini classifies the
 * incoming message red/orange/yellow/normal and the decision drives routing
 * before retrieval (design §2.2). The side-task model returns only the level;
 * this module owns the defensive fallback (never trust unparsed output) and
 * the routing decision.
 */

export interface ClassifyDeps {
  client: Pick<OpenAiClient, "classify">;
  logger: Logger;
}

/** Guard: one of the four risk levels the side-task is allowed to return. */
function isRiskLevel(value: unknown): value is RiskLevel {
  return (
    typeof value === "string" &&
    // Object.values() widens the as-const literals to (string)[]; the
    // includes() membership check below is the actual runtime validation.
    (Object.values(RISK_LEVEL) as string[]).includes(value)
  );
}

export async function classifyRisk(
  deps: ClassifyDeps,
  message: string
): Promise<RiskLevel> {
  let risk: RiskLevel;
  try {
    risk = await deps.client.classify(message);
  } catch (cause) {
    // Service-boundary contract: OpenAI degradation surfaces as the typed
    // UpstreamDependencyError so the router answers 502 upstream_failed
    // ("try again later") instead of a generic 500.
    throw new UpstreamDependencyError(
      `risk classification failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }
  if (!isRiskLevel(risk)) {
    // The JSON-only prompt should prevent this, but the model is not a
    // compiler — degrade to normal instead of routing on garbage.
    deps.logger.warn("unexpected risk classification; degrading to normal", {
      risk: String(risk),
    });
    return RISK_LEVEL.NORMAL;
  }
  return risk;
}

/**
 * Routing decision BEFORE retrieval (design §2.2):
 * - `red` → short-circuit: crisis response + red alert, no retrieval.
 * - `orange` → proceed: retrieval attaches chunks for supervisor review
 *   (emission is blocked later in the orchestrator).
 * - `yellow` / `normal` → proceed through retrieve → generate → gate.
 */
export type RiskRoutingDecision =
  | { action: "short_circuit"; level: "red" }
  | { action: "proceed"; level: RiskLevel };

export function routeByRisk(risk: RiskLevel): RiskRoutingDecision {
  if (risk === RISK_LEVEL.RED) {
    return { action: "short_circuit", level: risk };
  }
  return { action: "proceed", level: risk };
}
