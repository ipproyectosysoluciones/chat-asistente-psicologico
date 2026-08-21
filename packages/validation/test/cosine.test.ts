import { describe, expect, test } from "vitest";

import { cosineSimilarity } from "../src/index";

describe("cosineSimilarity", () => {
  test("orthogonal vectors have cosine 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  test("identical vectors have cosine exactly 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBe(1);
  });

  test("golden: cos([3,4],[4,3]) = 24/25 = 0.96", () => {
    expect(cosineSimilarity([3, 4], [4, 3])).toBeCloseTo(0.96, 10);
  });

  test("golden: cos([1,1],[1,0]) = 1/sqrt(2)", () => {
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2, 10);
  });

  test("golden: cos([2,0,2],[2,2,0]) = 4/8 = 0.5", () => {
    expect(cosineSimilarity([2, 0, 2], [2, 2, 0])).toBeCloseTo(0.5, 10);
  });

  test("golden: cos([1,2,2],[2,2,1]) = 8/9", () => {
    expect(cosineSimilarity([1, 2, 2], [2, 2, 1])).toBeCloseTo(8 / 9, 10);
  });

  test("the answer with itself is 1 regardless of scale (unit invariant)", () => {
    expect(cosineSimilarity([5, 10], [1, 2])).toBeCloseTo(1, 10);
  });

  test("a zero vector is not a valid embedding (throws)", () => {
    expect(() => cosineSimilarity([0, 0], [1, 1])).toThrow();
    expect(() => cosineSimilarity([1, 1], [0, 0])).toThrow();
  });

  test("mismatched dimensions throw instead of computing garbage", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
    expect(() => cosineSimilarity([], [])).toThrow();
  });

  test("empty vs non-empty throws", () => {
    expect(() => cosineSimilarity([], [1])).toThrow();
  });
});
