import type { RetrievedChunk } from "@chatcap/shared-types";
import type { ChatMessage, ChatReply, OpenAiClient } from "@chatcap/llm-client";

import { UpstreamDependencyError } from "./errors";

/**
 * Generation (task 3.4, REQ-RAG-1): GPT-4o at temperature 0, grounded ONLY
 * in the retrieved chunk context. The prompt carries chunk content + source
 * metadata (REQ-RAG-3) and the fixed medication standard-refusal rule. The
 * temperature-0 policy is enforced by @chatcap/llm-client — this module
 * never overrides it.
 */

/** REQ-RAG-1/9: RAG-only system prompt with the medication refusal rule. */
export const RAG_SYSTEM_PROMPT = [
  "Eres un asistente de apoyo emocional. Responde ÚNICAMENTE con la",
  "información de los fragmentos de contexto que se te proporcionan.",
  "No uses conocimiento externo ni tu propia experiencia clínica.",
  "No brindes diagnósticos, no prescribas tratamientos y no indiques dosis ni",
  "medicamentos. Si te preguntan por medicación, responde con la negativa",
  "estándar: que no puedes recomendar dosis ni medicación.",
  "Cita la fuente de cada fragmento que uses.",
  "Si no hay información suficiente en los fragmentos, dilo explícitamente",
  "y sugiere consultar a un profesional de la salud.",
].join(" ");

/**
 * Builds the RAG-only prompt: system grounding instruction + a user message
 * that contains ONLY the chunk context (content + metadata) and the user's
 * question. Nothing else is injected — the model cannot reach beyond the
 * retrieved chunks (REQ-RAG-1).
 */
export function buildRagMessages(
  chunks: RetrievedChunk[],
  message: string
): ChatMessage[] {
  const context = chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] Fuente: ${chunk.source} | Categoría: ${chunk.category} | ${chunk.content}`
    )
    .join("\n");

  return [
    { role: "system", content: RAG_SYSTEM_PROMPT },
    { role: "user", content: `Fragmentos de contexto:\n${context}\n\nPregunta: ${message}` },
  ];
}

export interface GeneratedAnswer {
  content: string;
  /** Characters sent in the prompt, for dashboard cost tracing. */
  promptCharCount: number;
}

export interface GenerateDeps {
  client: Pick<OpenAiClient, "chat">;
}

export async function generateAnswer(
  deps: GenerateDeps,
  chunks: RetrievedChunk[],
  message: string
): Promise<GeneratedAnswer> {
  const messages = buildRagMessages(chunks, message);
  try {
    // No temperature override: llm-client enforces temperature 0 (REQ-RAG-1).
    const reply: ChatReply = await deps.client.chat(messages);
    const promptCharCount = messages.reduce(
      (sum, m) => sum + m.content.length,
      0
    );
    return { content: reply.content, promptCharCount };
  } catch (cause) {
    throw new UpstreamDependencyError(
      `grounded generation failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }
}
