import { describe, expect, it } from "vitest";

import {
  BatchWorkerError,
  BatchWorkerTimeoutError,
  WorkerThreadBatchCrypto,
  createReencryptionWorkerFactory,
} from "../src/lifecycle/worker-thread";
import type { BatchWorkerPort } from "../src/lifecycle/worker-thread";
import type { BatchCryptoRequest } from "../src/lifecycle/batch-crypto";

/** Scripted worker double: lets the test fire message/error events. */
class FakeWorkerPort implements BatchWorkerPort {
  posted: unknown[] = [];
  terminated = false;
  private listeners: Record<string, Array<(data: unknown) => void>> = { message: [], error: [] };

  on(event: "message" | "error", listener: (data: unknown) => void): void {
    this.listeners[event]?.push(listener);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }

  /** Test hook: simulate the worker replying. */
  emit(event: "message" | "error", data: unknown): void {
    for (const listener of this.listeners[event] ?? []) {
      listener(data);
    }
  }
}

function scriptedFactory(port: FakeWorkerPort) {
  return { create: () => port };
}

const REQUEST: BatchCryptoRequest = {
  keyFrom: 1,
  keyTo: 2,
  saltFrom: Buffer.alloc(32, 1),
  saltTo: Buffer.alloc(32, 2),
  rows: [
    {
      rowId: "r1",
      keyFrom: 1,
      keyTo: 2,
      encodedPayload: Buffer.from("enc"),
    },
  ],
};

describe("WorkerThreadBatchCrypto (crypto off the event loop)", () => {
  it("posts the request and resolves with the worker result", async () => {
    const port = new FakeWorkerPort();
    const worker = new WorkerThreadBatchCrypto(scriptedFactory(port));
    const result = { keyFrom: 1, keyTo: 2, rows: [], integrityHash: "ab".repeat(32), verified: true };

    const promise = worker.run(REQUEST);
    expect(port.posted[0]).toEqual({ type: "request", request: REQUEST });
    port.emit("message", { type: "result", result });

    await expect(promise).resolves.toBe(result);
    expect(port.terminated).toBe(true);
  });

  it("rejects when the worker reports an error message", async () => {
    const port = new FakeWorkerPort();
    const worker = new WorkerThreadBatchCrypto(scriptedFactory(port));

    const promise = worker.run(REQUEST);
    port.emit("message", { type: "error", error: { message: "hmac mismatch" } });

    await expect(promise).rejects.toBeInstanceOf(BatchWorkerError);
    await expect(promise).rejects.toThrow("hmac mismatch");
  });

  it("rejects on a worker crash event", async () => {
    const port = new FakeWorkerPort();
    const worker = new WorkerThreadBatchCrypto(scriptedFactory(port));

    const promise = worker.run(REQUEST);
    port.emit("error", new Error("worker exited"));

    await expect(promise).rejects.toThrow("worker exited");
  });

  it("times out when the worker never answers and still terminates", async () => {
    const port = new FakeWorkerPort();
    const worker = new WorkerThreadBatchCrypto(scriptedFactory(port), 20);

    const promise = worker.run(REQUEST);
    await expect(promise).rejects.toBeInstanceOf(BatchWorkerTimeoutError);
    expect(port.terminated).toBe(true);
  });

  it("provides a factory factory that wraps a Node worker script path", () => {
    const factory = createReencryptionWorkerFactory("/abs/path/reencryption-worker.js");
    const worker = factory.create();
    expect(worker).toBeDefined();
  });
});
