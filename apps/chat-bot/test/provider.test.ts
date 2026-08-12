import { describe, expect, it, vi } from "vitest";

import { messageFrom, MockProvider } from "../src/provider/mock";
import { BaileysProvider, ProviderConfigurationError, ProviderNotConnectedError } from "../src/provider/baileys";
import { MetaProvider } from "../src/provider/meta";
import { createProvider } from "../src/provider/factory";
import type { ChatProviderEvent } from "../src/provider/provider";

/**
 * Provider pillar (task 4.1, REQ-CHATBOT-1): each provider is a swappable
 * channel behind one interface. The contract tested here — state machine,
 * configuration validation, event dispatch — is what the Baileys SDK wiring
 * (4.7) and the Meta webhook slice build on top of.
 */

describe("MockProvider (task 4.1 test double)", () => {
  it("records outbound messages and reflects connected state", async () => {
    const provider = new MockProvider();
    expect(await provider.isConnected()).toBe(false);
    await provider.start();
    expect(await provider.isConnected()).toBe(true);
    await provider.sendText("waid-1", "hola");
    expect(provider.sentMessages).toEqual([{ to: "waid-1", text: "hola" }]);
    await provider.stop();
    expect(await provider.isConnected()).toBe(false);
  });

  it("dispatches inbound events to the registered handler", async () => {
    const provider = new MockProvider();
    const seen: ChatProviderEvent[] = [];
    provider.onEvent((event) => {
      seen.push(event);
    });
    await provider.emit({
      type: "message",
      message: messageFrom("waid-1", "hola"),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("message");
  });

  it("throws when emitting without a registered handler", async () => {
    const provider = new MockProvider();
    await expect(provider.emit({ type: "message", message: messageFrom("waid-1", "x") })).rejects.toThrow(
      "no event handler registered"
    );
  });
});

describe("BaileysProvider (task 4.1 scaffold)", () => {
  it("rejects boot with an empty session dir", async () => {
    const provider = new BaileysProvider({ sessionDir: "   " });
    await expect(provider.start()).rejects.toBeInstanceOf(ProviderConfigurationError);
  });

  it("connects when a session dir is provided", async () => {
    const provider = new BaileysProvider({ sessionDir: "/data/baileys" });
    await provider.start();
    expect(await provider.isConnected()).toBe(true);
  });

  it("refuses to send before start", async () => {
    const provider = new BaileysProvider({ sessionDir: "/data/baileys" });
    await expect(provider.sendText("waid-1", "hola")).rejects.toBeInstanceOf(
      ProviderNotConnectedError
    );
  });

  it("dispatches SDK events to the handler after start", async () => {
    const provider = new BaileysProvider({ sessionDir: "/data/baileys" });
    await provider.start();
    const seen: ChatProviderEvent[] = [];
    provider.onEvent((event) => {
      seen.push(event);
    });
    provider.dispatch({ type: "reconnecting" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("reconnecting");
  });
});

describe("MetaProvider (task 4.1 Cloud API sender)", () => {
  it("rejects boot without an access token", async () => {
    const provider = new MetaProvider({
      accessToken: "",
      phoneNumberId: "12345",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(provider.start()).rejects.toBeInstanceOf(ProviderConfigurationError);
  });

  it("posts a text message to the Graph API with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 })
    );
    const provider = new MetaProvider({
      accessToken: "tok-1",
      phoneNumberId: "12345",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await provider.start();
    await provider.sendText("5491100000000", "hola");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://graph.facebook.com/v21.0/12345/messages"
    );
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok-1",
    });
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      messaging_product: "whatsapp",
      to: "5491100000000",
      type: "text",
      text: { body: "hola" },
    });
  });

  it("throws a descriptive error when the Cloud API rejects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("bad", { status: 403 })
    );
    const provider = new MetaProvider({
      accessToken: "tok-1",
      phoneNumberId: "12345",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await provider.start();
    await expect(provider.sendText("waid-1", "hola")).rejects.toThrow(
      "meta cloud api send failed: HTTP 403"
    );
  });
});

describe("createProvider (design §8 config-only swap)", () => {
  it("returns the mock provider when useMock is set", () => {
    const provider = createProvider({
      provider: "baileys",
      baileysSessionDir: "",
      useMock: true,
    });
    expect(provider.kind).toBe("mock");
  });

  it("constructs the Baileys provider", () => {
    const provider = createProvider({
      provider: "baileys",
      baileysSessionDir: "/data/baileys",
    });
    expect(provider.kind).toBe("baileys");
  });

  it("constructs the Meta provider", () => {
    const provider = createProvider({
      provider: "meta",
      baileysSessionDir: "",
      metaAccessToken: "tok-1",
      metaPhoneNumberId: "12345",
    });
    expect(provider.kind).toBe("meta");
  });
});
