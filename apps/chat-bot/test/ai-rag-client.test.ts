import { describe, expect, it, vi } from "vitest";

import { HttpAiRagClient } from "../src/ai-rag-client";

/**
 * Internal ai-rag client (task 4.1, REQ-CHATBOT-2/7): the chat-bot calls
 * POST /internal/rag/process with the shared internal-token auth header and
 * maps the four response kinds to chat actions. The `RagOutcome` mapping is
 * what the flow slice (4.6) will consume to decide grounded emission vs
 * fallback vs crisis escalation.
 */

const BASE_URL = "http://ai-rag:3000";
const TOKEN = "token-b";

function responseWith(kind: string): Response {
  const body =
    kind === "emitted"
      ? { kind, answer: "respuesta", trace: { id: "t1" } }
      : kind === "flagged"
        ? {
            kind,
            answer: "respuesta",
            fallbackText: "cuidado",
            trace: { id: "t1" },
          }
        : kind === "crisis"
          ? { kind, fallbackText: "contacta emergencias", trace: { id: "t1" } }
          : { kind, fallbackText: "no puedo", trace: { id: "t1" } };
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeClient(fetchMock: typeof fetch): HttpAiRagClient {
  return new HttpAiRagClient({
    baseUrl: BASE_URL,
    internalToken: TOKEN,
    fetchImpl: fetchMock,
  });
}

describe("HttpAiRagClient (task 4.1 internal process call)", () => {
  it("posts to /internal/rag/process with the internal-token header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseWith("blocked"));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await client.process({ sessionId: "s1", message: "mensaje" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://ai-rag:3000/internal/rag/process");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-internal-token": TOKEN,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: "s1",
      message: "mensaje",
    });
  });

  it.each([
    ["emitted", "answer"],
    ["flagged", "answer"],
    ["blocked", "fallbackText"],
    ["crisis", "fallbackText"],
  ])("maps the %s outcome to a chat action", async (kind, contentKey) => {
    const fetchMock = vi.fn().mockResolvedValue(responseWith(kind));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    const outcome = await client.process({ sessionId: "s1", message: "m" });

    expect(outcome.kind).toBe(kind);
    expect(outcome).toHaveProperty(contentKey);
  });

  it("throws RagUpstreamError with the HTTP status on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("down", { status: 503 })
    );
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(client.process({ sessionId: "s1", message: "m" })).rejects.toEqual(
      expect.objectContaining({
        name: "RagUpstreamError",
        status: 503,
      })
    );
  });

  it("health returns true on 2xx and false on errors", async () => {
    const ok = makeClient(
      vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) as unknown as typeof fetch
    );
    expect(await ok.health()).toBe(true);

    const down = makeClient(
      vi.fn().mockRejectedValue(new Error("network")) as unknown as typeof fetch
    );
    expect(await down.health()).toBe(false);
  });
});
