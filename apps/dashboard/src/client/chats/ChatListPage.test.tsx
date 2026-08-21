// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatListPage } from "./ChatListPage";

/**
 * Chat list view (task 5.2 frontend, REQ-DASH-2/9): paginated anonymized
 * conversations with alert badges; loading, error-with-retry and empty states.
 */

const SESSION_ID = "11111111-1111-7111-8111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatListPage", () => {
  it("renders loading, then the anonymized chat list, and opens a chat on click", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, chatListBody()))
    );
    const onOpenChat = vi.fn();
    const user = userEvent.setup();

    render(<ChatListPage token="jwt-token" onOpenChat={onOpenChat} />);

    expect(screen.getByText(/Cargando conversaciones/)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /b2c3d4e5f6a1/ })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /b2c3d4e5f6a1/ }));

    expect(onOpenChat).toHaveBeenCalledWith(SESSION_ID);
  });

  it("shows the alert badge for a chat with an open alert", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, chatListBody()))
    );

    render(<ChatListPage token="jwt-token" onOpenChat={vi.fn()} />);

    expect(await screen.findByText("orange")).toBeInTheDocument();
  });

  it("shows an error state with retry that recovers", async () => {
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
    const user = userEvent.setup();

    render(<ChatListPage token="jwt-token" onOpenChat={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An unexpected error occurred."
    );
    await user.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(await screen.findByRole("button", { name: /b2c3d4e5f6a1/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders an empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { items: [], total: 0 }))
    );

    render(<ChatListPage token="jwt-token" onOpenChat={vi.fn()} />);

    expect(await screen.findByText("No hay conversaciones.")).toBeInTheDocument();
  });

  it("navigates pages with the pager", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      sessionId: `99999999-9999-7999-8999-${String(index).padStart(12, "0")}`,
      contactKeyAnon: `anon-${index}-c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2`,
      jurisdiction: "AR",
      persistenceClass: "anonymous" as const,
      aiState: "auto" as const,
      lastActivityAt: "2026-08-14T12:00:00.000Z",
      messageCount: 1,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { items, total: 25 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ChatListPage token="jwt-token" onOpenChat={vi.fn()} />);

    expect(
      await screen.findByRole("button", { name: /anon-0-/ })
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Siguiente" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith("/chats?limit=20&offset=20", {
        headers: { authorization: "Bearer jwt-token" },
      });
    });
  });
});
