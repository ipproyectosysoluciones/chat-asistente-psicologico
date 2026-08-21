import type { OpenAiClient } from "@chatcap/llm-client";

/**
 * Embeds each chunk individually (task 6.3, REQ-INGEST-2). The llm-client
 * exposes `embed(string): Promise<number[]>` (single input), so we fan out
 * with `Promise.all` — one per chunk. Concurrency is bounded by the caller
 * (the router passes a small chunk count), so no semaphore is needed yet.
 */

export async function embedMany(
  client: OpenAiClient,
  chunks: readonly string[]
): Promise<number[][]> {
  return Promise.all(chunks.map((chunk) => client.embed(chunk)));
}
