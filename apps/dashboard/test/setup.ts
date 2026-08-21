import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals; RTL's auto-cleanup would not fire, so unmount
// every rendered tree explicitly after each test (node-env runs no-op).
afterEach(() => {
  cleanup();
});
