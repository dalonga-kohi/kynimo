import { describe, expect, it } from "vitest";
import { cubicPath } from "./path.js";

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((x, i) => x - (b[i] as number)));

// Standard cubic approximation of a quarter circle of radius r.
const K = 0.5522847498;
const quarterCircle = (r: number) =>
  cubicPath([r, 0] as const, [r, r * K] as const, [r * K, r] as const, [0, r] as const);

describe("cubicPath", () => {
  it("returns the exact end points", () => {
    const path = quarterCircle(100);
    expect(path.at(0)).toEqual([100, 0]);
    expect(path.at(1)).toEqual([0, 100]);
  });

  it("measures arc length", () => {
    expect(quarterCircle(100).length).toBeCloseTo((Math.PI / 2) * 100, 1);
  });

  it("moves at constant speed in p, regardless of how the handles bunch up", () => {
    const path = quarterCircle(100);
    const steps = Array.from({ length: 21 }, (_, i) => path.at(i / 20));
    const gaps = steps.slice(1).map((pt, i) => dist(pt, steps[i] as readonly number[]));
    for (const gap of gaps) expect(gap).toBeCloseTo(path.length / 20, 1);

    // Control points bunched near the end: raw bezier t = 0.5 would land at x = 83.75.
    const lopsided = cubicPath([0, 0], [90, 0], [100, 0], [100, 0]);
    expect(lopsided.at(0.5)[0]).toBeCloseTo(50, 2);
  });

  it("works in 3D", () => {
    const path = cubicPath([0, 0, 0], [0, 0, 10], [0, 0, 20], [0, 0, 30]);
    expect(path.length).toBeCloseTo(30, 9);
    const mid = path.at(0.5);
    expect(mid[2]).toBeCloseTo(15, 6);
  });

  it("continues along the end tangents when progress overshoots", () => {
    const path = quarterCircle(100);
    const after = path.at(1.1);
    expect(after[0]).toBeCloseTo(-0.1 * path.length, 6);
    expect(after[1]).toBeCloseTo(100, 6);
    const before = path.at(-0.1);
    expect(before[0]).toBeCloseTo(100, 6);
    expect(before[1]).toBeCloseTo(-0.1 * path.length, 6);
  });

  it("stays put on a zero-length path", () => {
    const path = cubicPath([5, 5], [5, 5], [5, 5], [5, 5]);
    expect(path.length).toBe(0);
    expect(path.at(0.5)).toEqual([5, 5]);
    expect(path.at(1.5)).toEqual([5, 5]);
  });

  it("rejects mixed dimensions", () => {
    expect(() => cubicPath([0, 0], [0, 0, 0], [0, 0], [0, 0])).toThrow(RangeError);
  });
});

describe("parameterAt", () => {
  it("is the bezier parameter of the point at(p) returns", () => {
    const path = quarterCircle(100);
    for (const p of [0.1, 0.37, 0.5, 0.9]) {
      const t = path.parameterAt(p);
      const u = 1 - t;
      // The cubic through quarterCircle's control points.
      const x = u ** 3 * 100 + 3 * u * u * t * 100 + 3 * u * t * t * (100 * K) + 0;
      const y = 3 * u * u * t * (100 * K) + 3 * u * t * t * 100 + t ** 3 * 100;
      const at = path.at(p);
      expect(at[0]).toBeCloseTo(x, 6);
      expect(at[1]).toBeCloseTo(y, 6);
    }
  });

  it("clamps to the ends", () => {
    const path = quarterCircle(100);
    expect(path.parameterAt(-1)).toBe(0);
    expect(path.parameterAt(0)).toBe(0);
    expect(path.parameterAt(1)).toBe(1);
    expect(path.parameterAt(2)).toBe(1);
  });
});
