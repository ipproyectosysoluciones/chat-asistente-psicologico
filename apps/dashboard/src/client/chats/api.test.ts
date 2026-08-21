// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatApiError,
  fetchChatDetail,
  fetchChats,
  type ChatDetail,
  type ChatList,
} from "./api";

/**
 * Chats API client (task 5.2 frontend, REQ-DASH-2/9): paginated chat list and
 * the dual chat detail, both zod-validated. Server failures surface as
 * ChatApiError carrying the RFC 7807 detail/code so views can render the exact
 * problem and offer retry.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chunkFixture(): Record<string, unknown> {
  return {
    chunkId: "chunk-1",
    docId: "doc-1",
    chunkIndex: 0,
    content: "Técnica de respiración diafragmática.",
    category: "clinical",
    source: "protocolo-ansiedad",
    language: "es",
    legalFramework: "COL-1581",
    score: 0.87,
  };
}

function ragTraceFixture(): Record<string, unknown> {
  return {
    traceId: "tr-1",
    sessionId: "11111111-1111-7111-8111-111111111111",
    risk: "orange",
    classification: { model: "gpt-4o-mini", risk: "orange", confidence: 0.91 },
    retrieval: {
      model: "text-embedding-3-small",
      topK: 3,
      hnsw: { efSearch: 40 },
      chunks: [chunkFixture()],
    },
    generation: { model: "gpt-4o", temperature: 0 },
    gate: {
      verdict: "orange_block",
      cosine: 0.83,
      nli: { verdict: "entailment", confidence: 0.9 },
      guardrail: { level: "orange", deviationTerms: ["suicidio"], blocked: true },
      chunks: [chunkFixture()],
    },
    emitted: false,
    createdAt: "2026-08-14T12:02:00.000Z",
  };
}

function detailFixture(): Record<string, unknown> {
  return {
    session: {
      id: "11111111-1111-7111-8111-111111111111",
      contactKeyAnon: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      jurisdiction: "CO",
      persistenceClass: "anonymous",
      consentState: "notice_shown",
      aiState: "auto",
      createdAt: "2026-08-14T08:00:00.000Z",
      lastActivityAt: "2026-08-14T12:00:00.000Z",
    },
    messages: [
      {
        id: "m-1",
        sessionId: "11111111-1111-7111-8111-111111111111",
        sender: "user",
        text: "Me siento muy ansioso",
        encrypted: false,
        createdAt: "2026-08-14T12:00:00.000Z",
      },
      {
        id: "m-2",
        sessionId: "11111111-1111-7111-8111-111111111111",
        sender: "bot",
        text: "Entiendo. ¿Quieres practicar una técnica de respiración?",
        encrypted: false,
        createdAt: "2026-08-14T12:01:00.000Z",
      },
    ],
    ragTraces: [ragTraceFixture()],
    alertLevel: "orange",
  };
}

async function expectChatError(
  promise: Promise<unknown>,
  expected: { code: string; detail?: string; status: number }
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ChatApiError);
  if (!(error instanceof ChatApiError)) {
    return;
  }
  expect(error.code).toBe(expected.code);
  expect(error.status).toBe(expected.status);
  if (expected.detail !== undefined) {
    expect(error.detail).toBe(expected.detail);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchChats", () => {
  it("GETs /chats with the bearer token and parses items + total", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        items: [
          {
            sessionId: "11111111-1111-7111-8111-111111111111",
            contactKeyAnon: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
            jurisdiction: "CO",
            persistenceClass: "anonymous",
            aiState: "auto",
            lastActivityAt: "2026-08-14T12:00:00.000Z",
            messageCount: 2,
            openAlertLevel: "orange",
          },
        ],
        total: 1,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result: ChatList = await fetchChats("jwt-token");

    expect(result).toEqual({
      items: [
        {
          sessionId: "11111111-1111-7111-8111-111111111111",
          contactKeyAnon: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
          jurisdiction: "CO",
          persistenceClass: "anonymous",
          aiState: "auto",
          lastActivityAt: "2026-08-14T12:00:00.000Z",
          messageCount: 2,
          openAlertLevel: "orange",
        },
      ],
      total: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith("/chats", {
      headers: { authorization: "Bearer jwt-token" },
    });
  });

  it("appends limit/offset query params when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchChats("jwt-token", { limit: 50, offset: 40 });

    expect(fetchMock).toHaveBeenCalledWith("/chats?limit=50&offset=40", {
      headers: { authorization: "Bearer jwt-token" },
    });
  });

  it("throws ChatApiError with the RFC 7807 detail on a 403", async () => {
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

    await expectChatError(fetchChats("jwt-token"), {
      code: "forbidden",
      detail: "Your role does not allow this operation.",
      status: 403,
    });
  });

  it("throws ChatApiError when the success body fails schema validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          items: [{ sessionId: "s-1" }],
          total: 1,
        })
      )
    );

    await expectChatError(fetchChats("jwt-token"), {
      code: "internal_error",
      status: 200,
    });
  });

  it("throws ChatApiError when the network request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expectChatError(fetchChats("jwt-token"), {
      code: "network_error",
      status: 0,
    });
  });
});

describe("fetchChatDetail", () => {
  it("GETs /chats/:sessionId and parses session, messages, traces and alertLevel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, detailFixture()));
    vi.stubGlobal("fetch", fetchMock);

    const result: ChatDetail = await fetchChatDetail(
      "jwt-token",
      "11111111-1111-7111-8111-111111111111"
    );

    expect(result.session.contactKeyAnon).toMatch(/^a1b2c3d4/);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({ sender: "bot", encrypted: false });
    expect(result.ragTraces).toHaveLength(1);
    expect(result.ragTraces[0]?.gate.verdict).toBe("orange_block");
    expect(result.ragTraces[0]?.gate.guardrail.deviationTerms).toEqual(["suicidio"]);
    expect(result.alertLevel).toBe("orange");
    expect(fetchMock).toHaveBeenCalledWith(
      "/chats/11111111-1111-7111-8111-111111111111",
      { headers: { authorization: "Bearer jwt-token" } }
    );
  });

  it("keeps alertLevel undefined when the server omits it", async () => {
    const body = detailFixture();
    delete body.alertLevel;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, body)));

    const result: ChatDetail = await fetchChatDetail(
      "jwt-token",
      "11111111-1111-7111-8111-111111111111"
    );

    expect(result.alertLevel).toBeUndefined();
  });

  it("throws ChatApiError with code not_found on a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, {
          type: "https://api.chatcap.app/errors/not_found",
          title: "Not Found",
          status: 404,
          detail: "The chat session does not exist.",
          code: "not_found",
        })
      )
    );

    await expectChatError(
      fetchChatDetail("jwt-token", "11111111-1111-7111-8111-111111111111"),
      { code: "not_found", status: 404 }
    );
  });
});
