import { evaluateFrame, projectPoint } from "@kynimo/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledFonts, canvasKit, pixel } from "./canvaskit.test-util.js";
import { type GpuSession, launchGpu } from "./compositor/browser.test-util.js";
import { placement, projectivePlacement } from "./compositor/pipeline.js";
import { compositeReference } from "./compositor/reference.js";
import { FrameDeformWork, MAX_FRAME_DEFORM_WORK, planDeform } from "./deform.js";
import {
  composition,
  fill,
  layer,
  type Obj,
  project,
  prop,
  rect,
  shapeLayer,
  textLayer,
  transform,
} from "./fixtures.test-util.js";
import { rasterizeFrame } from "./frame.js";
import { ImageLibrary } from "./images.js";
import type { FramePlan, PlannedDeform, PlannedLayerSpaceLayer, RasterImage } from "./raster.js";

let gpu: GpuSession;
let assets: Parameters<typeof rasterizeFrame>[2];
let ck: Awaited<ReturnType<typeof canvasKit>>;
beforeAll(async () => {
  ck = await canvasKit();
  assets = { fonts: await bundledFonts(ck), images: new ImageLibrary(ck) };
  gpu = await launchGpu();
}, 60_000);
afterAll(async () => {
  await gpu?.close();
}, 60_000);

const red = [255, 0, 0, 255];
const blue = [0, 0, 255, 255];
const clear = [0, 0, 0, 0];

const pin = (id: string, rest: [number, number], end: [number, number]) => ({
  id,
  rest,
  position: prop(end),
});
const kf = (frame: number, value: unknown) => ({ frame, value, interpolation: { type: "linear" } });
const active = {
  density: 8,
  iterations: 10,
  pins: [pin("root", [-10, 0], [-10, 0]), pin("tip", [32, 9], [48, 16])],
};
const evaluate = (layers: Obj[], frame = 0) =>
  evaluateFrame(project([composition("main", layers)]), frame);
const plan = (layers: Obj[], frame = 0) => rasterizeFrame(ck, evaluate(layers, frame), assets);

const only = (p: FramePlan): PlannedLayerSpaceLayer & { deform: PlannedDeform } => {
  expect(p.layers).toHaveLength(1);
  const l = p.layers[0];
  if (
    l === undefined ||
    l.type === "adjustment" ||
    l.space !== "layer" ||
    !("raster" in l) ||
    l.deform === undefined
  )
    throw new Error("expected one deformed raster layer");
  return l as PlannedLayerSpaceLayer & { deform: PlannedDeform };
};

function difference(a: RasterImage, b: RasterImage): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let peak = 0;
  for (let i = 0; i < a.pixels.length; i++)
    peak = Math.max(peak, Math.abs((a.pixels[i] as number) - (b.pixels[i] as number)));
  return peak;
}

async function parity(p: FramePlan, tolerance = 1): Promise<RasterImage> {
  const cpu = compositeReference(p);
  expect(compositeReference(p).pixels).toEqual(cpu.pixels);
  const first = await gpu.composite(p);
  expect((await gpu.composite(p)).pixels).toEqual(first.pixels);
  expect(difference(cpu, first)).toBeLessThanOrEqual(tolerance);
  return first;
}

