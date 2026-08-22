import { z } from "zod";

/**
 * Pub-sub payload parser (task 2.1): the emitter (packages/telemetry)
 * publishes `TelemetryEvent { type, payload, occurredAt }` as JSON on
 * `telemetry:<type>` channels. Parsing lives here so malformed messages are
 * rejected loudly (undefined) and never reach the alert router.
 */

const telemetryEventSchema = z.object({
  type: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.string().min(1),
});

export interface ParsedTelemetryEvent {
  type: string;
  payload: unknown;
  occurredAt: string;
}

export function parseTelemetryMessage(
  raw: string
): ParsedTelemetryEvent | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = telemetryEventSchema.safeParse(candidate);
  if (!result.success) {
    return undefined;
  }
  return {
    type: result.data.type,
    payload: result.data.payload,
    occurredAt: result.data.occurredAt,
  };
}
