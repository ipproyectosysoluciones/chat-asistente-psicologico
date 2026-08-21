// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useChatDetail, useChats } from "./hooks";

/**
 * Chats data hooks (task 5.2 frontend, REQ-DASH-9): discriminated-union state
 * (loading / error / ready) with an explicit reload() for the retry button.
 * Re-fetches when the session/page/token inputs change.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SESSION_ID = "11111111-1111-7111-8111-111111111111";

function chatListBody(): Record<string, unknown> {
  return {
    items: [
      {
        sessionId: SESSION_ID,
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
  };
}

function chatDetailBody(): Record<string, unknown> {
  return {
    session: {
      id: SESSION_ID,
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
        sessionId: SESSION_ID,
        sender: "user",
        text: "Me siento muy ansioso",
        encrypted: false,
        createdAt: "2026-08-14T12:00:00.000Z",
      },
    ],
    ragTraces: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useChats", () => {
  it("fetches the chat list and reaches the ready state with parsed data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, chatListBody()));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChats("jwt-token", { limit: 20, offset: 0 }));

    expect(result.current.state).toEqual({ status: "loading" });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    expect(result.current.state).toMatchObject({
      status: "ready",
      data: { total: 1 },
    });
    if (result.current.state.status === "ready") {
      expect(result.current.state.data.items[0]?.sessionId).toBe(SESSION_ID);
    }
    expect(fetchMock).toHaveBeenCalledWith("/chats?limit=20&offset=0", {
      headers: { authorization: "Bearer jwt-token" },
    });
  });

  it("reaches the error state with the server detail on failure", async () => {
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

    const { result } = renderHook(() => useChats("jwt-token", { limit: 20, offset: 0 }));

    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state).toEqual({
      status: "error",
      message: "Your role does not allow this operation.",
    });
  });

  it("reload() refetches and recovers after an error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(500, {
          type: "https://api.chatcap.app/errors/internal_error",
          title: "Internal Server Error",
          status: 500,
          detail: "An unexpected error occurred.",
          code: "internal_error",
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, chatListBody()));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChats("jwt-token", { limit: 20, offset: 0 }));
    await waitFor(() => expect(result.current.state.status).toBe("error"));

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("useChatDetail", () => {
  it("fetches the chat detail and reaches the ready state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, chatDetailBody()));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChatDetail("jwt-token", SESSION_ID));

    expect(result.current.state).toEqual({ status: "loading" });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    if (result.current.state.status === "ready") {
      expect(result.current.state.data.messages[0]).toMatchObject({
        sender: "user",
        encrypted: false,
      });
    }
    expect(fetchMock).toHaveBeenCalledWith(`/chats/${SESSION_ID}`, {
      headers: { authorization: "Bearer jwt-token" },
    });
  });

  it("refetches when the sessionId changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, chatDetailBody()));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useChatDetail("jwt-token", sessionId),
      { initialProps: { sessionId: SESSION_ID } }
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    rerender({ sessionId: "22222222-2222-7222-8222-222222222222" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/chats/22222222-2222-7222-8222-222222222222", {
      headers: { authorization: "Bearer jwt-token" },
    });
  });

  it("reload() refetches after an error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, {
        type: "https://api.chatcap.app/errors/not_found",
        title: "Not Found",
        status: 404,
        detail: "The chat session does not exist.",
        code: "not_found",
      }))
      .mockResolvedValueOnce(jsonResponse(200, chatDetailBody()));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChatDetail("jwt-token", SESSION_ID));
    await waitFor(() => expect(result.current.state.status).toBe("error"));

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
