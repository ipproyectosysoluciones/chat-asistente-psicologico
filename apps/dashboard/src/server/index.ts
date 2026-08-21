import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { Pool } from "pg";
import { Server as SocketIoServer } from "socket.io";

import {
  envKeyProviderFromConfig,
  type AppConfig,
  type KeyProvider,
} from "@chatcap/config";
import {
  BatchReencryptionCoordinator,
  InlineBatchCrypto,
  RepositoryAuditSink,
  computeRotationDates,
  isQrPayload,
  SALT_LENGTH,
  verifyQrPayload,
} from "@chatcap/crypto-keys";
import {
  acknowledgeAlert,
  countConsentRowsByKeyVersion,
  createNextKeyVersion,
  currentActiveKeyVersion,
  findAlertById,
  findOpenAlertLevel,
  findUserByEmail,
  findUserById,
  getSession,
  insertAuditEntry,
  listAuditEntries,
  listAlerts,
  listDashboardChats,
  listDashboardMessages,
  listDashboardRagTraces,
  listKeysPastForcedDue,
  listLegalFrameworks,
  publishTermsVersion,
  resolveAlert,
  type AuditQuery,
  type LegalFrameworkRow,
  type PublishTermsInput,
  setSessionAiState,
} from "@chatcap/db-schema";
import { createLogger } from "@chatcap/telemetry";
import type { QrPayload } from "@chatcap/shared-types";

import { bootstrapAdmin } from "./auth/admin-bootstrap";
import { createApp } from "./app";
import {
  subscribeAlertChannel,
  type AlertSubscriber,
} from "./alert-subscriber";

/**
 * Composition root (task 5.1): loads config, wires the pg pool + logger,
 * bootstraps the admin user, and starts the express server. Kept untested by
 * design — every piece it composes is unit-tested through createApp().
 */

const CLIENT_DIST_DIR = fileURLToPath(new URL("../../dist", import.meta.url));

