import type { ResolvedEffect, ResolvedGenerator } from "@kynimo/engine";
import { describe, expect, it } from "vitest";
import {
  activeEffect,
  band,
  effectPadding,
  effectSamples,
  generatorSamples,
  smoothstep,
} from "./effects.js";

const black = { r: 0, g: 0, b: 0, a: 1 };

describe("looks in the effect tables", () => {
  const vignette = {
    type: "vignette",
    amount: 1,
    radius: 0.5,
    feather: 0.5,
    color: black,
  } as const;
  const scanlines = {
    type: "scanlines",
    amount: 1,
    spacing: 4,
    thickness: 0.5,
    offset: 0,
    color: black,
  } as const;

  it("is active only when it changes pixels", () => {
    expect(activeEffect(vignette)).toBe(true);
    expect(activeEffect({ ...vignette, amount: 0 })).toBe(false);
    expect(activeEffect({ ...vignette, color: { ...black, a: 0 } })).toBe(false);
    expect(
      activeEffect({ type: "grain", amount: 0, size: 1, seed: 0, frame: 0, monochrome: false }),
    ).toBe(false);
    expect(
      activeEffect({ type: "grain", amount: 0.1, size: 1, seed: 0, frame: 0, monochrome: false }),
    ).toBe(true);
    expect(activeEffect({ type: "chromatic-aberration", amount: 0 })).toBe(false);
    expect(activeEffect({ type: "chromatic-aberration", amount: 0.5 })).toBe(true);
    expect(activeEffect({ type: "posterize", levels: 2 })).toBe(true);
    expect(activeEffect(scanlines)).toBe(true);
    expect(activeEffect({ ...scanlines, thickness: 0 })).toBe(false);
    expect(activeEffect({ ...scanlines, amount: 0 })).toBe(false);
  });

  it("pads only for chromatic aberration, by the ceiling of its amount, summed with other reach", () => {
    const stack: ResolvedEffect[] = [
      vignette,
      { type: "chromatic-aberration", amount: 2.5 },
      { type: "gaussian-blur", radius: 4 },
      { type: "chromatic-aberration", amount: 0 },
    ];
    expect(effectPadding(stack)).toEqual([7, 7]);
    expect(effectPadding([{ type: "posterize", levels: 4 }, scanlines])).toEqual([0, 0]);
  });

  it("counts samples", () => {
    expect(effectSamples({ type: "chromatic-aberration", amount: 3 })).toBe(9);
    expect(effectSamples(vignette)).toBe(1);
    expect(effectSamples({ type: "posterize", levels: 3 })).toBe(1);
  });
});

describe("generatorSamples", () => {
  const stops = [
    { offset: 0, color: black },
    { offset: 1, color: black },
  ];
  it("charges per kind", () => {
    const gradient: ResolvedGenerator = {
      type: "gradient",
      kind: "linear",
      start: [0, 0],
      end: [1, 0],
      stops,
    };
    expect(generatorSamples(gradient)).toBe(1);
    expect(
      generatorSamples({
        type: "pattern",
        kind: "dots",
        size: 4,
        thickness: 0.5,
        rotation: [1, 0],
        offset: [0, 0],
        foreground: black,
        background: black,
      }),
    ).toBe(1);
    expect(
      generatorSamples({ type: "aurora", colors: [black, black, black], points: [], sigma: 1 }),
    ).toBe(3);
    expect(
      generatorSamples({
        type: "noise",
        seed: 0,
        scale: 8,
        octaves: 6,
        evolution: 0,
        offset: [0, 0],
        low: black,
        high: black,
      }),
    ).toBe(48);
  });
});

describe("band", () => {
  it("is full at the center, half at the edge and fades thin lines", () => {
    expect(band(0, 2, 10)).toBe(1);
    expect(band(2, 2, 10)).toBeCloseTo(0.5);
    expect(band(2.5, 2, 10)).toBeCloseTo(0);
    expect(band(0, 0.25, 10)).toBeCloseTo(0.5); // a half-pixel line covers half a pixel
    expect(band(10, 0.25, 10)).toBeCloseTo(0.5);
    expect(band(-10.5, 0.25, 10)).toBeCloseTo(0.25);
  });

  it("covers every pixel when the band fills the period", () => {
    for (let x = -30; x <= 30; x += 0.37) expect(band(x, 5, 10)).toBeCloseTo(1);
  });

  it("merges neighboring bands that overlap one pixel's box", () => {
    // Period 2, half width 0.5: bands touch, so the whole line is covered.
    for (let x = -4; x <= 4; x += 0.25) expect(band(x, 1, 2)).toBeCloseTo(1);
  });
});

describe("smoothstep", () => {
  it("is the GLSL cubic", () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0.2, 0.4, 0.3)).toBeCloseTo(0.5);
    expect(smoothstep(0, 1, 2)).toBe(1);
  });
});
