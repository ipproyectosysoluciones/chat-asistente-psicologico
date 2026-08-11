import type { Pool } from "pg";

import {
  acknowledgeAlert,
  createAlert,
  findAlertById,
  findOpenAlertByDedupeKey,
  resolveAlert,
  touchAlert,
} from "@chatcap/db-schema";

import type { AlertStore } from "./alert-router";
import type { AlertLifecycleStore } from "./alert-lifecycle";

/**
 * AlertStore adapter over the db-schema repository functions (task 2.2):
 * the router stays persistence-agnostic; this mapping is the only place that
 * binds it to PostgreSQL.
 */
export function pgAlertStore(pool: Pool): AlertStore {
  return {
    findOpenByDedupeKey: (dedupeKey) => findOpenAlertByDedupeKey(pool, dedupeKey),
    create: (input) => createAlert(pool, input),
    touch: (alertId) => touchAlert(pool, alertId),
  };
}

/**
 * AlertLifecycleStore adapter (task 2.4, REQ-ALERT-6): binds the lifecycle
 * endpoints to PostgreSQL, reusing the repository functions that enforce the
 * one-open-alert invariant.
 */
export function pgAlertLifecycleStore(pool: Pool): AlertLifecycleStore {
  return {
    findById: (alertId) => findAlertById(pool, alertId),
    acknowledge: async (alertId, actorId) => {
      await acknowledgeAlert(pool, alertId, actorId);
    },
    resolve: async (alertId) => {
      await resolveAlert(pool, alertId);
    },
  };
}
