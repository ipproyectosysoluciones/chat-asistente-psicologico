import { Router } from "express";
import { z } from "zod";

import type { ChatPage, ChatPageOptions } from "@chatcap/db-schema";
import type {
  AlertLevel,
  DashboardMessage,
  RagTrace,
  Role,
  Session,
} from "@chatcap/shared-types";

import { PROBLEM_BASE, problemResponse } from "./errors";
import {
  createAuditMiddleware,
  createAuthenticate,
  createAuthorize,
  type AuditWriter,
} from "./auth/middleware";
import type { JwtConfig } from "./auth/jwt";
import type { AuthUsers } from "./auth/auth-router";

/**
 * Chats router (task 5.2, REQ-DASH-2/9 / design §3.1): paginated chat list
 * with anonymized identifiers and the dual chat view (session + messages +
 * RAG grounding traces + highest open alert level). Supervisor/admin only —
 * RBAC denials are audit-logged (REQ-DASH-1) and successful chat-content
 * access is audit-logged (REQ-DASH-8). Message content stays on the server;
 * the client renders only what these handlers expose.
 *
 * The repository is injected (narrow interface, like AuthUsers) so the router
 * stays unit-testable and the composition root binds it to the db-schema
 * read models (listDashboardChats / listDashboardMessages / ...).
 */

export interface ChatsRepository {
  listChats(options: ChatPageOptions): Promise<ChatPage>;
  getSession(sessionId: string): Promise<Session | undefined>;
  listMessages(sessionId: string): Promise<DashboardMessage[]>;
  listRagTraces(sessionId: string): Promise<RagTrace[]>;
  findOpenAlertLevel(sessionId: string): Promise<AlertLevel | undefined>;
}

export interface ChatsRouterDeps {
  jwt: JwtConfig;
  users: AuthUsers;
  audit: AuditWriter;
  chats: ChatsRepository;
}

const CHAT_ROLES: Role[] = ["supervisor", "admin"];
const CHAT_RESOURCE_TYPE = "chat";
const CHAT_DENIED_ACTION = "dashboard_chats_denied";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const sessionIdSchema = z.uuid();

export function createChatsRouter(deps: ChatsRouterDeps): Router {
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
    allowedRoles: CHAT_ROLES,
    deniedAction: CHAT_DENIED_ACTION,
    resourceType: CHAT_RESOURCE_TYPE,
    audit: deps.audit,
  });

  router.get("/chats", authenticate, authorize, async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/validation_error`,
        title: "Validation Error",
        status: 400,
        detail: "limit must be an integer between 1 and 100; offset a non-negative integer.",
        code: "validation_error",
      });
      return;
    }
    const page = await deps.chats.listChats(parsed.data);
    res.status(200).json({ items: page.items, total: page.total });
  });

  router.get(
    "/chats/:sessionId",
    authenticate,
    authorize,
    createAuditMiddleware({
      action: "chat_detail_access",
      resourceType: CHAT_RESOURCE_TYPE,
      resourceId: (req) => (typeof req.params.sessionId === "string" ? req.params.sessionId : ""),
      audit: deps.audit,
    }),
    async (req, res) => {
      const parsed = sessionIdSchema.safeParse(req.params.sessionId);
      if (!parsed.success) {
        problemResponse(res, {
          type: `${PROBLEM_BASE}/validation_error`,
          title: "Validation Error",
          status: 400,
          detail: "sessionId must be a valid UUID.",
          code: "validation_error",
        });
        return;
      }
      const session = await deps.chats.getSession(parsed.data);
      if (session === undefined) {
        problemResponse(res, {
          type: `${PROBLEM_BASE}/not_found`,
          title: "Not Found",
          status: 404,
          detail: "The chat session does not exist.",
          code: "not_found",
        });
        return;
      }
      const [messages, ragTraces, alertLevel] = await Promise.all([
        deps.chats.listMessages(session.id),
        deps.chats.listRagTraces(session.id),
        deps.chats.findOpenAlertLevel(session.id),
      ]);
      res.status(200).json({
        session,
        messages,
        ragTraces,
        ...(alertLevel === undefined ? {} : { alertLevel }),
      });
    }
  );

  return router;
}
