import { SESSION_STATE } from "@chatcap/shared-types";

import { type Flow, type FlowContext, type FlowOutput, EMPTY_FLOW_OUTPUT } from "./flow";
import { normalizeText } from "./matching";

/**
 * Crisis flow (task 4.5, REQ-CHATBOT-5, REQ-ALERT-3): an OMS/mhGAP-derived
 * crisis-keyword list (pending final sign-off by a mental-health
 * professional, design assumption 2) matched at ANY flow state triggers the
 * immediate crisis response — grounded text plus local emergency lines by
 * geolocation — and requests a PII-free red alert through the
 * `raise_red_alert` effect. The flow is PURE: the orchestrator publishes the
 * alert and, on publish failure, forces human takeover (REQ-ALERT-4).
 *
 * The matcher is deliberately accent-insensitive and conservative
 * (over-triggering beats a missed crisis); the list lives in ONE place so
 * the professional sign-off edits it without touching flow logic.
 */

/** Multi-word crisis phrases (accent-free; matched anywhere in the text). */
export const CRISIS_PHRASES = [
  "me quiero morir",
  "quiero morir",
  "no quiero vivir",
  "no quiero seguir viviendo",
  "quitarme la vida",
  "quitarse la vida",
  "me voy a matar",
  "pienso en matarme",
  "quiero desaparecer",
  "hacerme dano",
  "no puedo mas",
  "siento que no puedo seguir",
] as const;

/** Single crisis tokens (accent-free; word-boundary prefix match anywhere). */
export const CRISIS_TOKEN_PREFIXES = [
  "suicid", // suicidio, suicidarme, suicidar, suicida
  "matarme",
  "autolesion", // autolesión, autolesiones
  "cortarme",
  "lastimarme",
  "emergencia",
  "crisis",
] as const;

/** Conservative international fallback line (no location context). */
const DEFAULT_CRISIS_LINE =
  "tu línea local de emergencia (112 o 911) o acercarte a la guardia del hospital más cercano";

/** Local emergency lines by ISO-3166 country code (REQ-ALERT-3 geolocation). */
export const CRISIS_LINES_BY_COUNTRY: Record<string, string> = {
  CO: "Línea de Vida (Colombia): 106",
  MX: "Línea de la Vida (México): 800 911 2000",
  US: "988 Suicide & Crisis Lifeline (EE. UU.): 988",
  AR: "Línea de Prevención del Suicidio (Argentina): 135",
  CL: "Salud Responde (Chile): 600 360 7777",
  EU: "Línea de emergencia europea: 112",
  DEFAULT: DEFAULT_CRISIS_LINE,
};

/** Grounded crisis-response text; local lines injected by geolocation. */
export const CRISIS_RESPONSE_INTRO =
  "Estoy acá con vos. Lo que estás sintiendo es importante: si estás en peligro inmediato o pensás en hacerte daño, buscá ayuda YA.";

export function crisisResponseText(lines: string): string {
  return [
    CRISIS_RESPONSE_INTRO,
    "",
    `Ayuda disponible: ${lines}.`,
    "",
    "Llamá ahora a una de estas líneas: hay personas entrenadas para acompañarte. Si querés, un supervisor también puede tomar el chat.",
  ].join("\n");
}

/** Strips diacritics so keywords match regardless of accent input. */
function normalizeCrisisText(body: string): string {
  return normalizeText(body)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function tokenizeCrisis(body: string): string[] {
  return normalizeCrisisText(body)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Returns the matched crisis keyword (phrase or token), if any. */
export function crisisKeywordFor(body: string): string | undefined {
  const normalized = normalizeCrisisText(body);
  for (const phrase of CRISIS_PHRASES) {
    if (normalized.includes(phrase)) {
      return phrase;
    }
  }
  const token = tokenizeCrisis(body).find((candidate) =>
    CRISIS_TOKEN_PREFIXES.some((prefix) => candidate.startsWith(prefix))
  );
  return token;
}

/** True when the message contains a crisis keyword (REQ-CHATBOT-5). */
export function isCrisisKeyword(body: string): boolean {
  return crisisKeywordFor(body) !== undefined;
}

/** Local emergency line for a country code, conservative DEFAULT otherwise. */
export function crisisLinesFor(country: string | undefined): string {
  return (
    (country !== undefined ? CRISIS_LINES_BY_COUNTRY[country] : undefined) ??
    DEFAULT_CRISIS_LINE
  );
}

export function createCrisisFlow(): Flow {
  const handle = async (
    message: { from: string; body: string },
    context: FlowContext
  ): Promise<FlowOutput> => {
    const keyword = crisisKeywordFor(message.body);
    if (keyword === undefined) {
      return EMPTY_FLOW_OUTPUT;
    }
    const country = context.state.geoCountry ?? context.jurisdiction;
    return {
      replies: [{ from: message.from, body: crisisResponseText(crisisLinesFor(country)) }],
      effects: [
        { kind: "raise_red_alert", sessionId: context.sessionId, keyword },
      ],
      nextState: { ...context.state, state: SESSION_STATE.CRISIS },
    };
  };

  return { handle };
}
