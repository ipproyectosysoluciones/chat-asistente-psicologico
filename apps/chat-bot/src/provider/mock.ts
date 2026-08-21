import type { ChatMessage } from "@chatcap/shared-types";

import type {
  ChatEventHandler,
  ChatProvider,
  ChatProviderEvent,
} from "./provider";

export interface SentMessage {
  to: string;
  text: string;
}

/**
 * Deterministic provider double (design §8: provider is a swappable pillar).
 * Records outbound messages and lets tests inject inbound events, so the full
 * event → flow → sendText pipeline is exercised without a real WhatsApp
 * session. In dev, `CHATBOT_PROVIDER=mock` runs the whole service locally.
 */
export class MockProvider implements ChatProvider {
  readonly kind = "mock" as const;
  readonly sentMessages: SentMessage[] = [];
  private handler: ChatEventHandler | undefined;
  private started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async sendText(to: string, text: string): Promise<void> {
    this.sentMessages.push({ to, text });
  }

  onEvent(handler: ChatEventHandler): void {
    this.handler = handler;
  }

  async isConnected(): Promise<boolean> {
    return this.started;
  }

  /** Test hook: push an inbound event through the registered handler. */
  async emit(event: ChatProviderEvent): Promise<void> {
    if (this.handler === undefined) {
      throw new Error("MockProvider: no event handler registered");
    }
    await this.handler(event);
  }
}

/** A `ChatMessage` factory that always targets the same sender. */
export function messageFrom(
  from: string,
  body: string,
  remoteIp?: string
): ChatMessage {
  return { from, body, remoteIp };
}
