import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BaileysProvider,
  ProviderConfigurationError,
  type BaileysConnection,
  type BaileysConnectionUpdate,
} from "../src/provider/baileys";
import { messageFrom } from "../src/provider/mock";

/**
 * Baileys provider keep-alive + auto-reconnect (task 4.7, REQ-CHATBOT-8):
 * the state machine is driven by a swappable connection driver so the
 * WebSocket/SDK internals stay behind the three-pillar contract. Connection
 * loss auto-reconnects (reconnecting → reconnected); `logged_out` is
 * unrecoverable → `auth_failure` + re-pair QR surface, never a silent loop.
 */

class FakeConnection implements BaileysConnection {
  connected = false;
  readonly connect = vi.fn(async () => {
    this.connected = true;
  });
  readonly disconnect = vi.fn(async () => {
    this.connected = false;
  });
  readonly keepAlive = vi.fn(async () => this.connected);
  private updateHandler: ((update: BaileysConnectionUpdate) => void) | undefined;
  private messageHandler: ((message: { from: string; body: string }) => void) | undefined;

  onUpdate(handler: (update: BaileysConnectionUpdate) => void): void {
    this.updateHandler = handler;
  }

  onMessage(handler: (message: { from: string; body: string }) => void): void {
    this.messageHandler = handler;
  }

  emit(update: BaileysConnectionUpdate): void {
    if (this.updateHandler !== undefined) {
      this.updateHandler(update);
    }
  }

  pushMessage(message: { from: string; body: string }): void {
    if (this.messageHandler !== undefined) {
      this.messageHandler(message);
    }
  }
}

function makeProvider(overrides: {
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  keepAliveIntervalMs?: number;
} = {}) {
  const connection = new FakeConnection();
  const provider = new BaileysProvider({
    sessionDir: "/data/baileys",
    connection,
    keepAliveIntervalMs: overrides.keepAliveIntervalMs ?? 30_000,
    reconnectDelayMs: overrides.reconnectDelayMs ?? 5_000,
    maxReconnectAttempts: overrides.maxReconnectAttempts ?? 5,
  });
  return { provider, connection };
}

describe("BaileysProvider session persistence & reconnect (task 4.7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects boot when no connection driver is wired", async () => {
    const provider = new BaileysProvider({ sessionDir: "/data/baileys" });
    await expect(provider.start()).rejects.toBeInstanceOf(
      ProviderConfigurationError
    );
  });

  it("connects through the driver and forwards inbound messages", async () => {
    const { provider, connection } = makeProvider();
    const seen: string[] = [];
    provider.onEvent((event) => {
      if (event.type === "message") {
        seen.push(event.message.body);
      }
    });
    await provider.start();

    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(await provider.isConnected()).toBe(true);

    connection.pushMessage(messageFrom("waid-1", "hola"));
    expect(seen).toEqual(["hola"]);
  });

  it("auto-reconnects after a connection close and resumes", async () => {
    const { provider, connection } = makeProvider({
      reconnectDelayMs: 1_000,
    });
    const lifecycle: string[] = [];
    provider.onEvent((event) => {
      if (event.type !== "message") {
        lifecycle.push(event.type);
      }
    });
    await provider.start();

    connection.connected = false;
    connection.emit({ type: "close", reason: "keep-alive timeout" });
    expect(lifecycle).toEqual(["reconnecting"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.connect).toHaveBeenCalledTimes(2);
    expect(await provider.isConnected()).toBe(true);
    expect(lifecycle).toEqual(["reconnecting", "reconnected"]);
  });

  it("stops trying after the reconnect budget is exhausted", async () => {
    const { provider, connection } = makeProvider({
      reconnectDelayMs: 1_000,
      maxReconnectAttempts: 2,
    });
    connection.connect.mockResolvedValueOnce();
    connection.connect.mockRejectedValue(new Error("ws refused"));
    const lifecycle: string[] = [];
    provider.onEvent((event) => {
      if (event.type !== "message") {
        lifecycle.push(event.type);
      }
    });
    await provider.start();

    connection.emit({ type: "close", reason: "down" });
    expect(lifecycle).toEqual(["reconnecting"]);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(connection.connect).toHaveBeenCalledTimes(3);
    expect(await provider.isConnected()).toBe(false);
    expect(lifecycle).toEqual(["reconnecting"]);
  });

  it("surfaces auth_failure and a pairing QR on logged_out, never reconnects", async () => {
    const { provider, connection } = makeProvider();
    const lifecycle: string[] = [];
    const qrs: string[] = [];
    provider.onEvent((event) => {
      if (event.type !== "message") {
        lifecycle.push(event.type);
      }
    });
    provider.onPairingQr((qr) => {
      qrs.push(qr);
    });
    await provider.start();

    connection.emit({ type: "logged_out" });
    expect(lifecycle).toEqual(["auth_failure"]);
    expect(provider.pairingRequired).toBe(true);

    connection.emit({ type: "qr", qr: "2@pairing-code" });
    expect(qrs).toEqual(["2@pairing-code"]);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(await provider.isConnected()).toBe(false);
  });

  it("stops the keep-alive loop on stop()", async () => {
    const { provider, connection } = makeProvider({
      keepAliveIntervalMs: 10_000,
    });
    await provider.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(connection.keepAlive).toHaveBeenCalled();

    await provider.stop();
    const afterStop = connection.keepAlive.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connection.keepAlive.mock.calls.length).toBe(afterStop);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(await provider.isConnected()).toBe(false);
  });
});
