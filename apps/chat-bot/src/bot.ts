import { ALERT_LEVEL, type ChatMessage, type Session } from "@chatcap/shared-types";
import type { EventEmitter, Logger } from "@chatcap/telemetry";

import { buildAlertRaisedEvent } from "./alerts";
import { type AiRagClient, type RagOutcome, RagUpstreamError } from "./ai-rag-client";
import { hashContactKey } from "./contact-key";
import { type ChatDatabase, type HistoryEntry } from "./database/database";
import { type Flow, type FlowContext, type FlowEffect, type FlowState } from "./flow/flow";
import {
  InMemoryFlowStateStore,
  type FlowStateStore,
} from "./flow/state-store";
import type { ChatEventHandler, ChatProvider, ChatProviderEvent } from "./provider/provider";

/**
 * Bot orchestrator (task 4.1, REQ-CHATBOT-1): wires the three pillars
 * (Flow / Provider / Database) so each stays swappable. The flow is PURE —
 * this module owns every side effect: hashing contact ids, session
 * find-or-create, sending replies, applying effects, persisting flow state
 * and running the message lifecycle (RAG + history sink, task 4.6). Never
 * logs message content (the telemetry logger redacts it anyway; this module
 * simply never passes it).
 */

/** Fixed, PII-free reply when a message cannot be processed safely. */
export const PROCESSING_ERROR_TEXT =
  "Hubo un problema al procesar tu mensaje. Por favor, inténtalo de nuevo en unos minutos.";

/** Emission kill switch active (AI_EMISSION_ENABLED=false): human-only. */
export const AI_DISABLED_TEXT =
  "En este momento el asistente automático está desactivado. Un supervisor puede tomar el chat para acompañarte; escribí cualquier cosa y lo conectamos.";

/** ai-rag degraded/unreachable: fall back to human-only, never ungrounded. */
export const RAG_UNAVAILABLE_TEXT =
  "En este momento no puedo responder automáticamente. Un supervisor puede tomar el chat; escribí cualquier cosa y lo conectamos.";

export interface BotRuntime {
  logger: Logger;
  /** Pepper for contact-key hashing (min 16 chars, per-deploy). */
  contactKeySalt: string;
  stateStore?: FlowStateStore;
  /**
   * Redis pub-sub emitter for PII-free alert events (task 4.5). When the
   * crisis flow raises a red alert and publishing fails, the session is
   * forced to human takeover so escalation never depends on one channel
   * (REQ-ALERT-4).
   */
  emitter?: EventEmitter;
  /** ai-rag client (task 4.6). Absent → degraded human-only lifecycle. */
  aiRag?: AiRagClient;
  /**
   * Emission kill switch (AI_EMISSION_ENABLED). Defaults to enabled; when
   * false no AI call is made and the user gets the human-only text.
   */
  aiEmissionEnabled?: boolean;
}

