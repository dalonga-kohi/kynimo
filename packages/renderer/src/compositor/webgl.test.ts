import type { ResolvedEffect, ResolvedGenerator, ResolvedShader } from "@kynimo/engine";
import { BLEND_MODES, type BlendMode } from "@kynimo/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CoverageImage,
  FramePlan,
  PlannedAdjustmentLayer,
  PlannedFrameLayer,
  PlannedLayer,
  RasterImage,
} from "../raster.js";
import { blendColor } from "./blend.js";
import { type GpuSession, launchGpu } from "./browser.test-util.js";
import { precompUses } from "./pipeline.js";
import { cardProjection } from "./projective.test-util.js";
import { compositeReference } from "./reference.js";

let gpu: GpuSession;
beforeAll(async () => {
  gpu = await launchGpu();
}, 60_000);
afterAll(async () => {
  await gpu?.close();
}, 60_000);

const W = 64;
const H = 48;

/** A premultiplied raster whose color and alpha vary smoothly, so every blend branch is hit. */
function gradient(width: number, height: number, seed: number): RasterImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = 0.25 + (0.75 * ((x * 7 + y * 3 + seed * 11) % 64)) / 63;
      const r = (x / (width - 1) + seed * 0.13) % 1;
      const g = (y / (height - 1) + seed * 0.29) % 1;
      const b = ((x + y) / (width + height - 2) + seed * 0.41) % 1;
      pixels[i] = Math.round(r * a * 255);
      pixels[i + 1] = Math.round(g * a * 255);
      pixels[i + 2] = Math.round(b * a * 255);
      pixels[i + 3] = Math.round(a * 255);
    }
  return { width, height, pixels };
}

function coverage(width: number, height: number): CoverageImage {
  const c = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) c[y * width + x] = Math.round((255 * x) / (width - 1));
  return { width, height, coverage: c };
}

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

const plan = (layers: PlannedFrameLayer[], overrides: Partial<FramePlan> = {}): FramePlan => ({
  width: W,
  height: H,
  background: null,
  layers,
  skipped: [],
  warnings: [],
  ...overrides,
});

/** Modes with discontinuities, where float differences can flip a pixel sitting on a step. */
const STEPPED: ReadonlySet<BlendMode> = new Set([
  "hard-mix",
  "divide",
  "color-dodge",
  "color-burn",
  "vivid-light",
]);

const straight = (r: RasterImage, i: number): [number, number, number] => {
  const a = r.pixels[i * 4 + 3] ?? 0;
  const at = (k: number) => (a === 0 ? 0 : (r.pixels[i * 4 + k] ?? 0) / a);
  return [at(0), at(1), at(2)];
};

/**
 * Whether pixel `i` of a two-layer blend sits on a step of `mode`: nudging either input by 3/255
 * moves some channel of B(Cb, Cs) by more than 0.05. Only there may the GPU and reference differ.
 */
function onStep(mode: BlendMode, backdrop: RasterImage, source: RasterImage, i: number): boolean {
  const cb = straight(backdrop, i);
  const cs = straight(source, i);
  const base = blendColor(mode, cb, cs);
  const d = 3 / 255;
  for (const [db, ds] of [
    [d, 0],
    [-d, 0],
    [0, d],
    [0, -d],
  ] as const) {
    const nudged = blendColor(
      mode,
      cb.map((v) => Math.min(1, Math.max(0, v + db))) as [number, number, number],
      cs.map((v) => Math.min(1, Math.max(0, v + ds))) as [number, number, number],
    );
    if (nudged.some((v, k) => Math.abs(v - (base[k] ?? 0)) > 0.05)) return true;
  }
  return false;
}

/**
 * GPU and reference agree within 2/255 per channel (RGBA16F against float64), except on color
 * channels of pixels `allowed` says sit on a step.
 */
async function expectMatches(p: FramePlan, allowed: (pixel: number) => boolean = () => false) {
  const { bad } = await compare(p, p, allowed);
  expect(bad.slice(0, 8)).toEqual([]);
}

/** The reference of `p` against the GPU result of `gpuPlan`: the bytes out of tolerance, and the largest gap. */
async function compare(p: FramePlan, gpuPlan: FramePlan, allowed: (pixel: number) => boolean) {
  const ref = compositeReference(p);
  const out = await gpu.composite(gpuPlan);
  expect([out.width, out.height]).toEqual([ref.width, ref.height]);
  const bad: number[] = [];
  let gap = 0;
  for (let i = 0; i < ref.pixels.length; i++) {
    const d = Math.abs((ref.pixels[i] ?? 0) - (out.pixels[i] ?? 0));
    if (i % 4 !== 3 && allowed(Math.floor(i / 4))) continue;
    gap = Math.max(gap, d);
    if (d > 2) bad.push(i);
  }
  return { bad, gap };
}

