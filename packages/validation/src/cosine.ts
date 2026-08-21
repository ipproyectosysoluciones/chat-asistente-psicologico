/**
 * Cosine similarity between two embedding vectors (REQ-RAG-4 gate input).
 * Returns 0..1 (embeddings are non-negative); throws on malformed input so
 * the gate never silently computes on garbage.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    throw new Error("Cosine similarity requires non-empty vectors");
  }
  if (a.length !== b.length) {
    throw new Error(
      `Cosine similarity dimension mismatch: ${a.length} vs ${b.length}`
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA === 0 || normB === 0) {
    throw new Error("Cosine similarity requires non-zero vectors");
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
