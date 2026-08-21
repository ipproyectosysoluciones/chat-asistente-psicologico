import { z } from "zod";

/**
 * Internal process contract (task 3.1): the chat-bot calls
 * POST /internal/rag/process with `{ sessionId, message }`. The zod schema is
 * the single validation point so a malformed body never reaches the pipeline.
 * `message` cap of 4000 chars bounds prompt size and cost.
 */

export const ragProcessRequestSchema = z.object({
  sessionId: z.string().min(1).max(128),
  message: z.string().min(1).max(4000),
});

export type RagProcessRequest = z.infer<typeof ragProcessRequestSchema>;

/** Returns `undefined` when the payload is not a valid process request. */
export function parseRagProcessRequest(
  payload: unknown
): RagProcessRequest | undefined {
  const parsed = ragProcessRequestSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}
