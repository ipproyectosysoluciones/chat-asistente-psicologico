/**
 * Transport abstraction for the OpenAI-compatible API (design §6.2).
 * The Provider layer stays swappable: `FetchOpenAiTransport` is the HTTP
 * implementation; tests inject doubles. The API key NEVER appears in URLs.
 */
export interface ChatTransport {
  /** POSTs a JSON body to a path under the configured base URL. */
  request<T>(url: string, body: unknown): Promise<T>;
}

export interface FetchTransportOptions {
  apiKey: string;
  baseUrl: string;
}

/** HTTP transport over global fetch (Node 18+ / undici). */
export class FetchOpenAiTransport implements ChatTransport {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: FetchTransportOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async request<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${url}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `OpenAI upstream error ${response.status}${detail ? `: ${detail}` : ""}`
      );
    }

    // Upstream JSON is unchecked at this boundary; callers own validation of
    // the specific response shape (parseChatContent/parseEmbedding etc.).
    return (await response.json()) as T;
  }
}
