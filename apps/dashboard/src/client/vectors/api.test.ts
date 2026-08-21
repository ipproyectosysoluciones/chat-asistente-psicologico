// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VectorsApiError,
  deleteVectorChunk,
  fetchVectorSearch,
  vectorsErrorMessage,
} from "./api";

/**
 * Vectors API client (task 5.5 frontend, REQ-DASH-RAG-7): GET the
 * vector-search grounding trace and DELETE a single chunk from a document.
 * Responses are zod-validated so a malformed server payload never renders.
 * Failures surface as VectorsApiError carrying the RFC 7807 detail/code — the
 * explorer surfaces the exact problem and offers retry (REQ-DASH-9). The token
 * lives in sessionStorage ONLY (never localStorage — clinical data, AGENTS.md).
 * These tests stub `global.fetch` so no real network happens; the Authorization
 * header and JSON bodies are asserted explicitly.
 */

const TOKEN = "eyJ-some-jwt";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chunk(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    chunkId: "chunk-1",
    docId: "11111111-1111-4111-8111-111111111111",
    chunkIndex: 0,
    content: "Respuesta de ejemplo sobre salud mental.",
    category: "terapia",
    source: "manual-clinico-v1",
    language: "es",
    legalFramework: "AR-25326",
    score: 0.91,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchVectorSearch", () => {
  it("GETs /api/v1/vectors/search with the bearer token and returns a validated response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { chunks: [chunk()], query: "hola", count: 1 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchVectorSearch(TOKEN, { q: "hola", limit: 10 });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/vectors/search?q=hola&limit=10", {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.count).toBe(1);
    expect(response.chunks[0]?.chunkId).toBe("chunk-1");
  });

  it("omits optional filters when not provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { chunks: [], query: "hola", count: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchVectorSearch(TOKEN, { q: "hola" });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/vectors/search?q=hola", {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.count).toBe(0);
  });

  it("throws a VectorsApiError carrying the RFC 7807 detail on a 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          type: "https://api.chatcap.app/errors/validation_error",
          title: "Validation Error",
          status: 400,
          detail: "q must be a non-empty string.",
          code: "validation_error",
        })
      )
    );

    await expect(fetchVectorSearch(TOKEN, { q: "hola" })).rejects.toMatchObject({
      status: 400,
      code: "validation_error",
      detail: "q must be a non-empty string.",
    });
  });

  it("throws a VectorsApiError carrying the RFC 7807 detail on a 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(502, {
          type: "https://api.chatcap.app/errors/upstream_failed",
          title: "Upstream Failed",
          status: 502,
          detail: "Vector search could not be completed.",
          code: "upstream_failed",
        })
      )
    );

    await expect(fetchVectorSearch(TOKEN, { q: "hola" })).rejects.toMatchObject({
      status: 502,
      code: "upstream_failed",
      detail: "Vector search could not be completed.",
    });
  });
});

describe("deleteVectorChunk", () => {
  it("DELETEs the chunk and resolves on a 204", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteVectorChunk(TOKEN, "11111111-1111-4111-8111-111111111111", 0);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/vectors/documents/11111111-1111-4111-8111-111111111111/chunks/0",
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      }
    );
  });

  it("throws a VectorsApiError carrying the RFC 7807 detail on a 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(502, {
          type: "https://api.chatcap.app/errors/upstream_failed",
          title: "Upstream Failed",
          status: 502,
          detail: "Vector search could not be completed.",
          code: "upstream_failed",
        })
      )
    );

    await expect(
      deleteVectorChunk(TOKEN, "11111111-1111-4111-8111-111111111111", 3)
    ).rejects.toMatchObject({
      status: 502,
      code: "upstream_failed",
    });
  });
});

describe("vectorsErrorMessage", () => {
  it("returns the server detail for a VectorsApiError", () => {
    expect(
      vectorsErrorMessage(
        new VectorsApiError({
          status: 409,
          code: "conflict",
          detail: "Already removed.",
        })
      )
    ).toBe("Already removed.");
  });

  it("returns a generic message for non-api errors", () => {
    expect(vectorsErrorMessage(new Error("boom"))).toBe(
      "Ocurrió un error inesperado. Intente nuevamente."
    );
  });
});
