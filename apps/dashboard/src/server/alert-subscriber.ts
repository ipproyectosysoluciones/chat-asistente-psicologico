/**
 * Crisis-alert Redis subscriber (Phase 7.3 gap fix — design note).
 *
 * Phase 7.3 requires a NEW crisis alert to be pushed to the supervisor
 * dashboard over Socket.io within < 1s (`alert:new`). Alerts are raised by
 * ai-rag (`apps/ai-rag/src/pipeline.ts` → `raiseAlert`) and by the chat-bot
 * via Redis pub-sub on the `telemetry:alert_raised` channel (see
 * `packages/telemetry/src/emitter.ts` `RedisEventEmitter`). The dashboard's
 * Socket.io server previously only emitted `alert:updated` on resolve/ack
 * (see `alerts-router.ts`), so a freshly raised alert had NO real-time push —
 * which is why the 7.3 e2e alert test had to assert `alert:updated` (resolve)
 * and self-skip the new-crisis path.
 *
 * Decision: the dashboard subscribes to `telemetry:alert_raised` with a
 * dedicated subscriber-mode Redis client and re-emits the PII-free
 * `AlertEvent` payload (ids only — REQ-ALERT-6) as `alert:new`. This is
 * independent of the notifications service, which also subscribes to the same
 * channel for its own Socket.io/HTTP push; Redis pub-sub fans the message out
 * to every subscriber, so both may receive it. The subscription is best-effort:
 * if Redis is unreachable the dashboard stays up, `alert:new` simply does not
 * fire, and the alert still lands in the polled DB feed (`listAlerts`).
 */

import Redis from "ioredis";

import { EVENT_TYPE } from "@chatcap/shared-types";
import type { AlertEvent } from "@chatcap/shared-types";
import type { TelemetryEvent } from "@chatcap/telemetry";

export interface AlertSubscriber {
  close(): Promise<void>;
}

const ALERT_RAISED_CHANNEL = "telemetry:alert_raised";

export interface SubscribeAlertChannelOptions {
  redisUrl: string;
  /** Called for every well-formed alert_raised event on the channel. */
  onNewAlert: (alert: AlertEvent) => void;
  /** Surfaced on Redis connection/subscribe failure (non-fatal). */
  onError?: (error: unknown) => void;
  logger?: { error: (message: string, context?: unknown) => void };
}

export async function subscribeAlertChannel(
  options: SubscribeAlertChannelOptions
): Promise<AlertSubscriber> {
  const client = new Redis(options.redisUrl, { maxRetriesPerRequest: 2 });

  client.on("error", (error: unknown) => {
    options.onError?.(error);
  });

  client.on("message", (_channel: string, message: string) => {
    const alert = parseAlertMessage(message, options.logger);
    if (alert !== undefined) {
      options.onNewAlert(alert);
    }
  });

  try {
    await client.subscribe(ALERT_RAISED_CHANNEL);
  } catch (error) {
    // No empty catch: surface the failure, but never crash the dashboard.
    // alert:new just won't fire while Redis is down.
    options.onError?.(error);
    await client.quit().catch((quitError: unknown) => {
      options.logger?.error("redis client quit failed", { err: quitError });
    });
      return createNoopSubscriber(client, options.logger);
  }

  return {
    async close() {
      await client.quit().catch((quitError: unknown) => {
      options.logger?.error("redis client quit failed", { err: quitError });
    });
    },
  };
}

function createNoopSubscriber(
  client: Redis,
  logger?: { error: (message: string, context?: unknown) => void }
): AlertSubscriber {
  return {
    async close() {
      await client.quit().catch((quitError: unknown) => {
      logger?.error("redis client quit failed", { err: quitError });
    });
    },
  };
}

/**
 * Parses a raw Redis pub-sub message into an `AlertEvent`. Returns undefined
 * for malformed JSON, wrong event type, or a payload missing the required
 * PII-free alert fields — those are dropped (never throw) so a single bad
 * message can't break the subscriber.
 */
function parseAlertMessage(
  message: string,
  logger?: { error: (message: string, context?: unknown) => void }
): AlertEvent | undefined {
  let event: TelemetryEvent;
  try {
    // The emitter serializes the full TelemetryEvent (type + payload + ts);
    // we only trust the structure after validation below.
    event = JSON.parse(message) as TelemetryEvent;
  } catch {
    logger?.error("alert subscriber: dropped malformed telemetry message");
    return undefined;
  }
  if (event.type !== EVENT_TYPE.ALERT_RAISED) {
    return undefined;
  }
  if (!isAlertEvent(event.payload)) {
    logger?.error("alert subscriber: dropped malformed alert_raised payload");
    return undefined;
  }
  return event.payload;
}

/** Structural guard — avoids `any` and rejects partial/PII-leaking payloads. */
function isAlertEvent(value: unknown): value is AlertEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.alertId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.level === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.createdAt === "string"
  );
}
