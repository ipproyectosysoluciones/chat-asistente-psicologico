import { SESSION_STATE } from "@chatcap/shared-types";

import { type Flow, type FlowContext, type FlowOutput } from "./flow";

/**
 * Welcome/menu flow (task 4.2, REQ-CHATBOT-3). Pure flow: first contact
 * presents the welcome + menu options; the menu keyword re-enters the menu
 * from ANY flow state without losing session context (jurisdiction /
 * geoCountry ride along in the next state). Nothing is persisted here —
 * effects stay empty until the consent flow (4.4) and topic dispatch (4.6).
 */

export const WELCOME_TEXT =
  "Hola, soy el asistente de Chat Asistencia Psicológica. Estoy aquí para ofrecerte apoyo e información. Ten en cuenta que no reemplazo a un profesional de la salud.";

export const MENU_TEXT = [
  "¿En qué puedo ayudarte? Elegí una opción:",
  "1. Temas de apoyo",
  "2. Privacidad y consentimiento",
  "3. Crisis o emergencia",
  "",
  "Escribí “menú” en cualquier momento para volver a este menú.",
].join("\n");

export const CHOOSE_OPTION_TEXT =
  "Por favor, elegí una de las opciones del menú (1, 2 o 3) o escribí “menú” para verlo de nuevo.";

export const TOPIC_ENTRY_TEXT =
  "Decime con tus palabras qué tema te gustaría explorar y te comparto información de apoyo.";

const MENU_KEYWORDS = new Set(["menu", "menú"]);

/** Normalized menu-keyword check (case/whitespace insensitive). */
export function isMenuKeyword(body: string): boolean {
  return MENU_KEYWORDS.has(body.trim().toLowerCase());
}

export function createMenuFlow(): Flow {
  const handle = async (
    message: { from: string; body: string },
    context: FlowContext
  ): Promise<FlowOutput> => {
    if (isMenuKeyword(message.body)) {
      return {
        replies: [{ from: message.from, body: MENU_TEXT }],
        effects: [],
        nextState: { ...context.state, state: SESSION_STATE.MENU },
      };
    }

    if (context.state.state === SESSION_STATE.INITIAL) {
      return {
        replies: [
          { from: message.from, body: WELCOME_TEXT },
          { from: message.from, body: MENU_TEXT },
        ],
        effects: [],
        nextState: { state: SESSION_STATE.MENU },
      };
    }

    // "1. Temas de apoyo" (task 4.6): enter the TOPIC state; the next message
    // is processed by the ai-rag service through the rag_process effect.
    if (
      context.state.state === SESSION_STATE.MENU &&
      message.body.trim() === "1"
    ) {
      return {
        replies: [{ from: message.from, body: TOPIC_ENTRY_TEXT }],
        effects: [],
        nextState: { ...context.state, state: SESSION_STATE.TOPIC },
      };
    }

    return {
      replies: [{ from: message.from, body: CHOOSE_OPTION_TEXT }],
      effects: [],
      nextState: context.state,
    };
  };

  return { handle };
}