describe("deformed vector layers", () => {
  const box = (extra: Obj = {}) =>
    shapeLayer("shape", [rect([10, 8], [40, 16]), fill()], {
      deform: active,
      transform: transform({ position: prop([65, 44]) }),
      ...extra,
    });

  it("preserves the shape's raster offset through 2D placement", () => {
    const flat = only(plan([box()]));
    expect(flat.raster).toMatchObject({ width: 42, height: 18 });
    expect(flat.matrix).toEqual([1, 0, 0, 1, 54, 43]);
    const placed = placement(flat);
    expect(placed[4]).toBe(54 + flat.deform.origin[0]);
    expect(placed[5]).toBe(43 + flat.deform.origin[1]);
    expect(pixel(compositeReference(plan([box()])), 103, 54)[3]).toBeGreaterThan(0);
  });

  it("dissolves between the backdrop and the placed, warped layer", async () => {
    const backdrop = layer("backdrop", "solid", { width: 200, height: 100, color: "#0000ff" });
    const x = 103;
    const y = 54;
    expect(pixel(compositeReference(plan([box({ deform: null }), backdrop])), x, y)).toEqual(blue);
    const warped = pixel(compositeReference(plan([box(), backdrop])), x, y);
    expect(warped[0]).toBeGreaterThan(0);
    const half = await parity(
      plan([box({ transition: { kind: "dissolve", progress: prop(0.5) } }), backdrop]),
    );
    for (const [channel, sample] of pixel(half, x, y).entries()) {
      const expected = Math.round(((warped[channel] as number) + (blue[channel] as number)) / 2);
      expect(Math.abs(sample - expected)).toBeLessThanOrEqual(1);
    }
    expect(pixel(half, 0, 0)).toEqual(blue);
  });

  it("rasterizes text in layer space, independent of 2D placement scale", () => {
    const text = (scale: number) =>
      textLayer("word", "Puppet", {
        deform: active,
        transform: transform({ position: prop([16, 49]), scale: prop([scale, scale]) }),
      });
    const full = only(plan([text(1)]));
    const small = only(plan([text(0.3)]));
    expect(small.raster).toEqual(full.raster);
    expect(small.deform).toEqual(full.deform);
    expect(full.raster.pixels.some((value) => value > 0)).toBe(true);
  });

  it("keeps the warped origin under projective placement without deriving scale from the camera", async () => {
    const card = box({
      threeD: true,
      transform: transform({
        position: prop([110, 48]),
        rotationY: prop(25),
        positionZ: prop(-100),
      }),
    });
    const p = plan([card]);
    const tilted = only(p);
    expect(tilted.raster).toEqual(only(plan([box()])).raster);
    expect(tilted.deform).toEqual(only(plan([box()])).deform);
    const proj = evaluate([card]).layers[0]?.projection;
    if (proj == null) throw new Error("expected a projected layer");
    const [x, y] = tilted.deform.origin;
    const expected = projectPoint(proj, [x - 11, y - 1]);
    const actual = projectPoint(projectivePlacement(tilted), [0, 0]);
    expect(actual[0]).toBeCloseTo(expected[0], 10);
    expect(actual[1]).toBeCloseTo(expected[1], 10);
    await parity(p);
  });

  it("draws a deformed part of a behind-camera rest raster that enters view", async () => {
    const card = box({
      threeD: true,
      transform: transform({
        position: prop([0, 45]),
        rotationY: prop(45),
        positionZ: prop(-309),
      }),
      deform: { density: 4, pins: [pin("tip", [30, 12], [140, 12])] },
    });
    expect(plan([{ ...card, deform: null }]).layers).toEqual([]);
    const out = await parity(plan([card]));
    expect(out.pixels.some((value) => value > 0)).toBe(true);
  });

  it("samples one center pose while varying placement over the shutter", async () => {
    const moving = box({
      deform: {
        ...active,
        pins: [
          active.pins[0],
          { id: "tip", rest: [32, 9], position: { keyframes: [kf(0, [32, 9]), kf(10, [72, 13])] } },
        ],
      },
      motionBlur: { samples: 4, shutterAngle: 360, shutterPhase: -180 },
      transform: transform({ position: { keyframes: [kf(0, [45, 44]), kf(10, [115, 44])] } }),
    });
    const blurred = plan([moving], 5);
    const still = plan([{ ...moving, motionBlur: null }], 5);
    const mesh = only(blurred);
    expect(mesh.motion).toHaveLength(4);
    expect(mesh.deform).toEqual(only(still).deform);
    expect(mesh.deform).not.toEqual(only(plan([moving], 6)).deform);
    expect(difference(compositeReference(blurred), compositeReference(still))).toBeGreaterThan(0);
    await parity(blurred);
  });

  it("shares the planning budget with layers inside precomps", () => {
    const inner = composition("inner", [box({ id: "inner-shape" })]);
    const precomp = layer("nested", "precomp", { compositionId: "inner" });
    const onlyChild = project([composition("main", [precomp]), inner]);
    const shared = project([composition("main", [precomp, box()]), inner]);
    // Find the smallest sufficient budget for the inner warp and give both layers that budget.
    let lo = 0;
    let hi = MAX_FRAME_DEFORM_WORK;
    const tryPlan = (d: ReturnType<typeof project>, limit: number) =>
      rasterizeFrame(ck, evaluateFrame(d, 0), assets, { maxDeformWork: limit });
    while (hi - lo > 1) {
      const mid = (hi + lo) >> 1;
      try {
        tryPlan(onlyChild, mid);
        hi = mid;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("frame budget")) throw error;
        lo = mid;
      }
    }
    expect(() => tryPlan(shared, hi)).toThrow(/shape.*frame budget/);
  });
});

