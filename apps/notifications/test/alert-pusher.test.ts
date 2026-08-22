import { describe, expect, it, vi } from "vitest";

import type { NewAuditEntry } from "@chatcap/db-schema";

import {
  pushAlertWithFallback,
  type PushChannel,
  type PushDeps,
  type PushOutcome,
} from "../src/alert-pusher";
import type { AlertPushPayload, PushResult } from "../src/push-channel";

/**
 * Push + fallback (task 2.3, REQ-ALERT-2/REQ-ALERT-4): a Socket.io push that
 * cannot be confirmed falls back to the next channel (Telegram/Web) and the
 * attempt is recorded in the audit log with PII stripped. Escalation must not
 * depend on WhatsApp alone.
 */

const PAYLOAD: AlertPushPayload = {
  alertId: "alert-1",
  level: "red",
  category: "suicide",
  sessionId: "sess-1",
  status: "open",
  dedupeKey: "a".repeat(64),
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  eventKind: "created",
};

function channel(name: string, result: PushResult): PushChannel {
  return { name, push: vi.fn(async () => result) };
}

function fakeDeps(
  channels: PushChannel[],
  loggerError: ReturnType<typeof vi.fn> = vi.fn()
): { deps: PushDeps; entries: NewAuditEntry[] } {
  const entries: NewAuditEntry[] = [];
  return {
    entries,
    deps: {
      channels,
      logger: { error: loggerError },
      audit: async (entry: NewAuditEntry) => {
        entries.push(entry);
      },
    },
  };
}

describe("pushAlertWithFallback (REQ-ALERT-2/4)", () => {
  it("delivers via the primary channel with no audit noise and no error log", async () => {
    const socketio = channel("socket.io", { ok: true, deliveredTo: 1 });
    const fallback = channel("http-fallback", { ok: true });
    const loggerError = vi.fn();
    const { deps, entries } = fakeDeps([socketio, fallback], loggerError);

    const outcome = await pushAlertWithFallback(deps, PAYLOAD);

    expect(outcome).toEqual<PushOutcome>({ delivered: true, channel: "socket.io" });
    expect(socketio.push).toHaveBeenCalledExactlyOnceWith(PAYLOAD);
    expect(fallback.push).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("falls back to the next channel and records an audit row when the primary fails", async () => {
    const socketio = channel("socket.io", { ok: false, error: "no_supervisor_connected" });
    const fallback = channel("http-fallback", { ok: true });
    const { deps, entries } = fakeDeps([socketio, fallback]);

    const outcome = await pushAlertWithFallback(deps, PAYLOAD);

    expect(outcome).toEqual<PushOutcome>({ delivered: true, channel: "http-fallback" });
    expect(entries).toHaveLength(1);
    const audit = entries[0];
    if (audit === undefined) {
      throw new Error("expected a fallback audit entry");
    }
    expect(audit).toMatchObject({
      actorType: "system",
      action: "alert_push_fallback",
      resourceType: "alert",
      resourceId: "alert-1",
    });
    expect(audit.meta).toEqual({
      level: "red",
      channel: "socket.io",
      error: "no_supervisor_connected",
    });
    // PII-stripped audit meta: no session, no message, no keyword.
    expect(JSON.stringify(audit.meta)).not.toMatch(/sess-1|message|keyword|phone/);
  });

  it("records a failure audit row and a PII-stripped error log when every channel fails", async () => {
    const socketio = channel("socket.io", { ok: false, error: "no_supervisor_connected" });
    const fallback = channel("http-fallback", { ok: false, error: "http_error_500" });
    const loggerError = vi.fn();
    const { deps, entries } = fakeDeps([socketio, fallback], loggerError);

    const outcome = await pushAlertWithFallback(deps, PAYLOAD);

    expect(outcome).toEqual<PushOutcome>({
      delivered: false,
      attempts: [
        { channel: "socket.io", error: "no_supervisor_connected" },
        { channel: "http-fallback", error: "http_error_500" },
      ],
    });
    expect(entries).toHaveLength(1);
    const failedEntry = entries[0];
    if (failedEntry === undefined) {
      throw new Error("expected a failure audit entry");
    }
    expect(failedEntry).toMatchObject({
      actorType: "system",
      action: "alert_push_failed",
      resourceType: "alert",
      resourceId: "alert-1",
    });
    expect(failedEntry.meta).toEqual({
      level: "red",
      attempts: [
        { channel: "socket.io", error: "no_supervisor_connected" },
        { channel: "http-fallback", error: "http_error_500" },
      ],
    });
    expect(loggerError).toHaveBeenCalledExactlyOnceWith(
      "alert_push_failed",
      expect.objectContaining({ alertId: "alert-1", level: "red" })
    );
    const loggedContext = loggerError.mock.calls[0]?.[1];
    expect(loggedContext).toBeDefined();
    const logged = JSON.stringify(loggedContext);
    expect(logged).not.toMatch(/sess-1|message|keyword|phone/);
  });

  it("fails with a clear audit row when no channel is configured at all", async () => {
    const loggerError = vi.fn();
    const { deps, entries } = fakeDeps([], loggerError);

    const outcome = await pushAlertWithFallback(deps, PAYLOAD);

    expect(outcome).toEqual<PushOutcome>({ delivered: false, attempts: [] });
    expect(entries).toHaveLength(1);
    const failedEntry = entries[0];
    if (failedEntry === undefined) {
      throw new Error("expected a failure audit entry");
    }
    expect(failedEntry.action).toBe("alert_push_failed");
    expect(failedEntry.meta).toEqual({ level: "red", reason: "no_push_channel_configured" });
    expect(loggerError).toHaveBeenCalledExactlyOnceWith("alert_push_failed", expect.anything());
  });

  it("stops at the first successful channel in the chain", async () => {
    const socketio = channel("socket.io", { ok: false, error: "no_supervisor_connected" });
    const fallback = channel("http-fallback", { ok: true });
    const web = channel("web", { ok: true });
    const { deps } = fakeDeps([socketio, fallback, web]);

    const outcome = await pushAlertWithFallback(deps, PAYLOAD);

    expect(outcome).toEqual<PushOutcome>({ delivered: true, channel: "http-fallback" });
    expect(web.push).not.toHaveBeenCalled();
  });
});
