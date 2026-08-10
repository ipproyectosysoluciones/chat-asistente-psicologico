import { describe, expect, it } from "vitest";

import { RedisThrottleStore } from "../src/throttle";

/**
 * Throttle store (REQ-ALERT-5): a per-key window that suppresses repeated
 * notification pushes. The Redis implementation is a single atomic
 * `SET key value NX PX windowMs` — NX wins the first set, subsequent sets
 * within the window are no-ops, and the window expires on its own.
 */

interface FakeClient {
  calls: Array<{ key: string; value: string; px: number; nx: boolean }>;
  nextResult: "OK" | null;
  set(key: string, value: string, args: { PX: number; NX: boolean }): Promise<"OK" | null>;
}

function fakeClient(nextResult: "OK" | null): FakeClient {
  const calls: FakeClient["calls"] = [];
  const client: FakeClient = {
    calls,
    nextResult,
    async set(key, value, args) {
      calls.push({ key, value, px: args.PX, nx: args.NX });
      return client.nextResult;
    },
  };
  return client;
}

describe("RedisThrottleStore", () => {
  it("allows the first raise and throttles repeats within the window", async () => {
    const client = fakeClient("OK");
    const store = new RedisThrottleStore(client);
    expect(await store.checkAndMark("alert:throttle:red:k1", 60_000)).toBe(true);
    client.nextResult = null; // window still active
    expect(await store.checkAndMark("alert:throttle:red:k1", 60_000)).toBe(false);
  });

  it("issues an atomic SET with NX and PX window", async () => {
    const client = fakeClient("OK");
    const store = new RedisThrottleStore(client);
    await store.mark("alert:throttle:orange:k2", 300_000);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      key: "alert:throttle:orange:k2",
      value: "1",
      px: 300_000,
      nx: true,
    });
  });
});
