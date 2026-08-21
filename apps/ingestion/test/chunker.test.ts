import { describe, expect, it } from "vitest";

import { chunkText } from "../src/chunker";

describe("chunkText", () => {
  it("returns a single chunk when text fits within max", () => {
    const text = "a".repeat(100);
    const chunks = chunkText(text, 800, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("splits long text at sentence boundaries within the window", () => {
    // Two sentences each ~450 chars; a third pushes past 800 -> must split.
    const sentence = "This is a sentence. ".repeat(25); // 450 chars-ish
    const text = [sentence, sentence, sentence].join(" ");
    const chunks = chunkText(text, 800, 500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk (except possibly the last) must be <= max.
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.length).toBeLessThanOrEqual(800);
    }
  });

  it("falls back to hard cut when no sentence boundary exists in the window", () => {
    // Run-on text with no sentence punctuation at all.
    const text = "word ".repeat(1000); // ~5000 chars, no punctuation
    const chunks = chunkText(text, 800, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.length).toBeLessThanOrEqual(800);
    }
  });

  it("never produces a chunk smaller than the minimum unless it is the last", () => {
    const text = "a".repeat(2000);
    const chunks = chunkText(text, 800, 500);
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.length).toBeGreaterThanOrEqual(500);
    }
  });

  it("preserves all characters across chunks", () => {
    const text = "The quick brown fox. ".repeat(80);
    const chunks = chunkText(text, 800, 500);
    const joined = chunks.join("");
    expect(joined.length).toBe(text.length);
    // Reassembly must equal the original (no whitespace normalization in chunker).
    expect(joined).toBe(text);
  });
});
