import type { ResolvedEffect, ResolvedGenerator, Rgba } from "@kynimo/engine";
import { describe, expect, it } from "vitest";
import { pixel } from "../canvaskit.test-util.js";
import type { FramePlan, PlannedLayer, RasterImage } from "../raster.js";
import { cardProjection } from "./projective.test-util.js";
import { compositeReference } from "./reference.js";

/** A flat raster of one premultiplied RGBA8 value. */
const flat = (width: number, height: number, rgba: number[]): RasterImage => ({
  width,
  height,
  pixels: Uint8Array.from({ length: width * height * 4 }, (_, i) => rgba[i % 4] ?? 0),
});

const layerSpace = (
  id: string,
  raster: RasterImage,
  matrix: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0],
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
    matrix,
    raster,
    ...overrides,
  }) as PlannedLayer;

const generator = (
  id: string,
  size: number,
  g: ResolvedGenerator,
  overrides: Partial<PlannedLayer> = {},
): PlannedLayer =>
  ({
    id,
    type: "generator",
    space: "layer",
    opacity: 1,
    blendMode: "normal",
    mask: null,
    matte: null,
    matrix: [1, 0, 0, 1, 0, 0],
    width: size,
    height: size,
    generator: g,
    ...overrides,
  }) as PlannedLayer;

const gray = (v: number, a = 1): Rgba => ({ r: v, g: v, b: v, a });

const plan = (layers: PlannedLayer[], overrides: Partial<FramePlan> = {}): FramePlan => ({
  width: 8,
  height: 8,
  background: null,
  layers,
  skipped: [],
  warnings: [],
  ...overrides,
});

