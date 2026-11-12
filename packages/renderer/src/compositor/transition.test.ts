import type { ResolvedTransition } from "@kynimo/engine";
import { describe, expect, it } from "vitest";
import type { FramePlan, PlannedFrameLayer, PlannedLayer, RasterImage } from "../raster.js";
import { transitionSamples } from "./effects.js";
import { compositeReference } from "./reference.js";
import { transitionUniforms } from "./transition.js";

const W = 64;
const H = 48;

const RED = [255, 0, 0, 255] as const;
const BLUE = [0, 0, 255, 255] as const;

const fill = (width: number, height: number, [r, g, b, a]: readonly number[]): RasterImage => {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([r ?? 0, g ?? 0, b ?? 0, a ?? 0], i);
  return { width, height, pixels };
};

const solid = (
  id: string,
  raster: RasterImage,
  overrides: Partial<PlannedLayer> = {},
): PlannedLayer =>
  ({
    id,
    type: "solid",
    space: "layer",
    opacity: 1,
    blendMode: "normal",
    mask: null,
    matte: null,
    matrix: [1, 0, 0, 1, 0, 0],
    raster,
    ...overrides,
  }) as PlannedLayer;

const plan = (
  layers: PlannedFrameLayer[],
  width = W,
  height = H,
  overrides: Partial<FramePlan> = {},
): FramePlan => ({
  width,
  height,
  background: null,
  layers,
  skipped: [],
  warnings: [],
  ...overrides,
});

/** Blue over red, the blue layer carrying `transition`. */
const duel = (transition: ResolvedTransition | null, width = W, height = H): FramePlan =>
  plan(
    [solid("b", fill(width, height, BLUE), { transition }), solid("a", fill(width, height, RED))],
    width,
    height,
  );

const pixel = (image: RasterImage, x: number, y: number) => [
  ...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
];

const isBlue = (image: RasterImage, x: number, y: number) =>
  expect(pixel(image, x, y), `(${x}, ${y})`).toEqual([...BLUE]);
const isRed = (image: RasterImage, x: number, y: number) =>
  expect(pixel(image, x, y), `(${x}, ${y})`).toEqual([...RED]);

const kinds: ResolvedTransition[] = [
  { kind: "dissolve", progress: 0 },
  { kind: "noise-dissolve", progress: 0, seed: 7, scale: 8, feather: 0.3 },
  { kind: "wipe", progress: 0, angle: 30, feather: 12 },
  { kind: "clock", progress: 0, startAngle: 0, clockwise: true, center: [32, 24], feather: 10 },
  { kind: "iris", progress: 0, shape: "circle", center: [32, 24], feather: 8 },
  { kind: "blinds", progress: 0, count: 4, angle: 0, feather: 0.2 },
  { kind: "pixelate", progress: 0, cell: 12 },
  { kind: "push", progress: 0, angle: 0 },
  { kind: "zoom", progress: 0, center: [32, 24], strength: 1 },
  { kind: "glitch", progress: 0, seed: 3, bands: 8, amount: 0.5 },
];

