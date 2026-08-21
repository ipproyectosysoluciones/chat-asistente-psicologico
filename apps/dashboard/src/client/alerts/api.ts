import { z } from "zod";

/**
 * Alerts API client (task 5.4 frontend, REQ-DASH-4/9): GET /alerts (live
 * feed, severity-first) and POST /alerts/:id/acknowledge|resolve. Responses
 * are zod-validated so a malformed server payload never renders. Failures
 * surface as AlertApiError carrying the RFC 7807 detail/code — the semaphore
 * renders the exact problem and offers retry (REQ-DASH-9).
 */

export class AlertApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(input: { status: number; code: string; detail: string }) {
    super(input.detail);
    this.name = "AlertApiError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

export const alertItemSchema = z.object({
  id: z.string(),
  level: z.enum(["red", "orange", "yellow"]),
  category: z.string(),
  sessionId: z.string(),
  status: z.enum(["open", "acknowledged", "resolved"]),
  dedupeKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  acknowledgedBy: z.string().optional(),
  resolvedAt: z.string().optional(),
});

export type AlertItem = z.infer<typeof alertItemSchema>;

const alertListSchema = z.object({
  items: z.array(alertItemSchema),
  total: z.number(),
});

export type AlertList = z.infer<typeof alertListSchema>;

const problemSchema = z.object({
  status: z.number(),
  detail: z.string(),
  code: z.string(),
});

export interface AlertsQuery {
  limit?: number;
  offset?: number;
}

/** Human-readable message for any thrown value (AlertApiError uses the server detail). */
export function alertsErrorMessage(error: unknown): string {
  if (error instanceof AlertApiError) {
    return error.detail;
  }
  return "Ocurrió un error inesperado. Intente nuevamente.";
}

async function readErrorBody(response: Response): Promise<AlertApiError> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (parsed.success) {
      return new AlertApiError({
        status: parsed.data.status,
        code: parsed.data.code,
        detail: parsed.data.detail,
      });
    }
  } catch {
    // Non-JSON body: fall through to the generic problem below.
  }
  return new AlertApiError({
    status: response.status,
    code: "internal_error",
    detail: "El servidor devolvió una respuesta inesperada.",
  });
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
}

async function request<T>(
  path: string,
  token: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {}
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new AlertApiError({
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
    throw new AlertApiError({
      status: response.status,
      code: "internal_error",
      detail: "El servidor devolvió una respuesta inesperada.",
    });
  }
  return parsed.data;
}

export async function fetchAlerts(
  token: string,
  query: AlertsQuery = {}
): Promise<AlertList> {
  const search = new URLSearchParams();
  if (query.limit !== undefined) {
    search.set("limit", String(query.limit));
  }
  if (query.offset !== undefined) {
    search.set("offset", String(query.offset));
  }
  const queryString = search.toString();
  return request(
    `/alerts${queryString.length === 0 ? "" : `?${queryString}`}`,
    token,
    alertListSchema
  );
}

export async function acknowledgeAlert(
  token: string,
  alertId: string
): Promise<AlertItem> {
  return request(
    `/alerts/${encodeURIComponent(alertId)}/acknowledge`,
    token,
    alertItemSchema,
    { method: "POST" }
  );
}

export async function resolveAlert(
  token: string,
  alertId: string,
  reason?: string
): Promise<AlertItem> {
  return request(
    `/alerts/${encodeURIComponent(alertId)}/resolve`,
    token,
    alertItemSchema,
    { method: "POST", body: reason === undefined ? {} : { reason } }
  );
}
