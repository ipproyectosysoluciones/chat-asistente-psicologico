import { describe, expect, test } from "vitest";
import type { Request, Response } from "express";

import { internalTokenMiddleware, tokensEqual } from "../src/internal-token";

/**
 * Internal-token auth (task 3.1, design §8.3): services authenticate to the
 * /internal/* endpoints with one of the X_INTERNAL_TOKENS. Comparison is
 * constant-time; both sides are sha256-hashed so the token length leaks
 * nothing. Shared with the router and reachable by any service on the
 * private Docker network.
 */

describe("tokensEqual", () => {
  test("matches identical tokens", () => {
    expect(tokensEqual("secret-token", "secret-token")).toBe(true);
  });

  test("rejects a different token", () => {
    expect(tokensEqual("secret-token", "other-token")).toBe(false);
  });

  test("rejects tokens of different lengths", () => {
    expect(tokensEqual("short", "a-much-longer-token")).toBe(false);
  });
});

describe("internalTokenMiddleware", () => {
  test("calls next with a matching token", () => {
    const middleware = internalTokenMiddleware(["token-a", "token-b"]);
    const req = { header: () => "token-b" } as unknown as Request;
    let nextCalled = false;

    middleware(req, {} as Response, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  test("rejects with 401 problem+json when the token is missing", () => {
    const middleware = internalTokenMiddleware(["token-a"]);
    const req = { header: () => undefined } as unknown as Request;
    const res = {
      body: null,
      status(code: number) {
        (this as { statusCode?: number }).statusCode = code;
        return this;
      },
      type() {
        return this;
      },
      json(body: unknown) {
        (this as { body: unknown }).body = body;
        return this;
      },
    } as unknown as Response;

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    const body = (res as unknown as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({ status: 401, code: "unauthorized" });
  });
});
