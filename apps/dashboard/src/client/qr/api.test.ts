// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchQrValidation,
  QrApiError,
  qrErrorMessage,
} from "./api";

/**
 * QR validator API client (task 5.7 frontend, REQ-KEY-7): mirrors
 * alerts/api.test.ts — stubs `global.fetch` (no real network) and asserts the
 * Bearer header + the URL-encoded payload/signature params. The validation
 * endpoint reports validity (never errors on an invalid QR), so both a valid
 * and an invalid probe are 200s; only auth/transport failures throw QrApiError.
 */

const TOKEN = "eyJ-some-jwt";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchQrValidation", () => {
  it("GETs /api/v1/qr/validate with both params URL-encoded and the bearer token", async () => {
    const payloadJson = JSON.stringify({
      v: 1,
      consentId: "consent-1",
      termsVersion: 1,
      keyVersion: 1,
      iat: 1_700_000_000,
    });
    const signature = "abc123";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, {
          result: { valid: true, reason: "signature_match", keyVersion: 1 },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQrValidation(TOKEN, payloadJson, signature);

    const [calledUrl, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(
      `/api/v1/qr/validate?payload=${encodeURIComponent(payloadJson)}&signature=${encodeURIComponent(signature)}`
    );
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
    expect(result.valid).toBe(true);
    expect(result.reason).toBe("signature_match");
    expect(result.keyVersion).toBe(1);
  });

  it("returns {valid:false,reason:'invalid_signature'} still 200 for an invalid QR", async () => {
    const payloadJson = JSON.stringify({
      v: 1,
      consentId: "consent-1",
      termsVersion: 1,
      keyVersion: 1,
      iat: 1_700_000_000,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, {
          result: { valid: false, reason: "invalid_signature" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchQrValidation(TOKEN, payloadJson, "deadbeef");

    expect(result).toEqual({ valid: false, reason: "invalid_signature" });
  });

  it("throws a QrApiError carrying the RFC 7807 detail on a 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(403, {
          type: "https://api.chatcap.app/errors/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Insufficient role for this resource.",
          code: "forbidden",
        })
      )
    );

    await expect(
      fetchQrValidation(TOKEN, "{}", "sig")
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      detail: "Insufficient role for this resource.",
    });
  });

  it("throws a QrApiError carrying the RFC 7807 detail on a 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(500, {
          type: "https://api.chatcap.app/errors/internal_error",
          title: "Internal Server Error",
          status: 500,
          detail: "QR validation failed.",
          code: "internal_error",
        })
      )
    );

    await expect(
      fetchQrValidation(TOKEN, "{}", "sig")
    ).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
      detail: "QR validation failed.",
    });
  });
});

describe("qrErrorMessage", () => {
  it("returns the server detail for a QrApiError", () => {
    expect(
      qrErrorMessage(new QrApiError({ status: 403, code: "forbidden", detail: "Forbidden." }))
    ).toBe("Forbidden.");
  });

  it("returns a generic message for non-api errors", () => {
    expect(qrErrorMessage(new Error("boom"))).toBe(
      "Ocurrió un error inesperado. Intente nuevamente."
    );
  });
});
