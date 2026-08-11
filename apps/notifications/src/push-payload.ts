import type { AlertRow } from "@chatcap/db-schema";

import type { AlertPushPayload } from "./push-channel";

/**
 * Push payload projection (task 2.3, REQ-ALERT-2): what the supervisor
 * dashboard receives over Socket.io is a WHITELISTED view of the alert —
 * never the raw crisis keyword, message content or contact data. `dedupeKey`
 * is a sha256 hex digest (safe to expose), `sessionId` an opaque internal
 * identifier.
 */
export function buildPushPayload(
  alert: AlertRow,
  eventKind: "created" | "updated"
): AlertPushPayload {
  return {
    alertId: alert.id,
    level: alert.level,
    category: alert.category,
    sessionId: alert.sessionId,
    status: alert.status,
    dedupeKey: alert.dedupeKey,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
    eventKind,
  };
}
