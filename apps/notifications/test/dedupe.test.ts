import { describe, expect, it } from "vitest";

import { buildDedupeKey } from "../src/dedupe";

/**
 * Dedupe key derivation (REQ-ALERT-5): identical alerts — same level,
 * session, category and keyword — MUST collapse to the same key so the
 * one-open-alert semantics hold across Redis/pub-sub and PostgreSQL.
 */

describe("buildDedupeKey", () => {
  const base = { level: "red" as const, sessionId: "sess-1", category: "suicide" };

  it("returns a deterministic 64-char hex digest", () => {
    const key = buildDedupeKey({ ...base, keyword: "quiero morir" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls for identical inputs", () => {
    expect(buildDedupeKey({ ...base, keyword: "quiero morir" })).toBe(
      buildDedupeKey({ ...base, keyword: "quiero morir" })
    );
  });

  it("separates different levels for the same session/category", () => {
    expect(buildDedupeKey({ ...base, level: "red" })).not.toBe(
      buildDedupeKey({ ...base, level: "orange" })
    );
  });

  it("separates different categories for the same session/level", () => {
    expect(buildDedupeKey({ ...base, category: "suicide" })).not.toBe(
      buildDedupeKey({ ...base, category: "self_harm" })
    );
  });

  it("separates different keywords", () => {
    expect(buildDedupeKey({ ...base, keyword: "quiero morir" })).not.toBe(
      buildDedupeKey({ ...base, keyword: "no quiero vivir" })
    );
  });

  it("normalizes absent keyword and empty keyword to the same key", () => {
    expect(buildDedupeKey(base)).toBe(buildDedupeKey({ ...base, keyword: "" }));
  });
});
