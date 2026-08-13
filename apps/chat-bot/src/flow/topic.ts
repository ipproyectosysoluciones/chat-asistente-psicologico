import { type Flow, type FlowContext, type FlowOutput } from "./flow";

/**
 * Topic flow (task 4.6, REQ-CHATBOT-2): the "temas de apoyo" conversation.
 * Pure flow — every message delegates to the ai-rag service via the
 * `rag_process` effect. The orchestrator (createBot) owns the HTTP call, the
 * coherence-gate routing and the history-sink write (design §4.2.4 addAction
 * lifecycle). Crisis keywords never reach this flow: the session-level crisis
 * guard runs first, and the menu keyword re-enters the menu.
 */

export function createTopicFlow(): Flow {
  const handle = async (
    message: { from: string; body: string },
    context: FlowContext
  ): Promise<FlowOutput> => {
    return {
      replies: [],
      effects: [
        {
          kind: "rag_process",
          sessionId: context.sessionId,
          to: message.from,
          message: message.body,
        },
      ],
      nextState: context.state,
    };
  };

  return { handle };
}
