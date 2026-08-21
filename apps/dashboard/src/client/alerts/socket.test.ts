// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALERT_EVENT,
  ALERT_UPDATED_EVENT,
  connectAlertSocket,
} from "./socket";

/**
 * Live alert feed socket (task 5.4, REQ-DASH-4/9): connects via socket.io-client
 * with the JWT in `auth.token`. Supervisors room membership is server-side.
 * Payloads are zod-validated; unknown/malformed payloads are ignored, not
 * rendered. `connect_error` surfaces through `onError`. Mock `io` so no real
 * socket is opened.
 */

vi.mock("socket.io-client", () => ({
  io: vi.fn(),
}));

// Import the mocked module to reach the mock factory.
import { io } from "socket.io-client";

function makeFakeSocket() {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
    }),
    disconnect: vi.fn(),
    emit: vi.fn(),
    // Test helpers to drive the registered listeners.
    _emit: (event: string, payload: unknown) => {
      const cb = listeners[event];
      if (cb !== undefined) {
        cb(payload);
      }
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connectAlertSocket", () => {
  it("authenticates with the token and registers the alert listeners", () => {
    const socket = makeFakeSocket();
    vi.mocked(io).mockReturnValue(socket as unknown as ReturnType<typeof io>);

    const alertSocket = connectAlertSocket("jwt-token");

    expect(io).toHaveBeenCalledWith(undefined, { auth: { token: "jwt-token" } });
    expect(socket.on).toHaveBeenCalledWith(ALERT_EVENT, expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith(
      ALERT_UPDATED_EVENT,
      expect.any(Function)
    );
    expect(socket.on).toHaveBeenCalledWith("connect_error", expect.any(Function));

    // Must not leak the raw socket (lifecycle owned by caller).
    expect(alertSocket.disconnect).toBeTypeOf("function");
  });

  it("routes a valid alert:event payload through onAlert", () => {
    const socket = makeFakeSocket();
    vi.mocked(io).mockReturnValue(socket as unknown as ReturnType<typeof io>);

    const received: unknown[] = [];
    const alertSocket = connectAlertSocket("jwt-token");
    alertSocket.onAlert((alert) => received.push(alert));

    socket._emit(ALERT_EVENT, {
      id: "a1",
      level: "red",
      category: "crisis",
      sessionId: "s1",
      status: "open",
      dedupeKey: "k1",
      createdAt: "2026-08-14T12:00:00.000Z",
      updatedAt: "2026-08-14T12:00:00.000Z",
    });

    expect(received[0]).toMatchObject({ id: "a1", level: "red" });
  });

  it("ignores malformed payloads without delivering garbage to the UI", () => {
    const socket = makeFakeSocket();
    vi.mocked(io).mockReturnValue(socket as unknown as ReturnType<typeof io>);

    const received: unknown[] = [];
    const alertSocket = connectAlertSocket("jwt-token");
    alertSocket.onAlert((alert) => received.push(alert));
    alertSocket.onAlertUpdated((alert) => received.push(alert));

    // Missing required fields — must be silently ignored, not rendered.
    socket._emit(ALERT_EVENT, { id: "a1" });
    expect(received).toHaveLength(0);

    // Garbage entirely:
    socket._emit(ALERT_EVENT, "not-an-object");
    expect(received).toHaveLength(0);
  });

  it("maps alert:updated through onAlertUpdated", () => {
    const socket = makeFakeSocket();
    vi.mocked(io).mockReturnValue(socket as unknown as ReturnType<typeof io>);

    const received: unknown[] = [];
    const alertSocket = connectAlertSocket("jwt-token");
    alertSocket.onAlertUpdated((alert) => received.push(alert));

    socket._emit(ALERT_UPDATED_EVENT, {
      id: "a2",
      level: "yellow",
      category: "incoherencencia",
      sessionId: "s2",
      status: "acknowledged",
      dedupeKey: "k2",
      createdAt: "2026-08-14T12:00:00.000Z",
      updatedAt: "2026-08-14T12:01:00.000Z",
      acknowledgedBy: "sup-1",
    });

    expect(received[0]).toMatchObject({ id: "a2", status: "acknowledged" });
  });

  it("surfaces connect_error through onError and disconnects cleanly", () => {
    const socket = makeFakeSocket();
    vi.mocked(io).mockReturnValue(socket as unknown as ReturnType<typeof io>);

    const errors: Error[] = [];
    const alertSocket = connectAlertSocket("jwt-token");
    alertSocket.onError((error) => errors.push(error));

    const failure = new Error("connection refused");
    socket._emit("connect_error", failure);
    expect(errors[0]).toBe(failure);

    alertSocket.disconnect();
    expect(socket.disconnect).toHaveBeenCalled();
  });
});
