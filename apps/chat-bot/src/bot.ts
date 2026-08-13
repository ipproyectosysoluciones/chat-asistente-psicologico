import type { Session } from "@chatcap/shared-types";
import type { EventEmitter, Logger } from "@chatcap/telemetry";

import { buildAlertRaisedEvent } from "./alerts";
import { hashContactKey } from "./contact-key";
import type { ChatDatabase } from "./database/database";
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
 * find-or-create, sending replies, applying effects and persisting flow
 * state. Never logs message content (the telemetry logger redacts it anyway;
 * this module simply never passes it).
 */

/** Fixed, PII-free reply when a message cannot be processed safely. */
export const PROCESSING_ERROR_TEXT =
  "Hubo un problema al procesar tu mensaje. Por favor, inténtalo de nuevo en unos minutos.";

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

  async function applyEffects(effects: FlowEffect[]): Promise<void> {
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
      runtime.logger.debug("provider lifecycle event", { type: event.type });
      return;
    }
    const { from, body, remoteIp } = event.message;
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
      await applyEffects(output.effects);
      if (output.nextState !== undefined) {
        await stateStore.set(contactKeyAnon, output.nextState);
      }
    } catch (error) {
      runtime.logger.error("chat: flow handling failed", {
        error: String(error),
      });
      await pillars.provider.sendText(from, PROCESSING_ERROR_TEXT);
    }
  };

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
