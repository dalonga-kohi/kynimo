import { describe, expect, it } from "vitest";
import { pixel } from "../canvaskit.test-util.js";
import type { FramePlan, PlannedLayer, RasterImage } from "../raster.js";
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
});
