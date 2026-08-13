import { randomUUID } from "node:crypto";

import type { Session } from "@chatcap/shared-types";

import type { ChatDatabase } from "./database";

/**
 * In-memory ChatDatabase double for tests and mock local dev. Mirrors the
 * postgres adapter semantics (find-or-create by contact key, jurisdiction
 * update) without a server, so the full bot pipeline is testable.
 */
export class MemoryChatDatabase implements ChatDatabase {
  private readonly sessions = new Map<string, Session>();
  private pingCount = 0;

  get pingCountValue(): number {
    return this.pingCount;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  async findOrCreateSession(contactKeyAnon: string): Promise<Session> {
    const existing = [...this.sessions.values()].find(
      (session) => session.contactKeyAnon === contactKeyAnon
    );
    if (existing !== undefined) {
      return { ...existing, lastActivityAt: new Date().toISOString() };
    }
    const now = new Date();
    const session: Session = {
      id: randomUUID(),
      contactKeyAnon,
      persistenceClass: "anonymous",
      consentState: "notice_shown",
      aiState: "auto",
      createdAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
      purgeAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async setSessionJurisdiction(
    sessionId: string,
    jurisdiction: string
  ): Promise<Session> {
    const current = this.sessions.get(sessionId);
    if (current === undefined) {
      throw new Error(`memory-chat-db: session not found: ${sessionId}`);
    }
    const updated: Session = { ...current, jurisdiction };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async setSessionAiState(
    sessionId: string,
    aiState: Session["aiState"]
  ): Promise<Session> {
    const current = this.sessions.get(sessionId);
    if (current === undefined) {
      throw new Error(`memory-chat-db: session not found: ${sessionId}`);
    }
    const updated: Session = { ...current, aiState };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  async ping(): Promise<void> {
    this.pingCount += 1;
  }
}
