import type { KeyProvider } from "@chatcap/config";
import type { DbQueryable, QueryResultRow } from "@chatcap/db-schema";

import type {
  BatchCryptoRequest,
  BatchCryptoResult,
  BatchCryptoWorker,
} from "../src/lifecycle/batch-crypto";
import type { RotationAuditEvent } from "../src/lifecycle/audit-hooks";

/** Deterministic test master secret. */
export const TEST_MASTER = Buffer.from("test-master-secret-0123456789abcdef", "utf8");

export function staticMasterKeyProvider(): KeyProvider {
  return { getMasterSecret: async () => TEST_MASTER };
}

export interface FakeResponseEntry {
  /** Match on the SQL text and its bound parameters. */
  match: (sql: string, params: unknown[]) => boolean;
  rows?: QueryResultRow[];
  /** Consumed in order — after exhaustion the entry stops matching. */
  rowsQueue?: QueryResultRow[][];
}

/** Pattern-matching fake queryable that records every call. */
export function fakeDb(
  responses: FakeResponseEntry[]
): DbQueryable & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: DbQueryable = {
    async query<T extends QueryResultRow>(text: string, values?: unknown[]) {
      calls.push({ sql: text, params: values ?? [] });
      const hit = responses.find((entry) => {
        if (!entry.match(text, values ?? [])) return false;
        return entry.rows !== undefined || (entry.rowsQueue?.length ?? 0) > 0;
      });
      if (hit === undefined) {
        throw new Error(`fakeDb: no matching response for query: ${text.slice(0, 90)}`);
      }
      if (hit.rows !== undefined) {
        // safe: test fixtures are authored to match the T rows each test
        // declares; the fake exists to script queries, not to validate data.
        return { rows: hit.rows as T[], rowCount: hit.rows.length };
      }
      const rows = hit.rowsQueue!.shift() ?? [];
      // safe: same as above — queue entries are author-controlled fixtures
      // that the calling test typed as T by construction.
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
  return Object.assign(db, { calls });
}

/** Collects audit events for assertions. */
export class InMemoryAuditSink {
  readonly events: RotationAuditEvent[] = [];

  write(event: RotationAuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

/** Deterministic worker double for coordinator tests. */
export class MockBatchWorker implements BatchCryptoWorker {
  constructor(
    private readonly behavior: (
      request: BatchCryptoRequest
    ) => BatchCryptoResult | Promise<BatchCryptoResult>
  ) {}

  run(request: BatchCryptoRequest): Promise<BatchCryptoResult> {
    return Promise.resolve(this.behavior(request));
  }
}
