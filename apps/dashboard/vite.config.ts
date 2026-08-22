import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite client config (task 5.1, design §7.1 "Vite static served by Express"):
 * the built SPA lands in apps/dashboard/dist and is served by the Express
 * backend in production. In dev, /auth/* requests are proxied to the Express
 * API on the service port (src/server/config.ts — PORT, default 3000).
 */

const DEV_API_PORT = Number(process.env.PORT ?? 3000);

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  server: {
    proxy: {
      "/auth": {
        target: `http://localhost:${DEV_API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
  },
});
