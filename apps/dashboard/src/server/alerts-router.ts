import { Router, type Response } from "express";
import { z } from "zod";

import type {
  AlertPage,
  AlertPageOptions,
  AlertRow,
} from "@chatcap/db-schema";
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
 * Alerts router (task 5.4, REQ-DASH-4 / design §3.1): GET /alerts serves the
 * live alert feed (severity-first, paginated, PII-free rows) and POST
 * /alerts/{id}/acknowledge + /alerts/{id}/resolve drive the open →
 * acknowledged → resolved lifecycle (REQ-ALERT-6). Supervisor/admin only —
 * RBAC denials are audit-logged (REQ-DASH-1) and every state change is
 * audit-logged with who/when/why (REQ-DASH-8), then pushed over the injected
 * Socket.io emitter as `alert:updated` so connected supervisors see the
 * transition live (< 1s contract, REQ-ALERT-2). The repository is injected
 * (narrow interface, like ChatsRepository) so the router stays unit-testable.
 *
 * Mounted BEFORE the chats router so `/alerts` never hits the /chats-wide
 * auth gate.
 */

export interface AlertsRepository {
  listAlerts(options: AlertPageOptions): Promise<AlertPage>;
  findById(alertId: string): Promise<AlertRow | undefined>;
  acknowledge(alertId: string, actorId: string): Promise<void>;
  resolve(alertId: string): Promise<void>;
}

export type AlertUpdateEmitter = (
  event: "alert:updated",
  payload: AlertRow
) => void;

export interface AlertsRouterDeps {
  jwt: JwtConfig;
  users: AuthUsers;
  audit: AuditWriter;
  alerts: AlertsRepository;
  /** Live alert-state transitions over Socket.io; no-op when not wired. */
  emit?: AlertUpdateEmitter;
  /**
   * Audit-write error sink. A failed audit write must never block the state
   * change or turn a 200 into a 500 — the failure is surfaced here
   * (production: logger.error). Tests leave it unset.
   */
  onAuditError?(error: unknown): void;
}

const ALERT_ROLES: Role[] = ["supervisor", "admin"];
const ALERT_RESOURCE_TYPE = "alert";
const ALERT_DENIED_ACTION = "dashboard_alerts_denied";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const alertIdSchema = z.uuid();

const resolveBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
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

function notFound(res: Response): void {
  problemResponse(res, {
    type: `${PROBLEM_BASE}/not_found`,
    title: "Not Found",
    status: 404,
    detail: "The alert does not exist.",
    code: "not_found",
  });
}

function conflict(res: Response, detail: string): void {
  problemResponse(res, {
    type: `${PROBLEM_BASE}/conflict`,
    title: "Conflict",
    status: 409,
    detail,
    code: "conflict",
  });
}

export function createAlertsRouter(deps: AlertsRouterDeps): Router {
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
    allowedRoles: ALERT_ROLES,
    deniedAction: ALERT_DENIED_ACTION,
    resourceType: ALERT_RESOURCE_TYPE,
    audit: deps.audit,
  });

  router.use(
    ["/alerts", "/alerts/:alertId/acknowledge", "/alerts/:alertId/resolve"],
    authenticate,
    authorize
  );

  router.get("/alerts", async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      validationError(
        res,
        "limit must be an integer between 1 and 100; offset a non-negative integer."
      );
      return;
    }
    const page = await deps.alerts.listAlerts(parsed.data);
    res.status(200).json({ items: page.items, total: page.total });
  });

  router.post("/alerts/:alertId/acknowledge", async (req, res) => {
    const parsed = alertIdSchema.safeParse(req.params.alertId);
    if (!parsed.success) {
      validationError(res, "alertId must be a valid UUID.");
      return;
    }
    const alertId = parsed.data;
    const principal = req.principal;
    if (principal === undefined) {
      unauthorized(res);
      return;
    }

    const alert = await deps.alerts.findById(alertId);
    if (alert === undefined) {
      notFound(res);
      return;
    }
    if (alert.status !== "open") {
      conflict(res, "Only open alerts can be acknowledged.");
      return;
    }

    await deps.alerts.acknowledge(alertId, principal.userId);
    const updated = await deps.alerts.findById(alertId);
    if (updated === undefined) {
      notFound(res);
      return;
    }
    void deps.audit
      .write({
        actorType: principal.role,
        actorId: principal.userId,
        action: "alert_acknowledged",
        resourceType: ALERT_RESOURCE_TYPE,
        resourceId: alertId,
        reason: "REQ-DASH-4 supervisor acknowledge",
        meta: { actorId: principal.userId, requestedAction: "acknowledge" },
      })
      .catch((error: unknown) => {
        deps.onAuditError?.(error);
      });
    deps.emit?.("alert:updated", updated);

    res.status(200).json(updated);
  });

  router.post("/alerts/:alertId/resolve", async (req, res) => {
    const parsedId = alertIdSchema.safeParse(req.params.alertId);
    if (!parsedId.success) {
      validationError(res, "alertId must be a valid UUID.");
      return;
    }
    const alertId = parsedId.data;
    const principal = req.principal;
    if (principal === undefined) {
      unauthorized(res);
      return;
    }

    const alert = await deps.alerts.findById(alertId);
    if (alert === undefined) {
      notFound(res);
      return;
    }
    if (alert.status === "resolved") {
      conflict(res, "The alert is already resolved.");
      return;
    }

    // Validate the optional reason body once the alert/target are resolved so
    // state-machine conflicts (409) short-circuit before input-shape errors
    // — an "already resolved" request without a body must NOT be masked as a
    // validation 400.
    const parsedBody = resolveBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      validationError(res, "reason must be a string up to 500 characters.");
      return;
    }
    const reason = parsedBody.data.reason;

    await deps.alerts.resolve(alertId);
    const updated = await deps.alerts.findById(alertId);
    if (updated === undefined) {
      notFound(res);
      return;
    }
    void deps.audit
      .write({
        actorType: principal.role,
        actorId: principal.userId,
        action: "alert_resolved",
        resourceType: ALERT_RESOURCE_TYPE,
        resourceId: alertId,
        reason: "REQ-DASH-4 supervisor resolve",
        meta: {
          actorId: principal.userId,
          requestedAction: "resolve",
          ...(reason === undefined ? {} : { reason }),
        },
      })
      .catch((error: unknown) => {
        deps.onAuditError?.(error);
      });
    deps.emit?.("alert:updated", updated);

    res.status(200).json(updated);
  });

  return router;
}
