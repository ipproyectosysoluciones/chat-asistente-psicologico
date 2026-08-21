import type { AlertRow } from "@chatcap/db-schema";
import type { AlertStatus } from "@chatcap/shared-types";

/**
 * Alert lifecycle state machine (task 2.4, REQ-ALERT-6): alerts follow a
 * strict `open → acknowledged → resolved` path. A supervisor acknowledges
 * (takeover, audited who/when/why), then resolves. Any other transition is
 * invalid — the state machine is total over every status/action pair.
 */

export type AlertLifecycleAction = "acknowledge" | "resolve";

export class InvalidTransitionError extends Error {
  readonly current: AlertStatus;
  readonly action: AlertLifecycleAction;

  constructor(current: AlertStatus, action: AlertLifecycleAction) {
    super(`invalid alert transition: cannot ${action} an alert in status ${current}`);
    this.name = "InvalidTransitionError";
    this.current = current;
    this.action = action;
  }
}

const TRANSITIONS: Record<
  AlertStatus,
  Partial<Record<AlertLifecycleAction, AlertStatus>>
> = {
  open: { acknowledge: "acknowledged" },
  acknowledged: { resolve: "resolved" },
  resolved: {},
};

export function nextAlertStatus(
  current: AlertStatus,
  action: AlertLifecycleAction
): AlertStatus {
  const next = TRANSITIONS[current][action];
  if (next === undefined) {
    throw new InvalidTransitionError(current, action);
  }
  return next;
}

/**
 * Persistence contract for the lifecycle endpoints: the router stays
 * storage-agnostic; `pgAlertLifecycleStore` in alert-store.ts is the
 * PostgreSQL adapter and tests use in-memory fakes.
 */
export interface AlertLifecycleStore {
  findById(alertId: string): Promise<AlertRow | undefined>;
  acknowledge(alertId: string, actorId: string): Promise<void>;
  resolve(alertId: string): Promise<void>;
}
