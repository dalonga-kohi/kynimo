import { BLEND_MODES, type BlendMode } from "@kynimo/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CoverageImage, FramePlan, PlannedLayer, RasterImage } from "../raster.js";
import { type GpuSession, launchGpu, maxDifference } from "./browser.test-util.js";
import { compositeReference } from "./reference.js";

let gpu: GpuSession;
beforeAll(async () => {
  gpu = await launchGpu();
}, 60_000);
afterAll(async () => {
  await gpu?.close();
});

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

const plan = (layers: PlannedLayer[], overrides: Partial<FramePlan> = {}): FramePlan => ({
  width: W,
  height: H,
  background: null,
  layers,
  skipped: [],
  warnings: [],
  ...overrides,
});

/** Modes with discontinuities, where float differences can flip a few pixels to the other side. */
const STEPPED: ReadonlySet<BlendMode> = new Set([
  "hard-mix",
  "divide",
  "color-dodge",
  "color-burn",
  "vivid-light",
]);

/** GPU and reference agree within 2/255 per channel (RGBA16F against float64). */
async function expectMatches(p: FramePlan, mode: BlendMode = "normal") {
  const ref = compositeReference(p);
  const out = await gpu.composite(p);
  expect([out.width, out.height]).toEqual([ref.width, ref.height]);
  if (STEPPED.has(mode)) {
    let off = 0;
    for (let i = 0; i < ref.pixels.length; i++)
      if (Math.abs((ref.pixels[i] ?? 0) - (out.pixels[i] ?? 0)) > 2) off++;
    expect(off / ref.pixels.length).toBeLessThan(0.01);
  } else expect(maxDifference(ref, out).diff).toBeLessThanOrEqual(2);
}

describe("WebGL2 compositor on SwiftShader", () => {
  it("runs on SwiftShader", () => {
    expect(gpu.renderer).toMatch(/SwiftShader/);
  });

  it.each(BLEND_MODES)("matches the reference for %s", async (mode) => {
    const backdrop = solid("b", gradient(W, H, 1));
    const source = solid("s", gradient(W, H, 2), { blendMode: mode, opacity: 0.8 });
    await expectMatches(
      plan([source, backdrop], { background: { r: 0.1, g: 0.2, b: 0.3, a: 1 } }),
      mode,
    );
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
});
