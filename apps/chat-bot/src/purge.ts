import { insertAuditEntry, purgeAnonymousSessions, type DbQueryable } from "@chatcap/db-schema";
import type { Logger } from "@chatcap/telemetry";
import cron from "node-cron";

/**
 * Anonymous purge job (task 4.8, REQ-CHATBOT-9, REQ-CONSENT-5): the chat-bot
 * schedules the db-schema batched purge (24–48 h window) with node-cron and
 * records a PII-free audit entry. The purge repo owns the SQL (bounded 100–500
 * batches, WHERE persistence_class = 'anonymous', so HC rows are untouched) —
 * this module only wires the job: schedule, delegation, audit, and no silent
 * failure swallowing. Defaults are injectable so the unit tests never need a
 * live database or a real cron timer.
 */

export interface PurgeCounts {
  purgedSessions: number;
  purgedHistory: number;
  batches: number;
}

/** Default run time: daily 03:00 (server-local), well inside the 24–48 h window. */
export const DEFAULT_PURGE_SCHEDULE = "0 3 * * *";

export interface PurgeJobDeps {
  db: DbQueryable;
  logger: Logger;
  batchSize?: number;
  /** Injected for tests; defaults to the db-schema repository. */
  purge?: typeof purgeAnonymousSessions;
  audit?: typeof insertAuditEntry;
}

export async function runAnonymousPurge(deps: PurgeJobDeps): Promise<PurgeCounts> {
  const purge = deps.purge ?? purgeAnonymousSessions;
  const audit = deps.audit ?? insertAuditEntry;

  const result = await purge(
    deps.db,
    deps.batchSize !== undefined ? { batchSize: deps.batchSize } : undefined
  );

  await audit(deps.db, {
    actorType: "system",
    action: "purge.anonymous_sessions",
    resourceType: "session",
    meta: {
      purgedSessions: result.purgedSessions,
      purgedHistory: result.purgedHistory,
      batches: result.batches,
    },
  });

  deps.logger.info("anonymous purge completed", {
    purgedSessions: result.purgedSessions,
    purgedHistory: result.purgedHistory,
    batches: result.batches,
  });

  return result;
}

export interface ScheduledTaskHandle {
  stop(): void;
}

export interface PurgeCronDeps extends PurgeJobDeps {
  schedule?: string;
  /** Injected for tests; defaults to node-cron. */
  scheduleFn?: (
    expression: string,
    task: () => void
  ) => ScheduledTaskHandle;
}

export interface PurgeCron {
  start(): void;
  stop(): void;
}

export function createPurgeCron(deps: PurgeCronDeps): PurgeCron {
  let handle: ScheduledTaskHandle | undefined;

  const scheduleFn =
    deps.scheduleFn ?? ((expression, task) => cron.schedule(expression, task));

  return {
    start(): void {
      if (handle !== undefined) {
        return;
      }
      handle = scheduleFn(deps.schedule ?? DEFAULT_PURGE_SCHEDULE, () => {
        runAnonymousPurge(deps).catch((error: unknown) => {
          // Cron callbacks must not throw unhandled; surface to the logger.
          deps.logger.error("anonymous purge run failed", {
            error: String(error),
          });
        });
      });
    },
    stop(): void {
      handle?.stop();
      handle = undefined;
    },
  };
}
