import { Router, type Response } from "express";
import { z } from "zod";

import type { LegalFrameworkRow, PublishTermsInput } from "@chatcap/db-schema";
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
 * Legal-frameworks panel router (task 5.8, REQ-DASH-8): GET
 * `/api/v1/legal-frameworks` lists the published consent legal-frameworks
 * (supervisor/admin) and POST `/api/v1/legal-frameworks` publishes a new terms
 * version (admin only). RBAC denials are audit-logged (REQ-DASH-1); a
 * successful publish is audit-logged with the acting principal (REQ-DASH-8)
 * before the store write, and the completion is best-effort audit-logged by the
 * composition root (index.ts).
 *
 * The store is injected behind a narrow `FrameworksPort` (mirroring
 * AlertsRepository / RotationService) so the router stays type-checked, not
 * unit-tested. Mounted AFTER the qr router and BEFORE the chats router
 * (app.ts) so `/api/v1/legal-frameworks*` never hits the /chats-wide auth gate.
 */

/** Legal-framework store port — implemented by the composition root (index.ts). */
export interface FrameworksPort {
  list(): Promise<LegalFrameworkRow[]>;
  publish(input: PublishTermsInput): Promise<LegalFrameworkRow>;
}

export interface FrameworksRouterDeps {
  jwt: JwtConfig;
  users: AuthUsers;
  audit: AuditWriter;
  frameworks: FrameworksPort;
  /** Best-effort audit-write error sink (mirrors alerts-router). */
  onAuditError?: (error: unknown) => void;
}

const FRAMEWORKS_VIEW_ROLES: Role[] = ["supervisor", "admin"];
const FRAMEWORKS_MUTATE_ROLES: Role[] = ["admin"];
const FRAMEWORKS_RESOURCE_TYPE = "legal_framework";
const FRAMEWORKS_DENIED_ACTION = "framework_publish_denied";

const publishBodySchema = z.object({
  countryCode: z.string().trim().min(1).max(16),
  frameworkCode: z.string().trim().min(1).max(64),
  noticeText: z.string().trim().min(1).max(8000),
  version: z.number().int().min(1).optional(),
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

function unauthorized(res: Response): void {
  problemResponse(res, {
    type: `${PROBLEM_BASE}/unauthorized`,
    title: "Unauthorized",
    status: 401,
    detail: "A valid session is required.",
    code: "unauthorized",
  });
}

export function createFrameworksRouter(deps: FrameworksRouterDeps): Router {
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
  const authorizeView = createAuthorize({
    allowedRoles: FRAMEWORKS_VIEW_ROLES,
    deniedAction: FRAMEWORKS_DENIED_ACTION,
    resourceType: FRAMEWORKS_RESOURCE_TYPE,
    audit: deps.audit,
  });
  const authorizePublish = createAuthorize({
    allowedRoles: FRAMEWORKS_MUTATE_ROLES,
    deniedAction: FRAMEWORKS_DENIED_ACTION,
    resourceType: FRAMEWORKS_RESOURCE_TYPE,
    audit: deps.audit,
  });

  router.get(
    "/api/v1/legal-frameworks",
    authenticate,
    authorizeView,
    async (_req, res) => {
      try {
        const frameworks = await deps.frameworks.list();
        res.status(200).json({ frameworks });
      } catch {
        problemResponse(res, {
          type: `${PROBLEM_BASE}/internal_error`,
          title: "Internal Server Error",
          status: 500,
          detail: "Failed to list legal frameworks.",
          code: "internal_error",
        });
      }
    }
  );

  router.post(
    "/api/v1/legal-frameworks",
    authenticate,
    authorizePublish,
    async (req, res) => {
      const parsed = publishBodySchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(
          res,
          "countryCode, frameworkCode, and noticeText are required strings (max 16/64/8000); version is an optional positive integer."
        );
        return;
      }

      const principal = req.principal;
      if (principal === undefined) {
        unauthorized(res);
        return;
      }

      // Pre-write audit (REQ-DASH-8): record the acting principal's publish
      // intent BEFORE the store write so a persisted framework is traceable.
      void deps.audit
        .write({
          actorType: principal.role,
          actorId: principal.userId,
          action: "framework_published",
          resourceType: FRAMEWORKS_RESOURCE_TYPE,
          resourceId: parsed.data.frameworkCode,
          reason: "publish legal-framework terms version",
          meta: {
            actorId: principal.userId,
            countryCode: parsed.data.countryCode,
            frameworkCode: parsed.data.frameworkCode,
          },
        })
        .catch((error: unknown) => {
          deps.onAuditError?.(error);
        });

      try {
        const framework = await deps.frameworks.publish(parsed.data);
        res.status(201).json({ framework });
      } catch {
        problemResponse(res, {
          type: `${PROBLEM_BASE}/internal_error`,
          title: "Internal Server Error",
          status: 500,
          detail: "Failed to publish legal-framework terms.",
          code: "internal_error",
        });
      }
    }
  );

  return router;
}
