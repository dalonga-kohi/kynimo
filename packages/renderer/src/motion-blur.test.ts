import { evaluateFrame } from "@kynimo/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanvasKit } from "./canvaskit.js";
import { bundledFonts, canvasKit, pixel } from "./canvaskit.test-util.js";
import { type GpuSession, launchGpu } from "./compositor/browser.test-util.js";
import { MAX_FRAME_EFFECT_SAMPLES } from "./compositor/effects.js";
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
  transform,
} from "./fixtures.test-util.js";
import type { FontLibrary } from "./fonts.js";
import { rasterizeFrame } from "./frame.js";
import { ImageLibrary } from "./images.js";
import type { FramePlan, PlannedLayer, PlannedMotionSample, RasterImage } from "./raster.js";
import { motionCropRect } from "./rect.js";

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

const solid = (id: string, overrides: Obj = {}) =>
  layer(id, "solid", { width: 100, height: 20, color: "#ff0000", ...overrides });

const flat = (width: number, height: number, rgba: number[]): RasterImage => ({
  width,
  height,
  pixels: Uint8Array.from({ length: width * height * 4 }, (_, i) => rgba[i % 4] ?? 0),
});

const layerSpace = (
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

const plan = (layers: PlannedLayer[], width = 100, height = 20): FramePlan => ({
  width,
  height,
  background: null,
  layers,
  skipped: [],
  warnings: [],
});

/** 16 samples across a shutter that moves the layer 40 px, centred on the layer. */
const sweep = (count = 16, travel = 40, opacity = 1): PlannedMotionSample[] =>
  Array.from({ length: count }, (_, i) => ({
    delta: [1, 0, 0, 1, travel * (-0.5 + (i + 0.5) / count), 0],
    opacity,
  }));

const red20 = flat(20, 20, [255, 0, 0, 255]);
const moving = (overrides: Partial<PlannedLayer> = {}) =>
  layerSpace("m", red20, { matrix: [1, 0, 0, 1, 40, 0], motion: sweep(), ...overrides });

const alphaRow = (img: RasterImage, y = 10) =>
  Array.from({ length: img.width }, (_, x) => pixel(img, x, y)[3] ?? 0);

describe("motion blur: reference compositor", () => {
  it("smears a moving solid about one travel wider, symmetric around its centre", () => {
    const a = alphaRow(compositeReference(plan([moving()])));
    const covered = a.map((v, x) => [v, x] as const).filter(([v]) => v > 0);
    const first = covered[0]?.[1] ?? -1;
    const last = covered[covered.length - 1]?.[1] ?? -1;
    // The solid spans 40..60, the samples shift it by -18.75..+18.75.
    expect(first).toBe(21);
    expect(last).toBe(78);
    expect(last - first + 1 - 20).toBeGreaterThanOrEqual(36);
    expect(last - first + 1 - 20).toBeLessThanOrEqual(40);
    // Partial alpha at the ends, about half at the centre (8 of 16 samples cover it).
    expect(a[first]).toBeGreaterThan(0);
    expect(a[first]).toBeLessThan(40);
    expect(Math.abs((a[50] ?? 0) - 128)).toBeLessThanOrEqual(3);
    // Symmetric around x = 50 (pixel x mirrors 99 - x).
    for (let x = 0; x < 50; x++)
      expect(Math.abs((a[x] ?? 0) - (a[99 - x] ?? 0))).toBeLessThanOrEqual(1);
  });

  it("weights each sample by its own opacity over the count", () => {
    const half = compositeReference(plan([moving({ motion: sweep(4, 0, 0.5) })]));
    expect(pixel(half, 50, 10)).toEqual([128, 0, 0, 128]);
    const mixed = compositeReference(
      plan([
        moving({
          motion: [
            { delta: [1, 0, 0, 1, 0, 0], opacity: 1 },
            { delta: [1, 0, 0, 1, 0, 0], opacity: 0 },
          ],
        }),
      ]),
    );
    expect(pixel(mixed, 50, 10)).toEqual([128, 0, 0, 128]);
  });

  it("draws samples that never change exactly like the unblurred layer", () => {
    const still = Array.from({ length: 8 }, () => ({
      delta: [1, 0, 0, 1, 0, 0] as const,
      opacity: 1,
    }));
    const blurred = compositeReference(plan([moving({ motion: still })]));
    const plain = compositeReference(plan([moving({ motion: null })]));
    expect(blurred.pixels).toEqual(plain.pixels);
  });

  it("blurs under an alpha matte as blur then matte", () => {
    const matteSource = layerSpace("matte", flat(100, 20, [255, 255, 255, 255]), {
      raster: (() => {
        const r = flat(100, 20, [0, 0, 0, 0]);
        for (let y = 0; y < 20; y++)
          for (let x = 0; x < 50; x++) r.pixels.set([255, 255, 255, 255], (y * 100 + x) * 4);
        return r;
      })(),
    });
    const matted = moving({ matte: { layerId: "matte", mode: "alpha", source: matteSource } });
    const out = alphaRow(compositeReference(plan([matted])));
    const unmatted = alphaRow(compositeReference(plan([moving()])));
    for (let x = 0; x < 100; x++) expect(out[x]).toBe(x < 50 ? unmatted[x] : 0);
  });

  it("refuses a frame over the sample budget, naming the layer", () => {
    const huge = plan(
      [layerSpace("huge", flat(1, 1, [255, 0, 0, 255]), { motion: sweep(64) })],
      2800,
      2800,
    );
    expect(64 * 2800 * 2800).toBeGreaterThan(MAX_FRAME_EFFECT_SAMPLES);
    expect(() => compositeReference(huge)).toThrow(
      /layer 'huge' exceeds the frame budget of \d+ effect samples; reduce the motion blur samples or number of blurred layers/,
    );
  });
});

describe("motion blur: planning", () => {
  const blur = { shutterAngle: 360, shutterPhase: -180, samples: 16 };
  const frame1 = (layers: Obj[]) =>
    rasterizeFrame(
      ck,
      evaluateFrame(project([composition("main", layers, { width: 100, height: 20 })]), 1),
      { images: new ImageLibrary(ck), fonts },
    );
  const body = (overrides: Obj = {}) =>
    solid("s", {
      width: 20,
      height: 20,
      transform: transform({ position: { keyframes: [kf(0, [0, 0]), kf(10, [400, 0])] } }),
      ...overrides,
    });
  const kf = (frame: number, value: unknown) => ({
    frame,
    value,
    interpolation: { type: "linear" },
  });

  it("plans deltas relative to the centre placement", () => {
    const l = frame1([body({ motionBlur: blur })]).layers[0] as PlannedLayer;
    expect(l.motion).toHaveLength(16);
    expect(l.space === "layer" && l.matrix).toEqual([1, 0, 0, 1, 40, 0]);
    const dx = (l.motion ?? []).map((s) => s.delta[4]);
    expect(dx[0]).toBeCloseTo(-18.75, 9);
    expect(dx[15]).toBeCloseTo(18.75, 9);
  });

  it("plans no motion for a static layer, and renders it byte-identically", () => {
    const still = (overrides: Obj = {}) =>
      solid("s", {
        width: 20,
        height: 20,
        transform: transform({ position: prop([40, 0]) }),
        ...overrides,
      });
    const blurred = frame1([still({ motionBlur: blur })]);
    expect((blurred.layers[0] as PlannedLayer).motion).toBeNull();
    expect(compositeReference(blurred).pixels).toEqual(
      compositeReference(frame1([still()])).pixels,
    );
  });

  it("plans no motion for a singular matrix", () => {
    const l = frame1([
      body({
        transform: transform({
          scale: prop([0, 0]),
          position: { keyframes: [kf(0, [0, 0]), kf(10, [400, 0])] },
        }),
        motionBlur: blur,
      }),
    ]).layers[0] as PlannedLayer;
    expect(l.motion).toBeNull();
  });
});

describe("motion blur: composition-space rasters cover the shutter's reach", () => {
  const kf = (frame: number, value: unknown) => ({
    frame,
    value,
    interpolation: { type: "linear" },
  });
  const blur = { shutterAngle: 360, shutterPhase: -180, samples: 16 };
  /** A 200 px wide bar whose centre is at x = `x` + `shift` at frame 1, moving 60 px per frame. */
  const render = (width: number, shift: number, motionBlur: Obj | null) =>
    compositeReference(
      rasterizeFrame(
        ck,
        evaluateFrame(
          project([
            composition(
              "main",
              [
                shapeLayer("bar", [rect([0, 0], [200, 20]), fill()], {
                  transform: transform({
                    position: { keyframes: [kf(0, [-110 + shift, 10]), kf(10, [490 + shift, 10])] },
                  }),
                  motionBlur,
                }),
              ],
              { width, height: 20 },
            ),
          ]),
          1,
        ),
        { images: new ImageLibrary(ck), fonts },
      ),
    );

  it("draws what is off-screen at the centre frame but in view during the shutter", () => {
    const narrow = render(100, 0, blur);
    const wide = render(400, 300, blur);
    for (let x = 0; x <= 5; x++) {
      const a = pixel(narrow, x, 10)[3] ?? 0;
      const b = pixel(wide, 300 + x, 10)[3] ?? 0;
      expect(a).toBeGreaterThan(200);
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    }
  });
});

describe("motionCropRect", () => {
  const still = [{ delta: [1, 0, 0, 1, 0, 0] as const, opacity: 1 }];
  it("is the padded composition rect without motion", () => {
    expect(motionCropRect(100, 50, [4, 2], null)).toEqual([-4, -2, 104, 52]);
    expect(motionCropRect(100, 50, [0, 0], undefined)).toEqual([0, 0, 100, 50]);
    expect(motionCropRect(100, 50, [0, 0], [...still])).toEqual([0, 0, 100, 50]);
  });
  it("reaches back along the inverse of each delta", () => {
    const motion = [
      { delta: [1, 0, 0, 1, 30, 0] as const, opacity: 1 },
      { delta: [1, 0, 0, 1, -10, 0] as const, opacity: 1 },
    ];
    expect(
      motionCropRect(
        100,
        50,
        [0, 0],
        motion.map((m) => ({ ...m, delta: [...m.delta] })),
      ),
    ).toEqual([-30, 0, 110, 50]);
  });
  it("clamps to one composition size of extra margin per side", () => {
    const fast = [
      {
        delta: [1, 0, 0, 1, 5000, -5000] as [number, number, number, number, number, number],
        opacity: 1,
      },
    ];
    expect(motionCropRect(100, 50, [3, 3], fast)).toEqual([-103, -3, 103, 103]);
  });
  it("skips samples that cannot be inverted", () => {
    const singular = [
      { delta: [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number], opacity: 1 },
    ];
    expect(motionCropRect(100, 50, [0, 0], singular)).toEqual([0, 0, 100, 50]);
  });
});

describe("motion blur: WebGL2 against the reference", () => {
  const compare = async (p: FramePlan) => {
    const ref = compositeReference(p);
    const out = await gpu.composite(p);
    const bad: number[] = [];
    for (let i = 0; i < ref.pixels.length; i++)
      if (Math.abs((ref.pixels[i] ?? 0) - (out.pixels[i] ?? 0)) > 2) bad.push(i);
    expect(bad.slice(0, 8)).toEqual([]);
    return out;
  };

  it("matches for a moving, rotating, fading layer over a backdrop", async () => {
    const c = Math.cos(0.1);
    const s = Math.sin(0.1);
    const samples: PlannedMotionSample[] = Array.from({ length: 16 }, (_, i) => {
      const t = -0.5 + (i + 0.5) / 16;
      const a = 0.1 * t;
      return {
        delta: [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 30 * t, 4 * t],
        opacity: 0.6 + 0.4 * (i / 15),
      };
    });
    const p = plan(
      [
        moving({ motion: samples, matrix: [c, s, -s, c, 40, 2], opacity: 0.8 }),
        layerSpace("bg", flat(100, 20, [0, 40, 80, 255])),
      ],
      100,
      20,
    );
    const out = await compare(p);
    expect(out.pixels).not.toEqual(
      (await gpu.composite(plan([{ ...moving({ motion: null }) }]))).pixels,
    );
  });

  it("matches the plain sweep, smearing the same width", async () => {
    const out = await compare(plan([moving()]));
    expect(alphaRow(out)[21]).toBeGreaterThan(0);
    expect(alphaRow(out)[20]).toBe(0);
  });

  it("matches for a blurred layer under an alpha matte and a blurred matte source", async () => {
    const band = (() => {
      const r = flat(100, 20, [0, 0, 0, 0]);
      for (let y = 0; y < 20; y++)
        for (let x = 30; x < 70; x++) r.pixels.set([255, 255, 255, 255], (y * 100 + x) * 4);
      return r;
    })();
    const source = layerSpace("matte", band, { motion: sweep(8, 20) });
    for (const mode of ["alpha", "luma-inverted"] as const)
      await compare(
        plan([
          moving({ matte: { layerId: "matte", mode, source } }),
          layerSpace("bg", flat(100, 20, [10, 20, 30, 255])),
        ]),
      );
  });

  it("refuses a frame over the sample budget with the reference's message and stays usable", async () => {
    const huge = plan(
      [layerSpace("huge", flat(1, 1, [255, 0, 0, 255]), { motion: sweep(64) })],
      2800,
      2800,
    );
    await expect(gpu.composite(huge)).rejects.toThrow(
      /layer 'huge' exceeds the frame budget of \d+ effect samples; reduce the motion blur samples or number of blurred layers/,
    );
    await compare(plan([moving()]));
  }, 60_000);
});
