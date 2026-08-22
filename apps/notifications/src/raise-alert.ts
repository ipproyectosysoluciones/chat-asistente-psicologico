import { z } from "zod";

/**
 * Raise-alert payload contract (design §8.3): the chat-bot publishes a
 * validated `telemetry:alert_raised` event; the notifications service parses
 * the payload with zod so malformed or out-of-domain values never reach the
 * router. Unknown keys are tolerated and stripped (tolerant reader at a
 * distributed boundary — a future chat-bot field must never drop a red
 * alert); the required fields are still enforced.
 */

export const alertLevels = ["red", "orange", "yellow"] as const;

export const raiseAlertRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    level: z.enum(alertLevels),
    category: z.string().min(1),
    keyword: z.string().optional(),
    traceId: z.string().optional(),
  });

export type RaiseAlertRequest = z.infer<typeof raiseAlertRequestSchema>;

/** Parses an unknown pub-sub payload; returns undefined when invalid. */
export function parseRaiseAlertRequest(payload: unknown): RaiseAlertRequest | undefined {
  const parsed = raiseAlertRequestSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}
