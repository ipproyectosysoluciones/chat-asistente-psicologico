import type { ChatProvider } from "./provider";
import { BaileysProvider } from "./baileys";
import { MetaProvider } from "./meta";
import { MockProvider } from "./mock";

export type ProviderKind = "baileys" | "meta" | "mock";

export interface ProviderFactoryOptions {
  provider: "baileys" | "meta";
  baileysSessionDir: string;
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  /** Injectable fetch for the Meta Cloud API (test hook). */
  fetchImpl?: typeof fetch;
  /** When true, returns the MockProvider (test/local-dev mode). */
  useMock?: boolean;
}

/**
 * Configuration-only provider swap (design §8, REQ-CHATBOT-1): the whole
 * Baileys ↔ Meta choice collapses into this factory.
 */
export function createProvider(options: ProviderFactoryOptions): ChatProvider {
  if (options.useMock === true) {
    return new MockProvider();
  }
  switch (options.provider) {
    case "baileys":
      return new BaileysProvider({ sessionDir: options.baileysSessionDir });
    case "meta":
      return new MetaProvider({
        accessToken: options.metaAccessToken ?? "",
        phoneNumberId: options.metaPhoneNumberId ?? "",
        fetchImpl: options.fetchImpl,
      });
  }
}
