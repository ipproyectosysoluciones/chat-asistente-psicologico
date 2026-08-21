import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Response } from "express";

import { documentHandler } from "../src/ingest-router";
import type { IngestionDeps } from "../src/ingest-router";

/** Minimal express-like response used by the unit tests. */
interface MockResponse {
  status: Mock<(code: number) => MockResponse>;
  json: Mock<(body: unknown) => void>;
}

const vec = () => [0.1, 0.2] as const;
const embedN = vi.fn().mockImplementation((chunks: readonly string[]) =>
  Promise.resolve(chunks.map(() => vec()))
);

function makeDeps(overrides: Partial<IngestionDeps> = {}): IngestionDeps {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    embed: embedN,
    upsertVectorChunks: vi.fn().mockResolvedValue({ inserted: 2, blacklistedChars: 0 }),
    searchVectorChunks: vi.fn().mockResolvedValue([]),
    listAlerts: vi.fn().mockResolvedValue({ count: 0 }),
    revectorizeDocument: vi.fn().mockResolvedValue({ deleted: 0 }),
    internalTokens: ["secret"],
    chunkMinChars: 500,
    chunkMaxChars: 800,
    ...overrides,
  };
}

function makeReq(body: unknown, token?: string) {
  return {
    body,
    header: (name: string) => (name === "x-internal-token" ? token : undefined),
  } as never;
}
function makeRes(): MockResponse {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}
async function dispatch(deps: IngestionDeps, body: unknown, token?: string) {
  const res = makeRes();
  // test mock stands in for the express Response expected by the handler
  await documentHandler(deps)(makeReq(body, token), res as unknown as Response, () => {});
  return res;
}

const MIN_BODY = { text: "x".repeat(600), category: "note", source: "upload", language: "es", legalFramework: "argentina" };
const cleanLong = "Este es un texto clinico limpio y seguro. ".repeat(40);

describe("POST /documents", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("rejects unauthorized requests (missing token)", async () => {
    const res = await dispatch(makeDeps(), MIN_BODY);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects documents shorter than the minimum length after filtering", async () => {
    const res = await dispatch(makeDeps(), { ...MIN_BODY, text: "hola" }, "secret");
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "payload_too_short" }));
  });

  it("filters blacklist, chunks, embeds, and upserts a clean document", async () => {
    const deps = makeDeps();
    const res = await dispatch(deps, { ...MIN_BODY, text: cleanLong }, "secret");
    expect(deps.embed).toHaveBeenCalledTimes(1);
    const embedArg = vi.mocked(deps.embed).mock.calls[0]![0] as string[];
    expect(Array.isArray(embedArg)).toBe(true);
    expect(embedArg.length).toBeGreaterThan(1);
    expect(deps.upsertVectorChunks).toHaveBeenCalledOnce();
    expect(deps.searchVectorChunks).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it("returns 409 when a prohibited-zone chunk collides with a red alert", async () => {
    const deps = makeDeps({
      searchVectorChunks: vi.fn().mockResolvedValue([
        { chunkId: "c1", docId: "d1", score: 0.95, alertId: "a42", alertLevel: "orange" },
      ]),
    });
    const res = await dispatch(deps, { ...MIN_BODY, text: cleanLong }, "secret");
    expect(res.status).toHaveBeenCalledWith(409);
    expect(deps.upsertVectorChunks).not.toHaveBeenCalled();
  });

  it("re-vectorizes (deletes stale chunks) when a docId is supplied (REQ-INGEST-5)", async () => {
    const deps = makeDeps();
    const docId = "123e4567-e89b-42d3-a456-426614174000";
    await dispatch(deps, { ...MIN_BODY, text: cleanLong, docId }, "secret");
    expect(deps.revectorizeDocument).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.revectorizeDocument).mock.calls[0]![0]).toBe(docId);
  });

  it("upsert input is fully tagged with language/legalFramework (REQ-INGEST-4)", async () => {
    const deps = makeDeps();
    await dispatch(
      deps,
      { ...MIN_BODY, text: cleanLong, language: "es", legalFramework: "argentina", source: "curated-book" },
      "secret"
    );
    const upsertArg = vi.mocked(deps.upsertVectorChunks).mock.calls[0]![0];
    const first = upsertArg[0]!;
    expect(first.language).toBe("es");
    expect(first.legalFramework).toBe("argentina");
    expect(first.source).toBe("curated-book");
    expect(first.docId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.chunkIndex).toBe(0);
  });
});
