import { type Affine, transformMatrix } from "@kynimo/engine";
import { describe, expect, it } from "vitest";
import { apply, decompose, isSimilarity, type Matrix, multiply, parseTransform } from "./affine.js";

const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => {
  expect(a).toHaveLength(b.length);
  a.forEach((v, i) => {
    expect(Math.abs(v - (b[i] ?? 0))).toBeLessThan(eps);
  });
};

describe("parseTransform", () => {
  it("parses each function", () => {
    expect(parseTransform("translate(10 20)")).toEqual([1, 0, 0, 1, 10, 20]);
    expect(parseTransform("translate(10)")).toEqual([1, 0, 0, 1, 10, 0]);
    expect(parseTransform("scale(2)")).toEqual([2, 0, 0, 2, 0, 0]);
    expect(parseTransform("scale(2, 3)")).toEqual([2, 0, 0, 3, 0, 0]);
    expect(parseTransform("matrix(1 2 3 4 5 6)")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseTransform("rotate(90)")).toEqual([0, 1, -1, 0, 0, 0]);
    close(parseTransform("skewX(45)") ?? [], [1, 0, 1, 1, 0, 0]);
    close(parseTransform("skewY(45)") ?? [], [1, 1, 0, 1, 0, 0]);
  });

  it("rotates about a point", () => {
    const m = parseTransform("rotate(90, 10, 10)") as Matrix;
    close(apply(m, [10, 10]), [10, 10]);
    close(apply(m, [20, 10]), [10, 20]);
  });

  it("composes left to right, first listed outermost", () => {
    const m = parseTransform("translate(10,0) scale(2)") as Matrix;
    close(apply(m, [1, 1]), [12, 2]);
    close(parseTransform("translate(10 0),scale(2)") ?? [], m);
  });

  it("rejects invalid lists", () => {
    expect(parseTransform("translate(")).toBeUndefined();
    expect(parseTransform("foo(1)")).toBeUndefined();
    expect(parseTransform("matrix(1 2 3)")).toBeUndefined();
    expect(parseTransform("scale(1) garbage")).toBeUndefined();
  });

  it("treats an empty list as identity", () => {
    expect(parseTransform("  ")).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe("decompose", () => {
  const cases: [string, Matrix][] = [
    ["identity", [1, 0, 0, 1, 0, 0]],
    ["translate", [1, 0, 0, 1, 12.5, -7]],
    ["rotate", [Math.cos(0.7), Math.sin(0.7), -Math.sin(0.7), Math.cos(0.7), 3, 4]],
    ["non-uniform scale", [2, 0, 0, 0.5, 1, 1]],
    ["negative determinant (flip y)", [1, 0, 0, -1, 0, 10]],
    ["negative determinant (flip x)", [-1, 0, 0, 1, 10, 0]],
    ["rotate and flip", multiply(parseTransform("rotate(33)") as Matrix, [1, 0, 0, -2, 0, 0])],
    ["skewX 30", parseTransform("skewX(30) translate(5 5)") as Matrix],
    [
      "skewX -50 with scale",
      parseTransform("translate(3 9) rotate(20) skewX(-50) scale(2 3)") as Matrix,
    ],
    ["skewY", parseTransform("skewY(40)") as Matrix],
    ["arbitrary matrix", [1.3, 0.4, -0.9, 2.1, 17, -3]],
    ["half turn", parseTransform("rotate(180)") as Matrix],
  ];

  it.each(cases)("recomposes %s with the engine's transform matrix", (_name, m) => {
    const d = decompose(m);
    expect(d).not.toBeNull();
    if (d === null) return;
    expect(Math.abs(d.skew)).toBeLessThanOrEqual(85);
    const back: Affine = transformMatrix({
      anchorPoint: [0, 0],
      position: d.position,
      scale: d.scale,
      rotation: d.rotation,
      skew: d.skew,
    });
    close(back, m);
  });

  it("returns null for singular matrices", () => {
    expect(decompose([0, 0, 0, 1, 0, 0])).toBeNull();
    expect(decompose([1, 0, 2, 0, 0, 0])).toBeNull();
    expect(decompose([1, 2, 2, 4, 0, 0])).toBeNull();
  });

  it("returns null when the skew would exceed 85 degrees", () => {
    expect(decompose(parseTransform("skewX(89)") as Matrix)).toBeNull();
    expect(decompose(parseTransform("skewX(80)") as Matrix)).not.toBeNull();
  });
});

describe("isSimilarity", () => {
  it("accepts rotation, uniform scale and flips; rejects stretch and shear", () => {
    expect(isSimilarity([2, 0, 0, 2, 0, 0])).toBe(true);
    expect(isSimilarity(parseTransform("rotate(30) scale(3)") as Matrix)).toBe(true);
    expect(isSimilarity([1, 0, 0, -1, 0, 0])).toBe(true);
    expect(isSimilarity([2, 0, 0, 1, 0, 0])).toBe(false);
    expect(isSimilarity(parseTransform("skewX(30)") as Matrix)).toBe(false);
  });
});
