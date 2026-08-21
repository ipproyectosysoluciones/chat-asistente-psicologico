import { ACTOR_TYPE, type ActorType } from "@chatcap/shared-types";
import { z } from "zod";

/**
 * Audit-log API client (Phase 5.8 frontend, REQ-DASH-8): GET /api/v1/audit with
 * optional filters and the supervisor Bearer token. Responses are zod-validated
 * so a malformed server payload never renders. Failures surface as
 * AuditApiError carrying the RFC 7807 detail/code — the panel renders the exact
 * problem and offers retry. The token lives in sessionStorage ONLY (clinical
 * data, AGENTS.md) and is never logged.
 */

export class AuditApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(input: { status: number; code: string; detail: string }) {
    super(input.detail);
    this.name = "AuditApiError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

export const auditEntrySchema = z.object({
  id: z.string(),
  actorType: z.enum(Object.values(ACTOR_TYPE) as [ActorType, ...ActorType[]] /* why: Object.values on an as-const enum widens to string[]; z.enum requires a non-empty tuple type */),
  actorId: z.string().optional(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().optional(),
  reason: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditListSchema = z.object({
  entries: z.array(auditEntrySchema),
  count: z.number(),
});

export interface AuditQuery {
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** Human-readable message for any thrown value (AuditApiError uses server detail). */
export function auditErrorMessage(error: unknown): string {
  if (error instanceof AuditApiError) {
    return error.detail;
  }
  return "Ocurrió un error inesperado. Intente nuevamente.";
}

const problemSchema = z.object({
  status: z.number(),
  detail: z.string(),
  code: z.string(),
});

async function readErrorBody(response: Response): Promise<AuditApiError> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (parsed.success) {
      return new AuditApiError({
        status: parsed.data.status,
        code: parsed.data.code,
        detail: parsed.data.detail,
      });
    }
  } catch {
    // Non-JSON body: fall through to the generic problem below.
  }
  return new AuditApiError({
    status: response.status,
    code: "internal_error",
    detail: "El servidor devolvió una respuesta inesperada.",
  });
}

export async function fetchAuditLog(
  token: string,
  query: AuditQuery = {}
): Promise<{ entries: AuditEntry[]; count: number }> {
  const search = new URLSearchParams();
  if (query.resourceType !== undefined) {
    search.set("resourceType", query.resourceType);
  }
  if (query.resourceId !== undefined) {
    search.set("resourceId", query.resourceId);
  }
  if (query.actorId !== undefined) {
    search.set("actorId", query.actorId);
  }
  if (query.from !== undefined) {
    search.set("from", query.from);
  }
  if (query.to !== undefined) {
    search.set("to", query.to);
  }
  if (query.limit !== undefined) {
    search.set("limit", String(query.limit));
  }
  const queryString = search.toString();
  const path = `/api/v1/audit${queryString.length === 0 ? "" : `?${queryString}`}`;

  let response: Response;
  try {
    response = await fetch(path, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new AuditApiError({
      status: 0,
      code: "network_error",
      detail: "No se pudo conectar con el servidor.",
    });
  }

  if (!response.ok) {
    throw await readErrorBody(response);
  }

  const parsed = auditListSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AuditApiError({
      status: response.status,
      code: "internal_error",
      detail: "El servidor devolvió una respuesta inesperada.",
    });
  }
  return { entries: parsed.data.entries, count: parsed.data.count };
}
