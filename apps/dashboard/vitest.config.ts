import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    // Component tests opt into jsdom via the `// @vitest-environment jsdom`
    // docblock; the node default keeps server tests dependency-free.
    environment: "node",
    setupFiles: ["test/setup.ts"],
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@chatcap": resolve(import.meta.dirname, "../../packages"),
    },
  },
});
