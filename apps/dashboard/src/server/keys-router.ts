import { Router, type Response } from "express";
import { z } from "zod";

import type { BatchOutcome } from "@chatcap/crypto-keys";
import type { KeyStatus, Role } from "@chatcap/shared-types";

import { PROBLEM_BASE, problemResponse } from "./errors";
import {
  createAuthenticate,
  createAuthorize,
  type AuditWriter,
} from "./auth/middleware";
import type { JwtConfig } from "./auth/jwt";
import type { AuthUsers } from "./auth/auth-router";
import {
  createCriticalRateLimit,
  type RateLimiterMemory,
} from "./middleware/rate-limit";

/**
 * Key-rotation monitor router (task 5.6, REQ-KEY-3/REQ-DASH-1): GET
 * `/api/v1/keys/rotation` serves the active-key status (countdown, forced-due
 * list, pending rows) and POST `/api/v1/keys/rotation/rotate` triggers an
 * on-demand rotation. View is supervisor+admin; mutate is admin-only — RBAC
 * denials are audit-logged with who/when/why (REQ-DASH-1) and the requested
 * rotation is pre-write audit-logged (REQ-DASH-8) before the coordinator runs.
 *
 * The rotation engine is injected behind a narrow `RotationService` interface
 * (mirroring AlertsRepository) so the router stays decoupled from the
 * re-encryption coordinator and is type-checked, not unit-tested. Successful
 * non-dry-run rotations are pushed over the injected Socket.io emitter as
 * `rotation:completed` so connected supervisors see the outcome live.
 *
 * Mounted AFTER the alerts router and BEFORE the chats router so `/api/v1/keys*`
 * never hits the /chats-wide auth gate (REQ-DASH-4).
 */

/**
 * Frontend-safe projection of a key-version row (REQ-KEY-1): key metadata only —
 * never raw key material or salt. Defined here because @chatcap/db-schema only
 * exposes the richer `KeyVersionInfo` (which carries `salt`/`algorithm`).
 */
export interface KeyRow {
  keyVersion: number;
  createdAt: string;
  status: KeyStatus;
  retiredAt?: string;
}

export interface RotationStatus {
  activeKeyVersion: number;
  activeCreatedAt: string;
  daysUntilRotation: number;
  forcedDue: KeyRow[];
  pendingRows: number;
}

export interface RotateResult {
  dryRun: boolean;
  keyFrom: number;
  keyTo: number;
  /** dry-run only: the version that would be retired. */
  wouldRetire?: number;
  processed?: number;
  remaining?: number;
  retired?: boolean;
  outcomes?: BatchOutcome[];
}

/** Rotation engine port — implemented by the composition root (index.ts). */
export interface RotationService {
  status(): Promise<RotationStatus>;
  rotate(cmd: { forced?: boolean; dryRun?: boolean }): Promise<RotateResult>;
}

export interface KeysRouterDeps {
  jwt: JwtConfig;
  users: AuthUsers;
  audit: AuditWriter;
  rotation: RotationService;
  /** Live rotation outcomes over Socket.io; no-op when not wired. */
  emit?: (event: string, payload: unknown) => void;
  /** Best-effort audit-write error sink (mirrors alerts-router). */
  onAuditError?: (error: unknown) => void;
  /** Shared rate limiter for critical mutating endpoints (design §B5). */
  rateLimiter?: RateLimiterMemory;
}

const KEYS_VIEW_ROLES: Role[] = ["supervisor", "admin"];
const KEYS_MUTATE_ROLES: Role[] = ["admin"];
const KEYS_RESOURCE_TYPE = "key_version";
const KEYS_DENIED_ACTION = "key_rotation_denied";

const rotateBodySchema = z.object({
  forced: z.boolean().optional(),
  dryRun: z.boolean().optional(),
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

export function createKeysRouter(deps: KeysRouterDeps): Router {
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
    allowedRoles: KEYS_VIEW_ROLES,
    deniedAction: KEYS_DENIED_ACTION,
    resourceType: KEYS_RESOURCE_TYPE,
    audit: deps.audit,
  });
  const authorizeMutate = createAuthorize({
    allowedRoles: KEYS_MUTATE_ROLES,
    deniedAction: KEYS_DENIED_ACTION,
    resourceType: KEYS_RESOURCE_TYPE,
    audit: deps.audit,
  });

  router.get(
    "/api/v1/keys/rotation",
    authenticate,
    authorizeView,
    async (_req, res) => {
      const status = await deps.rotation.status();
      res.status(200).json({ status });
    }
  );

  const rotateRateLimit = deps.rateLimiter
    ? createCriticalRateLimit(
        deps.rateLimiter,
        (req) => req.principal?.userId ?? req.ip ?? "unknown"
      )
    : null;

  const rotateChain = rotateRateLimit
    ? [authenticate, rotateRateLimit, authorizeMutate]
    : [authenticate, authorizeMutate];

  router.post(
    "/api/v1/keys/rotation/rotate",
    ...rotateChain,
    async (req, res) => {
      const parsed = rotateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(
          res,
          "forced and dryRun must be booleans when provided."
        );
        return;
      }
      const principal = req.principal;
      if (principal === undefined) {
        unauthorized(res);
        return;
      }

      // Pre-write audit (REQ-DASH-8): record the intent BEFORE the
      // rotate call so a successful rotation is never untraceable.
      void deps.audit
        .write({
          actorType: principal.role,
          actorId: principal.userId,
          action: "key_rotation_requested",
          resourceType: KEYS_RESOURCE_TYPE,
          reason: "REQ-KEY-3 rotation request",
          meta: {
            actorId: principal.userId,
            forced: parsed.data.forced ?? false,
            dryRun: parsed.data.dryRun ?? false,
          },
        })
        .catch((error: unknown) => {
          deps.onAuditError?.(error);
        });

      let result: RotateResult;
      try {
        result = await deps.rotation.rotate(parsed.data);
      } catch {
        problemResponse(res, {
          type: `${PROBLEM_BASE}/internal_error`,
          title: "Internal Server Error",
          status: 500,
          detail: "Key rotation failed.",
          code: "internal_error",
        });
        return;
      }

      if (!result.dryRun) {
        deps.emit?.("rotation:completed", result);
      }
      res.status(200).json({ result });
    }
  );

  return router;
}