export async function startDashboard(config: AppConfig): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  const logger = createLogger({ level: config.logLevel });
  const pool = new Pool({ connectionString: config.databaseUrl });

  await bootstrapAdmin(config, pool);

  // Socket.io server bound to the HTTP server below (task 5.3, REQ-DASH-3):
  // the takeover router emits chat:takeover events on every AI-state flip so
  // the live supervisor UI stays in sync without polling.
  let io: SocketIoServer | undefined;

  const app = createApp({
    logger,
    jwt: {
      secret: config.jwtSecret,
      ttlSeconds: config.dashboard.jwtTtlMinutes * 60,
    },
    users: {
      findByEmail: async (email) => findUserByEmail(pool, email),
      findById: async (id) => findUserById(pool, id),
    },
    audit: {
      write: async (entry) => {
        await insertAuditEntry(pool, entry);
      },
    },
    chats: {
      listChats: async (options) => listDashboardChats(pool, options),
      getSession: async (sessionId) => getSession(pool, sessionId),
      listMessages: async (sessionId) => listDashboardMessages(pool, sessionId),
      listRagTraces: async (sessionId) => listDashboardRagTraces(pool, sessionId),
      findOpenAlertLevel: async (sessionId) => findOpenAlertLevel(pool, sessionId),
    },
    takeover: {
      jwt: {
        secret: config.jwtSecret,
        ttlSeconds: config.dashboard.jwtTtlMinutes * 60,
      },
      users: {
        findByEmail: async (email) => findUserByEmail(pool, email),
        findById: async (id) => findUserById(pool, id),
      },
      audit: {
        write: async (entry) => {
          await insertAuditEntry(pool, entry);
        },
      },
      sessions: {
        getSession: async (sessionId) => getSession(pool, sessionId),
        setAiState: async (sessionId, aiState) =>
          setSessionAiState(pool, sessionId, aiState),
      },
      emit: (event, payload) => {
        io?.emit(event, payload);
      },
      onAuditError: (error) => {
        logger.error("chat takeover audit write failed", error);
      },
    },
    alerts: {
      jwt: {
        secret: config.jwtSecret,
        ttlSeconds: config.dashboard.jwtTtlMinutes * 60,
      },
      users: {
        findByEmail: async (email) => findUserByEmail(pool, email),
        findById: async (id) => findUserById(pool, id),
      },
      audit: {
        write: async (entry) => {
          await insertAuditEntry(pool, entry);
        },
      },
      alerts: {
        listAlerts: async (options) => listAlerts(pool, options),
        findById: async (alertId) => findAlertById(pool, alertId),
        acknowledge: async (alertId, actorId) =>
          acknowledgeAlert(pool, alertId, actorId),
        resolve: async (alertId) => resolveAlert(pool, alertId),
      },
      emit: (event, payload) => {
        io?.emit(event, payload);
      },
      onAuditError: (error) => {
        logger.error("alert lifecycle audit write failed", error);
      },
    },
    keys: {
      jwt: {
        secret: config.jwtSecret,
        ttlSeconds: config.dashboard.jwtTtlMinutes * 60,
      },
      users: {
        findByEmail: async (email) => findUserByEmail(pool, email),
        findById: async (id) => findUserById(pool, id),
      },
      audit: {
        write: async (entry) => {
          await insertAuditEntry(pool, entry);
        },
      },
      rotation: {
        async status() {
          const now = new Date();
          const active = await currentActiveKeyVersion(pool);
          const forcedDue = await listKeysPastForcedDue(pool, now);
          const pendingRows =
            active === undefined
              ? 0
              : await countConsentRowsByKeyVersion(pool, active.keyVersion);
          const ageInDays =
            active === undefined
              ? 0
              : (now.getTime() - new Date(active.createdAt).getTime()) /
                86_400_000;
          const daysUntilRotation = Math.max(0, 7 - ageInDays);
          return {
            activeKeyVersion: active?.keyVersion ?? 0,
            activeCreatedAt: active?.createdAt ?? "",
            daysUntilRotation,
            forcedDue: forcedDue.map((key) => ({
              keyVersion: key.keyVersion,
              createdAt: key.createdAt,
              status: key.status,
            })),
            pendingRows,
          };
        },
        async rotate(cmd) {
          const active = await currentActiveKeyVersion(pool);
          if (active === undefined) {
            throw new Error("no active key version found");
          }
          const now = new Date();
          const { expiresAt, forcedRotationDueAt } = computeRotationDates(now);
          const next = await createNextKeyVersion(pool, {
            salt: randomBytes(SALT_LENGTH).toString("hex"),
            expiresAt,
            forcedRotationDueAt,
          });
          if (cmd.dryRun) {
            return {
              dryRun: true,
              keyFrom: active.keyVersion,
              keyTo: next.keyVersion,
              wouldRetire: active.keyVersion,
            };
          }
          const keyProvider: KeyProvider = envKeyProviderFromConfig(config);
          const result = await new BatchReencryptionCoordinator({
            db: pool,
            masterKeyProvider: keyProvider,
            crypto: new InlineBatchCrypto(keyProvider),
            audit: new RepositoryAuditSink(pool),
          }).reencryptKey(active.keyVersion, next.keyVersion, {
            forced: !!cmd.forced,
          });
          void insertAuditEntry(pool, {
            actorType: "system",
            action: "key_rotation_completed",
            resourceType: "key_version",
            resourceId: String(next.keyVersion),
            reason: cmd.forced ? "forced" : "scheduled",
            meta: {
              keyFrom: active.keyVersion,
              keyTo: next.keyVersion,
              forced: !!cmd.forced,
            },
          }).catch((error: unknown) => {
            logger.error("key rotation audit write failed", error);
          });
          return {
            dryRun: false,
            keyFrom: active.keyVersion,
            keyTo: next.keyVersion,
            ...result,
          };
        },
      },
      emit: (event, payload) => {
        io?.emit(event, payload);
      },
      onAuditError: (error) => {
        logger.error("keys router audit write failed", error);
      },
    },
    qr: {
      jwt: {
        secret: config.jwtSecret,
        ttlSeconds: config.dashboard.jwtTtlMinutes * 60,
      },
      users: {
        findByEmail: async (email) => findUserByEmail(pool, email),
        findById: async (id) => findUserById(pool, id),
      },
      audit: {
        write: async (entry) => {
          await insertAuditEntry(pool, entry);
        },
      },
      qr: {
        // QRs are signed with the global QR key (config.qrKey, REQ-KEY-7), the
        // same key the chat-bot ConsentService uses as its `signerKey`. The
        // payload's `keyVersion` is informational for the chain of trust; the
        // HMAC key is the single QR signing key, so verification derives the
        // Buffer directly from config rather than per-version HKDF.
        async validate(payload: QrPayload, signature: string) {
          if (!isQrPayload(payload)) {
            return { valid: false, reason: "malformed_payload" as const };
          }
          const key = Buffer.from(config.qrKey, "utf8");
          const valid = verifyQrPayload(payload, signature, key);
          return {
            valid,
            reason: valid ? ("signature_match" as const) : ("invalid_signature" as const),
            keyVersion: payload.keyVersion,
          };
        },
      },
      emit: (event, payload) => {
        io?.emit(event, payload);
      },
      onAuditError: (error) => {
        logger.error("qr validation audit write failed", error);
      },
    },
    auditLog: {
      jwt: {
        secret: config.jwtSecret,
        ttlSeconds: config.dashboard.jwtTtlMinutes * 60,
      },
      users: {
        findByEmail: async (email) => findUserByEmail(pool, email),
        findById: async (id) => findUserById(pool, id),
      },
      audit: {
        write: async (entry) => {
          await insertAuditEntry(pool, entry);
        },
      },
      auditLog: {
        list: (q: AuditQuery) => listAuditEntries(pool, q),
      },
    },
    frameworks: {
      jwt: {
        secret: config.jwtSecret,
        ttlSeconds: config.dashboard.jwtTtlMinutes * 60,
      },
      users: {
        findByEmail: async (email) => findUserByEmail(pool, email),
        findById: async (id) => findUserById(pool, id),
      },
      audit: {
        write: async (entry) => {
          await insertAuditEntry(pool, entry);
        },
      },
      frameworks: {
        list: () => listLegalFrameworks(pool),
        publish: async (i: PublishTermsInput) => {
          const framework: LegalFrameworkRow = await publishTermsVersion(pool, i);
          // Best-effort completion audit (REQ-DASH-8); the publish itself
          // succeeded regardless of whether this write lands.
          void insertAuditEntry(pool, {
            actorType: "system",
            action: "framework_published_completed",
            resourceType: "legal_framework",
            resourceId: framework.frameworkCode,
            reason: "legal-framework terms version published",
            meta: {
              frameworkCode: framework.frameworkCode,
              countryCode: framework.countryCode,
              termsVersion: framework.termsVersion,
            },
          }).catch((error: unknown) => {
            logger.error("framework published completed audit write failed", error);
          });
          return framework;
        },
      },
    },
    // Serve the built Vite client (design §7.1) when dist/index.html exists.
    clientDistDir: CLIENT_DIST_DIR,
    readiness: {
      database: {
        async check() {
          await pool.query("SELECT 1");
        },
      },
      chatbot: {
        async check() {
          if (config.dashboard.chatbotBaseUrl.length === 0) {
            return;
          }
          const response = await fetch(`${config.dashboard.chatbotBaseUrl}/healthz`);
          if (!response.ok) {
            throw new Error(`chat-bot /healthz returned ${response.status}`);
          }
        },
      },
    },
  });

  const server = app.listen(config.port, "0.0.0.0");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  const url = `http://127.0.0.1:${address.port}`;

  // Same-origin in production (design §7.1 serves the Vite client from this
  // Express server), so no CORS list is configured.
  io = new SocketIoServer(server);

  // Phase 7.3 gap fix: push newly raised crisis alerts to supervisors in
  // real time. ai-rag/chat-bot publish `alert_raised` on Redis pub-sub; we
  // subscribe here and re-emit the PII-free payload as `alert:new` (< 1s
  // contract, REQ-ALERT-2). Fire-and-forget: a failure (e.g. Redis down)
  // must never crash the dashboard — the alert still lands in the polled DB
  // feed. See ./alert-subscriber.ts for the full design note.
  let alertSubscriber: AlertSubscriber | undefined;
  void subscribeAlertChannel({
    redisUrl: config.redisUrl,
    onNewAlert: (alert) => {
      io?.emit("alert:new", alert);
    },
    onError: (error) => {
      logger.error("crisis-alert Redis subscription failed", error);
    },
    logger,
  }).then((subscriber) => {
    alertSubscriber = subscriber;
  });

  logger.info(`dashboard listening on ${url}`);

  return {
    url,
    async close() {
      if (alertSubscriber !== undefined) {
        await alertSubscriber.close();
      }
      if (io !== undefined) {
        await new Promise<void>((resolve) => io!.close(() => resolve()));
      }
      await pool.end();
    },
  };
}
