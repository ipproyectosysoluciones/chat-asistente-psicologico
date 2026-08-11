/**
 * Throttle store (REQ-ALERT-5): per-key time windows that suppress repeated
 * notification pushes. The Redis implementation maps to a single atomic
 * `SET key "1" PX <windowMs> NX` — the first call wins, later calls within
 * the window are no-ops, and the key expires on its own.
 */

export interface ThrottleStore {
  /** Returns true when the window is free (allowed), false when throttled. */
  checkAndMark(key: string, windowMs: number): Promise<boolean>;
  /** Primes/extends the window without reading the result. */
  mark(key: string, windowMs: number): Promise<void>;
}

/**
 * Minimal surface of an ioredis client needed by RedisThrottleStore: the
 * positional `SET key value PX <ms> NX` form ioredis actually types (it has
 * no object-form overload). A real `Redis` instance satisfies this interface.
 */
export interface SetArgsClient {
  set(
    key: string,
    value: string,
    msToken: "PX",
    milliseconds: number,
    nx: "NX"
  ): Promise<"OK" | null>;
}

export class RedisThrottleStore implements ThrottleStore {
  constructor(private readonly client: SetArgsClient) {}

  async checkAndMark(key: string, windowMs: number): Promise<boolean> {
    const result = await this.client.set(key, "1", "PX", windowMs, "NX");
    return result === "OK";
  }

  async mark(key: string, windowMs: number): Promise<void> {
    await this.client.set(key, "1", "PX", windowMs, "NX");
  }
}