describe("transitions in the reference compositor", () => {
  it("draws only the backdrop at progress 0, byte for byte, for every kind", () => {
    const without = compositeReference(plan([solid("a", fill(W, H, RED))]));
    for (const transition of kinds)
      expect(compositeReference(duel(transition)).pixels, transition.kind).toEqual(without.pixels);
  });

  it("draws the layer alone when the transition is null or omitted", () => {
    const plain = compositeReference(
      plan([solid("b", fill(W, H, BLUE)), solid("a", fill(W, H, RED))]),
    );
    expect(compositeReference(duel(null)).pixels).toEqual(plain.pixels);
    isBlue(plain, 3, 3);
  });

  it("cross-fades a dissolve", () => {
    const out = compositeReference(duel({ kind: "dissolve", progress: 0.5 }));
    expect(pixel(out, 10, 10)).toEqual([128, 0, 128, 255]);
    const quarter = compositeReference(duel({ kind: "dissolve", progress: 0.25 }));
    expect(pixel(quarter, 10, 10)).toEqual([191, 0, 64, 255]);
  });

  it("wipes from the left at angle 0 and from the top at angle 90", () => {
    const left = compositeReference(duel({ kind: "wipe", progress: 0.5, angle: 0, feather: 0 }));
    isBlue(left, 10, 20);
    isBlue(left, 31, 20);
    isRed(left, 40, 20);
    isRed(left, 60, 5);
    const top = compositeReference(duel({ kind: "wipe", progress: 0.5, angle: 90, feather: 0 }));
    isBlue(top, 30, 5);
    isRed(top, 30, 40);
  });

  it("softens a wipe over the feather width", () => {
    const out = compositeReference(duel({ kind: "wipe", progress: 0.5, angle: 0, feather: 20 }));
    // e = 0.5 * (64 + 20) = 42: fully B up to x = 22, fully A from x = 42.
    isBlue(out, 20, 3);
    isRed(out, 43, 3);
    const mid = pixel(out, 32, 3);
    expect(mid[0]).toBeGreaterThan(0);
    expect(mid[2]).toBeGreaterThan(0);
  });

  it("opens an iris from its center first", () => {
    const out = compositeReference(
      duel({ kind: "iris", progress: 0.5, shape: "circle", center: [32, 24], feather: 0 }),
    );
    isBlue(out, 32, 24);
    isBlue(out, 40, 24);
    isRed(out, 0, 0);
    isRed(out, 63, 47);
    const square = compositeReference(
      duel({ kind: "iris", progress: 0.4, shape: "square", center: [32, 24], feather: 0 }),
    );
    // Square reach 0.4 * (32 + 1) = 13.2: a pixel 11.5 away on both axes is inside.
    isBlue(square, 32 + 11, 24 + 11);
    isRed(square, 32 + 15, 24);
    const diamond = compositeReference(
      duel({ kind: "iris", progress: 0.4, shape: "diamond", center: [32, 24], feather: 0 }),
    );
    // Its diamond distance is 23: outside the 0.4 * 57 = 22.8 reach.
    isRed(diamond, 32 + 11, 24 + 11);
    isBlue(diamond, 32 + 10, 24);
  });

  it("sweeps a clock clockwise from 12 o'clock", () => {
    const clock = (clockwise: boolean, startAngle = 0) =>
      compositeReference(
        duel({
          kind: "clock",
          progress: 0.25,
          startAngle,
          clockwise,
          center: [32, 24],
          feather: 0,
        }),
      );
    const cw = clock(true);
    isBlue(cw, 45, 10); // upper right quadrant
    isRed(cw, 45, 40); // lower right
    isRed(cw, 10, 10); // upper left
    const ccw = clock(false);
    isBlue(ccw, 10, 10); // upper left quadrant first
    isRed(ccw, 45, 10);
    const from3 = clock(true, 90); // starts at 3 o'clock, sweeps the lower right
    isBlue(from3, 45, 40);
    isRed(from3, 45, 10);
  });

  it("opens blinds slat by slat along the angle", () => {
    const out = compositeReference(
      duel({ kind: "blinds", progress: 0.5, count: 4, angle: 0, feather: 0 }),
    );
    for (const slat of [0, 16, 32, 48]) {
      isBlue(out, slat + 3, 10);
      isRed(out, slat + 12, 10);
    }
  });

  it("pushes the layer in along the angle with a one pixel edge", () => {
    const out = compositeReference(duel({ kind: "push", progress: 0.5, angle: 0 }));
    isBlue(out, 10, 10);
    isRed(out, 50, 10);
  });

  it("pushes real content: the backdrop slides out as the layer slides in", () => {
    const ramp = (shade: (x: number) => number): RasterImage => {
      const pixels = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) pixels.set([shade(x), 0, 0, 255], (y * W + x) * 4);
      return { width: W, height: H, pixels };
    };
    const a = ramp((x) => x * 4);
    const b = ramp((x) => 255 - x * 4);
    const out = compositeReference(
      plan([
        solid("b", b, { transition: { kind: "push", progress: 0.5, angle: 0 } }),
        solid("a", a),
      ]),
    );
    // A moved right by 32: pixel 50 shows A's pixel 18. B moved from the left: pixel 10 shows B's pixel 42.
    expect(pixel(out, 50, 5)[0]).toBe(18 * 4);
    expect(pixel(out, 10, 5)[0]).toBe(255 - 42 * 4);
  });

  it("zooms about the center and cross-fades with progress", () => {
    const ramp = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) ramp.set([x * 4, 0, 0, 255], (y * W + x) * 4);
    const zoom = (strength: number) =>
      compositeReference(
        plan([
          solid("b", fill(W, H, BLUE), {
            transition: { kind: "zoom", progress: 0.5, center: [32, 24], strength },
          }),
          solid("a", { width: W, height: H, pixels: ramp }),
        ]),
      );
    // Zero strength is a plain cross-fade of the pixel itself: half of 44 * 4.
    expect(pixel(zoom(0), 44, 10)[0]).toBe(88);
    // Strength 1 at p = 0.5 scales both by 1.5: pixel 44 (12.5 from the center) reads A at 8.33
    // from it, between ramp texels 39 and 40: 159.33, halved.
    expect(pixel(zoom(1), 44, 10)[0]).toBe(80);
    // The center stays put.
    expect(pixel(zoom(1), 32, 24)[0]).toBe(pixel(zoom(0), 32, 24)[0]);
  });

  it("holds the pixelate mosaic constant within a cell", () => {
    const gradient = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) gradient.set([x * 4, y * 5, 0, 255], (y * W + x) * 4);
    const out = compositeReference(
      plan([
        solid("b", fill(W, H, BLUE), {
          transition: { kind: "pixelate", progress: 0.5, cell: 9 },
        }),
        solid("a", { width: W, height: H, pixels: gradient }),
      ]),
    );
    // k = 9 at p = 0.5: cells 0..8 share one color.
    expect(pixel(out, 1, 1)).toEqual(pixel(out, 7, 7));
    expect(pixel(out, 1, 1)).not.toEqual(pixel(out, 12, 1));
  });

  it("dissolves with seeded noise, monotonically, and in a hard step when the feather is 0", () => {
    const noise = (progress: number, feather: number, seed = 5) =>
      compositeReference(duel({ kind: "noise-dissolve", progress, seed, scale: 6, feather }));
    const blueShare = (image: RasterImage) => {
      let blue = 0;
      for (let i = 0; i < image.pixels.length; i += 4) blue += image.pixels[i + 2] === 255 ? 1 : 0;
      return blue / (image.pixels.length / 4);
    };
    const half = noise(0.5, 0);
    expect(blueShare(half)).toBeGreaterThan(0.3);
    expect(blueShare(half)).toBeLessThan(0.7);
    for (let i = 0; i < half.pixels.length; i += 4)
      expect([255, 0].includes(half.pixels[i + 2] ?? -1)).toBe(true); // hard: blue or red only
    const early = noise(0.2, 0);
    for (let i = 0; i < early.pixels.length; i += 4)
      if (early.pixels[i + 2] === 255) expect(half.pixels[i + 2]).toBe(255);
    expect(noise(0.5, 0, 6).pixels).not.toEqual(half.pixels);
    expect(noise(0.5, 0).pixels).toEqual(half.pixels);
  });

  it("glitches whole bands at a time and is seeded", () => {
    const glitch = (seed: number) =>
      compositeReference(duel({ kind: "glitch", progress: 0.5, seed, bands: 16, amount: 0.5 }));
    const out = glitch(1);
    let blueRows = 0;
    for (let y = 0; y < H; y++) {
      const first = pixel(out, 0, y);
      expect([RED, BLUE].map((c) => c.join())).toContain(first.join());
      for (let x = 0; x < W; x++) expect(pixel(out, x, y)).toEqual(first);
      blueRows += first[2] === 255 ? 1 : 0;
    }
    expect(blueRows).toBeGreaterThan(0);
    expect(blueRows).toBeLessThan(H);
    expect(glitch(2).pixels).not.toEqual(out.pixels);
    expect(glitch(1).pixels).toEqual(out.pixels);
  });

  it("splits the channels of a glitched band near its displaced edge", () => {
    const stripes: RasterImage = { width: W, height: H, pixels: new Uint8Array(W * H * 4) };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        stripes.pixels.set(x < 32 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * W + x) * 4);
    const glitch = (amount: number) =>
      compositeReference(
        plan([
          solid("b", stripes, {
            transition: { kind: "glitch", progress: 0.9, seed: 1, bands: 2, amount },
          }),
          solid("a", stripes),
        ]),
      );
    const fringes = (image: RasterImage) => {
      let count = 0;
      for (let i = 0; i < image.pixels.length; i += 4)
        if (image.pixels[i] !== image.pixels[i + 1] || image.pixels[i + 1] !== image.pixels[i + 2])
          count++;
      return count;
    };
    // Both inputs are the same grey-scale edge, so only the channel split can tint a pixel.
    expect(fringes(glitch(0))).toBe(0);
    expect(fringes(glitch(1))).toBeGreaterThan(0);
  });

  it("uses the size of the plan it composites: a transition inside a nested precomp", () => {
    const inner = duel({ kind: "wipe", progress: 0.5, angle: 0, feather: 0 }, 32, 24);
    const precomp = {
      id: "p",
      type: "precomp",
      space: "layer",
      opacity: 1,
      blendMode: "normal",
      mask: null,
      matte: null,
      matrix: [1, 0, 0, 1, 8, 8],
      frame: inner,
    } as PlannedLayer;
    const out = compositeReference(plan([precomp]));
    // Inside: e = 0.5 * 33 = 16.5 of 32 px: nested x < 16 is blue.
    isBlue(out, 8 + 10, 8 + 5);
    isRed(out, 8 + 20, 8 + 5);
  });

  it("charges transitionSamples per pixel", () => {
    expect(transitionSamples("dissolve")).toBe(2);
    expect(transitionSamples("noise-dissolve")).toBe(2);
    expect(transitionSamples("wipe")).toBe(2);
    expect(transitionSamples("clock")).toBe(2);
    expect(transitionSamples("iris")).toBe(2);
    expect(transitionSamples("blinds")).toBe(2);
    expect(transitionSamples("pixelate")).toBe(8);
    expect(transitionSamples("push")).toBe(8);
    expect(transitionSamples("zoom")).toBe(8);
    expect(transitionSamples("glitch")).toBe(12);
  });
});

