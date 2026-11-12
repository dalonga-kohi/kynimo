import { evaluateFrame, type Projective, projectPoint } from "@kynimo/engine";
import { MAX_COMPOSITION_SIZE } from "@kynimo/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanvasKit } from "./canvaskit.js";
import { bundledFonts, canvasKit, pixel } from "./canvaskit.test-util.js";
import { type GpuSession, launchGpu } from "./compositor/browser.test-util.js";
import { compositeReference } from "./compositor/reference.js";
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
import type { FontLibrary } from "./fonts.js";
import { rasterizeFrame } from "./frame.js";
import { ImageLibrary } from "./images.js";
import type { FramePlan, PlannedLayer, PlannedLayerSpaceLayer } from "./raster.js";

let ck: CanvasKit;
let fonts: FontLibrary;
let gpu: GpuSession;
beforeAll(async () => {
  ck = await canvasKit();
  fonts = await bundledFonts(ck);
  gpu = await launchGpu();
}, 60_000);
afterAll(async () => {
  await gpu?.close();
}, 60_000);

/** The composition is 200x100; the default camera frames it from 200 units back. */
const ZOOM = 200;
const camera = (t: Obj = {}) =>
  layer("cam", "null", {
    type: "camera",
    zoom: prop(ZOOM),
    pointOfInterest: null,
    transform: transform({ position: prop([100, 50]), positionZ: prop(-ZOOM), ...t }),
  });
/** A 3D layer centred on the composition at depth `ZOOM + z`: unit magnification at z = 0. */
const three = (t: Obj = {}) => ({
  threeD: true,
  transform: transform({ position: prop([100, 50]), positionZ: prop(0), ...t }),
});
const card = (id: string, color: string, t: Obj = {}, extra: Obj = {}) =>
  layer(id, "solid", {
    width: 40,
    height: 20,
    color,
    ...three({ anchorPoint: prop([20, 10]), ...t }),
    ...extra,
  });

const evaluate = (layers: Obj[], frame = 0) =>
  evaluateFrame(project([composition("main", layers)]), frame);
const plan = (layers: Obj[], frame = 0): FramePlan =>
  rasterizeFrame(ck, evaluate(layers, frame), { images: new ImageLibrary(ck), fonts });
const only = (p: FramePlan): PlannedLayer => {
  expect(p.layers).toHaveLength(1);
  return p.layers[0] as PlannedLayer;
};
const withProjection = (l: PlannedLayer): PlannedLayerSpaceLayer => {
  if (l.space !== "layer" || l.projection == null || !("raster" in l))
    throw new Error("expected a 3D layer-space raster plan");
  return l;
};
const blur = { shutterAngle: 360, shutterPhase: -180, samples: 4 };
const kf = (frame: number, value: unknown) => ({ frame, value, interpolation: { type: "linear" } });

