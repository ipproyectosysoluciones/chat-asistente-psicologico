import type { ChatMessage } from "@chatcap/shared-types";

/**
 * Provider pillar of the three-pillar contract (design §8, REQ-CHATBOT-1):
 * Baileys ↔ Meta is a configuration-only swap. The provider owns the channel
 * transport (WebSocket sessions, HTTP Cloud API, webhooks) and exposes a
 * minimal surface to the orchestrator. It never sees flow logic or the
 * database — the orchestrator wires the three pillars together.
 */

export type ChatProviderEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "reconnecting" }
  | { type: "reconnected" }
  | { type: "auth_failure"; reason?: string };

export type ChatEventHandler = (
  event: ChatProviderEvent
) => Promise<void> | void;

export interface ChatProvider {
  readonly kind: "baileys" | "meta" | "mock";
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(to: string, text: string): Promise<void>;
  /** Registers the single inbound handler; the provider calls it on events. */
  onEvent(handler: ChatEventHandler): void;
  isConnected(): Promise<boolean>;
}
