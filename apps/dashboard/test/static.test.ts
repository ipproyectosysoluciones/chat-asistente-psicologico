import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { notFoundHandler } from "../src/server/errors";
import { createClientServing } from "../src/server/static";

/**
 * Static client serving (task 5.1, design §7.1 "Vite static served by
 * Express"): serves the built Vite SPA from dist/ when present and answers
 * unknown non-API GET routes with index.html. API routes and the JSON 404
 * handler are never shadowed; when the client is not built the handler passes
 * through so app.test.ts keeps its RFC 7807 404 behavior.
 */

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  servers.length = 0;
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
});

async function startServer(distDir: string): Promise<string> {
  const app = express();
  app.use(createClientServing(distDir));
  app.use(notFoundHandler);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chatcap-dashboard-dist-"));
  tempDirs.push(dir);
  return dir;
}

describe("createClientServing", () => {
  it("passes through to the JSON 404 when the client is not built", async () => {
    const distDir = await makeTempDir();
    const baseUrl = await startServer(distDir);

    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("serves index.html and static assets from a built client", async () => {
    const distDir = await makeTempDir();
    await writeFile(join(distDir, "index.html"), '<div id="root"></div>');
    await mkdir(join(distDir, "assets"));
    await writeFile(join(distDir, "assets", "app.js"), "console.log('app');");
    const baseUrl = await startServer(distDir);

    const indexResponse = await fetch(`${baseUrl}/`);
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("content-type")).toMatch(/text\/html/);
    expect(await indexResponse.text()).toContain('<div id="root"></div>');

    const assetResponse = await fetch(`${baseUrl}/assets/app.js`);
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toContain("console.log('app');");
  });

  it("answers unknown non-API GET routes with the SPA index.html", async () => {
    const distDir = await makeTempDir();
    await writeFile(join(distDir, "index.html"), '<div id="root"></div>');
    const baseUrl = await startServer(distDir);

    const response = await fetch(`${baseUrl}/chats/abc`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root"></div>');
  });

  it("never shadows API routes: they reach the JSON 404 handler", async () => {
    const distDir = await makeTempDir();
    await writeFile(join(distDir, "index.html"), '<div id="root"></div>');
    const baseUrl = await startServer(distDir);

    for (const path of ["/api/v1/dashboard/chats", "/auth/me"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "not_found" });
    }
  });

  it("rejects non-GET routes with 404 even when the client is built", async () => {
    const distDir = await makeTempDir();
    await writeFile(join(distDir, "index.html"), '<div id="root"></div>');
    const baseUrl = await startServer(distDir);

    const response = await fetch(`${baseUrl}/chats`, { method: "POST" });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });
});
