import type { ChatMessage } from "@chatcap/shared-types";
import { SESSION_STATE } from "@chatcap/shared-types";

import { type Flow, type FlowContext, type FlowOutput } from "./flow";
import { WELCOME_TEXT } from "./menu";

/**
 * Placeholder flow for the task 4.1 scaffold, kept as a deterministic double
 * for orchestrator tests. The real dialogue flow is `createMenuFlow` (task
 * 4.2, REQ-CHATBOT-3), which the composition root wires in production.
 */

export { WELCOME_TEXT };

export function createScaffoldFlow(): Flow {
  const handle = async (
    message: ChatMessage,
    _context: FlowContext
  ): Promise<FlowOutput> => {
    return {
      replies: [{ from: message.from, body: WELCOME_TEXT }],
      effects: [],
      nextState: { state: SESSION_STATE.MENU },
    };
  };

  return { handle };
}
