// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuditApiError,
  auditErrorMessage,
  fetchAuditLog,
  type AuditQuery,
} from "./api";

/**
 * Audit-log API client (Phase 5.8 frontend, REQ-DASH-8): GET /api/v1/audit
 * with optional filters (resourceType/resourceId/actorId/from/to/limit) and the
 * supervisor Bearer token. The token lives in sessionStorage ONLY (clinical
 * data, AGENTS.md) — never logged. These tests stub `global.fetch` so no real
 * network happens; the Authorization header, query string and RFC 7807 error
 * parsing are asserted explicitly.
 */

const TOKEN = "eyJ-some-supervisor-jwt";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function auditEntry(overrides: Record<string, unknown> = {}): Record<
  string,
  unknown
> {
  return {
    id: "audit-1",
    actorType: "supervisor",
    actorId: "sup-1",
    action: "qr.validate",
    resourceType: "qr",
    resourceId: "qr-1",
    reason: "routine",
    meta: { ip: "10.0.0.1" },
    createdAt: "2026-08-14T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAuditLog", () => {
  it("GETs /api/v1/audit with the bearer token and returns validated entries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { entries: [auditEntry()], count: 1 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const query: AuditQuery = {
      resourceType: "qr",
      resourceId: "qr-1",
      actorId: "sup-1",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T23:59:59.000Z",
      limit: 50,
    };
    const result = await fetchAuditLog(TOKEN, query);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/audit?resourceType=qr&resourceId=qr-1&actorId=sup-1&from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-31T23%3A59%3A59.000Z&limit=50",
      {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      }
    );
    expect(result.count).toBe(1);
    expect(result.entries[0]?.id).toBe("audit-1");
    expect(result.entries[0]?.actorType).toBe("supervisor");
  });

  it("omits empty query params from the URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { entries: [], count: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAuditLog(TOKEN, {});

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/audit",
      expect.anything()
    );
  });

  it("throws an AuditApiError carrying the RFC 7807 detail on a 403", async () => {
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

    await expect(fetchAuditLog(TOKEN)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      detail: "Supervisor role required.",
    });
  });

  it("throws an AuditApiError on a 500 with the problem detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(500, {
          type: "https://api.chatcap.app/errors/internal",
          title: "Internal Server Error",
          status: 500,
          detail: "Audit store unavailable.",
          code: "internal_error",
        })
      )
    );

    await expect(fetchAuditLog(TOKEN)).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
      detail: "Audit store unavailable.",
    });
  });
});

describe("auditErrorMessage", () => {
  it("returns the server detail for an AuditApiError", () => {
    expect(
      auditErrorMessage(
        new AuditApiError({ status: 403, code: "forbidden", detail: "No access." })
      )
    ).toBe("No access.");
  });

  it("returns a generic message for non-api errors", () => {
    expect(auditErrorMessage(new Error("boom"))).toBe(
      "Ocurrió un error inesperado. Intente nuevamente."
    );
  });
});
