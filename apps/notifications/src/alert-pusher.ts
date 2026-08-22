import type { NewAuditEntry } from "@chatcap/db-schema";
import type { Logger } from "@chatcap/telemetry";

import type { AlertPushPayload, PushChannel } from "./push-channel";

export type { PushChannel } from "./push-channel";

/**
 * Push with fallback (task 2.3, REQ-ALERT-2/4): tries channels in order and
 * stops at the first confirmed delivery. A primary-channel failure triggers
 * the fallback channel (Telegram/Web) and every failure is recorded in the
 * audit log — escalation never depends on WhatsApp/Socket.io alone. All audit
 * meta and log context is PII-stripped: no session id, no message content,
 * no keyword.
 */

export interface PushDeps {
  channels: readonly PushChannel[];
  audit: (entry: NewAuditEntry) => Promise<void>;
  logger: Pick<Logger, "error">;
}

export type PushOutcome =
  | { delivered: true; channel: string }
  | { delivered: false; attempts: Array<{ channel: string; error: string }> };

export async function pushAlertWithFallback(
  deps: PushDeps,
  payload: AlertPushPayload
): Promise<PushOutcome> {
  const attempts: Array<{ channel: string; error: string }> = [];
  let primaryFailure: { channel: string; error: string } | undefined;

  for (const channel of deps.channels) {
    const result = await channel.push(payload);
    if (result.ok) {
      if (primaryFailure !== undefined) {
        // Primary failed → the delivery used the fallback: record why.
        await deps.audit({
          actorType: "system",
          action: "alert_push_fallback",
          resourceType: "alert",
          resourceId: payload.alertId,
          reason: "primary push channel failed; delivered via fallback",
          meta: {
            level: payload.level,
            channel: primaryFailure.channel,
            error: primaryFailure.error,
          },
        });
      }
      return { delivered: true, channel: channel.name };
    }
    const failure = { channel: channel.name, error: result.error };
    attempts.push(failure);
    if (primaryFailure === undefined) {
      primaryFailure = failure;
    }
  }

  const meta: Record<string, unknown> =
    deps.channels.length === 0
      ? { level: payload.level, reason: "no_push_channel_configured" }
      : { level: payload.level, attempts };

  await deps.audit({
    actorType: "system",
    action: "alert_push_failed",
    resourceType: "alert",
    resourceId: payload.alertId,
    reason: "no push channel confirmed delivery",
    meta,
  });
  deps.logger.error("alert_push_failed", {
    alertId: payload.alertId,
    level: payload.level,
    attempts,
  });

  return { delivered: false, attempts };
}
