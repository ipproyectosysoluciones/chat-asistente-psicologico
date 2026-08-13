import type { PersistenceClass, Session } from "@chatcap/shared-types";

/**
 * Database pillar of the three-pillar contract (design §4.1): the sink for
 * flow effects and the source for session context. The orchestrator depends
 * on this interface, never on pg — same configuration-only swap contract as
 * the provider pillar.
 */

/** One conversation turn persisted to the history sink (REQ-CHATBOT-2). */
export interface HistoryEntry {
  sessionId: string;
  sender: "user" | "bot";
  text: string;
  persistenceClass: PersistenceClass;
  purgeAt?: string;
}

export interface ChatDatabase {
  findOrCreateSession(contactKeyAnon: string): Promise<Session>;
  setSessionJurisdiction(
    sessionId: string,
    jurisdiction: string
  ): Promise<Session>;
  setSessionAiState(
    sessionId: string,
    aiState: Session["aiState"]
  ): Promise<Session>;
  /** Best-effort sink: must never throw the message flow on failure. */
  saveHistoryEntry(entry: HistoryEntry): Promise<void>;
  ping(): Promise<void>;
}
