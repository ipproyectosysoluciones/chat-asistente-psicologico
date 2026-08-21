import { describe, expect, it } from "vitest";

import { filterBlacklist } from "../src/blacklist";

describe("filterBlacklist", () => {
  it("removes blacklisted terms case-insensitively", () => {
    // "dosis" and "mg" are representative terms present in the validation set.
    const text = "La dosis recomendada es 5 mg al día.";
    const result = filterBlacklist(text);
    expect(result.blacklisted).toBe(true);
    // Original text must not appear verbatim in the allowed output.
    expect(result.allowed).not.toContain("dosis");
    expect(result.allowed.toLowerCase()).not.toContain("dosis");
  });

  it("reports each matched term once per occurrence", () => {
    const text = "dosis y DOSIS y Dosis";
    const result = filterBlacklist(text);
    expect(result.hits.length).toBe(3);
    expect(result.blacklisted).toBe(true);
  });

  it("does not match substrings (word-boundary aware)", () => {
    // "image" must NOT be flagged merely because "mg" is blacklisted, and
    // "dosis" must not match inside a longer token like "dosisificacion".
    const text = "image; dosisificacion";
    const result = filterBlacklist(text);
    expect(result.blacklisted).toBe(false);
    expect(result.hits).toHaveLength(0);
    expect(result.allowed).toBe(text.trim());
  });

  it("collapses whitespace around redacted spans", () => {
    const text = "a dosis b";
    const result = filterBlacklist(text);
    // "dosis" replaced by a single space, then collapsed.
    expect(result.allowed).toBe("a b");
  });

  it("leaves clean text untouched", () => {
    const text = "Hola, este es un texto limpio y seguro.";
    const result = filterBlacklist(text);
    expect(result.blacklisted).toBe(false);
    expect(result.allowed).toBe(text.trim());
    expect(result.hits).toHaveLength(0);
  });

  it("returns allowed text with all blacklisted spans removed", () => {
    const text = "Consulta: dosis 10mg. Recomendación de posología.";
    const result = filterBlacklist(text);
    expect(result.allowed.toLowerCase()).not.toContain("dosis");
    expect(result.allowed.toLowerCase()).not.toContain("posología");
  });
});
