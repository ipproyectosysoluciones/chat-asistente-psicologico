import { z } from "zod";

/**
 * Chats API client (task 5.2 frontend, REQ-DASH-2/9): GET /chats (paginated
 * list with anonymized identifiers) and GET /chats/:sessionId (dual chat
 * detail with RAG grounding traces). Responses are zod-validated so a
 * malformed server payload never renders. Failures surface as ChatApiError
 * carrying the RFC 7807 detail/code — the views render the exact problem and
 * offer retry (REQ-DASH-9).
 */

export class ChatApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(input: { status: number; code: string; detail: string }) {
    super(input.detail);
    this.name = "ChatApiError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

const riskLevelSchema = z.enum(["red", "orange", "yellow", "normal"]);
const alertLevelSchema = z.enum(["red", "orange", "yellow"]);
const persistenceClassSchema = z.enum(["anonymous", "hc"]);
const aiStateSchema = z.enum(["auto", "takeover"]);
const consentStateSchema = z.enum(["notice_shown", "accepted", "renewed", "revoked"]);
const gateVerdictSchema = z.enum(["emit", "retry", "yellow_flag", "orange_block"]);
const nliVerdictSchema = z.enum(["entailment", "neutral", "contradiction"]);
const guardrailLevelSchema = z.enum(["none", "yellow", "orange"]);

const sessionSchema = z.object({
  id: z.string(),
  contactKeyAnon: z.string(),
  jurisdiction: z.string().optional(),
  persistenceClass: persistenceClassSchema,
  consentState: consentStateSchema,
  aiState: aiStateSchema,
  createdAt: z.string(),
  lastActivityAt: z.string(),
  purgeAt: z.string().optional(),
});

const dashboardMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sender: z.enum(["user", "bot"]),
  text: z.string().optional(),
  encrypted: z.boolean(),
  createdAt: z.string(),
});

const retrievedChunkSchema = z.object({
  chunkId: z.string(),
  docId: z.string(),
  chunkIndex: z.number(),
  content: z.string(),
  category: z.string(),
  source: z.string(),
  language: z.string(),
  legalFramework: z.string(),
  score: z.number(),
});

const ragTraceSchema = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  risk: riskLevelSchema,
  classification: z.object({
    model: z.string(),
    risk: riskLevelSchema,
    confidence: z.number(),
  }),
  retrieval: z.object({
    model: z.string(),
    topK: z.number(),
    hnsw: z.object({ efSearch: z.number() }),
    chunks: z.array(retrievedChunkSchema),
  }),
  generation: z.object({
    model: z.string(),
    temperature: z.number(),
    promptCharCount: z.number().optional(),
  }),
  gate: z.object({
    verdict: gateVerdictSchema,
    cosine: z.number(),
    nli: z.object({ verdict: nliVerdictSchema, confidence: z.number() }),
    guardrail: z.object({
      level: guardrailLevelSchema,
      deviationTerms: z.array(z.string()),
      blocked: z.boolean(),
    }),
    chunks: z.array(retrievedChunkSchema),
  }),
  emitted: z.boolean(),
  latencyMs: z.number().optional(),
  createdAt: z.string(),
});

const chatSummarySchema = z.object({
  sessionId: z.string(),
  contactKeyAnon: z.string(),
  jurisdiction: z.string().optional(),
  persistenceClass: persistenceClassSchema,
  aiState: aiStateSchema,
  lastActivityAt: z.string(),
  messageCount: z.number(),
  openAlertLevel: alertLevelSchema.optional(),
});

const chatListSchema = z.object({
  items: z.array(chatSummarySchema),
  total: z.number(),
});

const chatDetailSchema = z.object({
  session: sessionSchema,
  messages: z.array(dashboardMessageSchema),
  ragTraces: z.array(ragTraceSchema),
  alertLevel: alertLevelSchema.optional(),
});

export type ChatList = z.infer<typeof chatListSchema>;
export type ChatDetail = z.infer<typeof chatDetailSchema>;
export type ChatSummary = z.infer<typeof chatSummarySchema>;
export type RagTrace = z.infer<typeof ragTraceSchema>;

const problemSchema = z.object({
  status: z.number(),
  detail: z.string(),
  code: z.string(),
});

export interface ChatsQuery {
  limit?: number;
  offset?: number;
}

/** Human-readable message for any thrown value (ChatApiError uses the server detail). */
export function chatsErrorMessage(error: unknown): string {
  if (error instanceof ChatApiError) {
    return error.detail;
  }
  return "Ocurrió un error inesperado. Intente nuevamente.";
}

async function readErrorBody(response: Response): Promise<ChatApiError> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (parsed.success) {
      return new ChatApiError({
        status: parsed.data.status,
        code: parsed.data.code,
        detail: parsed.data.detail,
      });
    }
  } catch {
    // Non-JSON body: fall through to the generic problem below.
  }
  return new ChatApiError({
    status: response.status,
    code: "internal_error",
    detail: "El servidor devolvió una respuesta inesperada.",
  });
}

async function request<T>(path: string, token: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ChatApiError({
      status: 0,
      code: "network_error",
      detail: "No se pudo conectar con el servidor.",
    });
  }

  if (!response.ok) {
    throw await readErrorBody(response);
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ChatApiError({
      status: response.status,
      code: "internal_error",
      detail: "El servidor devolvió una respuesta inesperada.",
    });
  }
  return parsed.data;
}

export async function fetchChats(
  token: string,
  query: ChatsQuery = {}
): Promise<ChatList> {
  const search = new URLSearchParams();
  if (query.limit !== undefined) {
    search.set("limit", String(query.limit));
  }
  if (query.offset !== undefined) {
    search.set("offset", String(query.offset));
  }
  const queryString = search.toString();
  return request(`/chats${queryString.length === 0 ? "" : `?${queryString}`}`, token, chatListSchema);
}

export async function fetchChatDetail(token: string, sessionId: string): Promise<ChatDetail> {
  return request(`/chats/${encodeURIComponent(sessionId)}`, token, chatDetailSchema);
}
