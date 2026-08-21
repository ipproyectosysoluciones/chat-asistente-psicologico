import { defineConfig } from "vitest/config";

/**
 * Phase 7.3 e2e suite config.
 *
 * The full-stack smoke needs generous timeouts because it talks to a live
 * compose stack (build + first-process latency on pgvector / OpenAI). `globals`
 * lets the tests use `describe`/`it`/`expect` without per-file imports.
 */
export default defineConfig({
  test: {
    globalSetup: "./globalSetup.ts",
    include: ["tests/**/*.test.ts"],
    globals: true,
    testTimeout: 60000,
    hookTimeout: 120000,
    // No live assertions run if the stack is not up; the tests `it.skip`
    // themselves, so a missing stack must not fail the run locally.
    passWithNoTests: true,
  },
});
