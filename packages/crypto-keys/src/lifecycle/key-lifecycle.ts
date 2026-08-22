import { randomBytes } from "node:crypto";

import type { KeyProvider } from "@chatcap/config";
import type { DbQueryable } from "@chatcap/db-schema";
import {
  createNextKeyVersion,
  currentActiveKeyVersion,
  retireKeyVersion,
} from "@chatcap/db-schema";
import type { KeyVersionInfo } from "@chatcap/shared-types";

import type { RotationAuditSink } from "./audit-hooks";
import { NullAuditSink } from "./audit-hooks";
import { computeRotationDates } from "./policy";
import { SALT_LENGTH } from "../core/derive";

/**
 * Key lifecycle (REQ-KEY-2): guarantees exactly one active writer key at all
 * times, rotating to N+1 on expiry with a 7-day cycle + 12h forced margin.
 * The previous key stays readable (dual-read, REQ-KEY-8) until its rows are
 * migrated and it is retired by the coordinator.
 */

export interface KeyLifecycleDeps {
  db: DbQueryable;
  masterKeyProvider: KeyProvider;
  audit?: RotationAuditSink;
  now?: () => Date;
}

export interface EnsureActiveKeyResult {
  current: KeyVersionInfo;
  created: boolean;
}

export async function ensureActiveKey(
  deps: KeyLifecycleDeps
): Promise<EnsureActiveKeyResult> {
  const { db } = deps;
  const audit = deps.audit ?? new NullAuditSink();
  const now = deps.now?.() ?? new Date();

  const current = await currentActiveKeyVersion(db);
  if (current !== undefined && new Date(current.expiresAt).getTime() > now.getTime()) {
    return { current, created: false };
  }

  const { expiresAt, forcedRotationDueAt } = computeRotationDates(now);
  const salt = randomBytes(SALT_LENGTH).toString("hex");
  const created = await createNextKeyVersion(db, {
    salt,
    expiresAt,
    forcedRotationDueAt,
  });
  await audit.write({
    action: "key_created",
    actorType: "system",
    resourceType: "key_version",
    resourceId: String(created.keyVersion),
    meta: {
      expiresAt: expiresAt.toISOString(),
      forcedRotationDueAt: forcedRotationDueAt.toISOString(),
    },
    occurredAt: now.toISOString(),
  });
  return { current: created, created: true };
}

/** Marks a key retired once its rows are fully migrated (dual-read ends). */
export async function retireKey(deps: KeyLifecycleDeps, keyVersion: number): Promise<void> {
  await retireKeyVersion(deps.db, keyVersion);
  const audit = deps.audit ?? new NullAuditSink();
  await audit.write({
    action: "key_retired",
    actorType: "system",
    resourceType: "key_version",
    resourceId: String(keyVersion),
    occurredAt: (deps.now?.() ?? new Date()).toISOString(),
  });
}
