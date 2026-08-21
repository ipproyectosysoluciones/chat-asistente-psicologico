import type { Logger } from "@chatcap/telemetry";

/**
 * Boot checks (task 3.1, REQ-RAG-2): the service must NEVER accept queries
 * without its HNSW vector index — fail loudly at boot instead of serving
 * silently degrading retrieval. The assertion itself lives in
 * @chatcap/db-schema; this module owns the boot-time failure logging.
 */

export interface BootDeps {
  logger: Logger;
  assertIndex: () => Promise<void>;
}

export async function runBootChecks(deps: BootDeps): Promise<void> {
  try {
    await deps.assertIndex();
    deps.logger.info("startup assertion passed: HNSW vector index present");
  } catch (error) {
    deps.logger.error("startup assertion FAILED: HNSW vector index missing", {
      error: String(error),
    });
    throw error;
  }
}
