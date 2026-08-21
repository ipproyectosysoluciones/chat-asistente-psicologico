// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FrameworksApiError,
  fetchLegalFrameworks,
  frameworksErrorMessage,
  publishLegalFramework,
} from "./api";

/**
 * Legal-framework API client (Phase 5.8 frontend): GET /api/v1/legal-frameworks
 * (published version list, supervisor-only) and POST /api/v1/legal-frameworks
 * (publish a new terms version). These tests stub `global.fetch` so no real
 * network happens; the Authorization header, JSON body and RFC 7807 error
 * parsing are asserted explicitly.
 */

const TOKEN = "eyJ-some-supervisor-jwt";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function framework(overrides: Record<string, unknown> = {}): Record<
  string,
  unknown
> {
  return {
    id: "lf-1",
    countryCode: "AR",
    frameworkCode: "AR-25326",
    noticeText: "Aviso de privacidad.",
    termsVersion: 1,
    active: true,
    createdAt: "2026-08-14T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLegalFrameworks", () => {
  it("GETs /api/v1/legal-frameworks with the bearer token and returns validated frameworks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { frameworks: [framework()] })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchLegalFrameworks(TOKEN);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/legal-frameworks", {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.frameworkCode).toBe("AR-25326");
    expect(result[0]?.termsVersion).toBe(1);
    expect(result[0]?.active).toBe(true);
  });

  it("throws a FrameworksApiError carrying the RFC 7807 detail on a 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(403, {
          type: "https://api.chatcap.app/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Supervisor role required.",
          code: "forbidden",
        })
      )
    );

    await expect(fetchLegalFrameworks(TOKEN)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      detail: "Supervisor role required.",
    });
  });
});

describe("publishLegalFramework", () => {
  it("POSTs the publish payload and returns the created framework on 201", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(201, framework({ termsVersion: 2 }))
      );
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      countryCode: "AR",
      frameworkCode: "AR-25326",
      noticeText: "Aviso de privacidad v2.",
    };
    const created = await publishLegalFramework(TOKEN, input);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(options.body as string)).toEqual(input);
    expect(created.termsVersion).toBe(2);
    expect(created.frameworkCode).toBe("AR-25326");
  });

  it("throws a FrameworksApiError on a 500 with the problem detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(500, {
          type: "https://api.chatcap.app/errors/internal",
          title: "Internal Server Error",
          status: 500,
          detail: "Could not publish terms.",
          code: "internal_error",
        })
      )
    );

    await expect(
      publishLegalFramework(TOKEN, {
        countryCode: "AR",
        frameworkCode: "AR-25326",
        noticeText: "x",
      })
    ).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
      detail: "Could not publish terms.",
    });
  });
});

describe("frameworksErrorMessage", () => {
  it("returns the server detail for a FrameworksApiError", () => {
    expect(
      frameworksErrorMessage(
        new FrameworksApiError({
          status: 403,
          code: "forbidden",
          detail: "No access.",
        })
      )
    ).toBe("No access.");
  });

  it("returns a generic message for non-api errors", () => {
    expect(frameworksErrorMessage(new Error("boom"))).toBe(
      "Ocurrió un error inesperado. Intente nuevamente."
    );
  });
});
