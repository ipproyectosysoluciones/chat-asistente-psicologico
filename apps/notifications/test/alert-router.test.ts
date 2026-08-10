import { describe, expect, it, vi } from "vitest";

import type { AlertLevel } from "@chatcap/shared-types";
import type { AlertRow, NewAlert } from "@chatcap/db-schema";

import { buildDedupeKey } from "../src/dedupe";
import {
  routeAlert,
  throttleKey,
  type AlertStore,
  type AlertRoutingEvent,
} from "../src/alert-router";
import type { RaiseAlertRequest } from "../src/raise-alert";
import type { ThrottleStore } from "../src/throttle";

/**
 * Alert router (REQ-ALERT-5): pure orchestration — dedupe by key, follow-ups
 * touch the open alert, per-level throttle windows gate pushes. Persistence
 * and Redis are injected (AlertStore / ThrottleStore) so the routing logic is
 * unit-testable without a database.
 */

function fakeAlert(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "alert-1",
    level: "red",
    category: "suicide",
    sessionId: "sess-1",
    status: "open",
    dedupeKey: "k1",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function fakeStore(
  openByKey: Map<string, AlertRow>,
  retainCreated = true
): AlertStore & { calls: string[] } {
  const calls: string[] = [];
  let sequence = 1;
  return {
    calls,
    async findOpenByDedupeKey(dedupeKey) {
      calls.push(`find:${dedupeKey}`);
      return openByKey.get(dedupeKey);
    },
    async create(input: NewAlert) {
      calls.push(`create:${input.dedupeKey}`);
      const row = fakeAlert({
        id: `alert-${sequence}`,
        level: input.level,
        category: input.category,
        sessionId: input.sessionId,
        dedupeKey: input.dedupeKey,
        updatedAt: new Date().toISOString(),
      });
      if (retainCreated) {
        openByKey.set(input.dedupeKey, row);
      }
      sequence += 1;
      return row;
    },
    async touch(alertId) {
      calls.push(`touch:${alertId}`);
    },
  };
}

function fakeThrottle(
  allowedKeys: Set<string> = new Set()
): ThrottleStore & { marked: string[] } {
  const marked: string[] = [];
  return {
    marked,
    async checkAndMark(key, _windowMs) {
      if (allowedKeys.has(key)) {
        allowedKeys.delete(key);
        return true;
      }
      marked.push(key);
      return false;
    },
    async mark(key, _windowMs) {
      marked.push(key);
    },
  };
}

const WINDOWS: Record<AlertLevel, number> = { red: 60_000, orange: 300_000, yellow: 900_000 };

const REQUEST: RaiseAlertRequest = {
  sessionId: "sess-1",
  level: "red",
  category: "suicide",
  keyword: "quiero morir",
};

describe("routeAlert (REQ-ALERT-5)", () => {
  it("creates an alert and notifies when no open alert exists", async () => {
    const alerts = fakeStore(new Map());
    const throttle = fakeThrottle(new Set());
    const notify = vi.fn<(event: AlertRoutingEvent) => void>();
    const event = await routeAlert(
      { alerts, throttle, notify, throttleWindowMs: (level) => WINDOWS[level] },
      REQUEST
    );

    const expectedKey = buildDedupeKey(REQUEST);
    expect(event.kind).toBe("created");
    expect(alerts.calls).toEqual([`find:${expectedKey}`, `create:${expectedKey}`]);
    expect(throttle.marked).toEqual([throttleKey("red", expectedKey)]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("touches the open alert and notifies an update when the window is free", async () => {
    const derivedKey = buildDedupeKey(REQUEST);
    const open = fakeAlert({ id: "alert-open", dedupeKey: derivedKey });
    const alerts = fakeStore(new Map([[derivedKey, open]]));
    const throttle = fakeThrottle(new Set([throttleKey("red", derivedKey)]));
    const notify = vi.fn<(event: AlertRoutingEvent) => void>();
    const event = await routeAlert(
      { alerts, throttle, notify, throttleWindowMs: (level) => WINDOWS[level] },
      REQUEST
    );

    expect(event.kind).toBe("updated");
    expect(alerts.calls).toEqual([`find:${derivedKey}`, `touch:alert-open`]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("throttles the push when the window is active (no notify, still touches)", async () => {
    const derivedKey = buildDedupeKey(REQUEST);
    const open = fakeAlert({ id: "alert-open", dedupeKey: derivedKey });
    const alerts = fakeStore(new Map([[derivedKey, open]]));
    const throttle = fakeThrottle(new Set()); // window active → denied
    const notify = vi.fn<(event: AlertRoutingEvent) => void>();
    const event = await routeAlert(
      { alerts, throttle, notify, throttleWindowMs: (level) => WINDOWS[level] },
      REQUEST
    );

    expect(event.kind).toBe("throttled");
    expect(alerts.calls).toEqual([`find:${derivedKey}`, `touch:alert-open`]);
    expect(throttle.marked).toEqual([throttleKey("red", derivedKey)]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("creates a fresh alert after the previous one is resolved (new occurrence)", async () => {
    const alerts = fakeStore(new Map(), false); // resolved → create does not reopen
    const throttle = fakeThrottle(new Set());
    const notify = vi.fn<(event: AlertRoutingEvent) => void>();

    await routeAlert({ alerts, throttle, notify, throttleWindowMs: (level) => WINDOWS[level] }, REQUEST);
    await routeAlert({ alerts, throttle, notify, throttleWindowMs: (level) => WINDOWS[level] }, REQUEST);

    expect(alerts.calls.filter((call) => call.startsWith("create:"))).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("derives different dedupe keys for different keywords", async () => {
    const openByKey = new Map<string, AlertRow>();
    const alerts = fakeStore(openByKey);
    const throttle = fakeThrottle(new Set());
    const notify = vi.fn<(event: AlertRoutingEvent) => void>();

    await routeAlert({ alerts, throttle, notify, throttleWindowMs: (level) => WINDOWS[level] }, {
      ...REQUEST,
      keyword: "quiero morir",
    });
    await routeAlert({ alerts, throttle, notify, throttleWindowMs: (level) => WINDOWS[level] }, {
      ...REQUEST,
      keyword: "no quiero vivir",
    });

    const createdKeys = alerts.calls.filter((call) => call.startsWith("create:"));
    expect(createdKeys).toHaveLength(2);
    expect(createdKeys[0]).not.toBe(createdKeys[1]);
  });
});

describe("throttleKey", () => {
  it("namespaces the key by level and dedupe key", () => {
    expect(throttleKey("orange", "k1")).toBe("alert:throttle:orange:k1");
  });
});
