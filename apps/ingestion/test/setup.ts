import { afterEach } from "vitest";
// Reset fetch/global stubs between tests (same contract as dashboard).
afterEach(() => {
  // Intentionally empty: per-test stubs are unstubbed in their own afterEach.
});
