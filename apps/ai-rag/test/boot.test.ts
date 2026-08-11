import { describe, expect, test, vi } from "vitest";

import { createLogger, type Logger } from "@chatcap/telemetry";
import { VectorIndexMissingError } from "@chatcap/db-schema";

import { runBootChecks } from "../src/boot";

/**
 * Boot checks (task 3.1, REQ-RAG-2): the service must NEVER accept queries
 * without its HNSW index — fail loudly at boot instead of serving silently
 * degrading retrieval. The assertion itself lives in @chatcap/db-schema;
 * this module owns the boot-time failure logging.
 */

const silentLogger = createLogger({
  level: "silent",
  destination: { write: () => {} },
});

describe("runBootChecks", () => {
  test("resolves when the HNSW index assertion passes", async () => {
    await expect(
      runBootChecks({ logger: silentLogger, assertIndex: async () => {} })
    ).resolves.toBeUndefined();
  });

  test("fails loudly with VectorIndexMissingError when the index is missing", async () => {
    const errorSpy = vi.fn();
    const logger: Logger = {
      ...silentLogger,
      error: errorSpy,
    };

    await expect(
      runBootChecks({
        logger,
        assertIndex: async () => {
          throw new VectorIndexMissingError();
        },
      })
    ).rejects.toThrow(VectorIndexMissingError);
    expect(errorSpy).toHaveBeenCalled();
  });

  test("propagates the original error (no silent swallows)", async () => {
    await expect(
      runBootChecks({
        logger: silentLogger,
        assertIndex: async () => {
          throw new Error("connection refused");
        },
      })
    ).rejects.toThrow("connection refused");
  });
});
