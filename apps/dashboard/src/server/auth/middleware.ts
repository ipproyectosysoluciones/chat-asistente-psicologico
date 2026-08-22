import type { Request, RequestHandler } from "express";

import type { NewAuditEntry } from "@chatcap/db-schema";
import type { Role } from "@chatcap/shared-types";

import { PROBLEM_BASE, problemResponse } from "../errors";
import { verifyAccessToken, type JwtConfig } from "./jwt";
/**
 * Auth middleware chain (task 5.1, REQ-DASH-1 / design §3.3):
 *
 *   authenticate  → parse Bearer JWT, attach `req.principal`
 *   authorize     → enforce the route's allowed roles; RBAC denials are
 *                   audit-logged with who/when/why (insufficient_role)
 *   audit         → record successful access to encrypted/chat data with the
 *                   acting principal, on 2xx responses only
 *
 * `req.principal` holds the resolved user (DB-backed) so a deleted/rotated
 * user is rejected even with a still-valid token.
 */

export interface Principal {
  userId: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export interface AuditWriter {
  write(entry: NewAuditEntry): Promise<void>;
}

export interface AuthenticateDeps {
  jwt: JwtConfig;
  /** Resolves a JWT subject to a live user; null = user gone → 401. */
  findUserById(id: string): Promise<{ id: string; role: Role } | null>;
}

export function createAuthenticate(deps: AuthenticateDeps): RequestHandler {
  return async (req, res, next) => {
    const header = req.header("authorization");
    if (header === undefined) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/unauthorized`,
        title: "Unauthorized",
        status: 401,
        detail: "Missing bearer token.",
        code: "unauthorized",
      });
      return;
    }
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || token === undefined || token.length === 0) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/unauthorized`,
        title: "Unauthorized",
        status: 401,
        detail: "Malformed bearer token.",
        code: "unauthorized",
      });
      return;
    }

    const verified = verifyAccessToken(deps.jwt, token);
    if (!verified.ok) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/unauthorized`,
        title: "Unauthorized",
        status: 401,
        detail: "Invalid or expired token.",
        code: "unauthorized",
      });
      return;
    }
    const user = await deps.findUserById(verified.claims.sub);
    if (user === null) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/unauthorized`,
        title: "Unauthorized",
        status: 401,
        detail: "Account no longer active.",
        code: "unauthorized",
      });
      return;
    }

    req.principal = { userId: user.id, role: user.role };
    next();
  };
}

export interface AuthorizeOptions {
  allowedRoles: Role[];
  /** Audit action recorded for a denial, e.g. "dashboard_keys_denied". */
  deniedAction: string;
  resourceType: string;
  audit: AuditWriter;
  /**
   * Error sink for audit-write failures. A failed audit write must NEVER
   * turn the denial into a 500 — the 403 is always sent and the audit
   * failure is surfaced here (production: logger.error).
   */
  onError?(error: unknown): void;
}

export function createAuthorize(options: AuthorizeOptions): RequestHandler {
  return async (req, res, next) => {
    const principal = req.principal;
    if (principal === undefined) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/unauthorized`,
        title: "Unauthorized",
        status: 401,
        detail: "Authentication required.",
        code: "unauthorized",
      });
      return;
    }
    if (options.allowedRoles.includes(principal.role)) {
      next();
      return;
    }

    await options.audit
      .write({
        actorType: "system",
        actorId: principal.userId,
        action: options.deniedAction,
        resourceType: options.resourceType,
        reason: "insufficient_role",
        meta: {
          reason: "insufficient_role",
          requestedAction: options.deniedAction,
          role: principal.role,
        },
      })
      .catch((error: unknown) => {
        options.onError?.(error);
      });

    problemResponse(res, {
      type: `${PROBLEM_BASE}/forbidden`,
      title: "Forbidden",
      status: 403,
      detail: "Your role does not allow this operation.",
      code: "forbidden",
    });
  };
}

export interface AuditMiddlewareOptions {
  action: string;
  resourceType: string;
  /** Resource identifier resolved from the request (params/body). */
  resourceId(req: Request): string;
  audit: AuditWriter;
  /**
   * Error sink for best-effort audit writes (fire-and-forget by design — the
   * response is already on the wire when this fires). Production wires this
   * to the logger; tests may leave it unset.
   */
  onError?(error: unknown): void;
}

export function createAuditMiddleware(options: AuditMiddlewareOptions): RequestHandler {
  return async (req, res, next) => {
    res.once("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return;
      }
      const principal = req.principal;
      if (principal === undefined) {
        return;
      }
      void options.audit
        .write({
          actorType: principal.role,
          actorId: principal.userId,
          action: options.action,
          resourceType: options.resourceType,
          resourceId: options.resourceId(req),
        })
        .catch((error: unknown) => {
          options.onError?.(error);
        });
    });
    next();
  };
}

