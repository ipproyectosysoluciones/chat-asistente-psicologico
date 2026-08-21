import { describe, expect, it, vi, type Mock } from "vitest";
import type { Response } from "express";
import { removeChunkHandler, type RemovalDeps } from "../src/removal-router";

/** Minimal express-like response used by the unit tests. */
interface MockResponse {
  status: Mock<(code: number) => MockResponse>;
  json: Mock<(body: unknown) => void>;
}

const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";

function makeDeps(overrides: Partial<RemovalDeps> = {}): RemovalDeps {
  return {
    removeChunk: vi.fn().mockResolvedValue({ deleted: 1 }),
    insertAudit: vi.fn().mockResolvedValue(undefined),
    internalTokens: ["secret"],
    ...overrides,
  };
}

function makeReq(params: Record<string, string>, token?: string, actorId?: string) {
  return {
    params,
    header: (name: string) => {
      if (name === "x-internal-token") return token;
      if (name === "x-actor-id") return actorId;
      return undefined;
    },
  } as never;
}
function makeRes(): MockResponse {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}
async function dispatch(deps: RemovalDeps, params = { docId: VALID_UUID, chunkIndex: "3" }, token?: string, actorId?: string) {
  const res = makeRes();
  // test mock stands in for the express Response expected by the handler
  await removeChunkHandler(deps)(makeReq(params, token, actorId), res as unknown as Response, () => {});
  return res;
}

describe("DELETE /:docId/chunks/:chunkIndex", () => {
  it("rejects unauthorized requests (missing token)", async () => {
    const res = await dispatch(makeDeps());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a non-UUID docId", async () => {
    const res = await dispatch(makeDeps(), { docId: "not-a-uuid", chunkIndex: "3" }, "secret");
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "validation_error" }));
  });

  it("rejects a negative chunkIndex", async () => {
    const res = await dispatch(makeDeps(), { docId: VALID_UUID, chunkIndex: "-1" }, "secret");
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("audit-logs THEN deletes the chunk and returns 204", async () => {
    const deps = makeDeps();
    const res = await dispatch(deps, { docId: VALID_UUID, chunkIndex: "3" }, "secret", "sup-007");
    // audit MUST happen before delete
    const auditOrder = vi.mocked(deps.insertAudit).mock.invocationCallOrder[0]!;
    const deleteOrder = vi.mocked(deps.removeChunk).mock.invocationCallOrder[0]!;
    expect(auditOrder).toBeLessThan(deleteOrder);

    expect(deps.insertAudit).toHaveBeenCalledOnce();
    const audit = vi.mocked(deps.insertAudit).mock.calls[0]![0];
    expect(audit.actorType).toBe("supervisor");
    expect(audit.actorId).toBe("sup-007");
    expect(audit.resourceType).toBe("vector_chunk");
    expect(audit.resourceId).toBe(`${VALID_UUID}:3`);
    expect(audit.meta).toEqual({ docId: VALID_UUID, chunkIndex: 3 });
    expect(deps.removeChunk).toHaveBeenCalledWith(VALID_UUID, 3);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("returns 404 when the chunk does not exist (audit still logged)", async () => {
    const deps = makeDeps({ removeChunk: vi.fn().mockResolvedValue({ deleted: 0 }) });
    const res = await dispatch(deps, { docId: VALID_UUID, chunkIndex: "3" }, "secret");
    expect(res.status).toHaveBeenCalledWith(404);
    expect(deps.insertAudit).toHaveBeenCalledOnce();
  });
});
