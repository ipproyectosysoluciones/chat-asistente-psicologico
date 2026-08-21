import { z } from "zod";

/**
 * Auth API client (task 5.1 frontend, design §3.3): POST /auth/login and
 * GET /auth/me with zod-validated responses. The access token lives in
 * sessionStorage ONLY — never localStorage — because this dashboard reads
 * clinical/chat data (AGENTS.md: health-data project, session-scoped
 * credentials only). Server failures surface as AuthError carrying the
 * RFC 7807 detail/code so the UI can render the exact problem.
 */

export const TOKEN_STORAGE_KEY = "chatcap.auth.token";

export interface AuthUser {
  id: string;
  email: string;
  role: "supervisor" | "admin";
}

export interface LoginResult {
  token: string;
  expiresIn: number;
  user: AuthUser;
}

/** RFC 7807 problem+json-derived error (design §3.2), plus network failures. */
export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;

  constructor(input: { status: number; code: string; detail: string }) {
    super(input.detail);
    this.name = "AuthError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(["supervisor", "admin"]),
});

const loginSchema = z.object({
  token: z.string().min(1),
  expiresIn: z.number(),
  user: userSchema,
});

const problemSchema = z.object({
  status: z.number(),
  detail: z.string(),
  code: z.string(),
});

export function getStoredToken(): string | null {
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function clearStoredToken(): void {
  window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

/** Human-readable message for any thrown value (AuthError uses server detail). */
export function errorMessage(error: unknown): string {
  if (error instanceof AuthError) {
    return error.detail;
  }
  return "Ocurrió un error inesperado. Intente nuevamente.";
}

async function readErrorBody(response: Response): Promise<AuthError> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    if (parsed.success) {
      return new AuthError({
        status: parsed.data.status,
        code: parsed.data.code,
        detail: parsed.data.detail,
      });
    }
  } catch {
    // Non-JSON body: fall through to the generic problem below.
  }
  return new AuthError({
    status: response.status,
    code: "internal_error",
    detail: "El servidor devolvió una respuesta inesperada.",
  });
}

export async function login(email: string, password: string): Promise<LoginResult> {
  let response: Response;
  try {
    response = await fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new AuthError({
      status: 0,
      code: "network_error",
      detail: "No se pudo conectar con el servidor.",
    });
  }

  if (!response.ok) {
    throw await readErrorBody(response);
  }

  const parsed = loginSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AuthError({
      status: response.status,
      code: "internal_error",
      detail: "El servidor devolvió una respuesta inesperada.",
    });
  }

  window.sessionStorage.setItem(TOKEN_STORAGE_KEY, parsed.data.token);
  return parsed.data;
}

export async function fetchMe(token: string): Promise<AuthUser> {
  let response: Response;
  try {
    response = await fetch("/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new AuthError({
      status: 0,
      code: "network_error",
      detail: "No se pudo conectar con el servidor.",
    });
  }

  if (!response.ok) {
    throw await readErrorBody(response);
  }

  const parsed = userSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AuthError({
      status: response.status,
      code: "internal_error",
      detail: "El servidor devolvió una respuesta inesperada.",
    });
  }

  return parsed.data;
}
