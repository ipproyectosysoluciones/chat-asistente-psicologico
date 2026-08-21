import type { LegalFrameworkRow } from "@chatcap/db-schema";
import { z } from "zod";

/**
 * Legal-framework API client (Phase 5.8 frontend): GET /api/v1/legal-frameworks
 * (published version list, supervisor-only) and POST /api/v1/legal-frameworks
 * (publish a new terms version). Responses are zod-validated so a malformed
 * server payload never renders. Failures surface as FrameworksApiError carrying
 * the RFC 7807 detail/code. The token lives in sessionStorage ONLY (clinical
 * data, AGENTS.md) and is never logged.
 */

export class FrameworksApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(input: { status: number; code: string; detail: string }) {
    super(input.detail);
    this.name = "FrameworksApiError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

export const legalFrameworkSchema = z.object({
  id: z.string(),
  countryCode: z.string(),
  frameworkCode: z.string(),
  noticeText: z.string(),
  termsVersion: z.number(),
  active: z.boolean(),
  createdAt: z.string(),
});

export type LegalFramework = z.infer<typeof legalFrameworkSchema>;

export const frameworksListSchema = z.object({
  frameworks: z.array(legalFrameworkSchema),
});

export const publishTermsSchema = z.object({
  countryCode: z.string(),
  frameworkCode: z.string(),
  noticeText: z.string(),
  version: z.number().optional(),
});

export type PublishTermsInput = z.infer<typeof publishTermsSchema>;

/** Human-readable message for any thrown value (FrameworksApiError uses server detail). */
export function frameworksErrorMessage(error: unknown): string {
  if (error instanceof FrameworksApiError) {
    return error.detail;
  }
  return "Ocurrió un error inesperado. Intente nuevamente.";
}

const problemSchema = z.object({
  status: z.number(),
  detail: z.string(),
  code: z.string(),
});

async function readErrorBody(response: Response): Promise<FrameworksApiError> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (parsed.success) {
      return new FrameworksApiError({
        status: parsed.data.status,
        code: parsed.data.code,
        detail: parsed.data.detail,
      });
    }
  } catch {
    // Non-JSON body: fall through to the generic problem below.
  }
  return new FrameworksApiError({
    status: response.status,
    code: "internal_error",
    detail: "El servidor devolvió una respuesta inesperada.",
  });
}

export async function fetchLegalFrameworks(
  token: string
): Promise<LegalFrameworkRow[]> {
  let response: Response;
  try {
    response = await fetch("/api/v1/legal-frameworks", {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new FrameworksApiError({
      status: 0,
      code: "network_error",
      detail: "No se pudo conectar con el servidor.",
    });
  }

  if (!response.ok) {
    throw await readErrorBody(response);
  }

  const parsed = frameworksListSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new FrameworksApiError({
      status: response.status,
      code: "internal_error",
      detail: "El servidor devolvió una respuesta inesperada.",
    });
  }
  return parsed.data.frameworks;
}

export async function publishLegalFramework(
  token: string,
  input: PublishTermsInput
): Promise<LegalFrameworkRow> {
  const validated = publishTermsSchema.parse(input);
  let response: Response;
  try {
    response = await fetch("/api/v1/legal-frameworks", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(validated),
    });
  } catch {
    throw new FrameworksApiError({
      status: 0,
      code: "network_error",
      detail: "No se pudo conectar con el servidor.",
    });
  }

  if (!response.ok) {
    throw await readErrorBody(response);
  }

  const parsed = legalFrameworkSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new FrameworksApiError({
      status: response.status,
      code: "internal_error",
      detail: "El servidor devolvió una respuesta inesperada.",
    });
  }
  return parsed.data;
}
