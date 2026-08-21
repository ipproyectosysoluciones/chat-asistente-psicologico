// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LegalFrameworksPage } from "./LegalFrameworksPage";
import type { LegalFramework } from "./api";

/**
 * Legal frameworks page (Phase 5.8 frontend): initial load renders the version
 * table; the publish form POSTs the new terms and prepends the created row on
 * success; a server error renders an error notice. The api module talks to
 * global `fetch`, so these tests stub `fetch` and assert the Bearer header +
 * POST body.
 */

const TOKEN = "jwt-token";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const LIST: LegalFramework[] = [
  {
    id: "lf-1",
    countryCode: "AR",
    frameworkCode: "AR-25326",
    noticeText: "Aviso v1.",
    termsVersion: 1,
    active: true,
    createdAt: "2026-08-14T12:00:00.000Z",
  },
];

const CREATED: LegalFramework = {
  id: "lf-2",
  countryCode: "AR",
  frameworkCode: "AR-25326",
  noticeText: "Aviso v2.",
  termsVersion: 2,
  active: true,
  createdAt: "2026-08-15T12:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LegalFrameworksPage", () => {
  it("renders the published frameworks table after load", async () => {
    const fetchMock = vi.fn((input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/v1/legal-frameworks")) {
        return Promise.resolve(jsonResponse(200, { frameworks: LIST }));
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LegalFrameworksPage token={TOKEN} />);

    expect(await screen.findByText("AR-25326")).toBeInTheDocument();
    expect(screen.getByText("AR")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();

    // mock.calls[0] is the fetch param tuple; cast through unknown for the test assertion.
    const [, options] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("publishes a new version and prepends the created row", async () => {
    const fetchMock = vi.fn((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/v1/legal-frameworks") && init?.method !== "POST") {
        return Promise.resolve(jsonResponse(200, { frameworks: LIST }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse(201, CREATED));
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<LegalFrameworksPage token={TOKEN} />);

    await screen.findByText("AR-25326");

    await user.type(screen.getByLabelText("countryCode"), "AR");
    await user.type(screen.getByLabelText("frameworkCode"), "AR-25326");
    await user.type(screen.getByLabelText("noticeText"), "Aviso v2.");
    await user.click(
      screen.getByRole("button", { name: "Publicar nueva versión" })
    );

    const [, options] = await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (entry) =>
          (entry as unknown as [string, RequestInit])[1]?.method === "POST"
      );
      expect(call).toBeDefined();
      return call as unknown as [string, RequestInit];
    });
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(options.body as string)).toEqual({
      countryCode: "AR",
      frameworkCode: "AR-25326",
      noticeText: "Aviso v2.",
    });

    expect(await screen.findByText("Versión 2 de AR-25326 publicada.")).toBeInTheDocument();
    expect(screen.getAllByText("AR-25326").length).toBeGreaterThan(0);
  });

  it("shows an error notice when publishing fails", async () => {
    const fetchMock = vi.fn((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/v1/legal-frameworks") && init?.method !== "POST") {
        return Promise.resolve(jsonResponse(200, { frameworks: LIST }));
      }
      if (init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(500, {
            type: "https://api.chatcap.app/errors/internal",
            title: "Internal Server Error",
            status: 500,
            detail: "Could not publish terms.",
            code: "internal_error",
          })
        );
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<LegalFrameworksPage token={TOKEN} />);

    await screen.findByText("AR-25326");

    await user.type(screen.getByLabelText("countryCode"), "AR");
    await user.type(screen.getByLabelText("frameworkCode"), "AR-25326");
    await user.type(screen.getByLabelText("noticeText"), "Aviso v2.");
    await user.click(
      screen.getByRole("button", { name: "Publicar nueva versión" })
    );

    expect(
      await screen.findByText(/Could not publish terms\./)
    ).toBeInTheDocument();
  });
});
