import { z } from "zod";

/**
 * Keys rotation API client (task 5.6 frontend, REQ-DASH-1/REQ-KEY-3):
 * GET /api/v1/keys/rotation (rotation status) and POST
 * /api/v1/keys/rotation/rotate (on-demand rotation, admin-only). Responses are
 * zod-validated so a malformed server payload never renders. Failures surface
 * as KeysApiError carrying the RFC 7807 detail/code — the monitor renders the
 * exact problem and offers retry. The token lives in sessionStorage ONLY
 * (never localStorage — clinical data, AGENTS.md).
 */

export class KeysApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(input: { status: number; code: string; detail: string }) {
    super(input.detail);
    this.name = "KeysApiError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

const keyRowSchema = z.object({
  keyVersion: z.number(),
  createdAt: z.string(),
  retiredAt: z.string().optional(),
  status: z.enum(["active", "retired", "expired", "compromised"]),
});

export type KeyRow = z.infer<typeof keyRowSchema>;

const rotationStatusSchema = z.object({
  activeKeyVersion: z.number(),
  activeCreatedAt: z.string(),
  daysUntilRotation: z.number(),
  forcedDue: z.array(keyRowSchema),
  pendingRows: z.number(),
});

export type RotationStatus = z.infer<typeof rotationStatusSchema>;

const rotationStatusResponseSchema = z.object({
  status: rotationStatusSchema,
});

const batchOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("verified"),
    batchId: z.string(),
    rowsProcessed: z.number(),
    integrityHash: z.string(),
  }),
  z.object({
    kind: z.literal("rolled_back"),
    batchId: z.string(),
    error: z.string(),
  }),
  z.object({ kind: z.literal("none") }),
]);

const rotateResultSchema = z.object({
  dryRun: z.boolean(),
  keyFrom: z.number(),
  keyTo: z.number(),
  wouldRetire: z.number().optional(),
  processed: z.number().optional(),
  remaining: z.number().optional(),
  retired: z.boolean().optional(),
  outcomes: z.array(batchOutcomeSchema).optional(),
});

export type RotateResult = z.infer<typeof rotateResultSchema>;

const rotateResponseSchema = z.object({
  result: rotateResultSchema,
});

const rotateCommandSchema = z.object({
  forced: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export type RotateCommand = z.infer<typeof rotateCommandSchema>;

const problemSchema = z.object({
  status: z.number(),
  detail: z.string(),
  code: z.string(),
});

/** Human-readable message for any thrown value (KeysApiError uses the server detail). */
export function keysErrorMessage(error: unknown): string {
  if (error instanceof KeysApiError) {
    return error.detail;
  }
  return "Ocurrió un error inesperado. Intente nuevamente.";
}

async function readErrorBody(response: Response): Promise<KeysApiError> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (parsed.success) {
      return new KeysApiError({
        status: parsed.data.status,
        code: parsed.data.code,
        detail: parsed.data.detail,
      });
    }
  } catch {
    // Non-JSON body: fall through to the generic problem below.
  }
  return new KeysApiError({
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
    throw new KeysApiError({
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
    throw new KeysApiError({
      status: response.status,
      code: "internal_error",
      detail: "El servidor devolvió una respuesta inesperada.",
    });
  }
  return parsed.data;
}

export async function fetchRotationStatus(
  token: string
): Promise<RotationStatus> {
  const response = await request(
    "/api/v1/keys/rotation",
    token,
    rotationStatusResponseSchema
  );
  return response.status;
}

export async function rotateKeys(
  token: string,
  cmd: RotateCommand
): Promise<RotateResult> {
  const response = await request(
    "/api/v1/keys/rotation/rotate",
    token,
    rotateResponseSchema,
    { method: "POST", body: cmd }
  );
  return response.result;
}
