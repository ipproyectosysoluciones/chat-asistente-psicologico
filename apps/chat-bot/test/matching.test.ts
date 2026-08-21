import { describe, expect, it } from "vitest";

import {
  containsPhrase,
  hasPhrase,
  isAffirmation,
  isNegated,
  normalizeText,
} from "../src/flow/matching";

/**
 * Shared text matchers (task 4.4): extracted from the jurisdiction flow so
 * the consent flow reuses the SAME refusal/confirmation semantics — the
 * negation-wins rule must apply to consent acceptance too (REQ-CONSENT-2/3).
 */

describe("matching helpers (task 4.4)", () => {
  it("normalizes case, accents and surrounding whitespace", () => {
    expect(normalizeText("  Sí, CONFIRMO  ")).toBe("si, confirmo");
  });

  it("hasPhrase only matches on token boundaries", () => {
    expect(hasPhrase("sindrome de down", "si")).toBe(false);
    expect(hasPhrase("sí quiero", "si")).toBe(true);
    expect(hasPhrase("no sé dónde estoy", "no sé")).toBe(true);
  });

  it("isNegated catches explicit refusals that must win over affirmatives", () => {
    expect(isNegated("no acepto")).toBe(true);
    expect(isNegated("nop quiero")).toBe(true);
    expect(isNegated("tampoco quiero registrarme")).toBe(true);
    expect(isNegated("no")).toBe(true);
    expect(isNegated("sí, acepto")).toBe(false);
  });

  it("negation wins through punctuation — 'no, acepto' is a refusal, never consent", () => {
    expect(isNegated("no, acepto")).toBe(true);
    expect(isNegated("no. quiero")).toBe(true);
    expect(isNegated("no: prefiero no registrarme")).toBe(true);
    expect(isNegated("nop!")).toBe(true);
    expect(isNegated("tampoco, gracias")).toBe(true);
    expect(isNegated("no quiero")).toBe(true);
    expect(isNegated("acepto, no me arrepiento")).toBe(false);
  });

  it("isAffirmation matches any phrase token-boundary and defers to negation", () => {
    const phrases = ["si", "acepto", "de acuerdo"];
    expect(isAffirmation("sí, de acuerdo", phrases)).toBe(true);
    expect(isAffirmation("acepto", phrases)).toBe(true);
    expect(isAffirmation("no estoy de acuerdo", phrases)).toBe(false);
    expect(isAffirmation("no, de acuerdo", phrases)).toBe(false);
    expect(isAffirmation("no acepto", phrases)).toBe(false);
    expect(isAffirmation("sindrome", phrases)).toBe(false);
  });

  it("containsPhrase is a normalized substring check", () => {
    expect(containsPhrase("no sé qué decir", "no sé")).toBe(true);
    expect(containsPhrase("no se que decir", "no sé")).toBe(true);
    expect(containsPhrase("solo quiero conversar", "no sé")).toBe(false);
  });
});
