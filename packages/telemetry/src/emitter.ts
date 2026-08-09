import { EVENT_TYPE } from "@chatcap/shared-types";

/**
 * Redis pub-sub event emitter (design §2.2). Events carry no PII by
 * construction: the shared `AlertEvent`/trace payloads only contain ids.
 * The `RedisPublisher` dependency is structural so ioredis ↔ alternatives
 * are a wiring-only swap (same provider-swap contract as the rest of the repo).
 */

export type TelemetryEventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

export interface TelemetryEvent {
  type: TelemetryEventType;
  payload: unknown;
  occurredAt: string;
}

export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

export interface EventEmitter {
  publish(event: TelemetryEvent): Promise<void>;
}

const CHANNEL_PREFIX = "telemetry:";

export class RedisEventEmitter implements EventEmitter {
  constructor(
    private readonly publisher: RedisPublisher,
    private readonly onError?: (error: unknown) => void
  ) {}

  async publish(event: TelemetryEvent): Promise<void> {
    const channel = `${CHANNEL_PREFIX}${event.type}`;
    const message = JSON.stringify(event);
    try {
      await this.publisher.publish(channel, message);
    } catch (error) {
      // No empty catches: the caller either wires a callback (pilot: logger)
      // or the failure propagates loudly.
      if (this.onError) {
        this.onError(error);
        return;
      }
      throw error;
    }
  }
}