describe("transition uniforms", () => {
  it("measures the frame along a direction from its corners", () => {
    const u = transitionUniforms({ kind: "wipe", progress: 0.5, angle: 0, feather: 0 }, 64, 48);
    expect(u.range).toEqual([0, 64]);
    expect(u.feather).toEqual([1]); // pixel feathers are at least one pixel
    const diagonal = transitionUniforms(
      { kind: "wipe", progress: 0.5, angle: 180, feather: 4 },
      64,
      48,
    );
    expect(diagonal.range?.[0]).toBeCloseTo(-64);
    expect(diagonal.range?.[1]).toBeCloseTo(64);
  });

  it("derives the iris reach from the farthest corner of its shape", () => {
    const u = (shape: "circle" | "diamond" | "square") =>
      transitionUniforms({ kind: "iris", progress: 0.5, shape, center: [0, 0], feather: 0 }, 30, 40)
        .rmax;
    expect(u("circle")).toEqual([50]);
    expect(u("diamond")).toEqual([70]);
    expect(u("square")).toEqual([40]);
  });

  it("peaks the pixelate cell and glitch amplitude at progress 0.5", () => {
    const cell = (progress: number) =>
      transitionUniforms({ kind: "pixelate", progress, cell: 11 }, 64, 48).cell?.[0] ?? 0;
    expect(cell(0.5)).toBe(11);
    expect(cell(0.25)).toBeCloseTo(6);
    const amp = (progress: number) =>
      transitionUniforms({ kind: "glitch", progress, seed: 1, bands: 4, amount: 1 }, 100, 50)
        .amp?.[0] ?? 0;
    expect(amp(0.5)).toBeCloseTo(10);
    expect(amp(0.25)).toBeCloseTo(5);
  });
});
