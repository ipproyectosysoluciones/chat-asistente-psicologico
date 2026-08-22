import { Router, json, type Request, type Response } from "express";

import type { NewAuditEntry } from "@chatcap/db-schema";
import type { AlertStatus, Role } from "@chatcap/shared-types";
import type { Logger } from "@chatcap/telemetry";

import {
  InvalidTransitionError,
  nextAlertStatus,
  type AlertLifecycleAction,
  type AlertLifecycleStore,
} from "./alert-lifecycle";
import { problemResponse } from "./errors";
import { internalTokenMiddleware } from "./internal-token";
import { lifecycleActionRequestSchema } from "./lifecycle-request";

/**
 * Alert lifecycle endpoints (task 2.4, REQ-ALERT-6): POST
 * /alerts/:alertId/{acknowledge,resolve}. Order of checks is deliberate:
 * 1. auth (internal token) — 401, never audited (no identity yet)
 * 2. body shape — 400 validation_error
 * 3. RBAC preflight (supervisor/admin only, REQ-DASH-1) — 403, denial
 *    audited BEFORE any alert data is loaded (least privilege)
 * 4. alert existence — 404
 * 5. state machine — 409 conflict, denial audited
 * Only then is the transition applied and audited (alert_acknowledged /
 * alert_resolved). Audit meta is PII-free: level + statuses, never session,
 * message, or contact data.
 */

const ALLOWED_ROLES: readonly Role[] = ["supervisor", "admin"];

export interface LifecycleDeps {
  logger: Logger;
  internalTokens: readonly string[];
  store: AlertLifecycleStore;
  findUserRole(userId: string): Promise<Role | undefined>;
  audit(entry: NewAuditEntry): Promise<void>;
}

export function createLifecycleRouter(deps: LifecycleDeps): Router {
  const router = Router();
  router.use(json());
  router.use(internalTokenMiddleware(deps.internalTokens));

  const handleAction =
    (action: AlertLifecycleAction) =>
    async (req: Request, res: Response): Promise<void> => {
      const alertIdParam = req.params.alertId;
      if (typeof alertIdParam !== "string") {
        problemResponse(res, {
          type: "https://api.chatcap.app/errors/validation_error",
          title: "Validation Error",
          status: 400,
          detail: "A single alert id is required in the URL.",
          code: "validation_error",
        });
        return;
      }
      const alertId = alertIdParam;
      try {
        const parsed = lifecycleActionRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          problemResponse(res, {
            type: "https://api.chatcap.app/errors/validation_error",
            title: "Validation Error",
            status: 400,
            detail: "A valid actorId (uuid) is required; reason is optional.",
            code: "validation_error",
          });
          return;
        }
        const { actorId, reason } = parsed.data;

        // RBAC preflight before touching alert data (REQ-DASH-1).
        const role = await deps.findUserRole(actorId);
        if (role === undefined || !ALLOWED_ROLES.includes(role)) {
          await deps.audit({
            actorType: "system",
            actorId,
            action: "alert_lifecycle_denied",
            resourceType: "alert",
            reason,
            meta: { reason: "insufficient_role", requestedAction: action },
          });
          problemResponse(res, {
            type: "https://api.chatcap.app/errors/forbidden",
            title: "Forbidden",
            status: 403,
            detail: "Only supervisors and admins may act on alerts.",
            code: "forbidden",
          });
          return;
        }

        const alert = await deps.store.findById(alertId);
        if (alert === undefined) {
          problemResponse(res, {
            type: "https://api.chatcap.app/errors/not_found",
            title: "Not Found",
            status: 404,
            detail: "The alert does not exist.",
            code: "not_found",
          });
          return;
        }

        let toStatus: AlertStatus;
        try {
          toStatus = nextAlertStatus(alert.status, action);
        } catch (error) {
          if (error instanceof InvalidTransitionError) {
            await deps.audit({
              actorType: role,
              actorId,
              action: "alert_lifecycle_denied",
              resourceType: "alert",
              resourceId: alertId,
              reason,
              meta: {
                reason: "invalid_transition",
                requestedAction: action,
                fromStatus: error.current,
              },
            });
            problemResponse(res, {
              type: "https://api.chatcap.app/errors/conflict",
              title: "Conflict",
              status: 409,
              detail: `Cannot ${action} an alert in status ${alert.status}.`,
              code: "conflict",
            });
            return;
          }
          throw error;
        }

        if (action === "acknowledge") {
          await deps.store.acknowledge(alertId, actorId);
        } else {
          await deps.store.resolve(alertId);
        }

        await deps.audit({
          actorType: role,
          actorId,
          action: action === "acknowledge" ? "alert_acknowledged" : "alert_resolved",
          resourceType: "alert",
          resourceId: alertId,
          reason,
          meta: {
            level: alert.level,
            fromStatus: alert.status,
            toStatus,
          },
        });

        res.status(200).json({ id: alertId, status: toStatus });
      } catch (error) {
        // Never leak internals: log the failure (PII-free — no alert content)
        // and answer with a stable internal_error problem.
        deps.logger.error("alert lifecycle action failed", {
          alertId,
          action,
          error: error instanceof Error ? error.message : String(error),
        });
        problemResponse(res, {
          type: "https://api.chatcap.app/errors/internal_error",
          title: "Internal Error",
          status: 500,
          detail: "The request could not be completed.",
          code: "internal_error",
        });
      }
    };

  router.post("/alerts/:alertId/acknowledge", handleAction("acknowledge"));
  router.post("/alerts/:alertId/resolve", handleAction("resolve"));

  return router;
}
