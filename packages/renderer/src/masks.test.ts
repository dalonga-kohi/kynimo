import type { Affine, ResolvedMask } from "@kynimo/engine";
import { evaluateFrame } from "@kynimo/engine";
import { beforeAll, describe, expect, it } from "vitest";
import type { CanvasKit } from "./canvaskit.js";
import { bundledFonts, canvasKit, freshCanvasKit, pixel } from "./canvaskit.test-util.js";
import { compositeReference } from "./compositor/reference.js";
import {
  composition,
  fill,
  frameOf,
  layer,
  type Obj,
  project,
  prop,
  rect,
  shapeLayer,
  solidPaint,
  transform,
} from "./fixtures.test-util.js";
import type { FontLibrary } from "./fonts.js";
import { rasterizeFrame } from "./frame.js";
import { ImageLibrary } from "./images.js";
import { rasterizeMasks } from "./masks.js";
import type { CoverageImage, FramePlan, PlannedLayer } from "./raster.js";

let ck: CanvasKit;
let fonts: FontLibrary;
beforeAll(async () => {
  ck = await canvasKit();
  fonts = await bundledFonts(ck);
});

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** Closed axis-aligned rectangle path from (x0, y0) to (x1, y1). */
const box = (x0: number, y0: number, x1: number, y1: number) => ({
  closed: true,
  vertices: [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map((point) => ({
    point: point as [number, number],
    inTangent: [0, 0] as [number, number],
    outTangent: [0, 0] as [number, number],
  })),
});

const resolved = (
  path: ReturnType<typeof box>,
  overrides: Partial<ResolvedMask> = {},
): ResolvedMask => ({
  id: "m",
  mode: "add",
  inverted: false,
  path,
  feather: [0, 0],
  opacity: 1,
  expansion: 0,
  ...overrides,
});

const at = (c: CoverageImage | "empty" | null, x: number, y: number) => {
  if (c === null) return 255;
  if (c === "empty") return 0;
  return c.coverage[y * c.width + x] ?? -1;
};

const cover = (masks: ResolvedMask[], m: Affine = IDENTITY, w = 20, h = 20) =>
  rasterizeMasks(ck, masks, m, w, h);

describe("rasterizeMasks", () => {
  it("keeps the inside of an add mask and removes the outside", () => {
    const c = cover([resolved(box(5, 5, 15, 15))]);
    expect(at(c, 10, 10)).toBe(255);
    expect(at(c, 2, 10)).toBe(0);
    expect(at(c, 17, 17)).toBe(0);
  });

  it("returns null when every pixel is kept and 'empty' when none is", () => {
    expect(cover([resolved(box(-5, -5, 30, 30))])).toBeNull();
    expect(cover([resolved(box(40, 40, 50, 50))])).toBe("empty");
    expect(cover([])).toBeNull();
  });

  it("combines masks top-first: add, subtract, intersect", () => {
    const left = resolved(box(0, 0, 10, 20));
    const middle = resolved(box(5, 0, 15, 20));
    const c = cover([left, { ...middle, mode: "subtract" }]);
    expect([at(c, 2, 10), at(c, 7, 10), at(c, 12, 10)]).toEqual([255, 0, 0]);
    const d = cover([left, { ...middle, mode: "intersect" }]);
    expect([at(d, 2, 10), at(d, 7, 10), at(d, 12, 10)]).toEqual([0, 255, 0]);
    const e = cover([left, middle]);
    expect([at(e, 2, 10), at(e, 7, 10), at(e, 12, 10), at(e, 17, 10)]).toEqual([255, 255, 255, 0]);
  });

  it("starts from a full layer when the first mask subtracts, intersects or darkens", () => {
    const hole = resolved(box(5, 5, 15, 15), { mode: "subtract" });
    const c = cover([hole]);
    expect([at(c, 2, 2), at(c, 10, 10)]).toEqual([255, 0]);
    const d = cover([{ ...hole, mode: "darken", opacity: 0.5 }]);
    expect([at(d, 2, 2), at(d, 10, 10)]).toEqual([0, 128]);
  });

  it("lightens, darkens and differences coverage values", () => {
    const left = resolved(box(0, 0, 10, 20));
    const half = resolved(box(5, 0, 15, 20), { opacity: 0.5 });
    const row = (c: ReturnType<typeof cover>) => [at(c, 2, 10), at(c, 7, 10), at(c, 12, 10)];
    expect(row(cover([left, { ...half, mode: "lighten" }]))).toEqual([255, 255, 128]);
    expect(row(cover([left, { ...half, mode: "darken" }]))).toEqual([0, 128, 0]);
    expect(row(cover([left, { ...half, mode: "difference" }]))).toEqual([255, 128, 128]);
  });

  it("inverts the path before opacity scales it", () => {
    const c = cover([resolved(box(5, 5, 15, 15), { inverted: true, opacity: 0.5 })]);
    expect([at(c, 2, 2), at(c, 10, 10)]).toEqual([128, 0]);
  });

  it("covers nothing with an open path", () => {
    expect(cover([resolved({ ...box(5, 5, 15, 15), closed: false })])).toBe("empty");
  });

  it("grows and shrinks the path by its expansion", () => {
    const grown = cover([resolved(box(8, 8, 12, 12), { expansion: 3 })]);
    expect([at(grown, 6, 10), at(grown, 4, 10)]).toEqual([255, 0]);
    // Round joins: the corner pixel of the grown square sits outside the rounded corner.
    expect(at(grown, 5, 5)).toBeLessThan(64); // a miter join would cover it fully
    const shrunk = cover([resolved(box(4, 4, 16, 16), { expansion: -3 })]);
    expect([at(shrunk, 6, 10), at(shrunk, 8, 10)]).toEqual([0, 255]);
    expect(cover([resolved(box(8, 8, 12, 12), { expansion: -3 })])).toBe("empty");
  });

  it("clamps expansion to the composition size limit, so huge values cover everything or nothing", () => {
    expect(cover([resolved(box(8, 8, 12, 12), { expansion: -1e300 })])).toBe("empty");
    expect(cover([resolved(box(8, 8, 12, 12), { expansion: 1e300 })])).toBeNull();
  });

  it("feathers edges symmetrically, per axis", () => {
    const c = cover([resolved(box(-20, -20, 20, 40), { feather: [6, 0] })], IDENTITY, 40, 20);
    // The edge at x = 20 sits at half coverage, with a ramp the feather wide.
    expect(at(c, 19, 10)).toBeGreaterThan(140);
    expect(at(c, 20, 10)).toBeLessThan(115);
    expect(at(c, 16, 10)).toBeGreaterThan(230);
    expect(at(c, 24, 10)).toBeLessThan(25);
    // No vertical feather, and the path's other edges are far outside the raster.
    expect(at(c, 5, 0)).toBe(255);
    expect(at(c, 0, 19)).toBe(255);
  });

  it("feathers in layer space, so the blur turns with the layer", () => {
    // Layer rotated 90°: layer x runs down the raster, so x-feather blurs the horizontal edge.
    const quarter: Affine = [0, 1, -1, 0, 20, 0];
    const c = cover([resolved(box(-20, -40, 10, 40), { feather: [6, 0] })], quarter, 40, 20);
    // The layer edge x = 10 lands on raster row y = 10.
    expect(at(c, 20, 6)).toBeGreaterThan(230);
    expect(at(c, 20, 14)).toBeLessThan(25);
    expect(at(c, 20, 10)).toBeGreaterThan(90);
    expect(at(c, 20, 10)).toBeLessThan(165);
  });

  it("is deterministic, also on a fresh CanvasKit instance", async () => {
    const masks = [
      resolved(box(2, 3, 17, 15), { feather: [3, 5], expansion: 1.5 }),
      resolved(box(6, 0, 9, 20), { mode: "subtract", opacity: 0.7, feather: [1, 0] }),
    ];
    const m: Affine = [0.9, 0.3, -0.3, 0.9, 4, -2];
    const a = cover(masks, m);
    expect(cover(masks, m)).toEqual(a);
    const other = await freshCanvasKit();
    expect(rasterizeMasks(other, masks, m, 20, 20)).toEqual(a);
  });
});

const maskObj = (path: ReturnType<typeof box>, overrides: Obj = {}): Obj => ({
  id: "m",
  name: "m",
  mode: "add",
  inverted: false,
  path: prop(path),
  feather: prop([0, 0]),
  opacity: prop(1),
  expansion: prop(0),
  ...overrides,
});

const solid = (id: string, overrides: Obj = {}) =>
  layer(id, "solid", { width: 40, height: 20, color: "#ffffff", ...overrides });

const planOf = (layers: Obj[]): FramePlan =>
  rasterizeFrame(ck, frameOf(layers), { images: new ImageLibrary(ck), fonts });

const only = (plan: FramePlan): PlannedLayer => {
  expect(plan.layers).toHaveLength(1);
  return plan.layers[0] as PlannedLayer;
};

describe("rasterizeFrame: masks", () => {
  it("masks a solid in its layer space and the reference composite applies it", () => {
    const plan = planOf([
      solid("s", {
        transform: transform({ position: prop([100, 50]) }),
        masks: [maskObj(box(0, 0, 20, 20))],
      }),
    ]);
    const s = only(plan);
    expect(s.mask).toMatchObject({ width: 40, height: 20 });
    expect([at(s.mask, 10, 10), at(s.mask, 30, 10)]).toEqual([255, 0]);
    const out = compositeReference(plan);
    expect(pixel(out, 110, 60)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 130, 60)).toEqual([0, 0, 0, 0]);
  });

  it("masks a shape layer in composition space, aligned with its cropped raster", () => {
    const plan = planOf([
      shapeLayer("sh", [rect([0, 0], [60, 60]), fill(solidPaint("#ff0000"))], {
        transform: transform({ position: prop([100, 50]), scale: prop([0.5, 0.5]) }),
        // Layer space: keep only x >= 0 (the right half of the rect).
        masks: [maskObj(box(0, -100, 100, 100))],
      }),
    ]);
    const sh = only(plan);
    if (sh.space !== "composition") throw new Error("expected a composition-space layer");
    expect(sh.mask).toMatchObject({ width: sh.raster.width, height: sh.raster.height });
    const out = compositeReference(plan);
    expect(pixel(out, 108, 50)).toEqual([255, 0, 0, 255]);
    expect(pixel(out, 92, 50)).toEqual([0, 0, 0, 0]);
  });

  it("leaves out a layer its masks remove entirely and keeps a fully kept one unmasked", () => {
    expect(planOf([solid("s", { masks: [maskObj(box(100, 100, 120, 120))] })]).layers).toEqual([]);
    expect(only(planOf([solid("s", { masks: [maskObj(box(-1, -1, 41, 21))] })])).mask).toBeNull();
    expect(
      only(planOf([solid("s", { masks: [maskObj(box(0, 0, 9, 9), { mode: "none" })] })])).mask,
    ).toBeNull();
  });

  it("masks a precomp at its nested composition size", () => {
    const doc = project([
      composition("main", [
        layer("p", "precomp", {
          compositionId: "inner",
          masks: [maskObj(box(0, 0, 25, 50))],
        }),
      ]),
      composition("inner", [solid("s", { width: 50, height: 50 })], { width: 50, height: 50 }),
    ]);
    const plan = rasterizeFrame(ck, evaluateFrame(doc, 0), {
      images: new ImageLibrary(ck),
      fonts,
    });
    const p = only(plan);
    expect(p.mask).toMatchObject({ width: 50, height: 50 });
    const out = compositeReference(plan);
    expect(pixel(out, 10, 10)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 40, 10)).toEqual([0, 0, 0, 0]);
  });

  it("counts mask rasters against the frame's pixel budget", () => {
    const masks = Array.from({ length: 4 }, (_, i) => maskObj(box(0, 0, 9, 9), { id: `m${i}` }));
    const resolvedFrame = frameOf([solid("s", { masks })]);
    const deps = { images: new ImageLibrary(ck), fonts };
    // 800 pixels for the solid, 800 for each mask, 800 for the combined coverage.
    expect(() =>
      rasterizeFrame(ck, resolvedFrame, deps, { maxRasterPixels: 800 * 6 }),
    ).not.toThrow();
    expect(() => rasterizeFrame(ck, resolvedFrame, deps, { maxRasterPixels: 800 * 6 - 1 })).toThrow(
      /raster pixels/,
    );
  });
});

