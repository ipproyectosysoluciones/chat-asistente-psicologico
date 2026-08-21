import { describe, expect, it, vi } from "vitest";
import type { DbQueryable, QueryResult, QueryResultRow } from "@chatcap/db-schema";
import type { ProhibitedHit, UpsertInput } from "../src/ingest-router";
import { PgVectorStore } from "../src/vector-store";
import { PROHIBITED_THRESHOLD } from "../src/ingest-router";

function mkInput(i: number): UpsertInput {
  const last5 = String(i % 100000).padStart(5, "0");
  return {
    docId: `123e4567-e89b-42d3-a456-${last5}`.slice(0, 36),
    chunkIndex: i,
    chunk: `chunk-${i}-text`,
    embedding: [0.1, 0.2],
    category: "note",
    source: "upload",
    language: "es",
    legalFramework: "argentina",
    metadata: { filtered: "false", blacklistedChars: 0 },
  };
}

function makeDbMock(rows: QueryResultRow[] = []): { db: DbQueryable; calls: unknown[] } {
  const calls: unknown[] = [];
  const db: DbQueryable = {
    query: vi.fn(async (text: string, values?: unknown[]): Promise<QueryResult> => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    }) as DbQueryable["query"],
  };
  return { db, calls };
}

describe("PgVectorStore.upsertVectorChunks", () => {
  it("returns zero when no chunks are given", async () => {
    const { db } = makeDbMock();
    const store = new PgVectorStore(db);
    const res = await store.upsertVectorChunks([]);
    expect(res).toEqual({ inserted: 0, blacklistedChars: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("inserts with parameterized SQL (no embedded text) — 9 params/row", async () => {
    const { db, calls } = makeDbMock();
    const store = new PgVectorStore(db);

    const input = [mkInput(0), mkInput(1)];
    const res = await store.upsertVectorChunks(input);

    expect(res.inserted).toBe(2);
    const sql = (calls[0] as { text: string; values: unknown[] }).text;
    const values = (calls[0] as { values: unknown[] }).values;
    expect(sql).toContain("INSERT INTO vector_chunks");
    expect(sql).not.toContain("chunk-0-text");
    expect(sql).toContain("ON CONFLICT (doc_id, chunk_index)");
    expect(values.length).toBe(2 * 9);
    expect(values).toContain("chunk-0-text");
    expect(values).toContain("[0.1,0.2]");
    expect(values).toContain("argentina");
    expect(values).toContain(JSON.stringify({ filtered: "false", blacklistedChars: 0 }));
  });

  it("batches 100-row rule into multiple statements", async () => {
    const { db, calls } = makeDbMock();
    const store = new PgVectorStore(db);

    const big = Array.from({ length: 250 }, (_, i) => mkInput(i));
    const res = await store.upsertVectorChunks(big);

    expect(res.inserted).toBe(250);
    expect(calls.length).toBe(3); // 100 + 100 + 50
    expect((calls[0] as { values: unknown[] }).values.length).toBe(100 * 9);
    expect((calls[2] as { values: unknown[] }).values.length).toBe(50 * 9);
  });
});

describe("PgVectorStore.revectorizeDocument", () => {
  it("deletes all chunks for a document", async () => {
    const { db } = makeDbMock();
    const store = new PgVectorStore(db);
    vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 3 });
    const res = await store.revectorizeDocument("doc-1");
    expect(res).toEqual({ deleted: 3 });
    expect(vi.mocked(db.query).mock.calls[0]![1]).toEqual(["doc-1"]);
  });
});

describe("PgVectorStore.removeChunk", () => {
  it("deletes a single chunk by (docId, chunkIndex)", async () => {
    const { db } = makeDbMock();
    const store = new PgVectorStore(db);
    vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await store.removeChunk("doc-1", 3);
    expect(res).toEqual({ deleted: 1 });
    expect(vi.mocked(db.query).mock.calls[0]![1]).toEqual(["doc-1", 3]);
  });
});

describe("PgVectorStore.searchVectorChunks (prohibited-zone sweep)", () => {
  it("maps red/orange hit rows and filters sub-threshold/yellow", async () => {
    const { db } = makeDbMock([
      { id: "vc1", doc_id: "d1", score: 0.96, alert_id: "a1", alert_level: "orange" },
      { id: "vc2", doc_id: "d2", score: 0.92, alert_id: "a2", alert_level: "red" },
      { id: "vc3", doc_id: "d3", score: 0.50, alert_id: "a3", alert_level: "yellow" },
    ]);
    const store = new PgVectorStore(db);
    const hits: ProhibitedHit[] = await store.searchVectorChunks([0, 0, 1], ["psychoeducation"]);

    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBe(0.96);
    expect(hits[0]!.alertLevel).toBe("orange");
    const sql = vi.mocked(db.query).mock.calls[0]![0];
    expect(sql).toContain("<=> $1::vector");
    expect(sql).toContain("status = 'open'");
    expect(sql).toContain("level IN ('red','orange')");
  });

  it("filters null alert rows out", async () => {
    const { db } = makeDbMock([
      { id: "vc1", doc_id: "d1", score: 0.96, alert_id: null, alert_level: null },
    ]);
    const store = new PgVectorStore(db);
    const hits = await store.searchVectorChunks([0.1], ["note"]);
    expect(hits).toHaveLength(0);
  });

  it("passes PROHIBITED_THRESHOLD into the query", async () => {
    const { db } = makeDbMock();
    const store = new PgVectorStore(db);
    await store.searchVectorChunks([0.1, 0.2], []);
    const params = vi.mocked(db.query).mock.calls[0]![1]!;
    expect(params[1]).toBe(PROHIBITED_THRESHOLD);
    expect(params[2]).toBe(null);
  });
});
