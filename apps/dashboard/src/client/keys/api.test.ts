// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KeysApiError,
  fetchRotationStatus,
  keysErrorMessage,
  rotateKeys,
} from "./api";

/**
 * Keys API client (task 5.6 frontend, REQ-KEY-3): GET /api/v1/keys/rotation and
 * POST /api/v1/keys/rotation/rotate. The token lives in sessionStorage ONLY
 * (never localStorage — clinical data, AGENTS.md). These tests stub
 * `global.fetch` so no real network happens; the Authorization header and JSON
 * bodies are asserted explicitly.
 */

const TOKEN = "eyJ-some-jwt";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rotationStatus(overrides: Partial<Record<string, unknown>> = {}): Record<
  string,
  unknown
> {
  return {
    activeKeyVersion: 2,
    activeCreatedAt: "2026-08-14T12:00:00.000Z",
    daysUntilRotation: 3,
    forcedDue: [
      {
        keyVersion: 1,
        createdAt: "2026-08-07T12:00:00.000Z",
        status: "active",
      },
    ],
    pendingRows: 5,
    ...overrides,
  };
}

function rotateResult(overrides: Partial<Record<string, unknown>> = {}): Record<
  string,
  unknown
> {
  return {
    dryRun: false,
    keyFrom: 2,
    keyTo: 3,
    processed: 5,
    remaining: 0,
    retired: true,
    outcomes: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRotationStatus", () => {
  it("GETs /api/v1/keys/rotation with the bearer token and returns a validated status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: rotationStatus() }));
    vi.stubGlobal("fetch", fetchMock);

    const status = await fetchRotationStatus(TOKEN);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/keys/rotation", {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(status.activeKeyVersion).toBe(2);
    expect(status.daysUntilRotation).toBe(3);
    expect(status.pendingRows).toBe(5);
    expect(status.forcedDue[0]?.keyVersion).toBe(1);
  });

  it("throws a KeysApiError carrying the RFC 7807 detail on a 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(403, {
          type: "https://api.chatcap.app/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Your role does not allow this operation.",
          code: "forbidden",
        })
      )
    );

    await expect(fetchRotationStatus(TOKEN)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      detail: "Your role does not allow this operation.",
    });
  });

  it("throws a KeysApiError on a malformed payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { status: { activeKeyVersion: "not-a-number" } })
      )
    );

    await expect(fetchRotationStatus(TOKEN)).rejects.toMatchObject({
      status: 200,
      code: "internal_error",
    });
  });
});

describe("rotateKeys", () => {
  it("POSTs the command as JSON with the bearer token and parses a 200 result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { result: rotateResult() })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await rotateKeys(TOKEN, { forced: true, dryRun: true });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(options.body as string)).toEqual({
      forced: true,
      dryRun: true,
    });
    expect(result.dryRun).toBe(false);
    expect(result.keyFrom).toBe(2);
  });

  it("throws a KeysApiError carrying the RFC 7807 detail on a 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(403, {
          type: "https://api.chatcap.app/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Your role does not allow this operation.",
          code: "forbidden",
        })
      )
    );

    await expect(
      rotateKeys(TOKEN, { forced: true, dryRun: false })
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      detail: "Your role does not allow this operation.",
    });
  });

  it("throws a network KeysApiError when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"))
    );

    await expect(
      rotateKeys(TOKEN, { forced: false, dryRun: false })
    ).rejects.toMatchObject({
      status: 0,
      code: "network_error",
      detail: "No se pudo conectar con el servidor.",
    });
  });
});

describe("keysErrorMessage", () => {
  it("returns the server detail for a KeysApiError", () => {
    expect(
      keysErrorMessage(
        new KeysApiError({
          status: 409,
          code: "conflict",
          detail: "Already rotating.",
        })
      )
    ).toBe("Already rotating.");
  });

  it("returns a generic message for non-api errors", () => {
    expect(keysErrorMessage(new Error("boom"))).toBe(
      "Ocurrió un error inesperado. Intente nuevamente."
    );
  });
});
