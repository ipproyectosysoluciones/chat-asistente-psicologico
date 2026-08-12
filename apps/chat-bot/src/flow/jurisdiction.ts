import { SESSION_STATE } from "@chatcap/shared-types";

import { KNOWN_COUNTRY_CODES, resolveJurisdiction } from "../jurisdiction";
import { type GeoResolver } from "../geo/resolver";
import { type Flow, type FlowContext, type FlowOutput } from "./flow";

/**
 * Jurisdiction flow (task 4.3, REQ-CONSENT-1/6): proposes the legal framework
 * derived from the geo-resolved country, waits for EXPLICIT user confirmation
 * before persisting anything, and handles the two exceptional paths — a stated
 * country that differs from the geo country (VPN: PII-stripped discrepancy log,
 * stated country wins) and an unresolvable jurisdiction (conservative DEFAULT
 * + legal-review flag). The geo pillar is injected so the flow stays pure and
 * provider-swappable.
 */

export const GEO_PROPOSAL_PREFIX = "Según tu ubicación, tu jurisdicción legal sería: ";

export const JURISDICTION_CONFIRMED =
  "Jurisdicción confirmada. Ahora podemos continuar con tu privacidad y consentimiento.";

const CONFIRM_PHRASES = ["sí", "si", "confirmo", "confirmar", "acepto", "aceptar", "de acuerdo", "ok"];

const UNKNOWN_PHRASES = ["no sé", "no se", "no lo sé", "no lo se", "desconozco", "no tengo idea"];

/** Accent-insensitive lowercase normalization for matching user replies. */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/**
 * Negation prefixes that MUST win over any affirmative phrase (consent flow —
 * REQ-CONSENT-1/6). "no estoy de acuerdo", "no acepto", "no confirmo" are
 * refusals, never consent.
 */
const NEGATION_PREFIXES = ["no ", "nop ", "tampoco "];

/** Token-boundary match: `si` inside "sindrome" must NOT confirm. */
function hasPhrase(input: string, phrase: string): boolean {
  const words = normalize(input).split(/[^a-z0-9]+/).filter(Boolean);
  const phraseWords = normalize(phrase).split(/[^a-z0-9]+/).filter(Boolean);
  if (phraseWords.length === 0) {
    return false;
  }
  return words.some((_, i) =>
    phraseWords.every((word, j) => words[i + j] === word)
  );
}

function isNegation(body: string): boolean {
  const normalized = normalize(body);
  return NEGATION_PREFIXES.some((prefix) => normalized.startsWith(prefix)) || normalized === "no";
}

function isConfirmation(body: string): boolean {
  const normalized = normalize(body);
  if (isNegation(normalized)) {
    return false;
  }
  return CONFIRM_PHRASES.some((phrase) => hasPhrase(normalized, phrase));
}

function isUnknown(body: string): boolean {
  const normalized = normalize(body);
  return UNKNOWN_PHRASES.some((phrase) => normalized.includes(phrase));
}

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  colombia: "CO",
  mexico: "MX",
  "estados unidos": "US",
  eeuu: "US",
  usa: "US",
  argentina: "AR",
  chile: "CL",
  españa: "ES",
  alemania: "DE",
  francia: "FR",
  italia: "IT",
  portugal: "PT",
  "paises bajos": "NL",
  holanda: "NL",
  belgica: "BE",
  austria: "AT",
  irlanda: "IE",
  suecia: "SE",
  dinamarca: "DK",
  finlandia: "FI",
  polonia: "PL",
  grecia: "GR",
};

/** Extracts an ISO-3166 alpha-2 country code from a free-text reply. */
export function parseCountryCode(body: string): string | undefined {
  const normalized = normalize(body);
  for (const [name, code] of Object.entries(COUNTRY_NAME_TO_CODE)) {
    if (normalized.includes(name)) {
      return code;
    }
  }
  // Accept a bare 2-letter code only when it resolves to a known framework
  // (mirror of KNOWN_COUNTRY_CODES — no guessing for arbitrary codes).
  const token = normalized.replace(/[^a-z]+/g, "").toUpperCase();
  if (KNOWN_COUNTRY_CODES.has(token)) {
    return token;
  }
  return undefined;
}

export interface JurisdictionFlowDeps {
  geoResolver: GeoResolver;
}

