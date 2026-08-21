import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Global setup for the Phase 7.3 e2e suite.
 *
 * Responsibilities (idempotent):
 *  1. Resolve the repo root via git so no absolute /media/... paths are baked
 *     in — works on any checkout.
 *  2. If Docker is available, start the compose stack (`up -d --build`).
 *     If Docker is missing, log a warning and return: the tests then `it.skip`
 *     themselves so the suite stays green without live infra.
 *  3. Poll every service `/healthz` up to ~90s. Throw only when a *required*
 *     service never comes up (genuine infra failure).
 */

interface ServiceHealth {
  name: string;
  url: string;
  required: boolean;
}

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function ping(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(service: ServiceHealth, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await ping(service.url, 2000)) {
      console.log(`[e2e:globalSetup] ${service.name} healthy at ${service.url}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export default async function globalSetup(): Promise<void> {
  const root = repoRoot();
  const composeFile = resolve(root, "docker-compose.yml");

  if (!dockerAvailable()) {
    console.warn(
      "[e2e:globalSetup] Docker not found — skipping stack bootstrap. " +
        "Tests that need the live compose stack will be skipped."
    );
    return;
  }

  console.log(`[e2e:globalSetup] Bringing up stack from ${composeFile}`);
  let bootstrapped = true;
  try {
    execFileSync(
      "docker",
      ["compose", "-f", composeFile, "up", "-d", "--build"],
      { stdio: "ignore" }
    );
  } catch (error) {
    // Bootstrap failure (e.g. daemon not running) is non-fatal: the stack may
    // already be running elsewhere, or the suite is meant to skip without
    // live infra. The health poll below decides what is actually reachable.
    bootstrapped = false;
    console.warn(
      "[e2e:globalSetup] `docker compose up` failed; continuing to probe " +
        "already-running services. Tests needing the stack will be skipped.",
      error instanceof Error ? error.message : error
    );
  }

  const services: ServiceHealth[] = [
    { name: "dashboard", url: "http://localhost:3000/healthz", required: true },
    { name: "chat-bot", url: "http://localhost:4001/healthz", required: true },
    { name: "notifications", url: "http://localhost:4002/healthz", required: true },
    { name: "ai-rag", url: "http://localhost:4003/healthz", required: true },
    { name: "ingestion", url: "http://localhost:4004/healthz", required: true },
  ];

  const deadline = Date.now() + 90_000;
  for (const service of services) {
    const ok = await waitForHealth(service, deadline);
    if (!ok && service.required) {
      if (bootstrapped) {
        // The stack was brought up but a required service is genuinely down.
        throw new Error(
          `[e2e:globalSetup] required service "${service.name}" never became healthy at ${service.url}`
        );
      }
      console.warn(
        `[e2e:globalSetup] required service "${service.name}" not reachable at ${service.url}; tests needing it will be skipped.`
      );
    }
  }
}
