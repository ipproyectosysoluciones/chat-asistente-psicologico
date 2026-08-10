import { describe, expect, it } from "vitest";

import { parseRaiseAlertRequest, type RaiseAlertRequest } from "../src/raise-alert";

/**
 * Raise-alert payload contract (design §8.3): the chat-bot publishes
 * validated raise-alert requests on the internal Redis channel; the
 * notifications service must reject malformed payloads instead of trusting
 * the wire format.
 */

const VALID: RaiseAlertRequest = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  level: "red",
  category: "suicide",
  keyword: "quiero morir",
};

describe("parseRaiseAlertRequest (contract validation)", () => {
  it("accepts a complete valid payload", () => {
    expect(parseRaiseAlertRequest(VALID)).toEqual(VALID);
  });

  it("accepts an alert without a keyword", () => {
    const { keyword: _keyword, ...rest } = VALID;
    expect(parseRaiseAlertRequest(rest)).toEqual(rest);
  });

  it("tolerates unknown fields (tolerant reader) and strips them", () => {
    expect(parseRaiseAlertRequest({ ...VALID, futureField: "x" })).toEqual(VALID);
  });

  it("rejects an unknown severity level", () => {
    expect(parseRaiseAlertRequest({ ...VALID, level: "purple" })).toBeUndefined();
  });

  it("rejects a payload without a session id", () => {
    expect(parseRaiseAlertRequest({ level: "red", category: "suicide" })).toBeUndefined();
  });

  it("rejects a non-object payload", () => {
    expect(parseRaiseAlertRequest("red")).toBeUndefined();
    expect(parseRaiseAlertRequest(null)).toBeUndefined();
  });
});
