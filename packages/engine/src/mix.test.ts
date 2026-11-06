import { describe, expect, it } from "vitest";
import { mixColor, parseColor } from "./color.js";
import { lerp, lerpVector } from "./mix.js";

describe("lerp", () => {
  it("is exact at both ends and for equal values", () => {
    expect(lerp(0.1, 0.7, 0)).toBe(0.1);
    expect(lerp(0.1, 0.7, 1)).toBe(0.7);
    for (const p of [0.13, 0.5, 0.77]) expect(lerp(0.3, 0.3, p)).toBe(0.3);
  });

  it("extrapolates on overshoot", () => {
    expect(lerp(0, 10, 1.2)).toBeCloseTo(12, 12);
    expect(lerp(0, 10, -0.1)).toBeCloseTo(-1, 12);
  });
});

describe("lerpVector", () => {
  it("mixes any dimension component-wise", () => {
    expect(lerpVector([0, 10] as const, [10, 20] as const, 0.5)).toEqual([5, 15]);
    expect(lerpVector([0, 0, 0], [2, 4, 6], 0.5)).toEqual([1, 2, 3]);
  });

  it("rejects mismatched dimensions", () => {
    expect(() => lerpVector([0, 0], [1, 1, 1], 0.5)).toThrow(RangeError);
  });
});

describe("parseColor", () => {
  it("reads #rrggbb and #rrggbbaa", () => {
    expect(parseColor("#ff8000")).toEqual({ r: 1, g: 128 / 255, b: 0, a: 1 });
    expect(parseColor("#00000080").a).toBeCloseTo(128 / 255, 12);
  });
});

describe("mixColor", () => {
  const white = parseColor("#ffffff");
  const black = parseColor("#000000");
  const red = parseColor("#ff0000");
  const blue = parseColor("#0000ff");

  it("returns the exact endpoints", () => {
    expect(mixColor(red, blue, 0)).toBe(red);
    expect(mixColor(red, blue, 1)).toBe(blue);
  });

  it("is perceptual: the white/black midpoint is OKLab L = 0.5, not sRGB 0.5", () => {
    const mid = mixColor(white, black, 0.5);
    // OKLab L 0.5 → linear 0.125 → sRGB ≈ 0.3885 (gamma sRGB mixing would give 0.5).
    expect(mid.r).toBeCloseTo(0.3885, 3);
    expect(mid.g).toBeCloseTo(mid.r, 6);
    expect(mid.b).toBeCloseTo(mid.r, 6);
  });

  it("round-trips a color through OKLab when both ends are equal", () => {
    const c = parseColor("#3a7bd5");
    const mid = mixColor(c, c, 0.4);
    expect(mid.r).toBeCloseTo(c.r, 6);
    expect(mid.g).toBeCloseTo(c.g, 6);
    expect(mid.b).toBeCloseTo(c.b, 6);
  });

  it("fades from transparent without darkening (premultiplied alpha)", () => {
    const mid = mixColor(parseColor("#00000000"), red, 0.5);
    expect(mid.a).toBeCloseTo(0.5, 12);
    expect(mid.r).toBeCloseTo(1, 6);
    expect(mid.g).toBeCloseTo(0, 6);
    expect(mid.b).toBeCloseTo(0, 6);
  });

  it("clips overshoot to the sRGB gamut and alpha to 0..1", () => {
    for (const p of [-0.5, 1.5]) {
      const c = mixColor(red, blue, p);
      for (const ch of [c.r, c.g, c.b, c.a]) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
    }
    expect(mixColor(parseColor("#ff000080"), red, 3).a).toBe(1);
    expect(mixColor(red, parseColor("#ff000000"), 2)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});
