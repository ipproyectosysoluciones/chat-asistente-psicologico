import { z } from "zod";

/**
 * Vectors API client (task 5.5 frontend, REQ-DASH-RAG-7): GET the vector-search
 * grounding trace and DELETE a single chunk from a document. Responses are
 * zod-validated so a malformed server payload never renders. Failures surface
 * as VectorsApiError carrying the RFC 7807 detail/code — the explorer renders
 * the exact problem and offers retry (REQ-DASH-9).
 */

export class VectorsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(input: { status: number; code: string; detail: string }) {
    super(input.detail);
    this.name = "VectorsApiError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

export const chunkSchema = z.object({
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

export type Chunk = z.infer<typeof chunkSchema>;

const searchResponseSchema = z.object({
  chunks: z.array(chunkSchema),
  query: z.string(),
  count: z.number(),
});

export type VectorSearchResponse = z.infer<typeof searchResponseSchema>;

const problemSchema = z.object({
  status: z.number(),
  detail: z.string(),
  code: z.string(),
});

export interface VectorSearchQuery {
  q: string;
  category?: string;
  language?: string;
  framework?: string;
  limit?: number;
}

/** Human-readable message for any thrown value (VectorsApiError uses the server detail). */
export function vectorsErrorMessage(error: unknown): string {
  if (error instanceof VectorsApiError) {
    return error.detail;
  }
  return "Ocurrió un error inesperado. Intente nuevamente.";
}

async function readErrorBody(response: Response): Promise<VectorsApiError> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (parsed.success) {
      return new VectorsApiError({
        status: parsed.data.status,
        code: parsed.data.code,
        detail: parsed.data.detail,
      });
    }
  } catch {
    // Non-JSON body: fall through to the generic problem below.
  }
  return new VectorsApiError({
    status: response.status,
    code: "internal_error",
    detail: "El servidor devolvió una respuesta inesperada.",
  });
}

interface RequestOptions {
  method?: "GET" | "DELETE";
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
    throw new VectorsApiError({
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
    throw new VectorsApiError({
      status: response.status,
      code: "internal_error",
      detail: "El servidor devolvió una respuesta inesperada.",
    });
  }
  return parsed.data;
}

export async function fetchVectorSearch(
  token: string,
  query: VectorSearchQuery
): Promise<VectorSearchResponse> {
  const search = new URLSearchParams();
  search.set("q", query.q);
  if (query.category !== undefined) {
    search.set("category", query.category);
  }
  if (query.language !== undefined) {
    search.set("language", query.language);
  }
  if (query.framework !== undefined) {
    search.set("framework", query.framework);
  }
  if (query.limit !== undefined) {
    search.set("limit", String(query.limit));
  }
  return request(`/api/v1/vectors/search?${search.toString()}`, token, searchResponseSchema);
}

export async function deleteVectorChunk(
  token: string,
  docId: string,
  chunkIndex: number
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/vectors/documents/${encodeURIComponent(docId)}/chunks/${chunkIndex}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }
    );
  } catch {
    throw new VectorsApiError({
      status: 0,
      code: "network_error",
      detail: "No se pudo conectar con el servidor.",
    });
  }

  if (!response.ok) {
    throw await readErrorBody(response);
  }
}
