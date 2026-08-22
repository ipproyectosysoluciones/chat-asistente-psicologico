import { describe, expect, it } from "vitest";

import { SESSION_STATE } from "@chatcap/shared-types";

import { type FlowContext } from "../src/flow/flow";
import { createTopicFlow } from "../src/flow/topic";
import { messageFrom } from "../src/provider/mock";

/**
 * Topic flow (task 4.6, REQ-CHATBOT-2): once the user picks the
 * "temas de apoyo" option (menu "1"), the TOPIC state delegates every
 * message to the ai-rag service through the `rag_process` effect. The flow
 * stays PURE — it only requests the action; the orchestrator owns the HTTP
 * call, the coherence-gate routing and the history-sink write (the
 * "addAction" lifecycle of design §4.2.4).
 */

function contextWith(state: FlowContext["state"]): FlowContext {
  return {
    sessionId: "s1",
    contactKeyAnon: "hash-contact",
    state,
  };
}

describe("createTopicFlow (task 4.6, REQ-CHATBOT-2)", () => {
  it("requests a RAG process for the user message via the rag_process effect", async () => {
    const flow = createTopicFlow();

    const output = await flow.handle(
      messageFrom("5491100000000", "¿qué es la ansiedad?"),
      contextWith({ state: SESSION_STATE.TOPIC, jurisdiction: "CO" })
    );

    expect(output.replies).toEqual([]);
    expect(output.effects).toEqual([
      {
        kind: "rag_process",
        sessionId: "s1",
        to: "5491100000000",
        message: "¿qué es la ansiedad?",
      },
    ]);
    expect(output.nextState).toEqual({ state: SESSION_STATE.TOPIC, jurisdiction: "CO" });
  });

  it("keeps the state unchanged for every topic message", async () => {
    const flow = createTopicFlow();
    const priorState = { state: SESSION_STATE.TOPIC, jurisdiction: "EU-GDPR" };

    const output = await flow.handle(
      messageFrom("5491100000000", "¿cómo manejo el estrés?"),
      contextWith(priorState)
    );

    expect(output.nextState).toEqual(priorState);
  });
});
