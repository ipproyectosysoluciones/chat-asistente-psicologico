// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AlertApiError,
  acknowledgeAlert,
  alertsErrorMessage,
  fetchAlerts,
  resolveAlert,
} from "./api";

/**
 * Alerts API client (task 5.4 frontend, REQ-DASH-4/9): the token lives in
 * sessionStorage ONLY (never localStorage — this project handles clinical
 * data, AGENTS.md). These tests stub `global.fetch` so no real network
 * happens; the Authorization header and JSON bodies are asserted explicitly.
 */

const TOKEN = "eyJ-some-jwt";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function alertItem(overrides: Partial<Record<string, unknown>> = {}): Record<
  string,
  unknown
> {
  return {
    id: "alert-1",
    level: "red",
    category: "crisis",
    sessionId: "11111111-1111-7111-8111-111111111111",
    status: "open",
    dedupeKey: "key-1",
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z",
    acknowledgedBy: undefined,
    resolvedAt: undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAlerts", () => {
  it("GETs /alerts with the bearer token and returns a validated list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { items: [alertItem()], total: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const list = await fetchAlerts(TOKEN, { limit: 20, offset: 20 });

    expect(fetchMock).toHaveBeenCalledWith("/alerts?limit=20&offset=20", {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(list.total).toBe(1);
    expect(list.items[0]?.id).toBe("alert-1");
  });

  it("omits the query string when no params are given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAlerts(TOKEN);

    expect(fetchMock).toHaveBeenCalledWith("/alerts", expect.anything());
  });

  it("throws an AlertApiError carrying the RFC 7807 detail on a 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          type: "https://api.chatcap.app/errors/unauthorized",
          title: "Unauthorized",
          status: 401,
          detail: "A valid session is required.",
          code: "unauthorized",
        })
      )
    );

    await expect(fetchAlerts(TOKEN)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      detail: "A valid session is required.",
    });
  });
});

describe("acknowledgeAlert", () => {
  it("POSTs to /alerts/:id/acknowledge and returns the updated alert", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, alertItem({ id: "alert-x", status: "acknowledged" }))
      );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await acknowledgeAlert(TOKEN, "alert-x");

    expect(fetchMock).toHaveBeenCalledWith("/alerts/alert-x/acknowledge", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: undefined,
    });
    expect(updated.status).toBe("acknowledged");
  });
});

describe("resolveAlert", () => {
  it("POSTs the reason only when provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, alertItem({ id: "alert-x", status: "resolved" }))
      );
    vi.stubGlobal("fetch", fetchMock);

    await resolveAlert(TOKEN, "alert-x", "duplicate");

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(options.body as string)).toEqual({ reason: "duplicate" });
  });

  it("omits the reason when no reason is given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, alertItem({ status: "resolved" }))
      );
    vi.stubGlobal("fetch", fetchMock);

    await resolveAlert(TOKEN, "alert-x");

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    // api.ts sends an empty JSON body ({}) when no reason is supplied.
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(options.body).toBe("{}");
  });
});

describe("alertsErrorMessage", () => {
  it("returns the server detail for an AlertApiError", () => {
    expect(
      alertsErrorMessage(new AlertApiError({ status: 409, code: "conflict", detail: "Already resolved." }))
    ).toBe("Already resolved.");
  });

  it("returns a generic message for non-api errors", () => {
    expect(alertsErrorMessage(new Error("boom"))).toBe(
      "Ocurrió un error inesperado. Intente nuevamente."
    );
  });
});