export interface Bot {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BotPillars {
  flow: Flow;
  provider: ChatProvider;
  database: ChatDatabase;
}

export function createBot(pillars: BotPillars, runtime: BotRuntime): Bot {
  const stateStore = runtime.stateStore ?? new InMemoryFlowStateStore();
  const aiEmissionEnabled = runtime.aiEmissionEnabled ?? true;

  /** Best-effort history sink (REQ-CHATBOT-2): a failed write is logged, never fatal. */
  async function persistHistory(
    session: Session,
    entry: { sessionId: string; sender: HistoryEntry["sender"]; text: string }
  ): Promise<void> {
    try {
      await pillars.database.saveHistoryEntry({
        sessionId: entry.sessionId,
        sender: entry.sender,
        text: entry.text,
        persistenceClass: session.persistenceClass,
        purgeAt: session.purgeAt,
      });
    } catch (error) {
      runtime.logger.error("chat: history sink write failed", {
        error: String(error),
      });
    }
  }

  /**
   * Message lifecycle for the rag_process effect (task 4.6, REQ-CHATBOT-2,
   * design §4.2.4): kill-switch check → ai-rag call → gate routing → grounded
   * emission → history sink. Ungrounded LLM output is NEVER emitted: blocked
   * outcomes send the RAG-provided fallback, and ai-rag being down switches
   * the session to human-only text (the human takeover can be requested with
   * any follow-up message).
   */
  async function runRagLifecycle(effect: { sessionId: string; to: string; message: string }, session: Session): Promise<void> {
    await persistHistory(session, {
      sessionId: effect.sessionId,
      sender: "user",
      text: effect.message,
    });

    if (!aiEmissionEnabled) {
      runtime.logger.warn("chat: ai emission disabled by kill switch; human-only");
      await pillars.provider.sendText(effect.to, AI_DISABLED_TEXT);
      await persistHistory(session, {
        sessionId: effect.sessionId,
        sender: "bot",
        text: AI_DISABLED_TEXT,
      });
      return;
    }

    if (runtime.aiRag === undefined) {
      runtime.logger.error("chat: ai-rag client not configured; degraded human-only");
      await pillars.provider.sendText(effect.to, RAG_UNAVAILABLE_TEXT);
      await persistHistory(session, {
        sessionId: effect.sessionId,
        sender: "bot",
        text: RAG_UNAVAILABLE_TEXT,
      });
      return;
    }

    let outcome: RagOutcome;
    try {
      outcome = await runtime.aiRag.process({
        sessionId: effect.sessionId,
        message: effect.message,
      });
    } catch (error) {
      runtime.logger.error("chat: ai-rag process failed; degraded human-only", {
        error: String(error),
        isUpstream: error instanceof RagUpstreamError,
      });
      await pillars.provider.sendText(effect.to, RAG_UNAVAILABLE_TEXT);
      await persistHistory(session, {
        sessionId: effect.sessionId,
        sender: "bot",
        text: RAG_UNAVAILABLE_TEXT,
      });
      return;
    }

    // Coherence-gate routing (REQ-RAG-4/5/6): emitted/flagged are grounded
    // answers; blocked/crisis carry a safe fallback and are never free-form.
    const text =
      outcome.kind === "emitted" || outcome.kind === "flagged"
        ? outcome.answer
        : outcome.fallbackText;
    await pillars.provider.sendText(effect.to, text);
    await persistHistory(session, {
      sessionId: effect.sessionId,
      sender: "bot",
      text,
    });
  }

  async function applyEffects(effects: FlowEffect[], session: Session): Promise<void> {
    for (const effect of effects) {
      switch (effect.kind) {
        case "persist_jurisdiction":
          await pillars.database.setSessionJurisdiction(
            effect.sessionId,
            effect.jurisdiction
          );
          break;
        case "log_vpn_discrepancy":
          // Country codes are not PII; the raw IP never reaches this line.
          runtime.logger.warn(
            "jurisdiction discrepancy: VPN detected between geo and stated country",
            { geoCountry: effect.geoCountry, statedCountry: effect.statedCountry }
          );
          break;
        case "flag_legal_review":
          runtime.logger.warn(
            "jurisdiction could not be resolved; conservative default applied",
            { jurisdiction: effect.jurisdiction }
          );
          break;
        case "raise_red_alert":
          await raiseRedAlert(effect);
          break;
        case "rag_process":
          await runRagLifecycle(effect, session);
          break;
      }
    }
  }

  async function raiseRedAlert(effect: {
    sessionId: string;
    keyword: string;
  }): Promise<void> {
    // REQ-ALERT-4: escalation must not depend on WhatsApp. If the alert
    // cannot be published, hand the session to a human (AI disabled).
    if (runtime.emitter === undefined) {
      runtime.logger.error("chat: red alert skipped; no event emitter configured");
      await pillars.database.setSessionAiState(effect.sessionId, "takeover");
      return;
    }
    try {
      await runtime.emitter.publish(
        buildAlertRaisedEvent({
          sessionId: effect.sessionId,
          level: "red",
          category: "crisis",
          keyword: effect.keyword,
        })
      );
    } catch (error) {
      runtime.logger.error("chat: red alert raise failed; forcing takeover", {
        error: String(error),
      });
      await pillars.database.setSessionAiState(effect.sessionId, "takeover");
    }
  }

  const handleEvent: ChatEventHandler = async (event: ChatProviderEvent) => {
    if (event.type !== "message") {
      await handleLifecycleEvent(event);
      return;
    }
    await handleInboundMessage(event.message);
  };

  /**
   * Provider lifecycle events (task 4.7, REQ-CHATBOT-8). Retriable drops are
   * handled by the provider's own reconnect loop; here we only log them. An
   * unrecoverable `auth_failure` escalates through the notifications service
   * so the supervisor is told on a channel independent of WhatsApp (the
   * fallback Telegram/Web path, REQ-ALERT-4) — the WhatsApp channel is the
   * one that just died. Pending history is never lost: the history sink
   * persists each message before the next is processed, so there is no
   * in-flight buffer to drop across a reconnect.
   */
  async function handleLifecycleEvent(
    event: Extract<ChatProviderEvent, { type: "auth_failure" | "reconnecting" | "reconnected" }>
  ): Promise<void> {
    switch (event.type) {
      case "auth_failure":
        await notifySupervisorOfAuthFailure(event.reason);
        break;
      case "reconnecting":
        runtime.logger.info("chat: provider reconnecting");
        break;
      case "reconnected":
        runtime.logger.info("chat: provider reconnected; resuming message processing");
        break;
    }
  }

  async function notifySupervisorOfAuthFailure(reason?: string): Promise<void> {
    if (runtime.emitter === undefined) {
      runtime.logger.error(
        "chat: auth_failure not escalated; no event emitter configured"
      );
      return;
    }
    try {
      await runtime.emitter.publish(
        buildAlertRaisedEvent({
          sessionId: `provider:${pillars.provider.kind}`,
          level: ALERT_LEVEL.ORANGE,
          category: "session",
          keyword: "auth_failure",
        })
      );
    } catch (error) {
      runtime.logger.error("chat: auth_failure escalation publish failed", {
        error: String(error),
        reason,
      });
    }
  }

  async function handleInboundMessage(message: ChatMessage): Promise<void> {
    const { from, body, remoteIp } = message;
    const contactKeyAnon = hashContactKey(from, runtime.contactKeySalt);

    let session: Session;
    try {
      session = await pillars.database.findOrCreateSession(contactKeyAnon);
    } catch (error) {
      runtime.logger.error("chat: session lookup failed", { error: String(error) });
      await pillars.provider.sendText(from, PROCESSING_ERROR_TEXT);
      return;
    }

    let state: FlowState;
    try {
      state =
        (await stateStore.get(contactKeyAnon)) ?? { state: "initial" as const };
    } catch (error) {
      // A state-store outage must not drop the message or reject the event
      // (BaileysProvider.dispatch fires-and-forgets): fall back to a fresh
      // initial state and let the flow re-onboard the user.
      runtime.logger.error("chat: state store read failed", {
        error: String(error),
      });
      state = { state: "initial" as const };
    }

    const context: FlowContext = {
      sessionId: session.id,
      contactKeyAnon,
      jurisdiction: session.jurisdiction,
      remoteIp,
      state,
    };

    try {
      const output = await pillars.flow.handle(
        { from, body, remoteIp },
        context
      );
      for (const reply of output.replies) {
        await pillars.provider.sendText(reply.from, reply.body);
      }
      await applyEffects(output.effects, session);
      if (output.nextState !== undefined) {
        await stateStore.set(contactKeyAnon, output.nextState);
      }
    } catch (error) {
      runtime.logger.error("chat: flow handling failed", {
        error: String(error),
      });
      await pillars.provider.sendText(from, PROCESSING_ERROR_TEXT);
    }
  }

  return {
    async start(): Promise<void> {
      pillars.provider.onEvent(handleEvent);
      await pillars.provider.start();
    },
    async stop(): Promise<void> {
      await pillars.provider.stop();
    },
  };
}
