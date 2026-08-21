import type { ChatMessage, SessionState } from "@chatcap/shared-types";

/**
 * Flow pillar of the three-pillar contract (design §4.2, REQ-CHATBOT-1).
 * A `Flow` is a PURE function: it turns a chat message + session context into
 * replies, effects and the next persisted state. It never touches the
 * provider, the database or the clock directly — the bot orchestrator
 * (`createBot`) owns sending replies and applying effects. This purity is
 * what makes the whole dialogue testable without a WhatsApp session.
 */

/** Persistable per-session flow state (the dialogue state machine). */
export interface FlowState {
  state: SessionState;
  /** Resolved legal jurisdiction (REQ-CHATBOT-3), set by the onboarding step. */
  jurisdiction?: string;
  /** Country detected by the geo provider, if any (never a raw IP). */
  geoCountry?: string;
  /** Jurisdiction proposed to the user, pending explicit confirmation (task 4.3). */
  proposedJurisdiction?: string;
}

/**
 * Side effects the flow requests. Discriminated union — the orchestrator
 * maps each kind to a database write or a PII-stripped log line.
 */
export type FlowEffect =
  | {
      kind: "persist_jurisdiction";
      sessionId: string;
      jurisdiction: string;
    }
  | {
      kind: "log_vpn_discrepancy";
      sessionId: string;
      geoCountry: string;
      statedCountry: string;
    }
  | {
      kind: "flag_legal_review";
      sessionId: string;
      jurisdiction: string;
    }
  | {
      kind: "raise_red_alert";
      sessionId: string;
      /** Matched crisis keyword — PII-free (REQ-ALERT-6, task 4.5). */
      keyword: string;
    }
  | {
      kind: "rag_process";
      sessionId: string;
      /** Recipient of the grounded emission (the original sender). */
      to: string;
      /** User message to process via ai-rag (task 4.6, REQ-CHATBOT-2). */
      message: string;
    };

export interface FlowContext {
  sessionId: string;
  /** Anonymized contact key (sha256 of provider id + pepper) — not PII. */
  contactKeyAnon: string;
  /** Jurisdiction persisted on the session row, if already resolved. */
  jurisdiction?: string;
  remoteIp?: string;
  state: FlowState;
}

export interface FlowOutput {
  /** Messages to send back; `from` is the recipient (the original sender). */
  replies: ChatMessage[];
  effects: FlowEffect[];
  /** State to persist; omit to keep the previous state unchanged. */
  nextState?: FlowState;
}

export interface Flow {
  handle(message: ChatMessage, context: FlowContext): Promise<FlowOutput>;
}

export const EMPTY_FLOW_OUTPUT: FlowOutput = {
  replies: [],
  effects: [],
};