describe("compositeReference", () => {
  it("puts the background under the layers and keeps transparent output premultiplied", () => {
    const half = layerSpace("s", flat(4, 8, [128, 0, 0, 128]));
    const bg = { r: 0, g: 0, b: 1, a: 1 };
    const out = compositeReference(plan([half], { background: bg }));
    expect(pixel(out, 1, 1)).toEqual([128, 0, 127, 255]);
    expect(pixel(out, 6, 1)).toEqual([0, 0, 255, 255]);
    expect(pixel(compositeReference(plan([half])), 1, 1)).toEqual([128, 0, 0, 128]);
  });

  it("blends layers bottom first with their blend mode; the background is not blended with", () => {
    const grey = layerSpace("bottom", flat(8, 8, [128, 128, 128, 255]));
    const red = layerSpace("top", flat(8, 8, [255, 0, 0, 255]), undefined, {
      blendMode: "multiply",
    });
    const out = compositeReference(plan([red, grey], { background: { r: 0, g: 1, b: 0, a: 1 } }));
    expect(pixel(out, 3, 3)).toEqual([128, 0, 0, 255]);
    // Alone over the background, multiply has no backdrop to multiply with: source-over.
    const alone = compositeReference(plan([red], { background: { r: 0, g: 1, b: 0, a: 1 } }));
    expect(pixel(alone, 3, 3)).toEqual([255, 0, 0, 255]);
  });

  it("places layer-space rasters bilinearly and is exact at whole-pixel offsets", () => {
    const dot = layerSpace("d", flat(1, 1, [255, 255, 255, 255]), [1, 0, 0, 1, 2, 3]);
    const out = compositeReference(plan([dot]));
    expect(pixel(out, 2, 3)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 3, 3)).toEqual([0, 0, 0, 0]);
    // Half a pixel to the right: two pixels at half coverage.
    const shifted = compositeReference(
      plan([layerSpace("d", flat(1, 1, [255, 255, 255, 255]), [1, 0, 0, 1, 2.5, 3])]),
    );
    expect([pixel(shifted, 2, 3)[3], pixel(shifted, 3, 3)[3]]).toEqual([128, 128]);
  });

  it("averages through mips when minifying instead of aliasing", () => {
    // A 1-pixel checker of white and transparent, scaled to 1/4: every output pixel is the mean.
    const w = 32;
    const pixels = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++)
        if ((x + y) % 2 === 0) pixels.fill(255, (y * w + x) * 4, (y * w + x) * 4 + 4);
    const checker = layerSpace("c", { width: w, height: w, pixels }, [0.25, 0, 0, 0.25, 0, 0]);
    const out = compositeReference(plan([checker]));
    for (const [x, y] of [
      [1, 1],
      [3, 2],
      [6, 6],
    ] as const)
      expect(pixel(out, x, y)).toEqual([128, 128, 128, 128]);
  });

  it("composites a precomp at float precision before placing it", () => {
    const inner = plan([
      layerSpace("s", flat(8, 8, [255, 255, 255, 255]), undefined, { opacity: 0.5 }),
    ]);
    const outer = plan([
      {
        id: "p",
        type: "precomp",
        space: "layer",
        opacity: 0.5,
        blendMode: "normal",
        mask: null,
        matte: null,
        matrix: [1, 0, 0, 1, 0, 0],
        frame: inner,
      },
    ]);
    // 0.5 · 0.5 = 0.25 → 64, not 128/255 · 0.5 rounded twice.
    expect(pixel(compositeReference(outer), 2, 2)).toEqual([64, 64, 64, 64]);
  });

  it("covers nothing with a degenerate placement", () => {
    const flatLayer = layerSpace("z", flat(4, 4, [255, 0, 0, 255]), [0, 0, 0, 1, 0, 0]);
    expect(pixel(compositeReference(plan([flatLayer])), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("draws a two-stop linear gradient with the midpoint halfway", () => {
    const g = generator("g", 8, {
      type: "gradient",
      kind: "linear",
      start: [0, 0],
      end: [8, 0],
      stops: [
        { offset: 0, color: gray(0) },
        { offset: 1, color: gray(1) },
      ],
    });
    const out = compositeReference(plan([g]));
    // Pixel centers 3.5 and 4.5 sit at 0.4375 and 0.5625 of the way.
    expect(pixel(out, 3, 5)).toEqual([112, 112, 112, 255]);
    expect(pixel(out, 4, 5)).toEqual([143, 143, 143, 255]);
    expect(pixel(out, 0, 0)).toEqual([16, 16, 16, 255]);
  });

  it("premultiplies a translucent generator and clamps outside the stops", () => {
    const g = generator("g", 8, {
      type: "gradient",
      kind: "linear",
      start: [2, 0],
      end: [6, 0],
      stops: [
        { offset: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } },
        { offset: 1, color: { r: 1, g: 0, b: 0, a: 0.5 } },
      ],
    });
    const out = compositeReference(plan([g]));
    expect(pixel(out, 0, 0)).toEqual([128, 0, 0, 128]);
    expect(pixel(out, 7, 0)).toEqual([128, 0, 0, 128]);
  });

  it("keeps noise between its low and high colors, seeded and deterministic", () => {
    const noise = (seed: number): ResolvedGenerator => ({
      type: "noise",
      seed,
      scale: 8,
      octaves: 3,
      evolution: 0.5,
      offset: [0, 0],
      low: gray(0.2),
      high: gray(0.6),
    });
    const a = compositeReference(plan([generator("n", 8, noise(1))]));
    const values = new Set<number>();
    for (let i = 0; i < a.pixels.length; i += 4) {
      const v = a.pixels[i] ?? 0;
      expect(v).toBeGreaterThanOrEqual(51);
      expect(v).toBeLessThanOrEqual(153);
      values.add(v);
    }
    expect(values.size).toBeGreaterThan(4);
    expect(compositeReference(plan([generator("n", 8, noise(1))])).pixels).toEqual(a.pixels);
    expect(compositeReference(plan([generator("n", 8, noise(2))])).pixels).not.toEqual(a.pixels);
  });

  it("draws pattern thickness 1 as solid foreground", () => {
    for (const kind of ["stripes", "grid"] as const) {
      const g = generator("p", 8, {
        type: "pattern",
        kind,
        size: 4,
        thickness: 1,
        rotation: [Math.cos(0.7), Math.sin(0.7)],
        offset: [0.3, 0.1],
        foreground: gray(1),
        background: gray(0),
      });
      const out = compositeReference(plan([g]));
      for (let i = 0; i < out.pixels.length; i++) expect(out.pixels[i], kind).toBe(255);
    }
  });

  it("blends an aurora toward the nearest color point", () => {
    const g = generator("a", 8, {
      type: "aurora",
      colors: [
        { r: 1, g: 0, b: 0, a: 1 },
        { r: 0, g: 0, b: 1, a: 1 },
      ],
      points: [
        [0, 4],
        [8, 4],
      ],
      sigma: 0.5,
    });
    const out = compositeReference(plan([g]));
    expect(pixel(out, 0, 4)[0]).toBeGreaterThan(250);
    expect(pixel(out, 7, 4)[2]).toBeGreaterThan(250);
  });

  it("posterizes to evenly spaced levels and leaves transparent pixels alone", () => {
    const layer = layerSpace("s", flat(8, 8, [200, 100, 50, 255]), undefined, {
      effects: [{ type: "posterize", levels: 3 }],
    });
    expect(pixel(compositeReference(plan([layer])), 2, 2)).toEqual([255, 128, 0, 255]);
    const clear = layerSpace("c", flat(8, 8, [0, 0, 0, 0]), undefined, {
      effects: [{ type: "posterize", levels: 3 }],
    });
    expect(pixel(compositeReference(plan([clear])), 2, 2)).toEqual([0, 0, 0, 0]);
  });

  it("leaves the vignette center alone and tints the corner at full amount", () => {
    const layer = layerSpace("s", flat(9, 9, [255, 255, 255, 255]), undefined, {
      effects: [
        {
          type: "vignette",
          amount: 1,
          radius: 0.3,
          feather: 0.5,
          color: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    const out = compositeReference(plan([layer], { width: 9, height: 9 }));
    expect(pixel(out, 4, 4)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(out, 8, 8)).toEqual([0, 0, 0, 255]);
  });

  it("draws scanlines and grain only on opaque pixels they select", () => {
    const lines = layerSpace("s", flat(8, 8, [255, 255, 255, 255]), undefined, {
      effects: [
        {
          type: "scanlines",
          amount: 1,
          spacing: 4,
          thickness: 0.5,
          offset: 0,
          color: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    const out = compositeReference(plan([lines]));
    // Lines are 2 px thick, centered on rows 0 and 4: pixel centers 0.5 and 1.5 hold half and
    // none of their coverage... row 0 covers [-1, 1] of the box [0, 1]: full; row 1 is outside.
    expect(pixel(out, 3, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(out, 3, 2)).toEqual([255, 255, 255, 255]);
    const grain = layerSpace("g", flat(8, 8, [0, 0, 0, 0]), undefined, {
      effects: [{ type: "grain", amount: 1, size: 1, seed: 1, frame: 0, monochrome: true }],
    });
    expect(pixel(compositeReference(plan([grain])), 2, 2)).toEqual([0, 0, 0, 0]);
  });

  describe("looks stay anchored to the unpadded raster", () => {
    const looks: Record<string, ResolvedEffect> = {
      vignette: {
        type: "vignette",
        amount: 0.8,
        radius: 0.3,
        feather: 0.6,
        color: { r: 0, g: 0, b: 0.2, a: 1 },
      },
      grain: { type: "grain", amount: 0.6, size: 3, seed: 7, frame: 0, monochrome: false },
      scanlines: {
        type: "scanlines",
        amount: 0.8,
        spacing: 5,
        thickness: 0.4,
        offset: 1.5,
        color: { r: 0, g: 0, b: 0, a: 1 },
      },
    };
    const interior = (effects: ResolvedEffect[]) =>
      compositeReference(
        plan(
          [layerSpace("s", flat(32, 32, [200, 120, 60, 255]), [1, 0, 0, 1, 8, 8], { effects })],
          {
            width: 48,
            height: 48,
          },
        ),
      );
    for (const [name, look] of Object.entries(looks))
      it(`gives the same ${name} interior with and without a reaching effect`, () => {
        const plain = interior([look]);
        const padded = interior([{ type: "chromatic-aberration", amount: 3 }, look]);
        const blurred = interior([{ type: "glow", radius: 4, intensity: 1, color: gray(1) }, look]);
        let varies = false;
        // The aberration itself fringes the outermost few pixels, so look past them.
        for (let y = 12; y < 36; y++)
          for (let x = 12; x < 36; x++) {
            expect(pixel(padded, x, y)).toEqual(pixel(plain, x, y));
            expect(pixel(blurred, x, y)).toEqual(pixel(plain, x, y));
            if (pixel(plain, x, y).join() !== "200,120,60,255") varies = true;
          }
        expect(varies).toBe(true);
      });
  });

  it("keeps the edge colour under chromatic aberration on an adjustment layer", () => {
    const backdrop = layerSpace("bg", flat(16, 16, [200, 100, 50, 255]), undefined, {});
    const adjustment = {
      id: "adj",
      type: "adjustment",
      opacity: 1,
      blendMode: "normal",
      mask: null,
      matte: null,
      effects: [{ type: "chromatic-aberration", amount: 6 }],
    } as unknown as PlannedLayer;
    const out = compositeReference(plan([adjustment, backdrop], { width: 16, height: 16 }));
    for (const [x, y] of [
      [0, 8],
      [15, 8],
      [8, 0],
      [8, 15],
      [0, 0],
      [15, 15],
    ] as const)
      expect(pixel(out, x, y)).toEqual([200, 100, 50, 255]);
  });

  it("refuses a huge generator before allocating it, naming the layer", () => {
    const g = generator("huge-noise", 8192, {
      type: "noise",
      seed: 1,
      scale: 64,
      octaves: 6,
      evolution: 0,
      offset: [0, 0],
      low: gray(0),
      high: gray(1),
    });
    expect(() => compositeReference(plan([g]))).toThrow(
      /layer 'huge-noise' exceeds the frame budget/,
    );
  });
});

describe("compositeReference: 3D layers", () => {
  const W = 64;
  const H = 48;
  const card = (
    id: string,
    raster: RasterImage,
    position: [number, number, number],
    extra: { rotationX?: number; rotationY?: number; zoom?: number } = {},
    overrides: Partial<PlannedLayer> = {},
  ): PlannedLayer =>
    layerSpace(id, raster, [1, 0, 0, 1, 0, 0], {
      projection: cardProjection({
        comp: [W, H],
        zoom: extra.zoom ?? 60,
        position,
        anchor: [raster.width / 2, raster.height / 2],
        ...extra,
      }),
      ...overrides,
    } as Partial<PlannedLayer>);
  const frame = (layers: PlannedLayer[]) => plan(layers, { width: W, height: H });
  const alphaAt = (out: RasterImage, x: number, y: number) => out.pixels[(y * W + x) * 4 + 3] ?? 0;
  const column = (out: RasterImage, x: number) =>
    Array.from({ length: H }, (_, y) => alphaAt(out, x, y)).filter((a) => a > 127).length;
  const gradientRaster = (w: number, h: number): RasterImage => ({
    width: w,
    height: h,
    pixels: Uint8Array.from({ length: w * h * 4 }, (_, i) => {
      const px = Math.floor(i / 4);
      const x = px % w;
      const y = Math.floor(px / w);
      return [(x * 255) / (w - 1), (y * 255) / (h - 1), 90, 255][i % 4] ?? 0;
    }),
  });

  it("at the default camera, unrotated at z = 0, draws like the 2D layer", () => {
    const raster = gradientRaster(20, 10);
    const flat3 = compositeReference(frame([card("a", raster, [32, 24, 0])]));
    // The 2D layer with the same position and anchor: translate(position - anchor).
    const flat2 = compositeReference(frame([layerSpace("a", raster, [1, 0, 0, 1, 22, 19])]));
    let gap = 0;
    for (let i = 0; i < flat2.pixels.length; i++)
      gap = Math.max(gap, Math.abs((flat2.pixels[i] ?? 0) - (flat3.pixels[i] ?? 0)));
    expect(gap).toBeLessThanOrEqual(1);
    expect(alphaAt(flat3, 32, 24)).toBe(255);
    expect(alphaAt(flat3, 5, 5)).toBe(0);
  });

  it("a card turned 60 degrees about Y is narrower and trapezoidal: the near edge is taller", () => {
    const solidCard = flat(40, 30, [0, 255, 0, 255]);
    const out = compositeReference(frame([card("a", solidCard, [32, 24, 0], { rotationY: 60 })]));
    const columns = Array.from({ length: W }, (_, x) => column(out, x));
    const drawn = columns.flatMap((n, x) => (n > 0 ? [x] : []));
    const left = drawn[0] as number;
    const right = drawn[drawn.length - 1] as number;
    // Narrower than the 40 px it is flat, and centred on the comp.
    expect(right - left + 1).toBeLessThan(30);
    expect(right - left + 1).toBeGreaterThan(10);
    // The left edge (turned toward the camera) is taller than the right.
    expect(columns[left + 1] as number).toBeGreaterThan(columns[right - 1] as number);
    expect(columns[left + 1] as number).toBeGreaterThan(30);
    expect(columns[right - 1] as number).toBeLessThan(30);
  });

  it("a card crossing the near plane draws only its in-front part, with no mirrored ghost", () => {
    // Camera at z = -20; the card is 5 px in front of it at its centre, turned so its left half
    // is behind the near plane. Its in-front part ends at about 10 px right of the centre.
    const wide = flat(80, 30, [0, 0, 255, 255]);
    const out = compositeReference(
      frame([card("a", wide, [32, 24, -15], { rotationY: 60, zoom: 20 })]),
    );
    expect(alphaAt(out, 20, 24)).toBe(255);
    expect(alphaAt(out, 40, 24)).toBe(255);
    for (let x = 44; x < W; x++) expect(column(out, x)).toBe(0);
    for (let y = 0; y < H; y++) expect(alphaAt(out, 60, y)).toBe(0);
  });

  it("a layer entirely behind the camera draws nothing", () => {
    const out = compositeReference(
      frame([card("a", flat(40, 30, [255, 255, 255, 255]), [32, 24, -90], { zoom: 60 })]),
    );
    expect(out.pixels.every((v) => v === 0)).toBe(true);
  });
});
