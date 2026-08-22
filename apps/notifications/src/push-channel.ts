import type { AlertLevel, AlertStatus } from "@chatcap/shared-types";

/**
 * Push channel contract (task 2.3, REQ-ALERT-2/4): a channel delivers the
 * PII-stripped alert payload to a supervisor surface. `push` resolves with a
 * confirmation result — a channel that cannot confirm delivery reports
 * failure so the pusher can try the next channel (fallback).
 */

/** Whitelisted alert projection that goes on the wire (see push-payload.ts). */
export interface AlertPushPayload {
  alertId: string;
  level: AlertLevel;
  category: string;
  sessionId: string;
  status: AlertStatus;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  eventKind: "created" | "updated";
}

export type PushResult =
  | { ok: true; deliveredTo?: number }
  | { ok: false; error: string };

export interface PushChannel {
  /** Stable short identifier used in audit meta and logs (e.g. "socket.io"). */
  readonly name: string;
  push(payload: AlertPushPayload): Promise<PushResult>;
}
