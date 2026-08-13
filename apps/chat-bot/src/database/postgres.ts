import type { Session } from "@chatcap/shared-types";
import type { DbQueryable } from "@chatcap/db-schema";
import {
  saveHistoryEntry,
  setSessionAiState,
  setSessionJurisdiction,
  upsertSession,
} from "@chatcap/db-schema";

import type { ChatDatabase, HistoryEntry } from "./database";

/**
 * PostgreSQL ChatDatabase adapter over the shared db-schema repositories
 * (design §4.1). The `DbQueryable` is structural (pg Pool or a fake), so the
 * adapter is testable without a live database and swappable at wiring time.
 */
export class PostgresChatDatabase implements ChatDatabase {
  constructor(private readonly db: DbQueryable) {}

  findOrCreateSession(contactKeyAnon: string): Promise<Session> {
    return upsertSession(this.db, { contactKeyAnon });
  }

  setSessionJurisdiction(
    sessionId: string,
    jurisdiction: string
  ): Promise<Session> {
    return setSessionJurisdiction(this.db, sessionId, jurisdiction);
  }

  setSessionAiState(
    sessionId: string,
    aiState: Session["aiState"]
  ): Promise<Session> {
    return setSessionAiState(this.db, sessionId, aiState);
  }

  saveHistoryEntry(entry: HistoryEntry): Promise<void> {
    return saveHistoryEntry(this.db, entry);
  }

  async ping(): Promise<void> {
    await this.db.query("SELECT 1");
  }
}
