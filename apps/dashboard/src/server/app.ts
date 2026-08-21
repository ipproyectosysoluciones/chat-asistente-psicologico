import express, { type Express } from "express";

import type { Logger } from "@chatcap/telemetry";

import {
  createAlertsRouter,
  type AlertsRouterDeps,
} from "./alerts-router";
import {
  createKeysRouter,
  type KeysRouterDeps,
} from "./keys-router";
import {
  createVectorsRouter,
  type VectorsRouterDeps,
} from "./vectors-router";
import {
  createQrRouter,
  type QrRouterDeps,
} from "./qr-router";
import {
  createAuditRouter,
  type AuditRouterDeps,
} from "./audit-router";
import {
  createFrameworksRouter,
  type FrameworksRouterDeps,
} from "./frameworks-router";
import { createAuthRouter } from "./auth/auth-router";
import type { AuthUsers } from "./auth/auth-router";
import type { AuditWriter } from "./auth/middleware";
import { createChatsRouter, type ChatsRepository } from "./chats-router";
import { createErrorHandler, notFoundHandler } from "./errors";
import { createClientServing } from "./static";
import {
  createTakeoverRouter,
  type TakeoverRouterDeps,
} from "./takeover-router";

/**
 * App factory (task 5.1 scaffold): express app wired with the auth router,
 * the chats API (task 5.2), the takeover/release API (task 5.3, REQ-DASH-3),
 * the alerts API (task 5.4, REQ-DASH-4), RFC 7807 not-found + error handlers,
 * and health/readiness probes. Mirrors the notifications/ai-rag scaffolds —
 * the composition root (index.ts) stays untested by design; everything
 * swappable is injected here.
 */

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface AppDeps {
  logger: Logger;
  jwt: {
    secret: string;
    ttlSeconds: number;
  };
  users: AuthUsers;
  audit: AuditWriter;
  chats: ChatsRepository;
  /**
   * Takeover/release router (task 5.3, REQ-DASH-3). Optional so existing
   * factory tests keep constructing the app without it; the composition root
   * always wires it.
   */
  takeover?: TakeoverRouterDeps;
  /**
    * Alerts router (task 5.4, REQ-DASH-4). Optional so existing factory tests
    * keep constructing the app without it; the composition root always wires it.
    */
  alerts?: AlertsRouterDeps;
  /**
    * Keys rotation monitor (task 5.6, REQ-KEY-3). Optional so existing factory
    * tests keep constructing the app without it; the composition root wires it.
    */
  keys?: KeysRouterDeps;
  /**
     * Vectors router (task 5.5 core, REQ-DASH-RAG-7). Optional so existing
     * factory tests keep constructing the app without it; the composition root
     * wires it once the pgvector + embedder adapters are bound (deferred to a
     * follow-up index.ts change).
     */
  vectors?: VectorsRouterDeps;
  /**
    * QR validator router (task 5.7, REQ-KEY-7). Optional so existing factory
    * tests keep constructing the app without it; the composition root wires it.
    */
  qr?: QrRouterDeps;
  /**
   * Audit-log panel (task 5.8, REQ-DASH-8). Optional so existing factory tests
   * keep constructing the app without it; the composition root always wires it.
   */
  auditLog?: AuditRouterDeps;
  /**
   * Legal-framework terms panel (task 5.8, REQ-DASH-8). Optional so existing
   * factory tests keep constructing the app without it; the composition root
   * always wires it.
   */
  frameworks?: FrameworksRouterDeps;
  readiness: {
    database: ReadinessProbe;
    chatbot: ReadinessProbe;
  };
  /**
   * Built Vite client directory (design §7.1 "Vite static served by
   * Express"). Provided by the composition root; omitted in tests and
   * API-only deployments so the RFC 7807 JSON 404 always answers.
   */
  clientDistDir?: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_req, res) => {
    try {
      await deps.readiness.database.check();
      await deps.readiness.chatbot.check();
      res.status(200).json({ status: "ready" });
    } catch (error) {
      deps.logger.error("readyz probe failed", error);
      res.status(503).json({ status: "unready" });
    }
  });

  app.use(
    createAuthRouter({
      jwt: deps.jwt,
      users: deps.users,
    })
  );

  // Takeover/release API (task 5.3, REQ-DASH-3): mounted before the chats
  // router so these POST paths never pass the chats /chats-wide auth gate
  // twice. Supervisor/admin only — RBAC denials are audit-logged (REQ-DASH-1).
  if (deps.takeover !== undefined) {
    app.use(createTakeoverRouter(deps.takeover));
  }

  // Alerts API (task 5.4, REQ-DASH-4): live alert feed + acknowledge/resolve
  // lifecycle. Mounted before the chats router so `/alerts*` answers JSON.
  if (deps.alerts !== undefined) {
    app.use(createAlertsRouter(deps.alerts));
  }

  // Keys rotation monitor (task 5.6, REQ-KEY-3): supervisor/admin status +
  // admin-only rotate. Mounted after alerts, before chats/vectors so
  // `/api/v1/keys*` never hits the /chats-wide auth gate.
  if (deps.keys !== undefined) {
    app.use(createKeysRouter(deps.keys));
  }

  // Vectors API (task 5.5 core, REQ-DASH-RAG-7): manual re-ranking + chunk
  // removal over the vector store. Mounted before the chats router so
  // `/api/v1/vectors*` answers JSON and never hits the /chats-wide auth gate.
  if (deps.vectors !== undefined) {
    app.use(createVectorsRouter(deps.vectors));
  }

  // QR validator API (task 5.7, REQ-KEY-7): validity probe for supervisor-
  // issued consent QR codes. Mounted after keys/vectors, before chats so
  // `/api/v1/qr*` answers JSON and never hits the /chats-wide auth gate.
  if (deps.qr !== undefined) {
    app.use(createQrRouter(deps.qr));
  }

  // Audit-log panel (task 5.8, REQ-DASH-8): supervisor/admin audit-trail feed.
  // Mounted after qr, before chats so `/api/v1/audit*` answers JSON and never
  // hits the /chats-wide auth gate.
  if (deps.auditLog !== undefined) {
    app.use(createAuditRouter(deps.auditLog));
  }

  // Legal-framework terms panel (task 5.8, REQ-DASH-8): supervisor/admin list
  // + admin-only publish. Mounted after qr, before chats so
  // `/api/v1/legal-frameworks*` answers JSON and never hits the /chats-wide
  // auth gate.
  if (deps.frameworks !== undefined) {
    app.use(createFrameworksRouter(deps.frameworks));
  }

  // Chats API (task 5.2, REQ-DASH-2/9): mounted before client serving so
  // `/chats*` answers JSON, never the SPA fallback.
  app.use(
    createChatsRouter({
      jwt: deps.jwt,
      users: deps.users,
      audit: deps.audit,
      chats: deps.chats,
    })
  );

  // Serve the built Vite client (design §7.1) before the JSON 404 handler.
  // No-op (pass-through) until `vite build` has produced dist/index.html.
  if (deps.clientDistDir !== undefined) {
    app.use(...createClientServing(deps.clientDistDir));
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
}

export type { Logger };
export type { VectorsRouterDeps };
export type { KeysRouterDeps, RotationService, RotationStatus, RotateResult } from "./keys-router";
export type { KeyRow } from "./keys-router";
export type { QrRouterDeps, QrValidatorService, QrValidationResult } from "./qr-router";
export type { AuditRouterDeps, AuditLogPort } from "./audit-router";
export type { FrameworksRouterDeps, FrameworksPort } from "./frameworks-router";
