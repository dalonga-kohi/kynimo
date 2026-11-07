import { BLEND_MODES, type BlendMode } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { blendColor, blendPixel, NON_SEPARABLE, SEPARABLE } from "./blend.js";

const one = (mode: BlendMode, b: number, s: number) => blendColor(mode, [b, b, b], [s, s, s])[0];

describe("blend formulas", () => {
  it("defines every blend mode of the schema exactly once", () => {
    const defined = [...Object.keys(SEPARABLE), ...Object.keys(NON_SEPARABLE)].sort();
    expect(defined).toEqual([...BLEND_MODES].sort());
  });

  it.each([
    // mode, backdrop, source, expected (hand-computed)
    ["normal", 0.2, 0.6, 0.6],
    ["multiply", 0.5, 0.4, 0.2],
    ["screen", 0.5, 0.4, 0.7],
    ["overlay", 0.25, 0.6, 0.3], // backdrop <= .5: 2·b·s
    ["overlay", 0.75, 0.6, 0.8], // 1 − 2(1 − b)(1 − s)
    ["darken", 0.3, 0.6, 0.3],
    ["lighten", 0.3, 0.6, 0.6],
    ["color-dodge", 0.3, 0.5, 0.6],
    ["color-dodge", 0, 1, 0],
    ["color-dodge", 0.3, 1, 1],
    ["color-burn", 0.7, 0.5, 0.4],
    ["color-burn", 1, 0, 1],
    ["color-burn", 0.7, 0, 0],
    ["hard-light", 0.6, 0.25, 0.3],
    ["hard-light", 0.6, 0.75, 0.8],
    ["soft-light", 0.5, 0.25, 0.375], // b − (1 − 2s)·b·(1 − b)
    ["soft-light", 0.16, 0.75, 0.279168], // D(b) = ((16b − 12)b + 4)b for b <= .25
    ["soft-light", 0.64, 0.75, 0.72], // D(b) = √b
    ["difference", 0.3, 0.8, 0.5],
    ["exclusion", 0.5, 0.4, 0.5],
    ["add", 0.3, 0.4, 0.7],
    ["add", 0.7, 0.6, 1],
    ["subtract", 0.7, 0.2, 0.5],
    ["subtract", 0.2, 0.7, 0],
    ["divide", 0.3, 0.6, 0.5],
    ["divide", 0.3, 0, 1],
    ["divide", 0, 0, 0],
    ["linear-burn", 0.7, 0.6, 0.3],
    ["linear-burn", 0.2, 0.3, 0],
    ["linear-light", 0.4, 0.6, 0.6], // b + 2s − 1
    ["vivid-light", 0.7, 0.25, 0.4], // color burn with 2s
    ["vivid-light", 0.3, 0.75, 0.6], // color dodge with 2s − 1
    ["pin-light", 0.7, 0.25, 0.5],
    ["pin-light", 0.2, 0.75, 0.5],
    ["hard-mix", 0.5, 0.5, 1],
    ["hard-mix", 0.5, 0.49, 0],
  ] as const)("%s(b=%f, s=%f) = %f", (mode, b, s, expected) => {
    expect(one(mode, b, s)).toBeCloseTo(expected, 10);
  });

  it("keeps the backdrop's luminosity for hue, saturation and color", () => {
    const lum = ([r, g, b]: readonly number[]) =>
      0.3 * (r ?? 0) + 0.59 * (g ?? 0) + 0.11 * (b ?? 0);
    const backdrop = [0.2, 0.5, 0.7] as const;
    const source = [0.9, 0.1, 0.3] as const;
    for (const mode of ["hue", "saturation", "color"] as const)
      expect(lum(blendColor(mode, backdrop, source))).toBeCloseTo(lum(backdrop), 10);
    expect(lum(blendColor("luminosity", backdrop, source))).toBeCloseTo(lum(source), 10);
    // Color takes the source's hue and saturation: a grey backdrop gives the source shifted.
    expect(blendColor("color", [0.5, 0.5, 0.5], [0.6, 0.4, 0.4])).toEqual([
      expect.closeTo(0.64, 10),
      expect.closeTo(0.44, 10),
      expect.closeTo(0.44, 10),
    ]);
    // Grey source has no saturation: saturation mode greys out the backdrop.
    const grey = blendColor("saturation", backdrop, [0.5, 0.5, 0.5]);
    expect(grey[0]).toBeCloseTo(grey[1], 10);
  });
});

describe("blendPixel (W3C alpha compositing, premultiplied)", () => {
  const run = (mode: BlendMode, b: number[], s: number[]) => {
    const out = new Float64Array(4);
    blendPixel(mode, b, s, out, 0);
    return [...out];
  };

  it("is source-over for normal", () => {
    expect(run("normal", [0.5, 0, 0, 0.5], [0, 0.25, 0, 0.5])).toEqual([0.25, 0.25, 0, 0.75]);
  });

  it("is source-over wherever either side is transparent", () => {
    expect(run("multiply", [0, 0, 0, 0], [0.4, 0.2, 0, 0.5])).toEqual([0.4, 0.2, 0, 0.5]);
    expect(run("difference", [0.4, 0.2, 0, 0.5], [0, 0, 0, 0])).toEqual([0.4, 0.2, 0, 0.5]);
  });

  it("mixes B(Cb, Cs) in by the overlap αs·αb", () => {
    // Opaque white backdrop, half-transparent red multiply: half red, half white.
    const [r, g, b, a] = run("multiply", [1, 1, 1, 1], [0.5, 0, 0, 0.5]);
    expect([r, g, b, a].map((v) => Number(v?.toFixed(10)))).toEqual([1, 0.5, 0.5, 1]);
    // Both half transparent: cs(1 − αb) + cb(1 − αs) + αsαb·B.
    const out = run("screen", [0.25, 0.25, 0.25, 0.5], [0.25, 0, 0, 0.5]);
    // Cb = .5, Cs = (.5, 0, 0): screen = (.75, .5, .5).
    expect(out.map((v) => Number(v.toFixed(10)))).toEqual([0.4375, 0.25, 0.25, 0.75]);
  });
});
