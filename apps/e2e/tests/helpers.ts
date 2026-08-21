import type { Socket } from "socket.io-client";

/**
 * Shared e2e helpers.
 *
 * Everything is driven by environment variables with localhost defaults so the
 * same suite runs against the compose stack (Phase 7.3) or a remote deploy.
 * No absolute paths, no hardcoded secrets — the internal token is read from the
 * environment (it must match the compose `X_INTERNAL_TOKENS` value).
 */

export const SERVICE_URLS = {
  dashboard: process.env.DASHBOARD_URL ?? "http://localhost:3000",
  chatbot: process.env.CHATBOT_URL ?? "http://localhost:4001",
  notifications: process.env.NOTIFICATIONS_URL ?? "http://localhost:4002",
  airag: process.env.AI_RAG_URL ?? "http://localhost:4003",
  ingestion: process.env.INGESTION_URL ?? "http://localhost:4004",
} as const;

/** Internal service token for the `/internal/*` endpoints (design §8.3).
 * Must be provided via env (AI_RAG_INTERNAL_TOKEN / X_INTERNAL_TOKENS); fails loudly if absent. */
const INTERNAL_TOKEN_ENV = process.env.AI_RAG_INTERNAL_TOKEN ?? process.env.X_INTERNAL_TOKENS;
if (!INTERNAL_TOKEN_ENV) {
  throw new Error(
    "INTERNAL_TOKEN is required for e2e: set AI_RAG_INTERNAL_TOKEN or X_INTERNAL_TOKENS"
  );
}
export const INTERNAL_TOKEN = INTERNAL_TOKEN_ENV;

export const HEALTHZ_PATH = "/healthz";

export interface HealthSummary {
  service: keyof typeof SERVICE_URLS;
  url: string;
  ok: boolean;
}

export async function waitForHealth(
  url: string,
  timeoutMs = 90_000,
  intervalMs = 2_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** True when every core service answers its /healthz (used to gate live tests). */
export async function isStackUp(): Promise<boolean> {
  const results = await Promise.all(
    (Object.keys(SERVICE_URLS) as (keyof typeof SERVICE_URLS)[]).map(
      async (service): Promise<HealthSummary> => {
        const url = `${SERVICE_URLS[service]}${HEALTHZ_PATH}`;
        const ok = await waitForHealth(url, 5_000);
        return { service, url, ok };
      }
    )
  );
  results.forEach((r) =>
    console.log(`[e2e:helpers] ${r.service} ${r.ok ? "UP" : "DOWN"} (${r.url})`)
  );
  return results.every((r) => r.ok);
}

export interface JsonOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  /** Expected success status; throws otherwise. Defaults to 2xx. */
  expectStatus?: number;
}

export async function fetchJson<T = unknown>(
  url: string,
  options: JsonOptions = {}
): Promise<T> {
  const { method = "GET", body, headers = {}, expectStatus } = options;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);

  if (expectStatus !== undefined) {
    if (res.status !== expectStatus) {
      throw new Error(
        `fetchJson ${method} ${url} expected ${expectStatus} but got ${res.status}: ${text}`
      );
    }
  } else if (res.status < 200 || res.status >= 300) {
    throw new Error(`fetchJson ${method} ${url} failed with ${res.status}: ${text}`);
  }

  return parsed;
}

/**
 * Call ai-rag `POST /internal/rag/process` with the internal token.
 * Mirrors exactly what the chat-bot does at runtime (design §8.3).
 */
export async function processWithRag(
  sessionId: string,
  message: string
): Promise<unknown> {
  return fetchJson(
    `${SERVICE_URLS.airag}/internal/rag/process`,
    {
      method: "POST",
      headers: { "x-internal-token": INTERNAL_TOKEN },
      body: { sessionId, message },
      expectStatus: 200,
    }
  );
}

/**
 * Connect to the dashboard Socket.io surface (the dashboard broadcasts via
 * `io?.emit(event, payload)`). No auth middleware is wired on the dashboard
 * socket, so a bare connection is enough to observe emitted events.
 */
export async function connectDashboardSocket(
  path = "/"
): Promise<Socket> {
  const { io } = await import("socket.io-client");
  const socket = io(`${SERVICE_URLS.dashboard}${path}`, {
    transports: ["websocket", "polling"],
    reconnection: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", (err: Error) => reject(err));
  });
  return socket;
}