export function createJurisdictionFlow(deps: JurisdictionFlowDeps): Flow {
  const propose = async (
    message: { from: string },
    context: FlowContext
  ): Promise<FlowOutput> => {
    const geoCountry = await deps.geoResolver.resolveCountry(context.remoteIp ?? "");
    const resolved = resolveJurisdiction(geoCountry);
    return {
      replies: [{ from: message.from, body: `${GEO_PROPOSAL_PREFIX}${resolved.name}.` }],
      effects: [],
      nextState: {
        ...context.state,
        state: SESSION_STATE.AWAITING_JURISDICTION,
        geoCountry,
        proposedJurisdiction: resolved.jurisdiction,
      },
    };
  };

  const confirmProposed = (
    proposedJurisdiction: string,
    message: { from: string },
    context: FlowContext
  ): FlowOutput => {
    const resolved = resolveJurisdiction(proposedJurisdiction);
    return {
      replies: [
        { from: message.from, body: `${JURISDICTION_CONFIRMED} (${resolved.name}).` },
      ],
      effects: [
        {
          kind: "persist_jurisdiction",
          sessionId: context.sessionId,
          jurisdiction: proposedJurisdiction,
        },
      ],
      nextState: {
        ...context.state,
        state: SESSION_STATE.MENU,
        jurisdiction: proposedJurisdiction,
      },
    };
  };

  const applyStatedCountry = (
    stated: string,
    message: { from: string },
    context: FlowContext
  ): FlowOutput => {
    const resolved = resolveJurisdiction(stated);
    const effects: FlowOutput["effects"] = [];
    if (context.state.geoCountry !== undefined && stated !== context.state.geoCountry) {
      effects.push({
        kind: "log_vpn_discrepancy",
        sessionId: context.sessionId,
        geoCountry: context.state.geoCountry,
        statedCountry: stated,
      });
    }
    effects.push({
      kind: "persist_jurisdiction",
      sessionId: context.sessionId,
      jurisdiction: resolved.jurisdiction,
    });
    return {
      replies: [{ from: message.from, body: `${JURISDICTION_CONFIRMED} (${resolved.name}).` }],
      effects,
      nextState: {
        ...context.state,
        state: SESSION_STATE.MENU,
        jurisdiction: resolved.jurisdiction,
      },
    };
  };

  const applyDefault = (
    message: { from: string },
    context: FlowContext
  ): FlowOutput => {
    const resolved = resolveJurisdiction(undefined);
    return {
      replies: [
        {
          from: message.from,
          body: "No pudimos determinar tu jurisdicción. Aplicaremos el marco más conservador para proteger tu información.",
        },
      ],
      effects: [
        { kind: "flag_legal_review", sessionId: context.sessionId, jurisdiction: resolved.jurisdiction },
        { kind: "persist_jurisdiction", sessionId: context.sessionId, jurisdiction: resolved.jurisdiction },
      ],
      nextState: {
        ...context.state,
        state: SESSION_STATE.MENU,
        jurisdiction: resolved.jurisdiction,
      },
    };
  };

  const handle = async (
    message: { from: string; body: string },
    context: FlowContext
  ): Promise<FlowOutput> => {
    if (context.state.state === SESSION_STATE.INITIAL) {
      return propose(message, context);
    }

    if (context.state.state !== SESSION_STATE.AWAITING_JURISDICTION) {
      return { replies: [], effects: [], nextState: context.state };
    }

    const { proposedJurisdiction } = context.state;

    if (proposedJurisdiction !== undefined && isConfirmation(message.body)) {
      return confirmProposed(proposedJurisdiction, message, context);
    }

    // A negation ("no estoy de acuerdo", bare "no") is a refusal to confirm:
    // never treated as consent, falls back to the conservative DEFAULT.
    if (isNegation(message.body)) {
      return applyDefault(message, context);
    }

    const stated = parseCountryCode(message.body);
    if (stated !== undefined) {
      return applyStatedCountry(stated, message, context);
    }

    if (isUnknown(message.body)) {
      return applyDefault(message, context);
    }

    if (proposedJurisdiction === undefined && context.state.geoCountry === undefined) {
      return propose(message, context);
    }

    return {
      replies: [
        {
          from: message.from,
          body: "No entendí tu respuesta. Confirmá tu jurisdicción o escribí tu país.",
        },
      ],
      effects: [],
      nextState: context.state,
    };
  };

  return { handle };
}