describe("WebGL2 compositor on SwiftShader", () => {
  it("runs on SwiftShader", () => {
    expect(gpu.renderer).toMatch(/SwiftShader/);
  });

  const color = { r: 0.15, g: 0.75, b: 0.4, a: 0.8 };
  const effects: ResolvedEffect[] = [
    { type: "gaussian-blur", radius: 5.5 },
    { type: "drop-shadow", radius: 3.25, offset: [-4.5, 3.25], color, opacity: 0.8 },
    { type: "glow", radius: 7, color, intensity: 0.7 },
    { type: "brightness-contrast", brightness: 0.2, contrast: -0.3 },
    { type: "hue-saturation", hue: -87, saturation: 0.2 },
    { type: "tint", black: color, white: { r: 1, g: 1, b: 0.2, a: 1 }, amount: 0.6 },
    { type: "fill", color, amount: 0.4 },
  ];

  for (const effect of effects) {
    it(`matches the reference for ${effect.type} on a translucent, masked, transformed layer`, async () => {
      const layer = solid("source", gradient(13, 11, 5), {
        effects: [effect],
        mask: coverage(13, 11),
        matrix: [1.3, 0.2, -0.2, 1.3, 17, 13],
      });
      const p = plan([layer]);
      const plain = plan([{ ...layer, effects: [] }]);
      await expectMatches(p);
      expect((await gpu.composite(p)).pixels).not.toEqual((await gpu.composite(plain)).pixels);
    });
  }

  it("keeps the padded shadow in source space and applies effects in order", async () => {
    const src = solid(
      "pixel",
      { width: 1, height: 1, pixels: Uint8Array.of(255, 0, 0, 255) },
      {
        matrix: [2, 0, 0, 2, 20, 20],
        effects: [
          { type: "drop-shadow", radius: 0, offset: [-5, 0], color, opacity: 1 },
          { type: "fill", color: { r: 0, g: 1, b: 0, a: 1 }, amount: 1 },
        ],
      },
    );
    const p = plan([src]);
    const first = await gpu.composite(p);
    const pixel = (img: RasterImage, x: number, y: number) => [
      ...img.pixels.subarray((y * W + x) * 4, (y * W + x) * 4 + 4),
    ];
    const shadow = pixel(first, 10, 20);
    expect(shadow[0]).toBe(0);
    expect(shadow[1]).toBeGreaterThan(0);
    expect(shadow[1]).toBe(shadow[3]);
    const reversed = await gpu.composite(
      plan([{ ...src, effects: [...(src.effects ?? [])].reverse() }]),
    );
    expect(pixel(reversed, 10, 20)[0]).toBeGreaterThan(0);
    await expectMatches(p);
    expect((await gpu.composite(p)).pixels).toEqual(first.pixels);
  });

  it("rejects a stack over the frame sample budget and keeps the compositor usable", async () => {
    const adjustment: PlannedAdjustmentLayer = {
      type: "adjustment",
      id: "large-grade",
      blendMode: "normal",
      opacity: 1,
      effects: Array.from({ length: 8 }, () => ({ type: "gaussian-blur", radius: 48 })),
      mask: null,
      matte: null,
    };
    const p = plan([adjustment], { width: 640, height: 640 });
    expect(() => compositeReference(p)).toThrow(/large-grade.*frame budget/);
    await expect(gpu.composite(p)).rejects.toThrow(/large-grade.*frame budget/);
    await expectMatches(plan([]));
  });

  it("uses masks and matte coverage to gate an adjustment without painting over layers above it", async () => {
    const width = 5;
    const height = 1;
    const row = (...values: number[]): RasterImage => ({
      width,
      height,
      pixels: Uint8Array.from(values),
    });
    const back = solid(
      "below",
      row(0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    );
    const top = solid("above", row(0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
    const matte = solid(
      "matte",
      row(0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255),
    );
    const adjustment: PlannedAdjustmentLayer = {
      type: "adjustment",
      id: "grade",
      blendMode: "normal",
      opacity: 0.75,
      effects: [{ type: "gaussian-blur", radius: 6 }],
      mask: { width, height, coverage: Uint8Array.of(255, 0, 255, 255, 0) },
      matte: { layerId: "matte", mode: "alpha", source: matte },
    };
    const p = plan([top, adjustment, back], { width, height });
    await expectMatches(p);
    const { pixels } = await gpu.composite(p);
    expect([...pixels.subarray(0, 8)]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
    expect(pixels[11]).toBeGreaterThan(0); // the blur sees the red pixel outside the adjustment mask
    expect([...pixels.subarray(12)]).toEqual(new Array(8).fill(0));
    const multiply = plan(
      [
        {
          ...adjustment,
          blendMode: "multiply",
          mask: null,
          matte: null,
          effects: [{ type: "fill", color: { r: 0.5, g: 1, b: 0, a: 1 }, amount: 1 }],
        },
        back,
      ],
      { width, height },
    );
    await expectMatches(multiply);
    expect([...(await gpu.composite(multiply)).pixels.subarray(4, 8)]).toEqual([159, 0, 0, 255]);
  });

  it.each(BLEND_MODES)("matches the reference for %s", async (mode) => {
    const b = gradient(W, H, 1);
    const s = gradient(W, H, 2);
    const backdrop = solid("b", b);
    const source = solid("s", s, { blendMode: mode, opacity: 0.8 });
    const p = plan([source, backdrop], { background: { r: 0.1, g: 0.2, b: 0.3, a: 1 } });
    await expectMatches(p, (i) => STEPPED.has(mode) && onStep(mode, b, s, i));
  });

  it("matches masks, mattes (every mode, chains, empty) and opacity", async () => {
    const m = solid("m", gradient(W, H, 3), { mask: coverage(W, H) });
    const n = solid("n", gradient(W, H, 4), { opacity: 0.6 });
    const chained = { ...m, id: "m2", matte: { layerId: "n", mode: "luma" as const, source: n } };
    for (const mode of ["alpha", "alpha-inverted", "luma", "luma-inverted"] as const) {
      const t = solid("t", gradient(W, H, 5), { matte: { layerId: "m2", mode, source: chained } });
      await expectMatches(plan([t, solid("bg", gradient(W, H, 6))]));
      const empty = solid("e", gradient(W, H, 5), { matte: { layerId: "x", mode, source: null } });
      await expectMatches(plan([empty]));
    }
  });

  it("matches placement: subpixel offsets, rotation, magnification and mipmapped minification", async () => {
    const src = gradient(40, 30, 7);
    const c = Math.cos(0.4);
    const s = Math.sin(0.4);
    for (const matrix of [
      [1, 0, 0, 1, 3.25, -2.5],
      [c, s, -s, c, 20, 2],
      [2.5, 0, 0, 1.75, -10, -5],
      [0.3, 0.05, -0.05, 0.3, 4, 6],
      [0.11, 0, 0, 0.07, 1, 1],
    ] as const)
      await expectMatches(plan([solid("p", src, { matrix: [...matrix] as never })]));
  });

  it("matches whole-pixel translations (texel copy), clipped at every edge, with mattes and effects", async () => {
    const src = gradient(40, 30, 3);
    for (const [x, y] of [
      [0, 0],
      [-9, 7],
      [30, -12],
      [-60, 5],
      [5, 60],
    ] as const) {
      const matte = solid("m", gradient(40, 30, 4), { matrix: [1, 0, 0, 1, 2, 3] });
      for (const mode of ["alpha", "luma-inverted"] as const)
        await expectMatches(
          plan([
            solid("p", src, {
              matrix: [1, 0, 0, 1, x, y],
              opacity: 0.7,
              matte: { mode, source: matte } as never,
            }),
            solid("q", src, {
              matrix: [1, 0, 0, 1, x, y],
              effects: [{ type: "gaussian-blur", radius: 2 }],
            }),
          ]),
        );
    }
  });

  it("matches composition-space layers at whole-pixel offsets and degenerate placements", async () => {
    const vector = {
      id: "v",
      type: "shape",
      space: "composition",
      x: 9,
      y: 4,
      opacity: 0.7,
      blendMode: "screen",
      mask: coverage(30, 20),
      matte: null,
      raster: gradient(30, 20, 8),
    } as PlannedLayer;
    await expectMatches(plan([vector, solid("bg", gradient(W, H, 9))]));
    await expectMatches(plan([solid("z", gradient(8, 8, 1), { matrix: [0, 0, 0, 1, 0, 0] })]));
  });

  it("matches nested precomps, transformed, masked and blended", async () => {
    const inner = plan([
      solid("a", gradient(W, H, 10), { blendMode: "overlay" }),
      solid("b", gradient(W, H, 11)),
    ]);
    const precomp = {
      id: "p",
      type: "precomp",
      space: "layer",
      opacity: 0.9,
      blendMode: "multiply",
      mask: coverage(W, H),
      matte: null,
      matrix: [0.45, 0.1, -0.1, 0.45, 12, 6],
      frame: inner,
    } as PlannedLayer;
    await expectMatches(plan([precomp, solid("bg", gradient(W, H, 12))]));
  });

  it("reuses one nested result for a precomp drawn twice and used as a matte source", async () => {
    const inner = plan([
      solid("a", gradient(W, H, 13), { blendMode: "screen" }),
      solid("b", gradient(W, H, 14)),
    ]);
    const pre = (id: string, matrix: number[], overrides: Partial<PlannedLayer> = {}) =>
      ({
        id,
        type: "precomp",
        space: "layer",
        opacity: 1,
        blendMode: "normal",
        mask: null,
        matte: null,
        matrix,
        frame: inner,
        ...overrides,
      }) as PlannedLayer;
    const source = pre("m", [1, 0, 0, 1, 0, 0]);
    const p = plan([
      solid("t", gradient(W, H, 15), { matte: { layerId: "m", mode: "luma", source } }),
      pre("p1", [0.5, 0, 0, 0.5, 2, 3]),
      source,
      pre("p2", [0.7, 0.2, -0.2, 0.7, 20, 1], { blendMode: "difference" }),
    ]);
    expect(precompUses(p).get(inner)).toBe(4);
    await expectMatches(p);
  });

  const rgba = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
  const generatorLayer = (
    id: string,
    width: number,
    height: number,
    generator: ResolvedGenerator,
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
      width,
      height,
      generator,
      ...overrides,
    }) as PlannedLayer;

  const stops = [
    { offset: 0, color: rgba(0.9, 0.2, 0.1, 1) },
    { offset: 0.35, color: rgba(0.2, 0.7, 0.3, 0.6) },
    { offset: 0.8, color: rgba(0.1, 0.2, 0.9, 1) },
    { offset: 1, color: rgba(1, 1, 0.2, 0.9) },
  ];
  const generators: Record<string, ResolvedGenerator> = {
    "linear gradient": {
      type: "gradient",
      kind: "linear",
      start: [7.5, 5.25],
      end: [58.25, 40.5],
      stops,
    },
    "radial gradient": {
      type: "gradient",
      kind: "radial",
      start: [30.5, 20.25],
      end: [60, 38],
      stops,
    },
    "conic gradient": {
      type: "gradient",
      kind: "conic",
      start: [30.25, 22.75],
      end: [50, 10],
      stops: [
        { offset: 0, color: rgba(0.9, 0.2, 0.1, 1) },
        { offset: 0.5, color: rgba(0.1, 0.4, 0.9, 0.7) },
        { offset: 1, color: rgba(0.9, 0.2, 0.1, 1) },
      ],
    },
    "noise, 1 octave": {
      type: "noise",
      seed: 0xdeadbeef,
      scale: 14.5,
      octaves: 1,
      evolution: 0.37,
      offset: [-3.25, 11.5],
      low: rgba(0.05, 0.1, 0.3, 1),
      high: rgba(0.9, 0.8, 0.5, 0.9),
    },
    "noise, 6 octaves": {
      type: "noise",
      seed: 77,
      scale: 40,
      octaves: 6,
      evolution: -2.6,
      offset: [123.75, -48.5],
      low: rgba(0.05, 0.1, 0.3, 1),
      high: rgba(0.9, 0.8, 0.5, 1),
    },
    "stripes pattern": pattern("stripes", 7.5, 0.35, 0.6),
    "checker pattern": pattern("checker", 6, 0.5, 0.6),
    "dots pattern": pattern("dots", 8.25, 0.55, 0.6),
    "grid pattern": pattern("grid", 9, 0.15, 0.6),
    "aurora, 2 colors": {
      type: "aurora",
      colors: [rgba(0.9, 0.2, 0.4, 1), rgba(0.1, 0.5, 0.9, 1)],
      points: [
        [14, 10],
        [50, 36],
      ],
      sigma: 14,
    },
    "aurora, 4 colors": {
      type: "aurora",
      colors: [
        rgba(0.9, 0.2, 0.4, 1),
        rgba(0.1, 0.5, 0.9, 0.8),
        rgba(0.2, 0.9, 0.4, 1),
        rgba(0.9, 0.9, 0.1, 1),
      ],
      points: [
        [14, 10],
        [50, 36],
        [30, 40],
        [5, 35],
      ],
      sigma: 12,
    },
  };

  function pattern(
    kind: "stripes" | "checker" | "dots" | "grid",
    size: number,
    thickness: number,
    angle: number,
  ): ResolvedGenerator {
    return {
      type: "pattern",
      kind,
      size,
      thickness,
      rotation: [Math.cos(angle), Math.sin(angle)],
      offset: [3.5, -2.25],
      foreground: rgba(0.95, 0.85, 0.2, 1),
      background: rgba(0.1, 0.15, 0.4, 0.8),
    };
  }

  for (const [name, generator] of Object.entries(generators))
    it(`matches the reference for a ${name} generator`, async () => {
      const p = plan([generatorLayer("g", W, H, generator)], {
        background: rgba(0.3, 0.3, 0.3, 1),
      });
      await expectMatches(p);
      const flat = plan([solid("flat", gradient(W, H, 1))]);
      expect((await gpu.composite(p)).pixels).not.toEqual((await gpu.composite(flat)).pixels);
    });

  it("renders gradients with degenerate or huge-but-valid points the same on both sides", async () => {
    const stops = [
      { offset: 0, color: rgba(0.9, 0.2, 0.1, 1) },
      { offset: 1, color: rgba(0.1, 0.4, 0.9, 1) },
    ];
    const pairs: [number, number][][] = [
      [
        [-65536, 65536],
        [65536, -65536],
      ],
      [
        [32, 24],
        [32, 24],
      ],
      [
        [-65536, -65536],
        [65536, 65536],
      ],
    ];
    for (const kind of ["linear", "radial", "conic"] as const)
      for (const [start, end] of pairs) {
        const g: ResolvedGenerator = {
          type: "gradient",
          kind,
          start: start as [number, number],
          end: end as [number, number],
          stops,
        };
        const p = plan([generatorLayer("g", W, H, g)]);
        expect(compositeReference(p).pixels.every(Number.isFinite)).toBe(true);
        await expectMatches(p, () => kind === "conic");
      }
  });

  it("places generators with a minifying rotation, a mask, effects and as a luma matte source", async () => {
    const source = generators["noise, 6 octaves"] as ResolvedGenerator;
    const rotated = generatorLayer("g", 128, 96, source, {
      matrix: [0.3, 0.05, -0.05, 0.3, 14, 9],
    });
    await expectMatches(plan([rotated]));
    const pat = generators["dots pattern"] as ResolvedGenerator;
    const masked = generatorLayer("m", W, H, pat, {
      mask: coverage(W, H),
      matrix: [0.8, 0.3, -0.3, 0.8, 8, 2],
      effects: [
        { type: "gaussian-blur", radius: 2.5 },
        { type: "drop-shadow", radius: 2, offset: [3, 2], color, opacity: 0.8 },
      ],
    });
    await expectMatches(plan([masked], { background: rgba(0.2, 0.3, 0.2, 1) }));
    const matte = generatorLayer("matte", W, H, generators["radial gradient"] as ResolvedGenerator);
    for (const mode of ["luma", "luma-inverted", "alpha"] as const) {
      const t = solid("t", gradient(W, H, 5), { matte: { layerId: "matte", mode, source: matte } });
      await expectMatches(plan([t, solid("bg", gradient(W, H, 6))]));
    }
  });

  const looks: Record<string, ResolvedEffect> = {
    vignette: {
      type: "vignette",
      amount: 0.8,
      radius: 0.4,
      feather: 0.5,
      color: rgba(0.1, 0.1, 0.3, 0.9),
    },
    grain: { type: "grain", amount: 0.5, size: 2, seed: 12345, frame: 3, monochrome: false },
    "monochrome grain": {
      type: "grain",
      amount: 0.6,
      size: 3,
      seed: 0xfffffff0,
      frame: 41,
      monochrome: true,
    },
    "chromatic-aberration": { type: "chromatic-aberration", amount: 5.5 },
    posterize: { type: "posterize", levels: 5 },
    scanlines: {
      type: "scanlines",
      amount: 0.7,
      spacing: 5.5,
      thickness: 0.4,
      offset: 1.25,
      color: rgba(0.05, 0.05, 0.2, 0.9),
    },
  };

  /** Whether nudging a channel of the straight color of pixel `i` by 3/255 crosses a posterize step. */
  const onPosterizeStep = (raster: RasterImage, levels: number, i: number): boolean => {
    const a = raster.pixels[i * 4 + 3] ?? 0;
    if (a === 0) return false;
    const steps = levels - 1;
    for (let k = 0; k < 3; k++) {
      const v = (raster.pixels[i * 4 + k] ?? 0) / a;
      const levelOf = (x: number) => Math.floor(Math.min(1, Math.max(0, x)) * steps + 0.5);
      if (levelOf(v - 3 / 255) !== levelOf(v + 3 / 255)) return true;
    }
    return false;
  };

  for (const [name, effect] of Object.entries(looks)) {
    it(`matches the reference for ${name} on an image layer and on an adjustment layer`, async () => {
      const raster = gradient(W, H, 3);
      const allowed = (i: number) =>
        effect.type === "posterize" && onPosterizeStep(raster, effect.levels, i);
      // Posterize steps are located in raster pixels, so that layer is placed without resampling.
      const matrix = effect.type === "posterize" ? [1, 0, 0, 1, 0, 0] : [1.1, 0.1, -0.1, 1.1, 6, 4];
      const layer = solid("image", raster, { effects: [effect], matrix: matrix as never });
      const plain = plan([{ ...layer, effects: [] }]);
      await expectMatches(plan([layer]), allowed);
      expect((await gpu.composite(plan([layer]))).pixels).not.toEqual(
        (await gpu.composite(plain)).pixels,
      );
      const vector = {
        id: "v",
        type: "shape",
        space: "composition",
        x: 9,
        y: 4,
        opacity: 0.9,
        blendMode: "normal",
        mask: coverage(30, 20),
        matte: null,
        raster: gradient(30, 20, 8),
        effects: [effect],
      } as PlannedLayer;
      const shape = vector.type === "shape" ? vector.raster : raster;
      await expectMatches(plan([vector]), (i) => {
        const x = (i % W) - 9;
        const y = Math.floor(i / W) - 4;
        return (
          effect.type === "posterize" &&
          x >= 0 &&
          y >= 0 &&
          x < 30 &&
          y < 20 &&
          onPosterizeStep(shape, effect.levels, y * 30 + x)
        );
      });
      const adjustment: PlannedAdjustmentLayer = {
        type: "adjustment",
        id: "look",
        blendMode: "normal",
        opacity: 0.85,
        effects: [effect],
        mask: coverage(W, H),
        matte: null,
      };
      const backdrop = solid("bg", raster);
      await expectMatches(
        plan([adjustment, backdrop]),
        (i) => effect.type === "posterize" && onPosterizeStep(raster, effect.levels, i),
      );
    });
  }

  it("animates grain with its frame and keeps static grain still", async () => {
    const grain = (frame: number): ResolvedEffect => ({
      type: "grain",
      amount: 0.6,
      size: 2,
      seed: 9,
      frame,
      monochrome: false,
    });
    const at = (frame: number) =>
      plan([solid("s", gradient(W, H, 2), { effects: [grain(frame)] })]);
    const a = await gpu.composite(at(0));
    expect((await gpu.composite(at(0))).pixels).toEqual(a.pixels);
    expect((await gpu.composite(at(4))).pixels).not.toEqual(a.pixels);
    await expectMatches(at(0));
    await expectMatches(at(4));
  });

  it("pads for chromatic aberration so the shifted channels reach past the raster edge", async () => {
    const white = { width: 20, height: 20, pixels: new Uint8Array(20 * 20 * 4).fill(255) };
    const p = plan([
      solid("w", white, {
        matrix: [1, 0, 0, 1, 20, 14],
        effects: [{ type: "chromatic-aberration", amount: 6 }],
      }),
    ]);
    await expectMatches(p);
    const { pixels } = await gpu.composite(p);
    const at = (x: number, y: number) => [...pixels.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
    const left = at(19, 24);
    expect(left[3]).toBeGreaterThan(0);
    // Outside the edge only the channel shifted inwards still sees the layer: blue on every side.
    expect(left[2]).toBeGreaterThan(left[0] ?? 255);
    expect(at(40, 24)[2]).toBeGreaterThan(at(40, 24)[0] ?? 255);
  });

  describe("looks stay anchored to the unpadded raster", () => {
    const flat32 = { width: 32, height: 32, pixels: new Uint8Array(32 * 32 * 4).fill(0) };
    for (let i = 0; i < flat32.pixels.length; i += 4) flat32.pixels.set([200, 120, 60, 255], i);
    const lookStack = (look: ResolvedEffect, before: ResolvedEffect[]) =>
      plan([solid("s", flat32, { matrix: [1, 0, 0, 1, 16, 8], effects: [...before, look] })]);
    const interiorEqual = async (a: FramePlan, b: FramePlan) => {
      const [pa, pb] = [(await gpu.composite(a)).pixels, (await gpu.composite(b)).pixels];
      // The aberration itself fringes the outermost few pixels, so look past them.
      for (let y = 12; y < 36; y++)
        for (let x = 20; x < 44; x++)
          for (let k = 0; k < 4; k++) expect(pa[(y * W + x) * 4 + k]).toBe(pb[(y * W + x) * 4 + k]);
    };
    const names = ["vignette", "grain", "scanlines"] as const;
    for (const name of names)
      it(`gives the same ${name} interior with and without chromatic aberration`, async () => {
        const look = looks[name] as ResolvedEffect;
        const plain = lookStack(look, []);
        const padded = lookStack(look, [{ type: "chromatic-aberration", amount: 3 }]);
        await interiorEqual(plain, padded);
        await expectMatches(padded);
      });
    it("keeps static grain still while a glow radius animates before it", async () => {
      const grain = looks.grain as ResolvedEffect;
      const glow = (radius: number): ResolvedEffect => ({
        type: "glow",
        radius,
        intensity: 1,
        color,
      });
      await interiorEqual(lookStack(grain, [glow(2)]), lookStack(grain, [glow(6)]));
    });
  });

  it("keeps the edge colour under chromatic aberration on an adjustment layer", async () => {
    const adjustment: PlannedAdjustmentLayer = {
      type: "adjustment",
      id: "adj",
      blendMode: "normal",
      opacity: 1,
      effects: [{ type: "chromatic-aberration", amount: 8 }],
      mask: null,
      matte: null,
    };
    const opaque = { width: W, height: H, pixels: new Uint8Array(W * H * 4) };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        opaque.pixels.set([(x * 4) % 256, (y * 5) % 256, 90, 255], (y * W + x) * 4);
    const p = plan([adjustment, solid("bg", opaque)]);
    await expectMatches(p);
    const { pixels } = await gpu.composite(p);
    // The left edge column keeps its backdrop colour instead of fringing towards transparent.
    expect(pixels[20 * W * 4 + 3]).toBe(255);
    expect(pixels[20 * W * 4 + 2]).toBe(90);
  });

  it("catches a mismatched hash: another grain or noise seed on the GPU fails the comparison", async () => {
    const grain = {
      type: "grain",
      amount: 0.6,
      size: 2,
      seed: 9,
      frame: 1,
      monochrome: false,
    } as const;
    const p = plan([solid("s", gradient(W, H, 2), { effects: [grain] })]);
    expect((await compare(p, p, () => false)).bad).toEqual([]);
    const other = plan([solid("s", gradient(W, H, 2), { effects: [{ ...grain, seed: 10 }] })]);
    expect((await compare(p, other, () => false)).bad.length).toBeGreaterThan(100);
    const noise = generators["noise, 1 octave"] as Extract<ResolvedGenerator, { type: "noise" }>;
    const n = plan([generatorLayer("n", W, H, noise)]);
    const wrong = plan([generatorLayer("n", W, H, { ...noise, seed: noise.seed + 1 })]);
    expect((await compare(n, wrong, () => false)).bad.length).toBeGreaterThan(100);
  });

  it("refuses a generator over the frame budget or the texture size limit and stays usable", async () => {
    const noise = generators["noise, 6 octaves"] as ResolvedGenerator;
    const huge = plan([generatorLayer("huge-noise", 8192, 8192, noise)]);
    expect(() => compositeReference(huge)).toThrow(/huge-noise.*frame budget/);
    await expect(gpu.composite(huge)).rejects.toThrow(/huge-noise.*frame budget/);
    const limit = await gpu.page.evaluate(() =>
      (
        document.createElement("canvas").getContext("webgl2") as WebGL2RenderingContext
      ).getParameter(WebGL2RenderingContext.MAX_TEXTURE_SIZE),
    );
    const wide = generatorLayer(
      "wide",
      limit + 1,
      1,
      generators["linear gradient"] as ResolvedGenerator,
    );
    await expect(gpu.composite(plan([wide]))).rejects.toThrow(/texture size limit/);
    await expectMatches(
      plan([generatorLayer("ok", W, H, generators["linear gradient"] as ResolvedGenerator)]),
    );
  });

  it("returns identical bytes for every generator and look in one frame", async () => {
    const layers = ["linear gradient", "noise, 6 octaves", "stripes pattern", "aurora, 4 colors"]
      .map((name) => generators[name] as ResolvedGenerator)
      .map((g, i) =>
        generatorLayer(`g${i}`, W, H, g, {
          opacity: 0.8,
          blendMode: i % 2 === 0 ? "normal" : "screen",
          matrix: [0.9, 0.05 * i, -0.05, 0.9, i * 2, 1],
          effects: i === 0 ? Object.values(looks) : [],
        }),
      );
    const p = plan(layers);
    const first = await gpu.composite(p);
    expect((await gpu.composite(p)).pixels).toEqual(first.pixels);
    expect(compositeReference(p).pixels.length).toBe(first.pixels.length);
  });

  it("refuses an image larger than the GPU's texture size limit", async () => {
    const limit = await gpu.page.evaluate(() =>
      (
        document.createElement("canvas").getContext("webgl2") as WebGL2RenderingContext
      ).getParameter(WebGL2RenderingContext.MAX_TEXTURE_SIZE),
    );
    const wide = { width: limit + 1, height: 1, pixels: new Uint8Array((limit + 1) * 4) };
    await expect(gpu.composite(plan([solid("w", wide)]))).rejects.toThrow(/texture size limit/);
    // The compositor stays usable afterwards.
    await expectMatches(plan([solid("ok", gradient(W, H, 1))]));
  });

  it("returns identical bytes for the same plan, also on a fresh browser", async () => {
    const p = plan(
      BLEND_MODES.slice(0, 8).map((mode, i) =>
        solid(`l${i}`, gradient(W, H, i), {
          blendMode: mode,
          opacity: 0.9,
          matrix: [0.9, 0.1 * i, -0.05, 0.8, i, 2],
        }),
      ),
    );
    const first = await gpu.composite(p);
    expect((await gpu.composite(p)).pixels).toEqual(first.pixels);
    const other = await launchGpu();
    try {
      expect((await other.composite(p)).pixels).toEqual(first.pixels);
    } finally {
      await other.close();
    }
  }, 60_000);
  /**
   * Runs `frames` (plans built in the page from `blendModes`/`matrices`) on a fresh compositor whose
   * program and texture calls are counted, and reports the counts after each frame and disposal.
   */
  async function probe(
    frames: { modes: string[]; matrices?: number[][]; size?: [number, number] }[],
  ) {
    return gpu.page.evaluate((input) => {
      const g = globalThis as unknown as {
        KynimoCompositor: {
          createCompositor(gl: WebGL2RenderingContext): {
            composite(plan: unknown): unknown;
            dispose(): void;
          };
        };
      };
      const gl = document.createElement("canvas").getContext("webgl2") as WebGL2RenderingContext;
      let programs = 0;
      let deletedPrograms = 0;
      let textures = 0;
      const count = <
        K extends "createProgram" | "deleteProgram" | "createTexture" | "deleteTexture",
      >(
        name: K,
        by: () => void,
      ) => {
        const real = gl[name].bind(gl) as (...a: unknown[]) => unknown;
        (gl as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
          by();
          return real(...a);
        };
      };
      count("createProgram", () => programs++);
      count("deleteProgram", () => deletedPrograms++);
      count("createTexture", () => textures++);
      count("deleteTexture", () => textures--);
      const compositor = g.KynimoCompositor.createCompositor(gl);
      const baseTextures = textures;
      const after: { programs: number; textures: number }[] = [];
      for (const { modes, matrices, size = [32, 24] } of input) {
        const [width = 32, height = 24] = size;
        const pixels = new Uint8Array(width * height * 4).fill(160);
        const layers = modes.map((blendMode, i) => ({
          id: `l${i}`,
          type: "solid",
          space: "layer",
          opacity: 1,
          blendMode,
          mask: null,
          matte: null,
          matrix: matrices?.[i] ?? [1, 0, 0, 1, 0, 0],
          raster: { width, height, pixels },
        }));
        compositor.composite({
          width,
          height,
          background: null,
          layers,
          skipped: [],
          warnings: [],
        });
        after.push({ programs, textures: textures - baseTextures });
      }
      compositor.dispose();
      return { after, deletedPrograms, programs, leftover: textures };
    }, frames);
  }

  it("compiles one program per distinct variant, on first use, and reuses it across frames", async () => {
    const still = [1, 0, 0, 1, 0, 0];
    const half = [1, 0, 0, 1, 0.5, 0];
    const frame = {
      modes: ["normal", "multiply", "normal", "multiply"],
      matrices: [still, still, half],
    };
    const normal = { modes: ["normal"] };
    const { after, deletedPrograms, programs } = await probe([
      normal, // prepare, place (texel copy), blend normal, final
      frame, // + blend multiply, place (bilinear)
      frame,
      frame,
      { modes: ["screen"] }, // + blend screen
      { modes: ["screen", "normal"] },
    ]);
    expect(after.map((a) => a.programs)).toEqual([4, 6, 6, 6, 7, 7]);
    expect(deletedPrograms).toBe(programs);
  });

  it("recycles render targets: rendering more frames does not grow the live textures", async () => {
    const stack = { modes: ["normal", "multiply", "screen", "normal"] };
    const idle = { modes: [] };
    const { after, leftover } = await probe([stack, stack, stack, stack, stack, idle, idle, idle]);
    const live = after.map((a) => a.textures);
    expect(live[0]).toBeGreaterThan(0);
    expect(live.slice(1, 5)).toEqual([live[0], live[0], live[0], live[0]]);
    // Targets idle for two frames are released, down to what an empty frame needs.
    expect(live[7]).toBeLessThan(live[0] as number);
    expect(live[7]).toBe(live[6]);
    expect(leftover).toBe(0);
  });

  it("caps idle pooled bytes within a frame: many distinct raster sizes stay near the cap and match the reference", async () => {
    const layerCount = 60;
    const size = (i: number): [number, number] => [1200 + i, 680 + i];
    const flat = (i: number): RasterImage => {
      const [width, height] = size(i);
      return { width, height, pixels: new Uint8Array(width * height * 4).fill(40 + i) };
    };
    const big = plan(
      Array.from({ length: layerCount }, (_, i) =>
        solid(`l${i}`, flat(i), { opacity: 0.5, blendMode: i % 2 === 0 ? "normal" : "multiply" }),
      ),
      { width: 1280, height: 720 },
    );
    const { peak, pixels } = await gpu.page.evaluate(
      ({ count }) => {
        const g = globalThis as unknown as {
          KynimoCompositor: {
            createCompositor(gl: WebGL2RenderingContext): {
              composite(plan: unknown): unknown;
              dispose(): void;
            };
          };
        };
        const gl = document.createElement("canvas").getContext("webgl2") as WebGL2RenderingContext;
        const bytes = new Map<WebGLTexture, number>();
        let live = 0;
        let peak = 0;
        const realCreate = gl.createTexture.bind(gl);
        gl.createTexture = () => {
          const t = realCreate() as WebGLTexture;
          bytes.set(t, 0);
          return t;
        };
        const realImage = gl.texImage2D.bind(gl) as (...a: unknown[]) => void;
        (gl as unknown as Record<string, unknown>).texImage2D = (...a: unknown[]) => {
          const t = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture;
          const [, , internal, width, height] = a as number[];
          live -= bytes.get(t) ?? 0;
          const b = (width ?? 0) * (height ?? 0) * (internal === gl.RGBA16F ? 8 : 4);
          bytes.set(t, b);
          live += b;
          peak = Math.max(peak, live);
          realImage(...a);
        };
        const realDelete = gl.deleteTexture.bind(gl);
        gl.deleteTexture = (t: WebGLTexture | null) => {
          if (t !== null) live -= bytes.get(t) ?? 0;
          if (t !== null) bytes.delete(t);
          realDelete(t);
        };
        const compositor = g.KynimoCompositor.createCompositor(gl);
        const layers = Array.from({ length: count }, (_, i) => {
          const width = 1200 + i;
          const height = 680 + i;
          return {
            id: `l${i}`,
            type: "solid",
            space: "layer",
            opacity: 0.5,
            blendMode: i % 2 === 0 ? "normal" : "multiply",
            mask: null,
            matte: null,
            matrix: [1, 0, 0, 1, 0, 0],
            raster: { width, height, pixels: new Uint8Array(width * height * 4).fill(40 + i) },
          };
        });
        const out = compositor.composite({
          width: 1280,
          height: 720,
          background: null,
          layers,
          skipped: [],
          warnings: [],
        }) as { pixels: Uint8Array };
        compositor.dispose();
        let binary = "";
        for (let i = 0; i < out.pixels.length; i += 0x8000)
          binary += String.fromCharCode(...out.pixels.subarray(i, i + 0x8000));
        return { peak, pixels: btoa(binary) };
      },
      { count: layerCount },
    );
    // In use at once: a few full-frame targets and one uploaded raster; idle adds at most 64 MiB.
    const inUse = 8 * 1280 * 720 * 8;
    expect(peak).toBeLessThanOrEqual(inUse + 64 * 1024 * 1024);
    const got = Buffer.from(pixels, "base64");
    const ref = compositeReference(big).pixels;
    let gap = 0;
    for (let i = 0; i < ref.length; i++)
      gap = Math.max(gap, Math.abs((ref[i] ?? 0) - (got[i] ?? 0)));
    expect(got.length).toBe(ref.length);
    expect(gap).toBeLessThanOrEqual(2);
  }, 120_000);
});

describe("WebGL2 compositor: 3D layers (projective placement)", () => {
  /** A layer-space layer placed by a projection; `matrix` is unused for it. */
  const card = (
    id: string,
    raster: RasterImage,
    view: Parameters<typeof cardProjection>[0] extends infer O
      ? Omit<O, "comp" | "anchor"> & { anchor?: [number, number] }
      : never,
    overrides: Partial<PlannedLayer> = {},
  ): PlannedLayer =>
    solid(id, raster, {
      projection: cardProjection({
        comp: [W, H],
        anchor: [raster.width / 2, raster.height / 2],
        ...view,
      }),
      ...overrides,
    } as Partial<PlannedLayer>);

  /** Matches the reference, and renders byte-identically twice on one compositor (no leaked state). */
  async function expectParity(p: FramePlan) {
    const { bad } = await compare(p, p, () => false);
    expect(bad.slice(0, 8)).toEqual([]);
    const first = await gpu.composite(p);
    const second = await gpu.composite(p);
    expect(second.pixels).toEqual(first.pixels);
    expect(first.pixels.some((v) => v !== 0)).toBe(true);
  }

  it("matches placement at the scales 1.0, 0.6 and 0.3, foreshortened so the level varies", async () => {
    // Mean on-screen scale = zoom / depth; each card is also turned 50 degrees about Y, so its
    // near edge is magnified and its far edge minified more than the mean.
    const zoom = 60;
    for (const [scale, size] of [
      [1, [60, 45]],
      [0.6, [100, 80]],
      [0.3, [200, 160]],
    ] as const) {
      const p = plan([
        card("p", gradient(size[0], size[1], 7), {
          zoom,
          position: [32, 24, zoom / scale - zoom],
          rotationY: 50,
        }),
        card("q", gradient(size[0], size[1], 2), {
          zoom,
          position: [30, 26, zoom / scale - zoom],
          rotationX: -40,
          rotationY: -20,
        }),
      ]);
      await expectParity(p);
    }
  });

  it("matches a card crossing the near plane, with nothing mirrored", async () => {
    // Zoom 20, a card 1.2 in front of the camera at its centre and tipped about X: the near plane
    // cuts it across the frame, and the half behind the camera would mirror in over the rest.
    const p = plan([
      solid("bg", gradient(W, H, 3)),
      card("p", gradient(40, 30, 5), { zoom: 20, position: [32, 24, -18.8], rotationX: 60 }),
    ]);
    await expectParity(p);
    const out = await gpu.composite(p);
    const bg = await gpu.composite(plan([solid("bg", gradient(W, H, 3))]));
    // The in-front part (upper rows) covers the background...
    const top = (y: number) => Array.from(out.pixels.slice((y * W + 32) * 4, (y * W + 32) * 4 + 4));
    expect(top(20)).not.toEqual(
      Array.from(bg.pixels.slice((20 * W + 32) * 4, (20 * W + 32) * 4 + 4)),
    );
    // ...lower rows (behind the near plane) show only the background.
    for (const y of [30, 40, 47]) {
      const i = (y * W + 32) * 4;
      expect(Array.from(out.pixels.slice(i, i + 4))).toEqual(Array.from(bg.pixels.slice(i, i + 4)));
    }
  });

  it("draws nothing for a layer whose inverse overflows float32, like the reference", async () => {
    const p = plan([
      card("p", gradient(40, 30, 5), { zoom: 60, position: [32, 24, 0], scale: 1e-42 }),
    ]);
    const { bad } = await compare(p, p, () => false);
    expect(bad).toEqual([]);
    const out = await gpu.composite(p);
    expect(out.pixels.every((v) => v === 0)).toBe(true);
  });

  it("matches a 3D layer with a luma matte, a mask and an effect", async () => {
    const matte = solid("m", gradient(W, H, 4));
    await expectParity(
      plan([
        card(
          "p",
          gradient(40, 30, 6),
          { zoom: 60, position: [32, 24, 20], rotationY: 35 },
          {
            opacity: 0.8,
            mask: coverage(40, 30),
            effects: [
              { type: "gaussian-blur", radius: 2.5 },
              {
                type: "glow",
                radius: 3,
                color: { r: 0.2, g: 0.8, b: 0.4, a: 0.9 },
                intensity: 0.6,
              },
            ],
            matte: { layerId: "m", mode: "luma", source: matte } as never,
          },
        ),
        solid("bg", gradient(W, H, 8)),
      ]),
    );
  });

  it("matches a 3D precomp", async () => {
    const inner = plan([solid("a", gradient(40, 30, 10), { blendMode: "overlay" })], {
      width: 40,
      height: 30,
    });
    const nested = {
      id: "pre",
      type: "precomp",
      space: "layer",
      opacity: 0.9,
      blendMode: "normal",
      mask: null,
      matte: null,
      matrix: [1, 0, 0, 1, 0, 0],
      frame: inner,
      projection: cardProjection({
        comp: [W, H],
        zoom: 60,
        position: [32, 24, 10],
        anchor: [20, 15],
        rotationY: -45,
      }),
    } as PlannedLayer;
    await expectParity(plan([nested, solid("bg", gradient(W, H, 12))]));
  });

  it("matches a motion-blurred 3D layer under a moving camera", async () => {
    const samples = [0, 1, 2, 3].map((i) => ({
      delta: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
      opacity: 1,
      projection: cardProjection({
        comp: [W, H],
        zoom: 60,
        position: [32, 24, 0],
        anchor: [20, 15],
        rotationY: 30,
        camera: [32 + 3 * i, 24, -60],
      }),
    }));
    const centre = samples[1]?.projection;
    await expectParity(
      plan([
        card("p", gradient(40, 30, 9), { zoom: 60, position: [32, 24, 0] }, {
          projection: centre,
          motion: samples,
        } as Partial<PlannedLayer>),
        solid("bg", gradient(W, H, 1)),
      ]),
    );
  });

  it("matches non-normal blend modes over a 2D layer", async () => {
    for (const blendMode of ["multiply", "screen", "difference"] as const)
      await expectParity(
        plan([
          card(
            "p",
            gradient(40, 30, 13),
            { zoom: 60, position: [32, 24, 0], rotationX: 30 },
            {
              blendMode,
              opacity: 0.85,
            },
          ),
          solid("bg", gradient(W, H, 14)),
        ]),
      );
  });

  it("renders a 2D frame the same before and after 3D frames", async () => {
    const flat = plan([
      solid("a", gradient(40, 30, 2), {
        matrix: [1, 0, 0, 1, 3.5, 2],
        effects: [{ type: "gaussian-blur", radius: 2 }],
      }),
      solid("b", gradient(W, H, 5), { matrix: [0.4, 0.1, -0.1, 0.4, 5, 5], blendMode: "screen" }),
    ]);
    const before = await gpu.composite(flat);
    await gpu.composite(
      plan([card("p", gradient(40, 30, 1), { zoom: 60, position: [32, 24, 0], rotationY: 40 })]),
    );
    await gpu.composite(
      plan([
        card(
          "p",
          gradient(40, 30, 1),
          { zoom: 60, position: [32, 24, 0], rotationY: 40 },
          {
            matte: { layerId: "m", mode: "alpha", source: solid("m", gradient(W, H, 4)) } as never,
            effects: [{ type: "gaussian-blur", radius: 2 }],
            motion: [
              { delta: [1, 0, 0, 1, 0, 0], opacity: 1 },
              { delta: [1, 0, 0, 1, 0, 0], opacity: 1 },
            ],
          },
        ),
      ]),
    );
    expect((await gpu.composite(flat)).pixels).toEqual(before.pixels);
  });
});

it("matches the reference for a custom generator and a single-input effect", async () => {
  const shader = (kind: "generator" | "effect", source: string): ResolvedShader => ({
    type: "custom-shader",
    definition: {
      id: "custom-parity",
      title: "Parity",
      version: "1.0.0",
      hash: "0".repeat(64),
      kind,
      source,
      uniforms: {},
    },
    frame: 3,
    fps: 30,
    seed: 0.25,
    uniforms: [],
  });
  const generator = shader("generator", "return vec4(uv, seed, 0.75);");
  const effect = shader(
    "effect",
    "vec4 c = sampleInput(uv); return vec4(c.bgr * (0.75 + frame / fps), c.a);",
  );
  const custom: PlannedLayer = {
    id: "generator",
    type: "generator",
    width: W,
    height: H,
    generator,
    space: "layer",
    opacity: 1,
    blendMode: "normal",
    mask: coverage(W, H),
    matte: null,
    matrix: [1, 0, 0, 1, 0, 0],
    effects: [effect],
  };
  const p = plan([custom]);
  await expectMatches(p);
  const first = await gpu.composite(p);
  expect((await gpu.composite(p)).pixels).toEqual(first.pixels);
  expect(first.pixels.some((value) => value > 0)).toBe(true);
});

it("rejects custom shader work before allocating its target", async () => {
  const huge: PlannedLayer = {
    id: "oversized-shader",
    type: "generator",
    width: 8192,
    height: 8192,
    generator: {
      type: "custom-shader",
      definition: {
        id: "custom-large",
        version: "1.0.0",
        title: "Large",
        hash: "0".repeat(64),
        kind: "generator",
        uniforms: {},
        source: "return vec4(uv, 0.0, 1.0);",
      },
      frame: 0,
      fps: 30,
      seed: 0,
      uniforms: [],
    },
    space: "layer",
    opacity: 1,
    blendMode: "normal",
    mask: null,
    matte: null,
    matrix: [1, 0, 0, 1, 0, 0],
  };
  const p = plan([huge]);
  await expect(gpu.composite(p)).rejects.toThrow(/oversized-shader.*custom shader work/);
  expect(() => compositeReference(p)).toThrow(/oversized-shader.*custom shader work/);
});

it("rounds custom shader intermediates like GLSL highp", async () => {
  const shader: PlannedLayer = {
    id: "rounding",
    type: "generator",
    width: W,
    height: H,
    generator: {
      type: "custom-shader",
      definition: {
        id: "custom-rounding",
        version: "1.0.0",
        title: "Rounding",
        hash: "0".repeat(64),
        kind: "generator",
        uniforms: { u_offset: { type: "float", default: 500000 } },
        source:
          "float offset = u_offset + 0.01; return vec4((offset - u_offset) * 100.0, 0.0, 0.0, 1.0);",
      },
      frame: 0,
      fps: 30,
      seed: 0,
      uniforms: [[500000]],
    },
    space: "layer",
    opacity: 1,
    blendMode: "normal",
    mask: null,
    matte: null,
    matrix: [1, 0, 0, 1, 0, 0],
  };
  const p = plan([shader]);
  expect([...compositeReference(p).pixels.slice(0, 4)]).toEqual([0, 0, 0, 255]);
  await expectMatches(p);
});
