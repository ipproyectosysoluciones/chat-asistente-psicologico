import { z } from "zod";

/**
 * QR validator API client (task 5.7 frontend, REQ-KEY-7/REQ-DASH-8): GET
 * /api/v1/qr/validate?payload=<json>&signature=<hex> runs the validity probe.
 * The validation endpoint reports validity (never errors on an invalid QR), so
 * the response is zod-validated and surfaced directly as a result badge.
 * Failures (auth/transport) surface as QrApiError carrying the RFC 7807
 * detail/code. The token lives in sessionStorage ONLY (never localStorage —
 * clinical data, AGENTS.md). No payload/signature contents are ever logged.
 */

export class QrApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(input: { status: number; code: string; detail: string }) {
    super(input.detail);
    this.name = "QrApiError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

/** Probe outcome as returned by GET /api/v1/qr/validate. */
export const qrValidationResultSchema = z.object({
  valid: z.boolean(),
  reason: z.string(),
  keyVersion: z.number().optional(),
});

export type QrValidationResult = z.infer<typeof qrValidationResultSchema>;

const qrValidationResponseSchema = z.object({
  result: qrValidationResultSchema,
});

const problemSchema = z.object({
  status: z.number(),
  detail: z.string(),
  code: z.string(),
});

/** Human-readable message for any thrown value (QrApiError uses the server detail). */
export function qrErrorMessage(error: unknown): string {
  if (error instanceof QrApiError) {
    return error.detail;
  }
  return "Ocurrió un error inesperado. Intente nuevamente.";
}

async function readErrorBody(response: Response): Promise<QrApiError> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (parsed.success) {
      return new QrApiError({
        status: parsed.data.status,
        code: parsed.data.code,
        detail: parsed.data.detail,
      });
    }
  } catch {
    // Non-JSON body: fall through to the generic problem below.
  }
  return new QrApiError({
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
    throw new QrApiError({
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
    throw new QrApiError({
      status: response.status,
      code: "internal_error",
      detail: "El servidor devolvió una respuesta inesperada.",
    });
  }
  return parsed.data;
}

/**
 * Probes a QR's validity. Both `payloadJson` (raw JSON string) and `signature`
 * (hex) are URL-encoded as query parameters via URLSearchParams, so the
 * `Authorization: Bearer` header and the encoded params are the only things on
 * the wire — nothing about the QR contents is logged.
 */
export async function fetchQrValidation(
  token: string,
  payloadJson: string,
  signature: string
): Promise<QrValidationResult> {
  const params = new URLSearchParams();
  params.set("payload", payloadJson);
  params.set("signature", signature);
  const response = await request(
    `/api/v1/qr/validate?${params.toString()}`,
    token,
    qrValidationResponseSchema
  );
  return response.result;
}
