// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AlertSemaphore } from "./AlertSemaphore";
import type { AlertItem } from "./api";

/**
 * Alert semaphore (task 5.4 frontend, REQ-DASH-4/9): live feed via REST +
 * Socket.io. Mocks the api + socket modules so behavior (loading, error+retry,
 * live alert insertion at the top, ack/resolve optimistic updates, socket
 * error notice, WS cleanup on unmount) is assertable without a server.
 */

const TOKEN = "jwt-token";

const ALERT_RED: AlertItem = {
  id: "red-1",
  level: "red",
  category: "crisis",
  sessionId: "11111111-1111-7111-8111-111111111111",
  status: "open",
  dedupeKey: "k-red-1",
  createdAt: "2026-08-14T12:00:00.000Z",
  updatedAt: "2026-08-14T12:00:00.000Z",
};

const ALERT_YELLOW: AlertItem = {
  id: "yel-1",
  level: "yellow",
  category: "incoherencia",
  sessionId: "22222222-2222-7222-8222-222222222222",
  status: "open",
  dedupeKey: "k-yel-1",
  createdAt: "2026-08-14T12:00:00.000Z",
  updatedAt: "2026-08-14T12:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    fetchAlerts: vi.fn(),
    acknowledgeAlert: vi.fn(),
    resolveAlert: vi.fn(),
    alertsErrorMessage: vi.fn((e: unknown) =>
      e instanceof Error ? e.message : "Error inesperado."
    ),
  };
});

vi.mock("./socket", () => ({
  connectAlertSocket: vi.fn(),
  ALERT_EVENT: "alert:event",
  ALERT_UPDATED_EVENT: "alert:updated",
  SUPERVISORS_ROOM: "supervisors",
}));

import { acknowledgeAlert, fetchAlerts, resolveAlert } from "./api";
import { connectAlertSocket } from "./socket";

// The mock returns a control handle so tests can drive incoming socket events.
function wireSocketMock(handlers: {
  onAlert?: (cb: (a: AlertItem) => void) => void;
  onAlertUpdated?: (cb: (a: AlertItem) => void) => void;
  onError?: (cb: (e: Error) => void) => void;
  onDisconnect?: () => void;
}) {
  const disconnect = vi.fn();
  vi.mocked(connectAlertSocket).mockReturnValue({
    onAlert: handlers.onAlert ?? (() => {}),
    onAlertUpdated: handlers.onAlertUpdated ?? (() => {}),
    onError: handlers.onError ?? (() => {}),
    disconnect,
  });
  return { disconnect };
}

describe("AlertSemaphore", () => {
  it("renders loading, then the open alerts with the open count", async () => {
    vi.mocked(fetchAlerts).mockResolvedValue({ items: [ALERT_RED, ALERT_YELLOW], total: 2 });
    wireSocketMock({});

    render(<AlertSemaphore token={TOKEN} />);

    expect(screen.getByText(/Cargando alertas/)).toBeInTheDocument();
    expect(await screen.findByText("2 abiertas")).toBeInTheDocument();
    expect(screen.getByText("Roja")).toBeInTheDocument();
    expect(screen.getByText("Amarilla")).toBeInTheDocument();
  });

  it("shows a red alert at the top when pushed live over the socket", async () => {
    const listFetch = vi
      .fn()
      .mockResolvedValue({ items: [ALERT_YELLOW], total: 1 });
    vi.mocked(fetchAlerts).mockImplementation(listFetch as never);

    let liveAlertCb: ((a: AlertItem) => void) | undefined;
    wireSocketMock({
      onAlert: (cb) => {
        liveAlertCb = cb;
      },
    });

    render(<AlertSemaphore token={TOKEN} />);

    await screen.findByText("Amarilla");
    // A red alert arrives over the live stream — the < 1s contract.
    liveAlertCb?.(ALERT_RED);

    const badge = await screen.findByText("Roja");
    expect(badge).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Roja");
  });

  it("shows an error state with retry that recovers", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Se cayó el servidor."))
      .mockResolvedValueOnce({ items: [ALERT_RED], total: 1 });
    vi.mocked(fetchAlerts).mockImplementation(fetchMock as never);
    wireSocketMock({});
    const user = userEvent.setup();

    render(<AlertSemaphore token={TOKEN} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Se cayó el servidor.");

    await user.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(await screen.findByText("1 abierta")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders an empty state when the feed has no open alerts", async () => {
    vi.mocked(fetchAlerts).mockResolvedValue({ items: [], total: 0 });
    wireSocketMock({});

    render(<AlertSemaphore token={TOKEN} />);

    expect(await screen.findByText("Sin alertas.")).toBeInTheDocument();
  });

  it("calls acknowledge/resolve through the api and updates the row optimistically", async () => {
    vi.mocked(fetchAlerts).mockResolvedValue({ items: [ALERT_RED], total: 1 });
    const ackResolved = new Promise((resolve) => {
      vi.mocked(acknowledgeAlert).mockResolvedValue({ ...ALERT_RED, status: "acknowledged" });
      resolve(undefined);
    });
    vi.mocked(acknowledgeAlert).mockResolvedValue({
      ...ALERT_RED,
      status: "acknowledged",
    });
    vi.mocked(resolveAlert).mockResolvedValue({
      ...ALERT_RED,
      status: "resolved",
    });
    wireSocketMock({});
    await ackResolved;
    const user = userEvent.setup();

    render(<AlertSemaphore token={TOKEN} />);

    await screen.findByText("Roja");
    const ackBtn = screen.getByRole("button", { name: /Reconocer alerta crisis/ });
    await user.click(ackBtn);

    expect(acknowledgeAlert).toHaveBeenCalledWith(TOKEN, "red-1");
    expect(await screen.findByText("acknowledged")).toBeInTheDocument();
  });

  it("surfaces a live notice when the socket drops and cleans up on unmount", async () => {
    vi.mocked(fetchAlerts).mockResolvedValue({ items: [ALERT_RED], total: 1 });
    const disconnect = vi.fn();
    let errorCb: ((e: Error) => void) | undefined;
    wireSocketMock({
      onError: (cb) => {
        errorCb = cb;
      },
    });
    // Re-wire to capture disconnect from the same mock.
    vi.mocked(connectAlertSocket).mockReturnValue({
      onAlert: () => {},
      onAlertUpdated: () => {},
      onError: (cb) => {
        errorCb = cb;
      },
      disconnect,
    });

    const { unmount } = render(<AlertSemaphore token={TOKEN} />);
    await screen.findByText("Roja");

    errorCb?.(new Error("connection lost"));
    expect(
      await screen.findByText("Se perdió la conexión en vivo. Reintentando…")
    ).toBeInTheDocument();

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
