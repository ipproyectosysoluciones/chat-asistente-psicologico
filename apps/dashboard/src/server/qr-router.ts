import { Router, type Response } from "express";

import {
  isQrPayload,
  type QrVerifyReason,
} from "@chatcap/crypto-keys";
import type { QrPayload, Role } from "@chatcap/shared-types";

import { PROBLEM_BASE, problemResponse } from "./errors";
import {
  createAuthenticate,
  createAuthorize,
  type AuditWriter,
} from "./auth/middleware";
import type { JwtConfig } from "./auth/jwt";
import type { AuthUsers } from "./auth/auth-router";

/**
 * QR validator router (task 5.7, REQ-KEY-7/REQ-DASH-8): GET
 * `/api/v1/qr/validate?payload=<json>&signature=<hex>` runs the injected
 * `QrValidatorService` and reports the validation result. This is a read-only
 * validity probe — an *invalid* QR is still a `200 { result: { valid: false,
 * reason } }`, never a 4xx/5xx, so the supervisor UI can render the badge
 * directly. RBAC denials (supervisor/admin only) are audit-logged (REQ-DASH-1)
 * and every validation outcome is audit-logged with who/when/why
 * (REQ-DASH-8).
 *
 * The validator service is injected behind a narrow `QrValidatorService`
 * interface (mirroring AlertsRepository / RotationService) so the router stays
 * type-checked, not unit-tested. Mounted AFTER the keys router and BEFORE the
 * chats router (app.ts) so `/api/v1/qr*` never hits the /chats-wide auth gate.
 */

/**
 * Validation result returned to the supervisor UI. `reason` is a closed union:
 * `QrVerifyReason` (from crypto-keys) plus the two transport-level outcomes
 * this router can produce directly (`malformed_payload` when the JSON fails the
 * shape guard, `malformed_signature`/`invalid_signature` from the service).
 */
export type QrValidationResult = {
  valid: boolean;
  reason:
    | QrVerifyReason
    | "malformed_payload"
    | "malformed_signature"
    | "invalid_signature";
  keyVersion?: number;
};

/** QR validation port — implemented by the composition root (index.ts). */
export interface QrValidatorService {
  validate(payload: QrPayload, signature: string): Promise<QrValidationResult>;
}

export interface QrRouterDeps {
  jwt: JwtConfig;
  users: AuthUsers;
  audit: AuditWriter;
  qr: QrValidatorService;
  /** Live validation outcomes over Socket.io; no-op when not wired. */
  emit?: (event: string, payload: unknown) => void;
  /** Best-effort audit-write error sink (mirrors alerts-router). */
  onAuditError?: (error: unknown) => void;
}

const QR_ROLES: Role[] = ["supervisor", "admin"];
const QR_RESOURCE_TYPE = "qr";
const QR_DENIED_ACTION = "qr_validation_denied";

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

export function createQrRouter(deps: QrRouterDeps): Router {
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
    allowedRoles: QR_ROLES,
    deniedAction: QR_DENIED_ACTION,
    resourceType: QR_RESOURCE_TYPE,
    audit: deps.audit,
  });

  router.use("/api/v1/qr/validate", authenticate, authorize);

  router.get("/api/v1/qr/validate", async (req, res) => {
    // Parse the `payload` query param as JSON first; a missing/non-string or
    // unparseable value is a 400 malformed_payload (transport error, not a
    // validity probe result).
    const payloadParam = req.query.payload;
    if (typeof payloadParam !== "string") {
      validationError(res, "payload query parameter is required.");
      return;
    }
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payloadParam);
    } catch {
      validationError(res, "payload must be valid JSON.");
      return;
    }
    if (!isQrPayload(parsedPayload)) {
      validationError(res, "payload is not a valid QR payload.");
      return;
    }

    const signature =
      typeof req.query.signature === "string" ? req.query.signature : "";

    const principal = req.principal;
    if (principal === undefined) {
      unauthorized(res);
      return;
    }

    try {
      const result = await deps.qr.validate(parsedPayload, signature);

      void deps.audit
        .write({
          actorType: principal.role,
          actorId: principal.userId,
          action: "qr_validation",
          resourceType: QR_RESOURCE_TYPE,
          resourceId: parsedPayload.consentId,
          reason: `qr validation: ${result.reason}`,
          meta: {
            actorId: principal.userId,
            valid: result.valid,
            reason: result.reason,
            keyVersion: result.keyVersion,
          },
        })
        .catch((error: unknown) => {
          deps.onAuditError?.(error);
        });

      // Push the outcome to connected supervisors (best-effort).
      deps.emit?.("qr_validation_completed", result);

      // Validity probe: an invalid QR is a normal 200 with a false result,
      // never an error status.
      res.status(200).json({ result });
    } catch {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/internal_error`,
        title: "Internal Server Error",
        status: 500,
        detail: "QR validation failed.",
        code: "internal_error",
      });
    }
  });

  return router;
}
