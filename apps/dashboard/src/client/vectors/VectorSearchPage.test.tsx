// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VectorSearchPage } from "./VectorSearchPage";
import type { VectorSearchResponse } from "./api";

/**
 * Vector search page (task 5.5 frontend, REQ-DASH-RAG-7): debounced query →
 * grounding-trace table + per-row "Eliminar" (manual chunk removal). The api
 * module talks to global `fetch`, so these tests stub `fetch` (no server) and
 * assert the Bearer header + the DELETE re-rank removal on click.
 */

const TOKEN = "jwt-token";

const SEARCH_RESPONSE: VectorSearchResponse = {
  chunks: [
    {
      chunkId: "chunk-1",
      docId: "11111111-1111-4111-8111-111111111111",
      chunkIndex: 0,
      content: "Respuesta de ejemplo sobre salud mental.",
      category: "terapia",
      source: "manual-clinico-v1",
      language: "es",
      legalFramework: "AR-25326",
      score: 0.91,
    },
  ],
  query: "hola",
  count: 1,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/v1/vectors/search")) {
      return Promise.resolve(jsonResponse(200, SEARCH_RESPONSE));
    }
    if (init?.method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse(200, { chunks: [], query: "", count: 0 }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VectorSearchPage", () => {
  it("renders the search input and shows a result row after a debounced search", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<VectorSearchPage token={TOKEN} />);

    await user.type(screen.getByPlaceholderText(/Buscar vectores/i), "hola");

    const row = await screen.findByText("terapia");
    expect(row).toBeInTheDocument();
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("sends a DELETE with the bearer token when 'Eliminar' is clicked", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<VectorSearchPage token={TOKEN} />);

    await user.type(screen.getByPlaceholderText(/Buscar vectores/i), "hola");
    await screen.findByText("terapia");

    await user.click(screen.getByRole("button", { name: "Eliminar" }));

    const deleteCalls = fetchMock.mock.calls.filter(
      (call) => (call as [string, RequestInit | undefined])[1]?.method === "DELETE"
    );
    await waitFor(() => {
      expect(deleteCalls).toHaveLength(1);
    });
    expect(deleteCalls[0]?.[1]).toMatchObject({
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  });

  it("shows a retryable error state when the search fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(502, {
        type: "https://api.chatcap.app/errors/upstream_failed",
        title: "Upstream Failed",
        status: 502,
        detail: "Vector search could not be completed.",
        code: "upstream_failed",
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<VectorSearchPage token={TOKEN} />);

    await user.type(screen.getByPlaceholderText(/Buscar vectores/i), "hola");

    expect(
      await screen.findByText(/Vector search could not be completed/)
    ).toBeInTheDocument();
  });
});
