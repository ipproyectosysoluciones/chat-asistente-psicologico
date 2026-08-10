import { describe, expect, it } from "vitest";

import { parseTelemetryMessage } from "../src/telemetry-parser";

/**
 * Pub-sub payload parser (task 2.1 scaffold): the emitter (packages/telemetry)
 * publishes `TelemetryEvent { type, payload, occurredAt }` as JSON on
 * `telemetry:<type>` channels. Malformed messages must be rejected loudly
 * (undefined) so the router never processes garbage.
 */
describe("parseTelemetryMessage", () => {
  it("parses a valid alert_raised event preserving payload and timestamp", () => {
    const event = parseTelemetryMessage(
      JSON.stringify({
        type: "alert_raised",
        payload: { sessionId: "s-1", level: "red", category: "suicide" },
        occurredAt: "2026-08-09T12:00:00.000Z",
      })
    );
    expect(event).toEqual({
      type: "alert_raised",
      payload: { sessionId: "s-1", level: "red", category: "suicide" },
      occurredAt: "2026-08-09T12:00:00.000Z",
    });
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseTelemetryMessage("{not json")).toBeUndefined();
  });

  it("returns undefined when required fields are missing", () => {
    expect(parseTelemetryMessage(JSON.stringify({ type: "alert_raised" }))).toBeUndefined();
    expect(
      parseTelemetryMessage(
        JSON.stringify({ payload: {}, occurredAt: "2026-08-09T12:00:00.000Z" })
      )
    ).toBeUndefined();
  });

  it("accepts an empty payload for telemetry events without data", () => {
    const event = parseTelemetryMessage(
      JSON.stringify({ type: "purge_run", payload: {}, occurredAt: "2026-08-09T12:00:00.000Z" })
    );
    expect(event?.type).toBe("purge_run");
    expect(event?.payload).toEqual({});
  });
});
