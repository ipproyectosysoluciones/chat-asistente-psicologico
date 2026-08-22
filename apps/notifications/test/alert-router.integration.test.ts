import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { runMigrations, resolveAlert, upsertSession } from "@chatcap/db-schema";

import { pgAlertStore } from "../src/alert-store";
import { routeAlert } from "../src/alert-router";
import type { RaiseAlertRequest } from "../src/raise-alert";
import type { ThrottleStore } from "../src/throttle";

const execFileAsync = promisify(execFile);

/**
 * Router integration suite (REQ-ALERT-5) against a real pgvector container:
 * the pgAlertStore adapter + routeAlert must reproduce the one-open-alert
 * lifecycle end-to-end. Gated behind RUN_PG_INTEGRATION=1 like the db-schema
 * suites; uses a recording throttle fake (Redis semantics covered by unit
 * tests) so no Redis container is required here.
 */
const RUN_INTEGRATION = process.env.RUN_PG_INTEGRATION === "1";
const run = RUN_INTEGRATION ? describe : describe.skip;

const CONTAINER_PREFIX = "chatcap-pg-router-";
const port = 57432 + (process.pid % 500);
const databaseUrl = `postgres://chatcap:chatcap_test@127.0.0.1:${port}/chatcap_test`;
const containerName = `${CONTAINER_PREFIX}${process.pid}-${Date.now()}`;

async function dockerRun(args: string[]): Promise<void> {
  await execFileAsync("docker", args, { timeout: 120_000 });
}

async function waitForPg(attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const { stdout } = await execFileAsync("docker", [
        "exec", containerName, "pg_isready", "-U", "chatcap", "-d", "chatcap_test",
      ]);
      if (stdout.includes("accepting connections")) {
        return;
      }
    } catch {
      // container still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("pg container not ready");
}

/** Always-allows throttle that records which keys were consulted. */
function recordingThrottle(): ThrottleStore & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async checkAndMark(key, _windowMs) {
      keys.push(key);
      return true;
    },
    async mark(key, _windowMs) {
      keys.push(key);
    },
  };
}

run("alert router vs test PG", () => {
  let pool: Pool;

  beforeAll(async () => {
    await dockerRun([
      "run", "-d", "--name", containerName,
      "-e", "POSTGRES_USER=chatcap",
      "-e", "POSTGRES_PASSWORD=chatcap_test",
      "-e", "POSTGRES_DB=chatcap_test",
      "-p", `127.0.0.1:${port}:5432`,
      "pgvector/pgvector:pg16",
    ]);
    await waitForPg();
    await runMigrations({ databaseUrl, direction: "up" });
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    try {
      await dockerRun(["rm", "-f", containerName]);
    } catch {
      // best-effort cleanup
    }
  });

  it("routes raise → dedupe → re-raise after resolve with one open row per key", async () => {
    const session = await upsertSession(pool, { contactKeyAnon: "router-anon-1", jurisdiction: "AR" });
    const alerts = pgAlertStore(pool);
    const throttle = recordingThrottle();
    const windowMs = { red: 60_000, orange: 300_000, yellow: 900_000 };
    const deps = {
      alerts,
      throttle,
      notify: async () => {},
      throttleWindowMs: (level: "red" | "orange" | "yellow") => windowMs[level],
    };

    const request: RaiseAlertRequest = {
      sessionId: session.id,
      level: "red",
      category: "suicide",
      keyword: "quiero morir",
    };

    const created = await routeAlert(deps, request);
    expect(created.kind).toBe("created");

    // Follow-up with the same keyword: dedupe → touch, not a second row.
    const updated = await routeAlert(deps, request);
    expect(updated.kind).toBe("updated");
    expect(updated.alert.id).toBe(created.alert.id);

    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM alerts WHERE session_id = $1 AND status = 'open';`,
      [session.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created.alert.id);

    // Acknowledge + resolve ends the episode; re-raise creates a NEW alert.
    await resolveAlert(pool, created.alert.id);
    const reopened = await routeAlert(deps, request);
    expect(reopened.kind).toBe("created");
    expect(reopened.alert.id).not.toBe(created.alert.id);
  });
});
