import type {
  BatchCryptoRequest,
  BatchCryptoResult,
  BatchCryptoWorker,
} from "./batch-crypto";

/**
 * worker_thread bridge (REQ-KEY-4: crypto must not block the event loop).
 * The parent dispatches a BatchCryptoRequest; the worker runs
 * executeBatchWithStore against its own PostgreSQL client and answers with
 * {type:'result'} or {type:'error'}. The port is duck-typed so tests can
 * script a fake worker without spinning real threads.
 */

export interface BatchWorkerPort {
  postMessage(message: unknown): void;
  on(event: "message" | "error", listener: (data: unknown) => void): void;
  terminate(): Promise<unknown>;
}

export interface BatchWorkerFactory {
  create(): BatchWorkerPort;
}

export class BatchWorkerError extends Error {
  readonly code = "batch_worker_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "BatchWorkerError";
  }
}

export class BatchWorkerTimeoutError extends Error {
  readonly code = "batch_worker_timeout" as const;

  constructor(timeoutMs: number) {
    super(`Batch worker did not respond within ${timeoutMs}ms`);
    this.name = "BatchWorkerTimeoutError";
  }
}

export class WorkerThreadBatchCrypto implements BatchCryptoWorker {
  constructor(
    private readonly factory: BatchWorkerFactory,
    private readonly timeoutMs = 30_000
  ) {}

  run(request: BatchCryptoRequest): Promise<BatchCryptoResult> {
    const worker = this.factory.create();
    return new Promise<BatchCryptoResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new BatchWorkerTimeoutError(this.timeoutMs));
      }, this.timeoutMs);

      worker.on("message", (data) => {
        clearTimeout(timer);
        // safe: data arrives via structured clone from our own worker entry;
        // the shape is validated below (type === 'result' / 'error') before
        // any field is read, so the cast is only a narrowing convenience.
        const message = data as { type?: string; result?: BatchCryptoResult; error?: { message?: string } };
        if (message?.type === "result" && message.result !== undefined) {
          resolve(message.result);
        } else if (message?.type === "error") {
          reject(new BatchWorkerError(message.error?.message ?? "unknown worker error"));
        } else {
          reject(new BatchWorkerError("malformed worker reply"));
        }
      });
      worker.on("error", (error) => {
        clearTimeout(timer);
        reject(
          error instanceof Error ? error : new BatchWorkerError(String(error))
        );
      });
      worker.postMessage({ type: "request", request });
    }).finally(() => {
      void worker.terminate();
    });
  }
}

/**
 * Production factory factory: points at the compiled worker entry. The path
 * is injected so tests never touch the real script.
 */
export function createReencryptionWorkerFactory(
  workerScriptPath: string
): BatchWorkerFactory {
  return {
    create() {
      // safe: node:worker_threads is a builtin whose Worker matches the
      // BatchWorkerPort duck type (postMessage/on/terminate); tests inject a
      // fake factory instead, so this path only runs in production.
      const { Worker } = require("node:worker_threads") as typeof import("node:worker_threads");
      // safe: Node's Worker implements postMessage/on/terminate with the same
      // shapes the port interface declares; structural compatibility checked
      // once here instead of duplicating the upstream types.
      return new Worker(workerScriptPath) as unknown as BatchWorkerPort;
    },
  };
}
