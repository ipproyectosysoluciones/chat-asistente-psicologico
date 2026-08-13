import type { Session } from "@chatcap/shared-types";

/**
 * Database pillar of the three-pillar contract (design §4.1): the sink for
 * flow effects and the source for session context. The orchestrator depends
 * on this interface, never on pg — same configuration-only swap contract as
 * the provider pillar.
 */
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
  ping(): Promise<void>;
}
