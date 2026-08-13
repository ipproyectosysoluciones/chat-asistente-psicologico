import type { ChatMessage } from "@chatcap/shared-types";
import type { Logger } from "@chatcap/telemetry";

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

/**
 * Connection-level updates from the Baileys WebSocket driver (task 4.7,
 * REQ-CHATBOT-8). The driver owns the raw socket; the provider turns these
 * updates into the orchestrator-facing `ChatProviderEvent` state machine.
 */
export type BaileysConnectionUpdate =
  | { type: "close"; reason?: string }
  | { type: "logged_out" }
  | { type: "qr"; qr: string };

/**
 * Swappable Baileys WebSocket driver (design §8 provider pillar): session
 * persistence (multi-file auth state in `sessionDir`), keep-alive pings and
 * inbound message delivery live behind this seam, so the provider's reconnect
 * state machine is unit-testable and the real `makeWASocket` adapter is a
 * wiring-only swap (Baileys ↔ Meta, config-only).
 */
export interface BaileysConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Keep-alive ping; `false` means the socket is dead and reconnect starts. */
  keepAlive(): Promise<boolean>;
  onUpdate(handler: (update: BaileysConnectionUpdate) => void): void;
  onMessage(handler: (message: ChatMessage) => void): void;
}

export interface BaileysProviderOptions {
  /** Directory where the multi-file auth state (session) is persisted. */
  sessionDir: string;
  /** Connection driver; required from task 4.7 on. */
  connection?: BaileysConnection;
  /** Optional logger (PII-free events only). */
  logger?: Logger;
  /** Keep-alive ping interval (default 30 s). */
  keepAliveIntervalMs?: number;
  /** Delay between auto-reconnect attempts (default 5 s). */
  reconnectDelayMs?: number;
  /** Auto-reconnect attempts before giving up (default 5). */
  maxReconnectAttempts?: number;
}

const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Baileys provider (tasks 4.1 + 4.7, REQ-CHATBOT-1/8): keep-alive,
 * auto-reconnect on connection loss, and re-pair handling on `logged_out`.
 * Retriable drops go through `reconnecting` → `reconnected` without touching
 * the orchestrator's session state; `logged_out` is unrecoverable and emits
 * `auth_failure` + surfaces the pairing QR. Never logs message content.
 */
export class BaileysProvider implements ChatProvider {
  readonly kind = "baileys" as const;
  private handler: ChatEventHandler | undefined;
  private pairingQrHandler: ((qr: string) => void) | undefined;
  private connected = false;
  private pairingRequiredFlag = false;
  private reconnecting = false;
  private stopped = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  private readonly connection: BaileysConnection | undefined;
  private readonly logger?: Logger;
  private readonly keepAliveIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;

  constructor(private readonly options: BaileysProviderOptions) {
    this.connection = options.connection;
    this.logger = options.logger;
    this.keepAliveIntervalMs =
      options.keepAliveIntervalMs ?? DEFAULT_KEEP_ALIVE_INTERVAL_MS;
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectAttempts =
      options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  }

  /** True after `logged_out`: a fresh WhatsApp pairing is required. */
  get pairingRequired(): boolean {
    return this.pairingRequiredFlag;
  }

  /** Re-pair QR surface (REQ-CHATBOT-8 scenario "Session loss requiring re-pair"). */
  onPairingQr(handler: (qr: string) => void): void {
    this.pairingQrHandler = handler;
  }

  async start(): Promise<void> {
    if (this.options.sessionDir.trim() === "") {
      throw new ProviderConfigurationError(
        "Baileys provider requires a non-empty CHATBOT_BAILEYS_SESSION_DIR"
      );
    }
    const connection = this.connection;
    if (connection === undefined) {
      throw new ProviderConfigurationError(
        "Baileys provider requires a connection driver (the makeWASocket adapter); pass `connection`"
      );
    }
    this.stopped = false;
    this.pairingRequiredFlag = false;
    connection.onUpdate((update) => {
      this.handleConnectionUpdate(update);
    });
    connection.onMessage((message) => {
      this.dispatch({ type: "message", message });
    });
    await connection.connect();
    this.connected = true;
    this.startKeepAlive();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.stopKeepAlive();
    this.connected = false;
    await this.connection?.disconnect();
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

  /** SDK hook — the connection driver and tests invoke this with events. */
  dispatch(event: ChatProviderEvent): void {
    if (this.handler === undefined) {
      return;
    }
    let result: Promise<void> | void;
    try {
      result = this.handler(event);
    } catch (error) {
      this.logger?.error("baileys event handler threw", {
        error: String(error),
      });
      return;
    }
    // A rejected handler must never become an unhandled rejection (which
    // terminates the process on modern Node): log it instead.
    void Promise.resolve(result).catch((error: unknown) => {
      this.logger?.error("baileys event handler failed", {
        error: String(error),
      });
    });
  }

  private handleConnectionUpdate(update: BaileysConnectionUpdate): void {
    switch (update.type) {
      case "close":
        if (this.stopped || this.pairingRequiredFlag || this.reconnecting) {
          return;
        }
        this.connected = false;
        void this.reconnectLoop();
        break;
      case "logged_out":
        if (this.stopped || this.pairingRequiredFlag) {
          return;
        }
        this.pairingRequiredFlag = true;
        this.connected = false;
        this.stopKeepAlive();
        this.dispatch({ type: "auth_failure", reason: "logged_out" });
        break;
      case "qr":
        if (this.pairingQrHandler !== undefined) {
          this.pairingQrHandler(update.qr);
        }
        break;
    }
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    const connection = this.connection;
    if (connection === undefined) {
      this.reconnecting = false;
      return;
    }
    this.dispatch({ type: "reconnecting" });
    try {
      let attempt = 0;
      while (
        !this.stopped &&
        !this.pairingRequiredFlag &&
        attempt < this.maxReconnectAttempts
      ) {
        await delay(this.reconnectDelayMs);
        attempt += 1;
        try {
          await connection.connect();
          this.connected = true;
          this.startKeepAlive();
          this.dispatch({ type: "reconnected" });
          return;
        } catch (error) {
          this.logger?.error("baileys reconnect attempt failed", {
            attempt,
            error: String(error),
          });
        }
      }
      if (!this.connected && !this.stopped) {
        this.logger?.error(
          "baileys reconnect budget exhausted; awaiting re-pair or restart",
          { attempts: this.maxReconnectAttempts }
        );
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      void this.keepAliveTick();
    }, this.keepAliveIntervalMs);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== undefined) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  private async keepAliveTick(): Promise<void> {
    if (!this.connected || this.reconnecting || this.stopped) {
      return;
    }
    const connection = this.connection;
    if (connection === undefined) {
      return;
    }
    try {
      const alive = await connection.keepAlive();
      if (!alive) {
        this.connected = false;
        void this.reconnectLoop();
      }
    } catch (error) {
      this.logger?.error("baileys keep-alive failed", {
        error: String(error),
      });
      this.connected = false;
      void this.reconnectLoop();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
