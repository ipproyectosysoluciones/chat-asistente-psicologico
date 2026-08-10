/**
 * Key rotation policy (REQ-KEY-2/REQ-KEY-3/REQ-KEY-5). Pure, clock-injected:
 * callers pass `now` so tests are deterministic and the scheduler can use a
 * virtual clock.
 */

export const KEY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const FORCED_ROTATION_DELAY_MS = 12 * 60 * 60 * 1000;
/** 1 day before expiry the key is flagged as "expiring soon" (monitoring). */
export const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;

export const REENCRYPTION_BATCH_MIN = 100;
export const REENCRYPTION_BATCH_MAX = 500;
export const REENCRYPTION_BATCH_DEFAULT = 200;

/** Inclusive hour start, exclusive hour end (0–23). */
export interface TimeWindow {
  start: number;
  end: number;
}

/** Default low-traffic maintenance window (UTC). */
export const LOW_TRAFFIC_WINDOW: TimeWindow = { start: 2, end: 5 };

export function isWithinWindow(date: Date, window: TimeWindow = LOW_TRAFFIC_WINDOW): boolean {
  const hour = date.getUTCHours();
  if (window.start <= window.end) {
    return hour >= window.start && hour < window.end;
  }
  // Window crosses midnight: [start, 24) ∪ [0, end)
  return hour >= window.start || hour < window.end;
}

/** Next run time: start of the next window (the following day if inside). */
export function computeNextWindowStart(
  date: Date,
  window: TimeWindow = LOW_TRAFFIC_WINDOW
): Date {
  const next = new Date(date);
  next.setUTCHours(window.start, 0, 0, 0);
  if (next.getTime() <= date.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

export interface RotationDates {
  expiresAt: Date;
  forcedRotationDueAt: Date;
}

export function computeRotationDates(
  now: Date,
  lifetimeMs: number = KEY_LIFETIME_MS
): RotationDates {
  const expiresAt = new Date(now.getTime() + lifetimeMs);
  const forcedRotationDueAt = new Date(expiresAt.getTime() + FORCED_ROTATION_DELAY_MS);
  return { expiresAt, forcedRotationDueAt };
}

export type RotationState =
  | "active"
  | "expiring_soon"
  | "rotation_due"
  | "forced_due";

export function rotationState(
  key: { expiresAt: string; forcedRotationDueAt: string },
  now: Date
): RotationState {
  const expiresAt = new Date(key.expiresAt);
  const forcedRotationDueAt = new Date(key.forcedRotationDueAt);
  if (forcedRotationDueAt.getTime() <= now.getTime()) return "forced_due";
  if (expiresAt.getTime() <= now.getTime()) return "rotation_due";
  if (expiresAt.getTime() - now.getTime() <= EXPIRING_SOON_MS) return "expiring_soon";
  return "active";
}
