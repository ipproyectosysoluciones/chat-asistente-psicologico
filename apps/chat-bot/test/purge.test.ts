import { describe, expect, it, vi } from "vitest";

import { createLogger, type Logger } from "@chatcap/telemetry";
import { insertAuditEntry, type DbQueryable } from "@chatcap/db-schema";

import { createPurgeCron, DEFAULT_PURGE_SCHEDULE, runAnonymousPurge } from "../src/purge";

/**
 * Anonymous purge job (task 4.8, REQ-CHATBOT-9, REQ-CONSENT-5): the chat-bot
 * schedules the db-schema batched purge (24–48 h window) on a cron and
 * records a PII-free audit entry. The db-schema integration suite already
 * proves purge-window bounds, batching (100–500) and that HC rows are
 * untouched (WHERE persistence_class = 'anonymous') — this module only wires
 * the job: schedule, delegation, audit, no silent failures.
 */

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    level: "silent",
    destination: { write: (chunk: string | Buffer) => lines.push(String(chunk)) },
  });
  return { logger, lines };
}

/** Audit mock shaped like insertAuditEntry so the args tuple is [db, entry]. */
function auditMock(): ReturnType<typeof vi.fn<typeof insertAuditEntry>> {
  return vi.fn<typeof insertAuditEntry>(async (_db, entry) => ({
    id: "audit-1",
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    reason: entry.reason,
    meta: entry.meta ?? {},
    createdAt: new Date().toISOString(),
  }));
}

describe("runAnonymousPurge (task 4.8, REQ-CHATBOT-9)", () => {
  const db = {} as DbQueryable; // never reached: purge + audit are injected

  it("delegates to the db-schema purge repo and returns the counts", async () => {
    const purge = vi.fn(async () => ({
      purgedSessions: 120,
      purgedHistory: 3,
      batches: 4,
    }));
    const audit = auditMock();
    const { logger } = captureLogger();

    const result = await runAnonymousPurge({ db, logger, batchSize: 200, purge, audit });

    expect(result).toEqual({ purgedSessions: 120, purgedHistory: 3, batches: 4 });
    expect(purge).toHaveBeenCalledWith(db, { batchSize: 200 });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("records a PII-free audit entry with system actor and counts-only meta", async () => {
    const purge = vi.fn(async () => ({
      purgedSessions: 120,
      purgedHistory: 3,
      batches: 4,
    }));
    const audit = auditMock();
    const { logger } = captureLogger();

    await runAnonymousPurge({ db, logger, purge, audit });

    const entry = audit.mock.calls[0]?.[1];
    expect(entry).toMatchObject({
      actorType: "system",
      action: "purge.anonymous_sessions",
      resourceType: "session",
      meta: { purgedSessions: 120, purgedHistory: 3, batches: 4 },
    });
    expect(JSON.stringify(entry)).not.toContain("phone");
    expect(JSON.stringify(entry)).not.toContain("contact");
  });

  it("defaults the batch size when not provided (repo clamps to 100–500)", async () => {
    const purge = vi.fn(async () => ({
      purgedSessions: 0,
      purgedHistory: 0,
      batches: 1,
    }));
    const audit = auditMock();
    const { logger } = captureLogger();

    await runAnonymousPurge({ db, logger, purge, audit });

    expect(purge).toHaveBeenCalledWith(db, undefined);
  });

  it("propagates purge failures instead of swallowing them", async () => {
    const purge = vi.fn(async () => {
      throw new Error("purge job failed");
    });
    const audit = auditMock();
    const { logger } = captureLogger();

    await expect(runAnonymousPurge({ db, logger, purge, audit })).rejects.toThrow(
      "purge job failed"
    );
  });
});

describe("createPurgeCron (task 4.8)", () => {
  const db = {} as DbQueryable; // never reached: purge + audit are injected

  it("schedules the purge on the configured expression and runs it when triggered", async () => {
    const purge = vi.fn(async () => ({
      purgedSessions: 10,
      purgedHistory: 0,
      batches: 1,
    }));
    const audit = auditMock();
    const { logger } = captureLogger();

    let task: (() => void) | undefined;
    const stop = vi.fn();
    const scheduleFn = vi.fn((_expression: string, scheduled: () => void) => {
      task = scheduled;
      return { stop };
    });

    const cron = createPurgeCron({
      db,
      logger,
      schedule: "0 3 * * *",
      purge,
      audit,
      scheduleFn,
    });
    cron.start();

    expect(scheduleFn).toHaveBeenCalledWith("0 3 * * *", expect.any(Function));
    expect(task).toBeDefined();
    await task?.();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);

    cron.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("uses the default daily schedule when none is configured", async () => {
    const purge = vi.fn(async () => ({
      purgedSessions: 0,
      purgedHistory: 0,
      batches: 1,
    }));
    const audit = auditMock();
    const { logger } = captureLogger();
    const scheduleFn = vi.fn(() => ({ stop: vi.fn() }));

    const cron = createPurgeCron({ db, logger, purge, audit, scheduleFn });
    cron.start();

    expect(scheduleFn).toHaveBeenCalledWith(DEFAULT_PURGE_SCHEDULE, expect.any(Function));
    cron.stop();
  });
});
