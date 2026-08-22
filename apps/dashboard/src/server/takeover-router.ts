import { Router, type Response } from "express";
import { z } from "zod";

import type {
  ChatTakeoverEvent,
  ReleaseResponse,
  Session,
  TakeoverResponse,
} from "@chatcap/shared-types";

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
 * Takeover/release router (task 5.3, REQ-DASH-3 / design §3.1): POST
 * /chats/{id}/takeover flips the session to ai_state='takeover' (AI off per
 * chat) and POST /chats/{id}/release resumes AI. Supervisor/admin only —
 * RBAC denials are audit-logged (REQ-DASH-1) and both state changes are
 * audit-logged with who/when/why (REQ-DASH-8), then pushed over the injected
 * Socket.io emitter so the live supervisor UI stays in sync (no-op emit when
 * not wired). The repository is injected (narrow interface, like
 * ChatsRepository) so the router stays unit-testable.
 *
 * Mounted BEFORE the chats router so these POST paths never pass the chats
 * router's /chats-wide auth gate twice.
 */

export interface TakeoverRepository {
  getSession(sessionId: string): Promise<Session | undefined>;
  setAiState(
    sessionId: string,
    aiState: Session["aiState"]
  ): Promise<Session>;
}

export type TakeoverEventEmitter = (
  event: "chat:takeover",
  payload: ChatTakeoverEvent
) => void;

export interface TakeoverRouterDeps {
  jwt: JwtConfig;
  users: AuthUsers;
  audit: AuditWriter;
  sessions: TakeoverRepository;
  /** Live chat-takeover events over Socket.io; no-op when not wired. */
  emit?: TakeoverEventEmitter;
  /**
   * Audit-write error sink. A failed audit write must never block the state
   * change or turn a 200 into a 500 — the failure is surfaced here
   * (production: logger.error). Tests leave it unset.
   */
  onAuditError?(error: unknown): void;
  /** Shared rate limiter for critical mutating endpoints (design §B5). */
  rateLimiter?: RateLimiterMemory;
}

const TAKE_OVER_ROLES = ["supervisor", "admin"] as const;
const CHAT_RESOURCE_TYPE = "chat";

const sessionIdSchema = z.uuid();

function validationError(res: Response): void {
  problemResponse(res, {
    type: `${PROBLEM_BASE}/validation_error`,
    title: "Validation Error",
    status: 400,
    detail: "sessionId must be a valid UUID.",
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
    detail: "The chat session does not exist.",
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

export function createTakeoverRouter(deps: TakeoverRouterDeps): Router {
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
    allowedRoles: [...TAKE_OVER_ROLES],
    deniedAction: "dashboard_takeover_denied",
    resourceType: CHAT_RESOURCE_TYPE,
    audit: deps.audit,
  });

  const rateLimit = deps.rateLimiter
    ? createCriticalRateLimit(
        deps.rateLimiter,
        (req) => req.principal?.userId ?? req.ip ?? "unknown"
      )
    : null;

  const authChain = rateLimit
    ? [authenticate, rateLimit, authorize]
    : [authenticate, authorize];

  router.use(
    ["/chats/:sessionId/takeover", "/chats/:sessionId/release"],
    ...authChain
  );

  router.post("/chats/:sessionId/takeover", async (req, res) => {
    const parsed = sessionIdSchema.safeParse(req.params.sessionId);
    if (!parsed.success) {
      validationError(res);
      return;
    }
    const sessionId = parsed.data;
    const principal = req.principal;
    if (principal === undefined) {
      unauthorized(res);
      return;
    }

    const session = await deps.sessions.getSession(sessionId);
    if (session === undefined) {
      notFound(res);
      return;
    }
    if (session.aiState === "takeover") {
      conflict(res, "Takeover already active.");
      return;
    }

    await deps.sessions.setAiState(sessionId, "takeover");
    const takenOverAt = new Date().toISOString();
    void deps.audit
      .write({
        actorType: principal.role,
        actorId: principal.userId,
        action: "chat_takeover",
        resourceType: CHAT_RESOURCE_TYPE,
        resourceId: sessionId,
        reason: "REQ-DASH-3 supervisor takeover",
        meta: { actorId: principal.userId, requestedAction: "takeover" },
      })
      .catch((error: unknown) => {
        deps.onAuditError?.(error);
      });
    deps.emit?.("chat:takeover", {
      sessionId,
      aiState: "takeover",
      actorId: principal.userId,
      occurredAt: takenOverAt,
    });

    const body: TakeoverResponse = {
      chatId: sessionId,
      aiState: "takeover",
      takenOverBy: principal.userId,
      takenOverAt,
    };
    res.status(200).json(body);
  });

  router.post("/chats/:sessionId/release", async (req, res) => {
    const parsed = sessionIdSchema.safeParse(req.params.sessionId);
    if (!parsed.success) {
      validationError(res);
      return;
    }
    const sessionId = parsed.data;
    const principal = req.principal;
    if (principal === undefined) {
      unauthorized(res);
      return;
    }

    const session = await deps.sessions.getSession(sessionId);
    if (session === undefined) {
      notFound(res);
      return;
    }
    if (session.aiState === "auto") {
      conflict(res, "The session is not under takeover.");
      return;
    }

    await deps.sessions.setAiState(sessionId, "auto");
    const releasedAt = new Date().toISOString();
    void deps.audit
      .write({
        actorType: principal.role,
        actorId: principal.userId,
        action: "chat_release",
        resourceType: CHAT_RESOURCE_TYPE,
        resourceId: sessionId,
        reason: "REQ-DASH-3 supervisor release",
        meta: { actorId: principal.userId, requestedAction: "release" },
      })
      .catch((error: unknown) => {
        deps.onAuditError?.(error);
      });
    deps.emit?.("chat:takeover", {
      sessionId,
      aiState: "auto",
      actorId: principal.userId,
      occurredAt: releasedAt,
    });

    const body: ReleaseResponse = {
      chatId: sessionId,
      aiState: "auto",
      releasedBy: principal.userId,
      releasedAt,
    };
    res.status(200).json(body);
  });

  return router;
}
