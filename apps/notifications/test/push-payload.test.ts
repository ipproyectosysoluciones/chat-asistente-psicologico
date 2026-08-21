import { describe, expect, it } from "vitest";

import type { AlertRow } from "@chatcap/db-schema";

import { buildPushPayload } from "../src/push-payload";

/**
 * Push payload (task 2.3, REQ-ALERT-2): what goes on the wire to the
 * supervisor dashboard is a WHITELISTED projection of the alert — never the
 * raw crisis keyword, message content or any contact data. `dedupeKey` is a
 * sha256 hex digest (safe), `sessionId` an opaque internal identifier.
 */

function fakeAlert(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "alert-1",
    level: "red",
    category: "suicide",
    sessionId: "sess-1",
    status: "open",
    dedupeKey: "a".repeat(64),
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildPushPayload", () => {
  it("projects a created alert onto the wire payload", () => {
    const alert = fakeAlert();
    const payload = buildPushPayload(alert, "created");
    expect(payload).toEqual({
      alertId: "alert-1",
      level: "red",
      category: "suicide",
      sessionId: "sess-1",
      status: "open",
      dedupeKey: "a".repeat(64),
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      eventKind: "created",
    });
  });

  it("marks a follow-up touch as updated", () => {
    const payload = buildPushPayload(fakeAlert(), "updated");
    expect(payload.eventKind).toBe("updated");
  });

  it("exposes ONLY the whitelisted fields — no keyword, message or contact data", () => {
    const payload = buildPushPayload(fakeAlert(), "created");
    expect(Object.keys(payload).sort()).toEqual([
      "alertId",
      "category",
      "createdAt",
      "dedupeKey",
      "eventKind",
      "level",
      "sessionId",
      "status",
      "updatedAt",
    ]);
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["keyword", "message", "phone", "contact", "content"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
