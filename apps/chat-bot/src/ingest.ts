import { Router } from "express";
import { z } from "zod";

import type { Logger } from "@chatcap/telemetry";

import type { ChatDatabase } from "./database/database";
import { problemResponse } from "./errors";
import { internalTokenMiddleware } from "./internal-token";
import type { ChatProvider } from "./provider/provider";

/**
 * Supervisor-reply ingest (task 5.3, REQ-DASH-3 / design §3.1): POST
 * /internal/messages/ingest is where the dashboard injects a supervisor reply
 * into a chat under takeover. Gating is defense-in-depth — the dashboard flips
 * ai_state, but this endpoint re-checks the session and its `ai_state` before
 * persisting (best-effort history sink) and emitting (provider sendText). The
 * body text is clinical content: errors are logged PII-free (session id only,
 * never the message), matching the project's no-PII logging rule.
 *
 * Mirror of how bot.ts gets its pillars: the router depends on the narrow
 * `pillars` object, so provider and database stay swappable and the whole
 * surface is unit-testable with the MemoryChatDatabase + MockProvider doubles.
 */

export interface IngestDeps {
  logger: Logger;
  internalTokens: readonly string[];
  pillars: {
    database: ChatDatabase;
    provider: ChatProvider;
  };
}

const ingestRequestSchema = z.object({
  sessionId: z.uuid(),
  text: z.string().trim().min(1).max(2000),
});

export function createIngestRouter(deps: IngestDeps): Router {
  const router = Router();
  router.use(internalTokenMiddleware(deps.internalTokens));

  router.post("/internal/messages/ingest", async (req, res) => {
    const parsed = ingestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      problemResponse(res, {
        type: "https://api.chatcap.app/errors/validation_error",
        title: "Validation Error",
        status: 400,
        detail: "sessionId must be a UUID; text must be 1–2000 characters.",
        code: "validation_error",
      });
      return;
    }
    const { sessionId, text } = parsed.data;

    try {
      const session = await deps.pillars.database.getSession(sessionId);
      if (session === undefined) {
        problemResponse(res, {
          type: "https://api.chatcap.app/errors/not_found",
          title: "Not Found",
          status: 404,
          detail: "The chat session does not exist.",
          code: "not_found",
        });
        return;
      }
      if (session.aiState !== "takeover") {
        problemResponse(res, {
          type: "https://api.chatcap.app/errors/conflict",
          title: "Conflict",
          status: 409,
          detail: "Supervisor replies require the chat to be under takeover.",
          code: "conflict",
        });
        return;
      }

      // Persist first so a supervisor reply is never lost even if the send
      // fails (clinical conversations stay auditable).
      await deps.pillars.database.saveHistoryEntry({
        sessionId,
        sender: "bot",
        text,
        persistenceClass: session.persistenceClass,
        purgeAt: session.purgeAt,
      });

      const phone = await deps.pillars.database.resolveContactPhone(sessionId);
      if (phone === undefined) {
        deps.logger.error(
          "chat: ingest could not resolve contact phone; reply not sent",
          { sessionId }
        );
        problemResponse(res, {
          type: "https://api.chatcap.app/errors/internal_error",
          title: "Internal Server Error",
          status: 500,
          detail: "The reply could not be delivered.",
          code: "internal_error",
        });
        return;
      }

      await deps.pillars.provider.sendText(phone, text);
      res.status(202).json({ accepted: true });
    } catch (error) {
      deps.logger.error("chat: ingest failed", {
        sessionId,
        error: String(error),
      });
      problemResponse(res, {
        type: "https://api.chatcap.app/errors/internal_error",
        title: "Internal Server Error",
        status: 500,
        detail: "The reply could not be delivered.",
        code: "internal_error",
      });
    }
  });

  return router;
}
