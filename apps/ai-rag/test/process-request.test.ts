import { describe, expect, test } from "vitest";

import {
  parseRagProcessRequest,
  ragProcessRequestSchema,
} from "../src/process-request";

/**
 * Internal process contract (task 3.1): the chat-bot calls
 * POST /internal/rag/process with { sessionId, message }; the zod schema is
 * the single validation point so a malformed body never reaches the pipeline.
 */

describe("rag process request validation", () => {
  test("accepts a well-formed request", () => {
    const parsed = parseRagProcessRequest({
      sessionId: "0195e3f2-0000-7000-8000-000000000001",
      message: "Me siento ansioso.",
    });

    expect(parsed).toEqual({
      sessionId: "0195e3f2-0000-7000-8000-000000000001",
      message: "Me siento ansioso.",
    });
  });

  test("rejects a missing sessionId", () => {
    expect(parseRagProcessRequest({ message: "hola" })).toBeUndefined();
  });

  test("rejects an empty message", () => {
    expect(
      parseRagProcessRequest({ sessionId: "s1", message: "" })
    ).toBeUndefined();
  });

  test("rejects an overlong message (> 4000 chars)", () => {
    const result = ragProcessRequestSchema.safeParse({
      sessionId: "s1",
      message: "a".repeat(4001),
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-object payloads", () => {
    expect(parseRagProcessRequest("hola")).toBeUndefined();
    expect(parseRagProcessRequest(null)).toBeUndefined();
  });
});
