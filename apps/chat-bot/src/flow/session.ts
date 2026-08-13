import { SESSION_STATE } from "@chatcap/shared-types";

import { type Flow, type FlowContext, type FlowOutput } from "./flow";
import { MENU_TEXT, WELCOME_TEXT } from "./menu";

/**
 * Session flow composition (task 4.3, extended 4.5): routes by state. First
 * contact shows the welcome + menu AND the jurisdiction proposal
 * (REQ-CHATBOT-3 first contact, REQ-CONSENT-1/6), moving to
 * AWAITING_JURISDICTION; the jurisdiction conversation is handled by the
 * jurisdiction flow. The crisis guard runs FIRST at every state: a crisis
 * keyword (REQ-CHATBOT-5) wins over whatever the session was doing, so the
 * immediate crisis response is never blocked by an unfinished onboarding.
 * Every other state falls back to the menu flow (keyword re-entry preserved).
 */

export interface SessionFlowDeps {
  menu: Flow;
  jurisdiction: Flow;
  crisis: Flow;
}

export function createSessionFlow(deps: SessionFlowDeps): Flow {
  const handle = async (
    message: { from: string; body: string },
    context: FlowContext
  ): Promise<FlowOutput> => {
    // Crisis guard: matched keywords win at ANY state (REQ-CHATBOT-5).
    const crisisOutput = await deps.crisis.handle(message, context);
    if (crisisOutput.replies.length > 0) {
      return crisisOutput;
    }

    const { state } = context;

    if (state.state === SESSION_STATE.AWAITING_JURISDICTION) {
      return deps.jurisdiction.handle(message, context);
    }

    if (state.state === SESSION_STATE.INITIAL) {
      const output = await deps.jurisdiction.handle(message, context);
      return {
        ...output,
        replies: [
          { from: message.from, body: WELCOME_TEXT },
          { from: message.from, body: MENU_TEXT },
          ...output.replies,
        ],
      };
    }

    return deps.menu.handle(message, context);
  };

  return { handle };
}
