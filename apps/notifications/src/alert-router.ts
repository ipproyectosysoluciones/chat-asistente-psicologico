import type { AlertLevel } from "@chatcap/shared-types";
import type { AlertRow, NewAlert } from "@chatcap/db-schema";

import { buildDedupeKey } from "./dedupe";
import type { RaiseAlertRequest } from "./raise-alert";
import type { ThrottleStore } from "./throttle";

/**
 * Alert router (REQ-ALERT-5): pure orchestration between the persistence
 * layer and the push side. Storage (AlertStore) and throttling are injected
 * so the routing decisions are unit-testable without infra:
 *
 *  1. Derive the dedupe key from the request.
 *  2. No open alert  → CREATE + prime the throttle window + push `created`.
 *  3. Open alert     → TOUCH (refresh updated_at); push `updated` only when
 *     the per-level throttle window is free, else return `throttled`.
 *  4. After resolve  → the open row is gone, so a re-raise creates a fresh
 *     alert (a new occurrence must reach the supervisor, even inside a
 *     throttle window — the window only gates follow-up pushes).
 */

export interface AlertStore {
  findOpenByDedupeKey(dedupeKey: string): Promise<AlertRow | undefined>;
  create(input: NewAlert): Promise<AlertRow>;
  touch(alertId: string): Promise<void>;
}

export type AlertRoutingEvent =
  | { kind: "created"; alert: AlertRow }
  | { kind: "updated"; alert: AlertRow }
  | { kind: "throttled"; alert: AlertRow };

export interface AlertRouterDeps {
  alerts: AlertStore;
  throttle: ThrottleStore;
  notify: (event: AlertRoutingEvent) => Promise<void> | void;
  throttleWindowMs: (level: AlertLevel) => number;
}

export function throttleKey(level: AlertLevel, dedupeKey: string): string {
  return `alert:throttle:${level}:${dedupeKey}`;
}

export async function routeAlert(
  deps: AlertRouterDeps,
  request: RaiseAlertRequest
): Promise<AlertRoutingEvent> {
  const dedupeKey = buildDedupeKey({
    level: request.level,
    sessionId: request.sessionId,
    category: request.category,
    keyword: request.keyword,
  });

  const open = await deps.alerts.findOpenByDedupeKey(dedupeKey);
  if (open !== undefined) {
    await deps.alerts.touch(open.id);
    const allowed = await deps.throttle.checkAndMark(
      throttleKey(open.level, open.dedupeKey),
      deps.throttleWindowMs(open.level)
    );
    if (!allowed) {
      return { kind: "throttled", alert: open };
    }
    const event: AlertRoutingEvent = { kind: "updated", alert: open };
    await deps.notify(event);
    return event;
  }

  const created = await deps.alerts.create({
    level: request.level,
    category: request.category,
    sessionId: request.sessionId,
    dedupeKey,
  });
  await deps.throttle.mark(
    throttleKey(created.level, created.dedupeKey),
    deps.throttleWindowMs(created.level)
  );
  const event: AlertRoutingEvent = { kind: "created", alert: created };
  await deps.notify(event);
  return event;
}
