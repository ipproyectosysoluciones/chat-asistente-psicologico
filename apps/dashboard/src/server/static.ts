import { existsSync } from "node:fs";
import { resolve } from "node:path";

import express, { type RequestHandler } from "express";

/**
 * Static client serving (task 5.1, design §7.1 "Vite static served by
 * Express"): serves the built Vite SPA from dist/ when index.html exists and
 * answers unknown non-API GET routes with index.html (minimal, explicit SPA
 * fallback). API prefixes (/auth, /api) and JSON routes are never shadowed.
 * When the client has not been built (test suite, API-only deployment) the
 * handler passes through so the RFC 7807 404 handler keeps answering.
 */

const API_PATH_PREFIXES = ["/auth", "/api"] as const;

export function createClientServing(distDir: string): RequestHandler[] {
  const indexFile = resolve(distDir, "index.html");
  if (!existsSync(indexFile)) {
    return [(_req, _res, next) => next()];
  }
  return [express.static(distDir), createSpaFallback(indexFile)];
}

function createSpaFallback(indexFile: string): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET") {
      next();
      return;
    }
    if (API_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
      next();
      return;
    }
    res.sendFile(indexFile);
  };
}
