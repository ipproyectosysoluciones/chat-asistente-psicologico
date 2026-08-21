// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditPanelPage } from "./AuditPanelPage";
import type { AuditEntry } from "./api";

/**
 * Audit panel page (Phase 5.8 frontend, REQ-DASH-8): initial load renders the
 * audit table; filters are sent on submit; a server error renders a retryable
 * alert. The api module talks to global `fetch`, so these tests stub `fetch`
 * and assert the Bearer header + filter query string.
 */

const TOKEN = "jwt-token";

const ENTRIES: AuditEntry[] = [
  {
    id: "audit-1",
    actorType: "supervisor",
    actorId: "sup-1",
    action: "qr.validate",
    resourceType: "qr",
    resourceId: "qr-1",
    reason: "routine",
    meta: { ip: "10.0.0.1" },
    createdAt: "2026-08-14T12:00:00.000Z",
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/v1/audit")) {
      return Promise.resolve(jsonResponse(200, { entries: ENTRIES, count: 1 }));
    }
    return Promise.resolve(jsonResponse(200, { entries: [], count: 0 }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuditPanelPage", () => {
  it("renders a results row after the initial load", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<AuditPanelPage token={TOKEN} />);

    expect(await screen.findByText("qr.validate")).toBeInTheDocument();
    expect(screen.getByText(/sup-1/)).toBeInTheDocument();
    expect(screen.getByText(/qr-1/)).toBeInTheDocument();

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("sends filters in the query string on search", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AuditPanelPage token={TOKEN} />);

    await screen.findByText("qr.validate");

    await user.type(screen.getByLabelText("resourceType"), "qr");
    await user.type(screen.getByLabelText("actorId"), "sup-1");
    await user.click(screen.getByRole("button", { name: "Buscar" }));

    await waitFor(() => {
      const searchCall = fetchMock.mock.calls.find((call) =>
        (call as [string, RequestInit])[0].includes("/api/v1/audit?")
      );
      expect(searchCall).toBeDefined();
      expect((searchCall as [string, RequestInit])[0]).toContain(
        "resourceType=qr"
      );
      expect((searchCall as [string, RequestInit])[0]).toContain("actorId=sup-1");
    });
  });

  it("shows a retryable error state when the request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        type: "https://api.chatcap.app/errors/forbidden",
        title: "Forbidden",
        status: 403,
        detail: "Supervisor role required.",
        code: "forbidden",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AuditPanelPage token={TOKEN} />);

    expect(
      await screen.findByText(/Supervisor role required\./)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });
});
