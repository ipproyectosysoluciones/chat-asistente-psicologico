import type { Pool } from "pg";

import {
  createAlert,
  findOpenAlertByDedupeKey,
  touchAlert,
} from "@chatcap/db-schema";

import type { AlertStore } from "./alert-router";

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