const makePlan = (l: PlannedLayerSpaceLayer): FramePlan => ({
  width: 96,
  height: 64,
  background: null,
  layers: [l],
  skipped: [],
  warnings: [],
});
const raster = (
  width: number,
  height: number,
  color: (x: number, y: number) => readonly number[],
): RasterImage => {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) pixels.set(color(x, y), (y * width + x) * 4);
  return { width, height, pixels };
};
const sourceLayer = (
  r: RasterImage,
  deform: PlannedDeform | undefined,
  extra: Partial<PlannedLayerSpaceLayer> = {},
): PlannedLayerSpaceLayer => ({
  type: "image",
  id: "source",
  space: "layer",
  matrix: [1, 0, 0, 1, 0, 0],
  opacity: 1,
  raster: r,
  ...(deform === undefined ? {} : { deform }),
  mask: null,
  matte: null,
  blendMode: "normal",
  ...extra,
});
const triangle = (a: number[], b: number[], c: number[], [u, v]: [number, number]): number[] => [
  ...a,
  u,
  v,
  ...b,
  u,
  v,
  ...c,
  u,
  v,
];

describe("deform compositor parity", () => {
  it("preserves source samples in a near-collapsed triangle that covers a pixel center", async () => {
    const r = raster(8, 8, (x) => (x === 6 ? red : [0, 0, 0, 255]));
    const { warp } = planDeform(
      "thin",
      {
        density: 4,
        iterations: 10,
        pins: [
          { id: "left", rest: [6, 6], position: [1.4375, 1.5] },
          { id: "middle", rest: [8, 8], position: [129.4375, 129.4375] },
          { id: "right", rest: [6, 8], position: [257.625, 257.5625] },
        ],
      },
      { width: 8, height: 8, raster: r, mask: null },
      [1, 0, 0],
      [0, 0],
      new FrameDeformWork(),
    );
    if (warp === null) throw new Error("expected a mesh");
    const [x, y] = warp.origin;
    const p = {
      ...makePlan(sourceLayer(r, warp, { matrix: [1, 0, 0, 1, -x, -y] })),
      width: warp.width,
      height: warp.height,
    };
    const cpu = pixel(compositeReference(p), 129, 129);
    expect(cpu).toEqual([212, 0, 0, 255]);
    const first = await gpu.composite(p);
    const sample = pixel(first, 129, 129);
    // The thin triangle's exact centroid lands at this pixel. Its alpha must stay opaque.
    expect(sample[3], `sample [${sample}] at the centroid`).toBe(255);
    expect(Math.abs(sample[0] - cpu[0]), `sample [${sample}] at the centroid`).toBeLessThanOrEqual(
      1,
    );
    expect((await gpu.composite(p)).pixels).toEqual(first.pixels);
  });

  it.each([1, 0.6, 0.3])(
    "renders a masked and effected nonrigid raster twice at %s",
    async (scale) => {
      const width = 58;
      const height = 35;
      const r = raster(width, height, (x, y) => {
        const a = (x + y) % 17 === 0 ? 0 : ((x * 13 + y * 5) % 195) + 60;
        return [Math.min(a, x * 3), Math.min(a, y * 6), Math.floor(a / 2), a];
      });
      const coverage = Uint8Array.from({ length: width * height }, (_, i) =>
        i % width < 4 ? 0 : (i * 3) % 256,
      );
      const mask = { width, height, coverage };
      const { warp } = planDeform(
        "source",
        {
          ...active,
          pins: [
            { id: "root", rest: [0, 0], position: [0, 0] },
            { id: "tip", rest: [56, 28], position: [67, 39] },
          ],
        },
        { width, height, raster: r, mask },
        [1, 0, 0],
        [2, 2],
        new FrameDeformWork(),
      );
      if (warp === null) throw new Error("expected a mesh");
      const p = makePlan(
        sourceLayer(r, warp, {
          matrix: [scale, 0, 0, scale, 7.25, 8.5],
          mask,
          effects: [{ type: "gaussian-blur", radius: 2 }],
        }),
      );
      const out = await parity(p);
      expect(out.pixels.some((value) => value > 0)).toBe(true);
      expect(pixel(out, 0, 0)).toEqual(clear);
    },
  );

  it("applies the mask in source space before deform and the blur after deform", async () => {
    const width = 4;
    const height = 4;
    const r = raster(width, height, () => red);
    const mask = {
      width,
      height,
      coverage: Uint8Array.from({ length: 16 }, (_, i) => (i % 4 < 2 ? 255 : 0)),
    };
    const warp = {
      origin: [0, 0] as const,
      width: 16,
      height: 8,
      drawWork: 500,
      vertices: [0, 0, 0, 0, 16, 0, 4, 0, 16, 8, 4, 4, 0, 0, 0, 0, 16, 8, 4, 4, 0, 8, 0, 4],
    };
    const expanded = makePlan(
      sourceLayer(r, warp, {
        matrix: [1, 0, 0, 1, 10, 10],
        mask,
        effects: [{ type: "gaussian-blur", radius: 2 }],
      }),
    );
    // Build the same warped pixels, then apply blur by the ordinary effect path.
    const unfiltered = compositeReference(makePlan(sourceLayer(r, warp, { mask })));
    const filteredAgain = makePlan({
      ...sourceLayer(r, undefined),
      raster: raster(16, 8, (x, y) => pixel(unfiltered, x, y)),
      matrix: [1, 0, 0, 1, 10, 10],
      effects: [{ type: "gaussian-blur", radius: 2 }],
    });
    const out = await parity(expanded);
    expect(pixel(out, 14, 14)[3]).toBeGreaterThan(220);
    expect(pixel(out, 23, 14)).toEqual(clear);
    expect(difference(out, compositeReference(filteredAgain))).toBeLessThanOrEqual(2);
  });

  it("uses top-left edge ownership and later folds overwrite even with zero alpha", async () => {
    const r = raster(3, 1, (x) => [red, blue, clear][x] as number[]);
    const a = triangle([1.5, 1.5], [5.5, 1.5], [1.5, 5.5], [0.5, 0.5]);
    // Opposite winding of the adjacent triangle still owns the shared diagonal.
    const b = triangle([5.5, 1.5], [1.5, 5.5], [5.5, 5.5], [1.5, 0.5]);
    const overlap = triangle([2, 1], [4, 1], [2, 3], [2.5, 0.5]);
    // A subpixel sliver collapsed by raster quantization writes nothing.
    const degenerate = triangle([1.5, 1.5], [1.5, 5.5], [1.5, 3.5], [2.5, 0.5]);
    const base = { origin: [0, 0] as const, width: 8, height: 8, drawWork: 150 };
    const before = await parity(
      makePlan(sourceLayer(r, { ...base, vertices: [...a, ...b, ...degenerate] })),
      0,
    );
    expect(pixel(before, 1, 1)).toEqual(red);
    expect(pixel(before, 3, 3)).toEqual(blue);
    expect(pixel(before, 2, 1)).toEqual(red);
    const fold = await parity(
      makePlan(sourceLayer(r, { ...base, vertices: [...a, ...b, ...overlap] })),
      0,
    );
    expect(pixel(fold, 2, 1)).toEqual(clear);
    // Same pool size, mostly uncovered this time: old triangle pixels must be cleared.
    const sparse = await parity(makePlan(sourceLayer(r, { ...base, vertices: overlap })), 0);
    expect(pixel(sparse, 1, 1)).toEqual(clear);
    expect(pixel(sparse, 3, 3)).toEqual(clear);
  });

  it("charges actual repeated draws even when a matte source shares one plan", async () => {
    const r = raster(1, 1, () => red);
    const repeated = sourceLayer(r, {
      origin: [0, 0],
      width: 8,
      height: 8,
      drawWork: MAX_FRAME_DEFORM_WORK,
      vertices: triangle([1.5, 1.5], [5.5, 1.5], [1.5, 5.5], [0.5, 0.5]),
    });
    const p = makePlan({
      ...sourceLayer(r, undefined, { id: "matted" }),
      matte: { layerId: repeated.id, mode: "alpha", source: repeated },
    });
    p.layers.push(repeated);
    expect(() => compositeReference(p)).toThrow(/source.*deformation.*frame budget/);
    await expect(gpu.composite(p)).rejects.toThrow(/source.*deformation.*frame budget/);
    await parity(makePlan(repeated), 0);
  });
});
