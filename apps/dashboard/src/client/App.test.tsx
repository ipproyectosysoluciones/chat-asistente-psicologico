// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { TOKEN_STORAGE_KEY } from "./auth/api";

/**
 * Auth gate (task 5.1 frontend) + chats shell (task 5.2): no token → login
 * page; token → /auth/me → header with role + logout and the chat list view;
 * /auth/me failure → error state with retry. The alert semaphore (task 5.4)
 * renders inside the authenticated home, so its socket module is stubbed and
 * GET /alerts answers an empty feed here.
 */

const socketMocks = vi.hoisted(() => ({
  connectAlertSocket: vi.fn(() => ({
    onAlert: vi.fn(),
    onAlertUpdated: vi.fn(),
    onError: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

vi.mock("./alerts/socket", () => ({
  connectAlertSocket: socketMocks.connectAlertSocket,
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const AUTH_USER_BODY = { id: "u1", email: "sup@example.com", role: "supervisor" };
const EMPTY_CHATS_BODY = { sessions: [], total: 0, limit: 20, offset: 0 };
const EMPTY_ALERTS_BODY = { items: [], total: 0 };

function authedFetchMock(): typeof fetch {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/me")) {
      return Promise.resolve(jsonResponse(200, AUTH_USER_BODY));
    }
    if (url.includes("/alerts")) {
      return Promise.resolve(jsonResponse(200, EMPTY_ALERTS_BODY));
    }
    return Promise.resolve(jsonResponse(200, EMPTY_CHATS_BODY));
  });
}

beforeEach(() => {
  sessionStorage.clear();
  socketMocks.connectAlertSocket.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App auth gate", () => {
  it("shows the login page when no token is stored", () => {
    render(<App />);

    expect(screen.getByLabelText("Correo electrónico")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Panel de Supervisión" })).toBeInTheDocument();
  });

  it("shows the header with the logged user role after /auth/me resolves", async () => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "jwt-token");
    vi.stubGlobal("fetch", authedFetchMock());

    render(<App />);

    expect(await screen.findByText(/sup@example\.com/)).toBeInTheDocument();
    expect(screen.getByText("supervisor")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Conversaciones" })
    ).toBeInTheDocument();
  });

  it("shows an error with retry when /auth/me fails", async () => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "expired-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          type: "https://api.chatcap.app/errors/unauthorized",
          title: "Unauthorized",
          status: 401,
          detail: "Invalid or expired token.",
          code: "unauthorized",
        })
      )
    );

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid or expired token."
    );
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("logs out and returns to the login page", async () => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "jwt-token");
    vi.stubGlobal("fetch", authedFetchMock());
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/sup@example\.com/);

    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));

    expect(screen.getByLabelText("Correo electrónico")).toBeInTheDocument();
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});
