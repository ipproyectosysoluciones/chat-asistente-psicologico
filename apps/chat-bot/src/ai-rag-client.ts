import type { RagTrace } from "@chatcap/shared-types";

/**
 * Internal HTTP client for the ai-rag service (task 4.1, REQ-CHATBOT-2/7).
 * The chat-bot authenticates with `x-internal-token` (the token is
 * cross-checked against X_INTERNAL_TOKENS at config time). The wire contract
 * mirrors apps/ai-rag POST /internal/rag/process: the response is a
 * discriminated union the bot maps to chat actions. Structural typing keeps
 * the client decoupled from the ai-rag package.
 */

export type RagOutcome =
  | { kind: "emitted"; answer: string; trace: RagTrace }
  | { kind: "flagged"; answer: string; fallbackText: string; trace: RagTrace }
  | { kind: "blocked"; fallbackText: string; trace: RagTrace }
  | { kind: "crisis"; fallbackText: string; trace: RagTrace };

/** Thrown when ai-rag is degraded/unreachable (maps to retry, not a bug). */
export class RagUpstreamError extends Error {
  readonly code = "RAG_UPSTREAM_ERROR" as const;
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RagUpstreamError";
    this.status = status;
  }
}

export interface AiRagClientOptions {
  baseUrl: string;
  internalToken: string;
  fetchImpl?: typeof fetch;
}

export interface AiRagClient {
  process(input: { sessionId: string; message: string }): Promise<RagOutcome>;
  health(): Promise<boolean>;
}

export class HttpAiRagClient implements AiRagClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AiRagClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async process(input: {
    sessionId: string;
    message: string;
  }): Promise<RagOutcome> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/internal/rag/process`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": this.options.internalToken,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      throw new RagUpstreamError(
        `ai-rag process failed: HTTP ${response.status}`,
        response.status
      );
    }
    // safe: the response body is the mirrored discriminated union from
    // apps/ai-rag (POST /internal/rag/process wire contract, REQ-CHATBOT-2/7);
    // the flow layer treats it structurally and unknown kinds are never
    // emitted to users, so a malformed payload cannot reach chat output.
    return (await response.json()) as RagOutcome;
  }

  async health(): Promise<boolean> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/healthz`;
    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
