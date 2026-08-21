import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp, type AppDeps } from "../src/server/app";
import { createLogger } from "@chatcap/telemetry";

/**
 * App factory (task 5.1 scaffold): /healthz liveness, /readyz dependency
 * probe (pg), RFC 7807 404 for unknown routes, the optional built-client
 * serving (design §7.1), and the chats API mount (task 5.2). Mirrors the
 * notifications and ai-rag scaffolds.
 */

function makeDeps(
  readinessOverrides: Partial<AppDeps["readiness"]> = {},
  clientDistDir?: string
): AppDeps {
  return {
    logger: createLogger({ level: "silent" }),
    jwt: { secret: "j".repeat(32), ttlSeconds: 900 },
    users: {
      async findByEmail() {
        return undefined;
      },
      async findById() {
        return undefined;
      },
    },
    audit: {
      async write() {},
    },
    chats: {
      async listChats() {
        return { items: [], total: 0 };
      },
      async getSession() {
        return undefined;
      },
      async listMessages() {
        return [];
      },
      async listRagTraces() {
        return [];
      },
      async findOpenAlertLevel() {
        return undefined;
      },
    },
    readiness: {
      database: { check: async () => {} },
      chatbot: { check: async () => {} },
      ...readinessOverrides,
    },
    ...(clientDistDir === undefined ? {} : { clientDistDir }),
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
});

async function makeBuiltDist(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chatcap-dashboard-app-dist-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "index.html"), '<div id="root"></div>');
  return dir;
}

describe("createApp", () => {
  it("serves /healthz with 200", async () => {
    const app = createApp(makeDeps());
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    server.close();
  });

  it("serves /readyz with 200 when all probes pass", async () => {
    const app = createApp(makeDeps());
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready" });
    server.close();
  });

  it("serves /readyz with 503 when a probe fails", async () => {
    const app = createApp(
      makeDeps({
        database: {
          check: async () => {
            throw new Error("pg down");
          },
        },
      })
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "unready" });
    server.close();
  });

  it("returns an RFC 7807 problem for unknown routes", async () => {
    const app = createApp(makeDeps());
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    server.close();
  });

  it("mounts the chats API, which answers JSON instead of the SPA fallback", async () => {
    const app = createApp(makeDeps());
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/chats`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
    server.close();
  });

  it("serves the built client with an SPA fallback when clientDistDir is provided", async () => {
    const app = createApp(makeDeps({}, await makeBuiltDist()));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const spa = await fetch(`${baseUrl}/app/some-client-route`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('<div id="root"></div>');

    const api = await fetch(`${baseUrl}/auth/me`);
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ code: "unauthorized" });
    server.close();
  });
});
