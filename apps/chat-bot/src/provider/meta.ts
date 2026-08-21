import { ProviderConfigurationError, ProviderNotConnectedError } from "./baileys";
import type { ChatProvider, ChatEventHandler } from "./provider";

export interface MetaProviderOptions {
  accessToken: string;
  phoneNumberId: string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const GRAPH_API_VERSION = "v21.0";

/**
 * Meta (WhatsApp Cloud API) provider (task 4.1). Sending is plain HTTP over
 * the Graph API — implemented here; inbound webhook verification, signature
 * validation and message receive land with the flow slice. Access token and
 * phone-number-id come from config, never code (config-only swap, design §8).
 */
export class MetaProvider implements ChatProvider {
  readonly kind = "meta" as const;
  private readonly fetchImpl: typeof fetch;
  private connected = false;

  constructor(private readonly options: MetaProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async start(): Promise<void> {
    if (this.options.accessToken.trim() === "") {
      throw new ProviderConfigurationError(
        "Meta provider requires a non-empty CHATBOT_META_ACCESS_TOKEN"
      );
    }
    if (this.options.phoneNumberId.trim() === "") {
      throw new ProviderConfigurationError(
        "Meta provider requires a non-empty CHATBOT_META_PHONE_NUMBER_ID"
      );
    }
    this.connected = true;
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  async sendText(to: string, text: string): Promise<void> {
    if (!this.connected) {
      throw new ProviderNotConnectedError(
        "Meta provider is not connected; start() must complete first"
      );
    }
    const url =
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.options.phoneNumberId}/messages`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    if (!response.ok) {
      throw new Error(
        `meta cloud api send failed: HTTP ${response.status}`
      );
    }
  }

  onEvent(_handler: ChatEventHandler): void {
    // Inbound webhook receive lands with the flow slice (task 4.6).
  }

  async isConnected(): Promise<boolean> {
    return this.connected;
  }
}
