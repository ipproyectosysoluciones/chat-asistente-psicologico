import { Router, type Response } from "express";
import { z } from "zod";

import type { AuditQuery } from "@chatcap/db-schema";
import type { AuditLogEntry } from "@chatcap/shared-types";
import type { Role } from "@chatcap/shared-types";

import { PROBLEM_BASE, problemResponse } from "./errors";
import {
  createAuthenticate,
  createAuthorize,
  type AuditWriter,
} from "./auth/middleware";
import type { JwtConfig } from "./auth/jwt";
import type { AuthUsers } from "./auth/auth-router";

/**
 * Audit-log panel router (task 5.8, REQ-DASH-8): GET `/api/v1/audit` serves the
 * audit-trail feed filtered by optional resourceType / resourceId / actorId /
 * from / to with a bounded limit (1..200). Supervisor/admin only — RBAC denials
 * are audit-logged (REQ-DASH-1). The audit store is injected behind a narrow
 * `AuditLogPort` (mirroring AlertsRepository / RotationService) so the router
 * stays type-checked, not unit-tested; the composition root (index.ts)
 * implements it against `listAuditEntries`.
 *
 * Mounted AFTER the qr router and BEFORE the chats router (app.ts) so
 * `/api/v1/audit*` never hits the /chats-wide auth gate.
 */

/** Audit-trail read port — implemented by the composition root (index.ts). */
export interface AuditLogPort {
  list(query: AuditQuery): Promise<AuditLogEntry[]>;
}

export interface AuditRouterDeps {
  jwt: JwtConfig;
  users: AuthUsers;
  audit: AuditWriter;
  auditLog: AuditLogPort;
}

const AUDIT_ROLES: Role[] = ["supervisor", "admin"];
const AUDIT_RESOURCE_TYPE = "audit";
const AUDIT_DENIED_ACTION = "dashboard_audit_denied";

const auditQuerySchema = z.object({
  resourceType: z.string().trim().min(1).max(120).optional(),
  resourceId: z.string().trim().min(1).max(255).optional(),
  actorId: z.string().trim().min(1).max(255).optional(),
  from: z.string().trim().min(1).max(64).optional(),
  to: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function validationError(res: Response, detail: string): void {
  problemResponse(res, {
    type: `${PROBLEM_BASE}/validation_error`,
    title: "Validation Error",
    status: 400,
    detail,
    code: "validation_error",
  });
}

export function createAuditRouter(deps: AuditRouterDeps): Router {
  const router = Router();
  const authenticate = createAuthenticate({
    jwt: deps.jwt,
    findUserById: async (id) => {
      const user = await deps.users.findById(id);
      if (user === undefined) {
        return null;
      }
      return { id: user.id, role: user.role };
    },
  });
  const authorize = createAuthorize({
    allowedRoles: AUDIT_ROLES,
    deniedAction: AUDIT_DENIED_ACTION,
    resourceType: AUDIT_RESOURCE_TYPE,
    audit: deps.audit,
  });

  router.use("/api/v1/audit", authenticate, authorize);

  router.get("/api/v1/audit", async (req, res) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      validationError(
        res,
        "limit must be an integer between 1 and 200; resourceType, resourceId, actorId, from, to are optional strings."
      );
      return;
    }

    try {
      const entries = await deps.auditLog.list(parsed.data);
      res.status(200).json({ entries, count: entries.length });
    } catch {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/internal_error`,
        title: "Internal Server Error",
        status: 500,
        detail: "Audit log query failed.",
        code: "internal_error",
      });
    }
  });

  return router;
}