describe("rasterizeFrame: blend modes and track mattes", () => {
  it("carries the blend mode for the compositor", () => {
    expect(only(planOf([solid("s", { blendMode: "screen" })])).blendMode).toBe("screen");
  });

  it("plans a hidden matte source without listing it, with its own mask", () => {
    const plan = planOf([
      solid("t", { matte: { layerId: "m", mode: "luma-inverted" } }),
      solid("m", { hidden: true, masks: [maskObj(box(0, 0, 20, 20))] }),
    ]);
    const t = only(plan);
    expect(t.matte).toMatchObject({
      layerId: "m",
      mode: "luma-inverted",
      source: { id: "m", type: "solid", blendMode: "normal" },
    });
    expect(t.matte?.source?.mask).not.toBeNull();
  });

  it("shares one planned object when the source also draws, and plans chains", () => {
    const plan = planOf([
      solid("a", { matte: { layerId: "b", mode: "alpha" } }),
      solid("b", { matte: { layerId: "c", mode: "alpha" } }),
      solid("c", { hidden: true }),
    ]);
    const [a, b] = plan.layers;
    expect(plan.layers.map((l) => l.id)).toEqual(["a", "b"]);
    expect(a?.matte?.source).toBe(b);
    expect(b?.matte?.source).toMatchObject({ id: "c" });
  });

  it("gives an empty matte when the source is out of range or draws nothing", () => {
    const out = only(
      planOf([solid("t", { matte: { layerId: "m", mode: "alpha" } }), solid("m", { inFrame: 5 })]),
    );
    expect(out.matte).toEqual({ layerId: "m", mode: "alpha", source: null });
    const masked = only(
      planOf([
        solid("t", { matte: { layerId: "m", mode: "alpha" } }),
        solid("m", { hidden: true, masks: [maskObj(box(100, 100, 110, 110))] }),
      ]),
    );
    expect(masked.matte?.source).toBeNull();
  });

  it("skips, and reports, a layer whose matte chain reaches a layer it cannot draw yet", () => {
    const plan = planOf([
      solid("t", { matte: { layerId: "b", mode: "alpha" } }),
      solid("b", { hidden: true, matte: { layerId: "c", mode: "alpha-inverted" } }),
      layer("c", "component", {
        hidden: true,
        componentId: "badge",
        componentVersion: "1.0.0",
        props: {},
      }),
      solid("free"),
    ]);
    expect(plan.layers.map((l) => l.id)).toEqual(["free"]);
    expect(plan.skipped).toEqual([
      {
        id: "t",
        type: "solid",
        reason: "its track matte source 'c' is a component layer, which cannot be drawn yet",
      },
    ]);
  });

  it("composites alpha, luma and inverted mattes, with an empty matte for a missing source", () => {
    // Matte: left half white and opaque, right half transparent; a 50% grey solid over all.
    const target = (mode: string, source = "m") =>
      solid("t", { color: "#ff0000", matte: { layerId: source, mode } });
    const matteSource = solid("m", {
      hidden: true,
      color: "#808080",
      masks: [maskObj(box(0, 0, 20, 20))],
    });
    const at = (mode: string, x: number) =>
      pixel(compositeReference(planOf([target(mode), matteSource])), x, 10);
    expect(at("alpha", 5)).toEqual([255, 0, 0, 255]);
    expect(at("alpha", 30)).toEqual([0, 0, 0, 0]);
    expect(at("alpha-inverted", 5)).toEqual([0, 0, 0, 0]);
    expect(at("alpha-inverted", 30)).toEqual([255, 0, 0, 255]);
    // Luma of #808080 is 128/255.
    expect(at("luma", 5)).toEqual([128, 0, 0, 128]);
    expect(at("luma-inverted", 5)).toEqual([127, 0, 0, 127]);
    expect(at("luma-inverted", 30)).toEqual([255, 0, 0, 255]);
    const outOfRange = solid("m", { inFrame: 5 });
    expect(pixel(compositeReference(planOf([target("alpha"), outOfRange])), 5, 10)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(
      pixel(compositeReference(planOf([target("alpha-inverted"), outOfRange])), 5, 10),
    ).toEqual([255, 0, 0, 255]);
  });

  it("applies the matte source's own matte and opacity, but not its blend mode", () => {
    const plan = planOf([
      solid("t", { matte: { layerId: "m", mode: "alpha" } }),
      solid("m", {
        hidden: true,
        blendMode: "multiply",
        transform: transform({ opacity: prop(0.5) }),
        matte: { layerId: "n", mode: "alpha" },
      }),
      solid("n", { hidden: true, masks: [maskObj(box(0, 0, 20, 20))] }),
    ]);
    const out = compositeReference(plan);
    expect(pixel(out, 5, 10)).toEqual([128, 128, 128, 128]);
    expect(pixel(out, 30, 10)).toEqual([0, 0, 0, 0]);
  });
});
