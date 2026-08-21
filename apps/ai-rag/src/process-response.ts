import type { RagTrace } from "@chatcap/shared-types";

/**
 * HTTP outcome of POST /internal/rag/process (task 3.1). Four discriminated
 * kinds — the chat-bot maps each to a chat action:
 * - `emitted`: answer passed the coherence gate and was emitted.
 * - `flagged`: grounded answer, but yellow-flagged (needs supervisor review).
 * - `blocked`: role-deviation / low-coherence; send the safe fallback text.
 * - `crisis`: vital risk; send crisis lines and the red-alert path takes over.
 * Every kind carries the full RAG trace for the supervisor dashboard.
 */

export type RagProcessResponse =
  | { kind: "emitted"; answer: string; trace: RagTrace }
  | { kind: "flagged"; answer: string; fallbackText: string; trace: RagTrace }
  | { kind: "blocked"; fallbackText: string; trace: RagTrace }
  | { kind: "crisis"; fallbackText: string; trace: RagTrace };
