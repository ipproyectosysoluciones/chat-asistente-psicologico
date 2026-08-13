import { randomUUID } from "node:crypto";

import { ALERT_STATUS, EVENT_TYPE } from "@chatcap/shared-types";
import type { AlertEvent, AlertLevel } from "@chatcap/shared-types";
import type { TelemetryEvent } from "@chatcap/telemetry";

/**
 * PII-free red-alert event builder (task 4.5, REQ-ALERT-3/6). The alert
 * payload carries ids and a category only — never message content, phones or
 * raw webhook payloads (REQ-ALERT-6). The notifications service owns the
 * per-session dedupe window via the `dedupeKey`.
 */

export function buildAlertRaisedEvent(input: {
  sessionId: string;
  level: AlertLevel;
  category: string;
  keyword?: string;
  traceId?: string;
}): TelemetryEvent {
  const now = new Date().toISOString();
  const payload: AlertEvent = {
    alertId: randomUUID(),
    sessionId: input.sessionId,
    level: input.level,
    category: input.category,
    dedupeKey: `${input.sessionId}:${input.level}`,
    status: ALERT_STATUS.OPEN,
    createdAt: now,
    keyword: input.keyword,
    traceId: input.traceId,
  };
  return { type: EVENT_TYPE.ALERT_RAISED, payload, occurredAt: now };
}
