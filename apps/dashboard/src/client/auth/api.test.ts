// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthError,
  fetchMe,
  login,
  TOKEN_STORAGE_KEY,
} from "./api";

/**
 * Auth API client (task 5.1 frontend): POST /auth/login and GET /auth/me with
 * zod-validated responses. The token lives in sessionStorage ONLY (never
 * localStorage — this project handles clinical data, AGENTS.md). Server
 * failures surface as AuthError carrying the RFC 7807 detail/code.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function expectAuthError(
  promise: Promise<unknown>,
  expected: { code: string; detail?: string; status: number }
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(AuthError);
  if (!(error instanceof AuthError)) {
    return;
  }
  expect(error.code).toBe(expected.code);
  expect(error.status).toBe(expected.status);
  if (expected.detail !== undefined) {
    expect(error.detail).toBe(expected.detail);
  }
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login", () => {
  it("POSTs credentials and stores the JWT in sessionStorage on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        token: "jwt-token",
        expiresIn: 900,
        user: { id: "u1", email: "sup@example.com", role: "supervisor" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await login("sup@example.com", "s3cret");

    expect(result).toEqual({
      token: "jwt-token",
      expiresIn: 900,
      user: { id: "u1", email: "sup@example.com", role: "supervisor" },
    });
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe("jwt-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/login",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "sup@example.com", password: "s3cret" }),
      })
    );
  });

  it("throws AuthError with the RFC 7807 detail on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          type: "https://api.chatcap.app/errors/unauthorized",
          title: "Unauthorized",
          status: 401,
          detail: "Invalid credentials.",
          code: "unauthorized",
        })
      )
    );

    await expectAuthError(login("sup@example.com", "wrong"), {
      code: "unauthorized",
      detail: "Invalid credentials.",
      status: 401,
    });
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("throws AuthError when the success body fails schema validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          token: "jwt-token",
          user: { id: "u1", email: "sup@example.com" },
        })
      )
    );

    await expectAuthError(login("sup@example.com", "s3cret"), {
      code: "internal_error",
      status: 200,
    });
  });

  it("throws AuthError when the network request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    );

    await expectAuthError(login("sup@example.com", "s3cret"), {
      code: "network_error",
      status: 0,
    });
  });
});

describe("fetchMe", () => {
  it("returns the current user for a valid token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "u1", email: "admin@example.com", role: "admin" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const user = await fetchMe("jwt-token");

    expect(user).toEqual({
      id: "u1",
      email: "admin@example.com",
      role: "admin",
    });
    expect(fetchMock).toHaveBeenCalledWith("/auth/me", {
      headers: { authorization: "Bearer jwt-token" },
    });
  });

  it("throws AuthError with code unauthorized on a 401", async () => {
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

    await expectAuthError(fetchMe("expired-token"), {
      code: "unauthorized",
      status: 401,
    });
  });
});
