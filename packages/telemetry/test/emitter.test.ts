import { describe, expect, it } from "vitest";

import { EVENT_TYPE } from "@chatcap/shared-types";

import { RedisEventEmitter, type RedisPublisher, type TelemetryEvent } from "../src/emitter";

function fakePublisher() {
  const calls: Array<{ channel: string; message: string }> = [];
  let failNext = false;
  const publisher: RedisPublisher = {
    async publish(channel: string, message: string) {
      if (failNext) {
        failNext = false;
        throw new Error("redis down");
      }
      calls.push({ channel, message });
      return 1;
    },
  };
  return { calls, publisher, setFailNext: () => (failNext = true) };
}

const alertEvent: TelemetryEvent = {
  type: EVENT_TYPE.ALERT_RAISED,
  payload: { alertId: "alert-1", level: "red", traceId: "trace-abc" },
  occurredAt: "2026-08-09T06:00:00.000Z",
};

describe("RedisEventEmitter (design §2.2)", () => {
  it("publishes the event JSON on telemetry:<type> channel", async () => {
    const { calls, publisher } = fakePublisher();
    const emitter = new RedisEventEmitter(publisher);
    await emitter.publish(alertEvent);
    expect(calls).toHaveLength(1);
    const first = calls[0];
    if (first === undefined) {
      throw new Error("expected one publish call");
    }
    expect(first.channel).toBe("telemetry:alert_raised");
    const parsed = JSON.parse(first.message) as TelemetryEvent;
    expect(parsed.type).toBe(EVENT_TYPE.ALERT_RAISED);
    expect(parsed.payload).toEqual(alertEvent.payload);
    expect(parsed.occurredAt).toBe(alertEvent.occurredAt);
  });

  it("does not leak PII: payload carries ids only", async () => {
    const { calls, publisher } = fakePublisher();
    const emitter = new RedisEventEmitter(publisher);
    await emitter.publish(alertEvent);
    const first = calls[0];
    if (first === undefined) {
      throw new Error("expected one publish call");
    }
    const raw = first.message;
    expect(raw).not.toMatch(/\+?[0-9]{10,}/);
    expect(raw).not.toMatch(/@[a-z]/i);
  });

  it("routes publish failures to the error callback when provided", async () => {
    const { publisher, setFailNext } = fakePublisher();
    const errors: unknown[] = [];
    const emitter = new RedisEventEmitter(publisher, (err) => errors.push(err));
    setFailNext();
    await expect(emitter.publish(alertEvent)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("redis down");
  });

  it("rethrows publish failures when no error callback is wired", async () => {
    const { publisher, setFailNext } = fakePublisher();
    const emitter = new RedisEventEmitter(publisher);
    setFailNext();
    await expect(emitter.publish(alertEvent)).rejects.toThrow("redis down");
  });
});
