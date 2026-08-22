/**
 * Redis pub-sub subscriber (design §2.2, task 2.1). Subscribes to a
 * telemetry channel and forwards raw messages to the handler. Parsing is the
 * alert router's job (task 2.2). The client dependency is structural so
 * ioredis ↔ alternatives are a wiring-only swap (provider-swap contract).
 */

export interface SubscriberClient {
  on(
    event: "message",
    listener: (channel: string, message: string) => void
  ): unknown;
  subscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface RedisSubscriber {
  subscribe(
    channel: string,
    handler: (message: string) => Promise<void>
  ): Promise<void>;
  close(): Promise<void>;
}

export class IoredisSubscriber implements RedisSubscriber {
  constructor(
    private readonly client: SubscriberClient,
    private readonly onError?: (error: unknown) => void
  ) {}

  async subscribe(
    channel: string,
    handler: (message: string) => Promise<void>
  ): Promise<void> {
    this.client.on("message", (messageChannel, message) => {
      if (messageChannel !== channel) {
        return;
      }
      void handler(message).catch((error: unknown) => {
        // No silent catches: the caller wires onError (pilot: logger) or the
        // rejection stays loud as an unhandled rejection.
        if (this.onError) {
          this.onError(error);
          return;
        }
        throw error;
      });
    });

    await this.client.subscribe(channel);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
