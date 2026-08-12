import type { ChatMessage } from "@chatcap/shared-types";
import { SESSION_STATE } from "@chatcap/shared-types";

import { type Flow, type FlowContext, type FlowOutput } from "./flow";

/**
 * Placeholder flow for the task 4.1 scaffold. It proves the message pipeline
 * end-to-end (provider event → flow → sendText) with a static welcome and no
 * side effects. Replaced by the real menu flow in task 4.2.
 */

export const WELCOME_TEXT =
  "Hola, soy el asistente de Chat Asistencia Psicológica. Estoy aquí para ofrecerte apoyo e información. Ten en cuenta que no reemplazo a un profesional de la salud.";

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