describe("planning 3D layers", () => {
  it("plans a 3D solid as a layer-space raster with the engine's projection", () => {
    const layers = [card("a", "#00ff00", { rotationY: prop(30) }), camera()];
    const resolved = evaluate(layers).layers[0];
    const l = withProjection(only(plan(layers)));
    expect(l.type).toBe("solid");
    expect(l.projection).toEqual(resolved?.projection);
    expect(l.raster).toMatchObject({ width: 40, height: 20 });
    // 2D layers carry no projection at all.
    const flat = only(plan([layer("f", "solid", { width: 40, height: 20, color: "#00ff00" })]));
    expect("projection" in flat).toBe(false);
  });

  const box = (extra: Obj = {}, z = 0) =>
    shapeLayer("s", [rect([0, 0], [40, 20]), fill()], {
      ...three({ positionZ: prop(z) }),
      ...extra,
    });
  const blurFx = { effects: [{ type: "gaussian-blur", id: "b", radius: prop(2) }] };
  /** Raster pixels per layer unit: the raster is the 40-unit rect plus one pixel of anti-aliasing each side. */
  const scaleOf = (p: FramePlan) => (withProjection(only(p)).raster.width - 2) / 40;

  it("rasterizes a 3D shape in layer space at 1x when it has effects", () => {
    // Depth 60: a 3.3x magnification, which would pick 4x without the effect.
    const p = plan([box(blurFx, -140), camera()]);
    const l = withProjection(only(p));
    expect(l.type).toBe("shape");
    expect(l.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(l.raster).toMatchObject({ width: 42, height: 22 });
    expect(l.effects).toHaveLength(1);
  });

  it("picks the resolution from the magnification: 1x to 8x, in powers of two", () => {
    expect(scaleOf(plan([box({}, 0), camera()]))).toBe(1);
    expect(scaleOf(plan([box({}, -50), camera()]))).toBe(2); // depth 150: 1.33x
    expect(scaleOf(plan([box({}, -140), camera()]))).toBe(4); // depth 60: 3.33x
    expect(scaleOf(plan([box({}, -190), camera()]))).toBe(8); // depth 10: 20x, clamped at 8x
    expect(scaleOf(plan([box({}, 200), camera()]))).toBe(1); // far away: minified, never below 1x
  });

  it("places the raster so projection(raster pixel) is projection(layer point)", () => {
    const layers = [box({}, -140), camera()];
    const resolved = evaluate(layers).layers[0]?.projection as Projective;
    const l = withProjection(only(plan(layers)));
    const proj = l.projection as Projective;
    // Raster is 4x with the origin at (floor(-20 * 4 - 1), floor(-10 * 4 - 1)) = (-81, -41): raster (161, 81) is layer (20, 10).
    const [x, y] = projectPoint(proj, [81 + 80, 41 + 40]);
    const [ex, ey] = projectPoint(resolved, [20, 10]);
    expect(x).toBeCloseTo(ex, 9);
    expect(y).toBeCloseTo(ey, 9);
  });

  it("shrinks the raster below 1x rather than exceed the size limit", () => {
    const wide = shapeLayer("s", [rect([0, 0], [20000, 20]), fill()], three());
    const l = withProjection(only(plan([wide, camera()])));
    expect(l.raster.width).toBeLessThanOrEqual(MAX_COMPOSITION_SIZE);
    expect(l.raster.width).toBeGreaterThan(MAX_COMPOSITION_SIZE / 2 - 1000);
    // A magnified one is brought down to the largest power of two that fits: 6000 * 4 does not.
    const big = shapeLayer(
      "s",
      [rect([0, 0], [6000, 100]), fill()],
      three({ positionZ: prop(-140) }),
    );
    const m = withProjection(only(plan([big, camera()])));
    expect(m.raster.width).toBe(6002); // 1x
  });

  it("draws nothing for a vector layer entirely behind the camera", () => {
    const p = plan([box({}, -300), camera()]);
    expect(p.layers).toEqual([]);
    expect(p.skipped).toEqual([]);
  });

  it("plans 3D text in layer space, sharper when magnified and unscaled with effects", () => {
    const text = (extra: Obj = {}) =>
      textLayer("t", "Hi", { ...three({ positionZ: prop(-140) }), ...extra });
    const sharp = withProjection(only(plan([text(), camera()])));
    const fx = withProjection(only(plan([text(blurFx), camera()])));
    expect(sharp.type).toBe("text");
    expect(sharp.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(sharp.raster.width / fx.raster.width).toBeGreaterThan(3);
    expect(sharp.raster.width / fx.raster.width).toBeLessThan(4.5);
  });

  it("plans animated 3D text in layer space too", () => {
    const animator = {
      name: "a",
      selector: {
        unit: "characters",
        start: prop(0),
        end: prop(0.5),
        offset: prop(0),
        shape: "square",
        easeHigh: prop(0),
        easeLow: prop(0),
        order: "forward",
        seed: 0,
        amount: prop(1),
      },
      properties: { position: prop([0, -30]) },
    };
    const text = (animators: Obj[]) => textLayer("t", "II", { ...three(), animators });
    const plain = withProjection(only(plan([text([]), camera()])));
    const moved = withProjection(only(plan([text([animator]), camera()])));
    expect(moved.type).toBe("text");
    expect(moved.raster.height).toBeGreaterThan(plain.raster.height);
  });

  it("masks a 3D layer in its raster space", () => {
    const square = {
      closed: true,
      vertices: [
        [0, -100],
        [100, -100],
        [100, 100],
        [0, 100],
      ].map((point) => ({ point, inTangent: [0, 0], outTangent: [0, 0] })),
    };
    const mask = {
      id: "m",
      name: "m",
      mode: "add",
      inverted: false,
      path: prop(square),
      feather: prop([0, 0]),
      opacity: prop(1),
      expansion: prop(0),
    };
    // A 3D solid: the mask raster is the layer's, one pixel per layer unit (here keeping x >= 20).
    const right = {
      ...mask,
      path: prop({
        ...square,
        vertices: square.vertices.map((v, i) => ({
          ...v,
          point: [i === 0 || i === 3 ? 20 : 100, v.point[1]],
        })),
      }),
    };
    const s = withProjection(only(plan([card("a", "#ffffff", {}, { masks: [right] }), camera()])));
    expect(s.mask).toMatchObject({ width: 40, height: 20 });
    expect([s.mask?.coverage[10 * 40 + 10], s.mask?.coverage[10 * 40 + 30]]).toEqual([0, 255]);
    // A 3D shape at 4x: the mask follows the raster's resolution and origin.
    const v = withProjection(only(plan([box({ masks: [mask] }, -140), camera()])));
    const m = v.mask;
    expect(m).toMatchObject({ width: v.raster.width, height: v.raster.height });
    const at = (x: number, y: number) => m?.coverage[y * (m?.width ?? 0) + x];
    // Raster origin is layer (-20.25, -10.25) at 4x: layer x = 0 is raster x = 81.
    expect([at(40, 80), at(120, 80)]).toEqual([0, 255]);
  });

  it("plans one sample per shutter time for a moving camera, with the full projection", () => {
    const moving = camera({ position: { keyframes: [kf(0, [100, 50]), kf(10, [140, 50])] } });
    const layers = [card("a", "#00ff00", {}, { motionBlur: blur }), moving];
    const resolved = evaluate(layers, 5).layers[0];
    const l = only(plan(layers, 5));
    expect(l.motion).toHaveLength(4);
    (l.motion ?? []).forEach((s, i) => {
      expect(s.delta).toEqual([1, 0, 0, 1, 0, 0]);
      expect(s.projection).toEqual(resolved?.motion?.[i]?.projection);
    });
    expect(l.motion?.[0]?.projection).not.toEqual(l.motion?.[3]?.projection);
  });

  it("carries the raster-to-layer map into a 3D vector layer's samples", () => {
    const moving = camera({ position: { keyframes: [kf(0, [100, 50]), kf(10, [140, 50])] } });
    const layers = [box({ motionBlur: blur }, -140), moving];
    const resolved = evaluate(layers, 5).layers[0];
    const l = only(plan(layers, 5));
    const sample = l.motion?.[2]?.projection as Projective;
    // Raster (161, 81) is layer (20, 10) in the 4x raster whose origin is at (-81, -41).
    const [x, y] = projectPoint(sample, [81 + 80, 41 + 40]);
    const [ex, ey] = projectPoint(resolved?.motion?.[2]?.projection as Projective, [20, 10]);
    expect(x).toBeCloseTo(ex, 9);
    expect(y).toBeCloseTo(ey, 9);
  });

  it("plans no motion when nothing moves, and renders byte-identically to the unblurred layer", () => {
    const still = (extra: Obj = {}) => [
      card("a", "#00ff00", { rotationY: prop(20) }, extra),
      camera(),
    ];
    const blurred = plan(still({ motionBlur: blur }));
    expect(only(blurred).motion).toBeNull();
    expect(compositeReference(blurred).pixels).toEqual(compositeReference(plan(still())).pixels);
  });
});

describe("3D scene end to end", () => {
  const title = layer("title", "solid", {
    width: 200,
    height: 20,
    color: "#ffffff",
    transform: transform({ position: prop([0, 40]) }),
  });
  const big = (id: string, color: string, x: number, z: number) =>
    layer(id, "solid", {
      width: 60,
      height: 50,
      color,
      ...three({ anchorPoint: prop([30, 25]), position: prop([x, 50]), positionZ: prop(z) }),
    });
  // Listed far card first: the engine sorts each run of 3D layers by depth, nearest on top.
  const layers = [
    big("far", "#ff0000", 80, 100),
    big("near", "#0000ff", 100, -40),
    title,
    big("back", "#00ff00", 150, 0),
    camera(),
  ];

  const parity = async (p: FramePlan) => {
    const ref = compositeReference(p);
    const out = await gpu.composite(p);
    let gap = 0;
    for (let i = 0; i < ref.pixels.length; i++)
      gap = Math.max(gap, Math.abs((ref.pixels[i] ?? 0) - (out.pixels[i] ?? 0)));
    return { ref, gap };
  };

  // The float64 reference of this projective scene takes about 4.5 s on a CI runner, so the
  // default 5 s timeout fails whenever the runner is loaded.
  it("sorts each run of 3D layers by depth around a 2D layer, and both compositors agree", {
    timeout: 30_000,
  }, async () => {
    const p = plan(layers);
    expect(p.layers.map((l) => l.id)).toEqual(["near", "far", "title", "back"]);
    const { ref, gap } = await parity(p);
    expect(gap).toBeLessThanOrEqual(2);
    // The near card is bigger on screen and on top where it overlaps the far one.
    expect(pixel(ref, 90, 50)).toEqual([0, 0, 255, 255]);
    // The title (2D) covers the 3D layer below it, and the card in the run above covers the title.
    expect(pixel(ref, 20, 50)).toEqual([255, 255, 255, 255]);
    expect(pixel(ref, 150, 50)).toEqual([255, 255, 255, 255]);
    expect(pixel(ref, 150, 25)).toEqual([0, 255, 0, 255]);
  });

  it("a 2D frame renders the same before and after a 3D frame on the same compositor", async () => {
    const flat = plan([title]);
    const first = await gpu.composite(flat);
    const a = await gpu.composite(plan(layers));
    const b = await gpu.composite(plan(layers));
    expect(b.pixels).toEqual(a.pixels);
    expect((await gpu.composite(flat)).pixels).toEqual(first.pixels);
  });
});
