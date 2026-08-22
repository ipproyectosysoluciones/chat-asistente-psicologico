import { describe, expect, test } from "vitest";

import {
  BLACKLIST_TERMS,
  DRUG_TERMS,
  DOSE_TERMS,
  scanGuardrail,
} from "../src/index";

describe("role-deviation guardrail (REQ-RAG-6)", () => {
  test("a safe answer passes with level none and no deviation terms", () => {
    const result = scanGuardrail(
      "Es normal sentirse ansioso. Te recomiendo hablar con un profesional."
    );
    expect(result.level).toBe("none");
    expect(result.deviationTerms).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  test("'diagnóstico' is orange-blocked", () => {
    const result = scanGuardrail("Mi diagnóstico es depresión.");
    expect(result.level).toBe("orange");
    expect(result.deviationTerms).toContain("diagnóstico");
    expect(result.blocked).toBe(true);
  });

  test("'receto' is orange-blocked", () => {
    const result = scanGuardrail("Te receto un ansiolítico.");
    expect(result.level).toBe("orange");
    expect(result.deviationTerms).toContain("receto");
    expect(result.blocked).toBe(true);
  });

  test("'padeces' is orange-blocked", () => {
    const result = scanGuardrail("Padeces un trastorno grave.");
    expect(result.level).toBe("orange");
    expect(result.deviationTerms).toContain("padeces");
    expect(result.blocked).toBe(true);
  });

  test("multiple deviation terms are all reported", () => {
    const result = scanGuardrail("Mi diagnóstico: padeces esquizofrenia, te receto clozapina.");
    expect(result.deviationTerms).toEqual(
      expect.arrayContaining(["diagnóstico", "padeces", "receto"])
    );
    expect(result.blocked).toBe(true);
  });

  test("case-insensitive matching", () => {
    const upper = scanGuardrail("RECETO medicación");
    expect(upper.level).toBe("orange");
    expect(upper.deviationTerms).toContain("receto");
  });

  test("word boundaries: 'recomiendo' must NOT trigger 'receto'", () => {
    const result = scanGuardrail("Te recomiendo buscar ayuda profesional.");
    expect(result.level).toBe("none");
    expect(result.deviationTerms).toEqual([]);
  });

  test("drug terms in the blacklist are blocked", () => {
    const result = scanGuardrail("El clonazepam ayuda con la ansiedad.");
    expect(result.level).toBe("orange");
    expect(result.blocked).toBe(true);
  });

  test("dose terms trigger the blacklist scan", () => {
    const result = scanGuardrail("Toma 5 mg de lorazepam cada 8 horas.");
    expect(result.level).toBe("orange");
    expect(result.blocked).toBe(true);
  });

  test("'mg' boundary: 'mg' inside a word is not a dose unit", () => {
    const result = scanGuardrail("El término 'imagen' aparece aquí.");
    expect(result.blocked).toBe(false);
  });

  test("blacklist constants are exported for content filtering before vectorization", () => {
    expect(BLACKLIST_TERMS.size).toBeGreaterThan(0);
    expect(DRUG_TERMS.size).toBeGreaterThan(0);
    expect(DOSE_TERMS.size).toBeGreaterThan(0);
  });

  test("an empty or whitespace answer is safe (nothing to block)", () => {
    expect(scanGuardrail("").level).toBe("none");
    expect(scanGuardrail("   ").level).toBe("none");
  });
});
