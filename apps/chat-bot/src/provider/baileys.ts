import type { ChatProvider, ChatProviderEvent, ChatEventHandler } from "./provider";

/** Thrown at boot when provider configuration is incomplete or invalid. */
export class ProviderConfigurationError extends Error {
  readonly code = "PROVIDER_CONFIGURATION_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

/** Thrown when a send/stop is attempted while the channel is not connected. */
export class ProviderNotConnectedError extends Error {
  readonly code = "PROVIDER_NOT_CONNECTED" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderNotConnectedError";
  }
}

export interface BaileysProviderOptions {
  sessionDir: string;
}

/**
 * Baileys provider scaffold (task 4.1, REQ-CHATBOT-1). The three-pillar
 * contract and connection state machine are enforced here; the Baileys SDK
 * internals (WebSocket session, keep-alive, auto-reconnect, re-pair QR)
 * land in task 4.7 on top of this same interface. Never imports the flow or
 * the database — the orchestrator wires the pillars.
 */
export class BaileysProvider implements ChatProvider {
  readonly kind = "baileys" as const;
  private handler: ChatEventHandler | undefined;
  private connected = false;

  constructor(private readonly options: BaileysProviderOptions) {}

  async start(): Promise<void> {
    if (this.options.sessionDir.trim() === "") {
      throw new ProviderConfigurationError(
        "Baileys provider requires a non-empty CHATBOT_BAILEYS_SESSION_DIR"
      );
    }
    this.connected = true;
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  async sendText(_to: string, _text: string): Promise<void> {
    if (!this.connected) {
      throw new ProviderNotConnectedError(
        "Baileys provider is not connected; start() must complete first"
      );
    }
  }

  onEvent(handler: ChatEventHandler): void {
    this.handler = handler;
  }

  async isConnected(): Promise<boolean> {
    return this.connected;
  }

  /** SDK hook — the Baileys adapter invokes this with inbound events (4.7). */
  dispatch(event: ChatProviderEvent): void {
    if (this.handler === undefined) {
      return;
    }
    void this.handler(event);
  }
}
