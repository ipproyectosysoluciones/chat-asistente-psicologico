import { describe, expect, test, vi } from "vitest";

import type { ChatMessage } from "@chatcap/llm-client";
import type { RetrievedChunk } from "@chatcap/shared-types";

import {
  buildRagMessages,
  generateAnswer,
  RAG_SYSTEM_PROMPT,
} from "../src/generate";
import { UpstreamDependencyError } from "../src/errors";

/**
 * Generation (task 3.4, REQ-RAG-1): GPT-4o at temperature 0, prompted with
 * ONLY the retrieved chunk context (no free knowledge). The system prompt
 * carries the medication standard-refusal instruction; the fixed refusal
 * text lives in safety-text.ts for the blocked path.
 */

const chunks: RetrievedChunk[] = [
  {
    chunkId: "chunk-1",
    docId: "doc-1",
    chunkIndex: 0,
    content: "La respiración diafragmática reduce la activación fisiológica.",
    category: "técnicas",
    source: "manual-bienestar.pdf",
    language: "es",
    legalFramework: "ar_2024",
    score: 0.91,
  },
];

describe("RAG_SYSTEM_PROMPT (medication standard-refusal path)", () => {
  test("forbids diagnosis, prescription and medication guidance", () => {
    const prompt = RAG_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain("diagnóstic");
    expect(prompt).toContain("no prescrib");
    expect(prompt).toContain("medicament");
    expect(prompt).not.toMatch(/receto|recetar/);
  });

  test("requires grounding: answer only from the provided chunks", () => {
    const prompt = RAG_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain("fragmento");
  });
});

describe("buildRagMessages (prompt contains only chunk context)", () => {
  test("builds system + user messages with only chunk context and the question", () => {
    const messages = buildRagMessages(chunks, "¿Cómo calmo la ansiedad?");

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");

    const user = messages[1]?.content ?? "";
    // Every chunk's content is in the context.
    expect(user).toContain("La respiración diafragmática");
    // Chunk metadata is attached so the model can cite the source.
    expect(user).toContain("manual-bienestar.pdf");
    expect(user).toContain("técnicas");
    // The original question is the final instruction.
    expect(user).toContain("¿Cómo calmo la ansiedad?");
  });

  test("does not inject any content outside the chunks and the question", () => {
    const user = buildRagMessages(chunks, "hola")[1]?.content ?? "";
    // Nothing beyond chunk context + question: assert no free-text filler.
    const chunkContent = chunks[0]?.content ?? "";
    const question = "hola";
    expect(user).toContain(chunkContent);
    expect(user).toContain(question);
    // Strip chunk content, question and structural scaffold (labels +
    // separators); what remains must be empty — no injected knowledge.
    const remaining = user
      .replace(chunkContent, "")
      .replace(question, "")
      .replace(
        /Fragmentos de contexto|Fuente|Categoría|Pregunta|manual-bienestar\.pdf|técnicas|ar_2024|[#:\[\]|0-9\s\n]/g,
        ""
      );
    expect(remaining).toBe("");
  });

  test("returns an empty context (no chunks) and still carries the question", () => {
    const messages = buildRagMessages([], "hola");
    const user = messages[1]?.content ?? "";
    expect(user).toContain("hola");
  });
});

describe("generateAnswer", () => {
  test("calls chat with the RAG-only messages at temperature 0 (no override)", async () => {
    const chat = vi.fn(
      async (_messages: ChatMessage[]) => ({ content: "respuesta segura" })
    );
    const result = await generateAnswer(
      { client: { chat } },
      chunks,
      "¿Cómo calmo la ansiedad?"
    );

    expect(chat).toHaveBeenCalledTimes(1);
    const call = chat.mock.calls[0] ?? [];
    // chat() receives exactly ONE argument — no temperature override, so the
    // llm-client enforces temp 0 (REQ-RAG-1).
    expect(call).toHaveLength(1);
    const [messages] = call;
    expect(messages).toHaveLength(2);
    expect(result.content).toBe("respuesta segura");
  });

  test("reports promptCharCount for cost tracing", async () => {
    const chat = vi.fn(
      async (_messages: ChatMessage[]) => ({ content: "respuesta" })
    );
    const result = await generateAnswer(
      { client: { chat } },
      chunks,
      "pregunta"
    );

    const messages = chat.mock.calls[0]?.[0] ?? [];
    const expectedChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    expect(result.promptCharCount).toBe(expectedChars);
  });

  test("wraps upstream failures in UpstreamDependencyError", async () => {
    const chat = vi.fn(async () => {
      throw new Error("chat completion 500");
    });

    await expect(
      generateAnswer({ client: { chat } }, chunks, "pregunta")
    ).rejects.toThrow(UpstreamDependencyError);
  });
});
