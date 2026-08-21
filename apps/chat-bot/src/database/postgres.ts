import { serializePayload, type Encryptor } from "@chatcap/crypto-keys";
import type { Session } from "@chatcap/shared-types";
import type { DbQueryable } from "@chatcap/db-schema";
import {
  findContactPhoneBySession,
  getSession,
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
export interface ChatLogger {
  warn(message: string, meta: Record<string, unknown>): void;
}

export interface PostgresChatDatabaseOptions {
  /**
   * When set, HC history rows are encrypted at rest under the active key
   * version (task 4.9, REQ-CONSENT-5); anonymous rows always stay plaintext.
   */
  historyEncryptor?: Encryptor;
  /** Resolves the current active key version; undefined degrades to plaintext. */
  activeKeyVersion?: () => Promise<number | undefined>;
  /**
   * PII-free warning sink: an HC turn that degrades to plaintext is always
   * surfaced (never silent), so an operator notices encryption misconfig.
   */
  logger?: ChatLogger;
}

export class PostgresChatDatabase implements ChatDatabase {
  constructor(
    private readonly db: DbQueryable,
    private readonly options: PostgresChatDatabaseOptions = {}
  ) {}

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

  getSession(sessionId: string): Promise<Session | undefined> {
    return getSession(this.db, sessionId);
  }

  resolveContactPhone(sessionId: string): Promise<string | undefined> {
    return findContactPhoneBySession(this.db, sessionId);
  }

  async saveHistoryEntry(entry: HistoryEntry): Promise<void> {
    // HC turns are stored encrypted at rest (REQ-CONSENT-5); anonymous turns
    // and HC without an active key degrade to the plaintext sink — the sink
    // must never throw the message flow (best-effort contract).
    if (entry.persistenceClass === "hc") {
      if (this.options.historyEncryptor === undefined) {
        this.warnUnencryptedHc(entry.sessionId);
      } else {
        const keyVersion = await this.options.activeKeyVersion?.();
        if (keyVersion === undefined) {
          this.warnUnencryptedHc(entry.sessionId);
        } else {
          const encrypted = await this.options.historyEncryptor.encrypt(
            Buffer.from(JSON.stringify({ text: entry.text }), "utf8"),
            keyVersion
          );
          await saveHistoryEntry(this.db, {
            sessionId: entry.sessionId,
            sender: entry.sender,
            text: serializePayload(encrypted),
            persistenceClass: entry.persistenceClass,
            purgeAt: entry.purgeAt,
            keyVersion,
            integrityHash: encrypted.hmac.toString("hex"),
          });
          return;
        }
      }
    }
    await saveHistoryEntry(this.db, entry);
  }

  private warnUnencryptedHc(sessionId: string): void {
    this.options.logger?.warn(
      "hc_history_plaintext_degradation",
      {
        sessionId,
        // Intentionally PII-free: never log message content or clinical data.
        sink: "plaintext",
      }
    );
  }

  async ping(): Promise<void> {
    await this.db.query("SELECT 1");
  }
}
