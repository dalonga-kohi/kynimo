import { describe, expect, it } from "vitest";
import { applyToPoint, multiply, transformMatrix } from "./affine.js";
import { evaluateFrame, MAX_EVALUATION_UNITS, nestedFrame } from "./evaluate.js";
import {
  composition,
  deepFreeze,
  layer,
  type Obj,
  project,
  prop,
  solid,
  transform,
} from "./fixtures.test-util.js";
import { cubicPath } from "./path.js";
import type { ResolvedLayer, ResolvedPrecompLayer } from "./resolved.js";

const linear = { type: "linear" };
const kf = (frame: number, value: unknown, interpolation: Obj = linear) => ({
  frame,
  value,
  interpolation,
});
const ids = (layers: readonly ResolvedLayer[]) => layers.map((l) => l.id);
const single = (doc: Obj[], frame = 0) => evaluateFrame(project(doc), frame);
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("evaluateFrame: inputs", () => {
  const doc = project([composition("main", [solid("a")]), composition("other", [])]);

  it("evaluates the main composition by default, or the one named", () => {
    expect(evaluateFrame(doc, 0).id).toBe("main");
    expect(evaluateFrame(doc, 0, "other").id).toBe("other");
  });

  it("rejects frames that are not integers inside the composition", () => {
    expect(() => evaluateFrame(doc, 1.5)).toThrow(/integer from 0 to 89/);
    expect(() => evaluateFrame(doc, -1)).toThrow(RangeError);
    expect(() => evaluateFrame(doc, 90)).toThrow(RangeError);
    expect(() => evaluateFrame(doc, Number.NaN)).toThrow(RangeError);
  });

  it("names the valid compositions when the id is unknown", () => {
    expect(() => evaluateFrame(doc, 0, "nope")).toThrow(/use one of: main, other/);
  });

  it("returns the composition settings and the root background as float RGBA", () => {
    const out = evaluateFrame(doc, 0);
    expect(out).toMatchObject({ width: 1920, height: 1080, fps: { num: 30, den: 1 }, frame: 0 });
    expect(out.background).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    const transparent = project([composition("main", [], { background: null })]);
    expect(evaluateFrame(transparent, 0).background).toBeNull();
  });
});

describe("evaluateFrame: which layers draw", () => {
  it("draws a layer on inFrame <= frame < outFrame", () => {
    const doc = project([composition("main", [solid("a", { inFrame: 10, outFrame: 20 })])]);
    expect(ids(evaluateFrame(doc, 9).layers)).toEqual([]);
    expect(ids(evaluateFrame(doc, 10).layers)).toEqual(["a"]);
    expect(ids(evaluateFrame(doc, 19).layers)).toEqual(["a"]);
    expect(ids(evaluateFrame(doc, 20).layers)).toEqual([]);
  });

  it("keeps document order (top-first) and leaves out hidden and null layers", () => {
    const out = single([
      composition("main", [
        solid("top"),
        solid("off", { hidden: true }),
        layer("n", "null"),
        solid("bottom"),
      ]),
    ]);
    expect(ids(out.layers)).toEqual(["top", "bottom"]);
  });

  it("draws and plays only soloed layers once any layer is soloed", () => {
    const doc = project(
      [
        composition("main", [
          solid("a", { solo: true }),
          solid("b"),
          layer("music", "audio", { assetId: "song", volume: prop(1) }),
          layer("voice", "audio", { assetId: "song", volume: prop(1), solo: true }),
        ]),
      ],
      {
        assets: [
          {
            id: "song",
            name: "song",
            type: "audio",
            uri: "assets/song.mp3",
            sha256: "0".repeat(64),
            durationMs: 3000,
          },
        ],
      },
    );
    const out = evaluateFrame(doc, 0);
    expect(ids(out.layers)).toEqual(["a"]);
    expect(out.audio.map((a) => a.id)).toEqual(["voice"]);
  });

  it("does not let a hidden layer draw even when soloed", () => {
    const out = single([
      composition("main", [solid("a", { solo: true, hidden: true }), solid("b")]),
    ]);
    expect(ids(out.layers)).toEqual([]);
  });
});

describe("evaluateFrame: time and transforms", () => {
  it("samples keyframes in layer time (frame - startFrame)", () => {
    const moving = solid("a", {
      startFrame: 10,
      transform: transform({ position: { keyframes: [kf(0, [0, 0]), kf(10, [100, 0])] } }),
    });
    const out = single([composition("main", [moving])], 15);
    const a = out.layers[0] as ResolvedLayer;
    expect(a.layerFrame).toBe(5);
    expect(a.transform.position).toEqual([50, 0]);
    expect(applyToPoint(a.matrix, [0, 0])).toEqual([50, 0]);
  });

  it("clamps opacity and skew overshoot without touching stored values", () => {
    const overshoot = { type: "bezier", x1: 0.3, y1: 2, x2: 0.7, y2: 2 };
    const a = solid("a", {
      transform: transform({
        opacity: { keyframes: [kf(0, 0, overshoot), kf(10, 1)] },
        skew: { keyframes: [kf(0, 0, overshoot), kf(10, 80)] },
      }),
    });
    const out = single([composition("main", [a])], 5);
    const t = (out.layers[0] as ResolvedLayer).transform;
    expect(t.opacity).toBe(1);
    expect(t.skew).toBe(85);
  });

  it("chains parent transforms into the world matrix but not parent opacity", () => {
    const parent = layer("p", "null", {
      transform: transform({ position: prop([100, 0]), rotation: prop(90), opacity: prop(0.2) }),
    });
    const child = solid("c", { parent: "p", transform: transform({ position: prop([10, 0]) }) });
    const c = single([composition("main", [child, parent])]).layers[0] as ResolvedLayer;
    expect(applyToPoint(c.matrix, [0, 0])).toEqual([100, 10]);
    expect(c.transform.opacity).toBe(1);
    expect(c.transform.position).toEqual([10, 0]);
  });

  it("lets hidden or out-of-range parents drive children, each sampled at its own layer time", () => {
    const parent = solid("p", {
      hidden: true,
      inFrame: 50,
      outFrame: 60,
      startFrame: 20,
      transform: transform({ position: { keyframes: [kf(0, [0, 0]), kf(10, [100, 0])] } }),
    });
    const child = solid("c", { parent: "p" });
    const out = single([composition("main", [child, parent])], 25);
    expect(ids(out.layers)).toEqual(["c"]);
    expect(applyToPoint((out.layers[0] as ResolvedLayer).matrix, [0, 0])).toEqual([50, 0]);
  });

  it("handles parent chains as long as the layer limit", () => {
    const chain = Array.from({ length: 1000 }, (_, i) =>
      layer(`l${i}`, "null", {
        parent: i === 999 ? null : `l${i + 1}`,
        transform: transform({ position: prop([1, 0]) }),
      }),
    );
    chain[0] = solid("l0", { parent: "l1", transform: transform({ position: prop([1, 0]) }) });
    const out = single([composition("main", chain)]);
    expect(applyToPoint((out.layers[0] as ResolvedLayer).matrix, [0, 0])).toEqual([1000, 0]);
  });
});

describe("evaluateFrame: parenting parity", () => {
  const p = {
    anchorPoint: [10, 20],
    position: [300, 200],
    scale: [2, -1],
    rotation: 30,
    skew: 15,
  } as const;
  const c = {
    anchorPoint: [5, 5],
    position: [40, -10],
    scale: [0.5, 0.5],
    rotation: -45,
    skew: -10,
  } as const;
  const asTransform = (t: typeof p | typeof c) =>
    transform({
      anchorPoint: prop(t.anchorPoint),
      position: prop(t.position),
      scale: prop(t.scale),
      rotation: prop(t.rotation),
      skew: prop(t.skew),
    });
  const expected = multiply(transformMatrix(p), transformMatrix(c));

  it("composes anchor point, scale, rotation and skew through the parent", () => {
    const out = single([
      composition("main", [
        solid("c", { parent: "p", transform: asTransform(c) }),
        layer("p", "null", { transform: asTransform(p) }),
      ]),
    ]);
    expect((out.layers[0] as ResolvedLayer).matrix).toEqual(expected);
  });

  it("resolves parents per composition inside a precomp", () => {
    const inner = composition("inner", [
      solid("c", { parent: "p", transform: asTransform(c) }),
      layer("p", "null", { transform: asTransform(p) }),
    ]);
    const outer = composition("main", [layer("pc", "precomp", { compositionId: "inner" })]);
    const pc = evaluateFrame(project([outer, inner]), 0).layers[0] as ResolvedPrecompLayer;
    const child = pc.composition?.layers[0];
    expect(child?.matrix).toEqual(expected);
  });

  it("chains through a null whose own parent is out of range", () => {
    const out = single([
      composition("main", [
        solid("c", { parent: "mid" }),
        layer("mid", "null", { parent: "top", transform: transform({ position: prop([0, 7]) }) }),
        solid("top", {
          inFrame: 50,
          outFrame: 60,
          transform: transform({ position: prop([3, 0]) }),
        }),
      ]),
    ]);
    expect(ids(out.layers)).toEqual(["c"]);
    expect(applyToPoint((out.layers[0] as ResolvedLayer).matrix, [0, 0])).toEqual([3, 7]);
  });
});

describe("evaluateFrame: precomps", () => {
  const precomp = (id: string, compositionId: string, overrides: Obj = {}) =>
    layer(id, "precomp", { compositionId, ...overrides });

  it("nests the referenced composition at its local frame, with a transparent background", () => {
    const doc = project([
      composition("main", [precomp("pc", "inner", { startFrame: 30 })]),
      composition("inner", [solid("s")], { durationFrames: 20, background: "#ffffff" }),
    ]);
    const pc = evaluateFrame(doc, 35).layers[0] as ResolvedPrecompLayer;
    expect(pc.composition?.frame).toBe(5);
    expect(pc.composition?.background).toBeNull();
    expect(ids(pc.composition?.layers ?? [])).toEqual(["s"]);
    // Before its content starts and after its composition ends, a precomp draws nothing.
    expect((evaluateFrame(doc, 29).layers[0] as ResolvedPrecompLayer).composition).toBeNull();
    expect((evaluateFrame(doc, 50).layers[0] as ResolvedPrecompLayer).composition).toBeNull();
  });

  it("evaluates a composition shared by several precomps once per local frame", () => {
    const doc = project([
      composition("main", [
        precomp("a", "inner"),
        precomp("b", "inner"),
        precomp("c", "inner", { startFrame: 1 }),
      ]),
      composition("inner", [solid("s")]),
    ]);
    const [a, b, c] = evaluateFrame(doc, 5).layers as ResolvedPrecompLayer[];
    expect(a?.composition).toBe(b?.composition);
    expect(c?.composition).not.toBe(a?.composition);
    expect(c?.composition?.frame).toBe(4);
  });

  it("stays fast on deeply shared precomp graphs", () => {
    // 30 levels, each placing the next one twice: 2^30 paths without sharing.
    const comps = Array.from({ length: 30 }, (_, i) =>
      composition(
        `c${i}`,
        i === 29
          ? [solid("leaf")]
          : [precomp(`c${i}a`, `c${i + 1}`), precomp(`c${i}b`, `c${i + 1}`)],
      ),
    );
    const doc = project([composition("main", [precomp("root", "c0")]), ...comps]);
    expect(evaluateFrame(doc, 0).layers).toHaveLength(1);
  });

  it("refuses precomp fan-out at distinct offsets beyond the work budget", () => {
    // main places c1 N times and c1 places c2 N times, all at different start frames: N³ layers from 3N.
    const n = 110;
    const doc = project([
      composition(
        "main",
        Array.from({ length: n }, (_, i) => precomp(`a${i}`, "c1", { startFrame: -i, inFrame: 0 })),
      ),
      composition(
        "c1",
        Array.from({ length: n }, (_, i) =>
          precomp(`b${i}`, "c2", { startFrame: -i * n, inFrame: 0, outFrame: 90 }),
        ),
      ),
      composition(
        "c2",
        Array.from({ length: n }, (_, i) => solid(`s${i}`)),
        { durationFrames: 100_000 },
      ),
    ]);
    expect(n ** 3).toBeGreaterThan(MAX_EVALUATION_UNITS);
    expect(() => evaluateFrame(doc, 0)).toThrow(
      /more than 1000000 units of work .*; it ran out in composition 'c2' via precomp layers a\d+ > b\d+/,
    );
  });

  it("allows exactly the budget and refuses one unit more", () => {
    // main (not charged): 999 placements of c1 at distinct offsets (999 × 1,000 units) plus one
    // placement of c2 (1,000 units). Total: exactly 1,000,000.
    const rect = {
      id: "r",
      name: "r",
      type: "rect",
      position: prop([0, 0]),
      size: prop([1, 1]),
      cornerRadius: prop(0),
    };
    const solids = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => solid(`${prefix}${i}`));
    const placements = Array.from({ length: 999 }, (_, i) =>
      precomp(`a${i}`, "c1", { startFrame: -i, inFrame: 0 }),
    );
    const c1 = composition("c1", solids("s", 1000), { durationFrames: 1000 });
    const doc = (c2Shape: Obj[]) =>
      project([
        composition("main", [...placements, precomp("b", "c2")]),
        c1,
        composition("c2", [...solids("t", 999), layer("shape", "shape", { contents: c2Shape })]),
      ]);
    expect(evaluateFrame(doc([]), 0).layers).toHaveLength(1000);
    // One rect in c2 is exactly one more unit.
    expect(() => evaluateFrame(doc([rect]), 0)).toThrow(RangeError);
  }, 20_000);

  it("does not charge the root composition", () => {
    // 1000 path layers × 1000 vertices: over a million units, but linear work with no precomps.
    const vertices = Array.from({ length: 1000 }, (_, v) => ({
      point: [v, 0],
      inTangent: [0, 0],
      outTangent: [0, 0],
    }));
    const path = (id: string) => ({
      id,
      name: id,
      type: "path",
      path: prop({ closed: false, vertices }),
    });
    // Validate one layer, then copy the parsed layer: parsing a million vertices takes seconds and
    // timed out on loaded CI runners, while every copy differs only in fields the schema checks the same way.
    const parsed = project([
      composition("main", [
        layer("p0", "shape", { inFrame: 0, outFrame: 1, contents: [path("p0path")] }),
      ]),
    ]);
    const main = parsed.compositions[0] as (typeof parsed.compositions)[number];
    const template = main.layers[0] as (typeof main.layers)[number];
    const layers = Array.from({ length: 1000 }, (_, i) => ({
      ...template,
      id: `p${i}`,
      name: `p${i}`,
      inFrame: i % 90,
      outFrame: (i % 90) + 1,
    }));
    const big = { ...parsed, compositions: [{ ...main, layers }] } as typeof parsed;
    expect(evaluateFrame(big, 0).layers.length).toBeGreaterThan(0);
  });

  it("charges shape contents, not just layers", () => {
    // 700 placements of one shape layer with 500 groups of 3 rects: only 1,400 layers, but 1.4M units.
    const rect = (id: string) => ({
      id,
      name: id,
      type: "rect",
      position: prop([0, 0]),
      size: prop([1, 1]),
      cornerRadius: prop(0),
    });
    const groups = Array.from({ length: 500 }, (_, g) => ({
      id: `g${g}`,
      name: `g${g}`,
      type: "group",
      transform: transform(),
      items: [rect(`g${g}a`), rect(`g${g}b`), rect(`g${g}c`)],
    }));
    const doc = project([
      composition(
        "main",
        Array.from({ length: 700 }, (_, i) =>
          precomp(`a${i}`, "c1", { startFrame: -i, inFrame: 0 }),
        ),
      ),
      composition("c1", [layer("shape", "shape", { contents: groups })], { durationFrames: 1000 }),
    ]);
    expect(() => evaluateFrame(doc, 0)).toThrow(/units of work/);
  });

  it("maps frames across frame rates, flooring to the nested composition's frames", () => {
    const doc = project([
      composition("main", [precomp("pc", "inner")]),
      composition("inner", [solid("s")], { fps: { num: 24, den: 1 } }),
    ]);
    const frameAt = (f: number) =>
      (evaluateFrame(doc, f).layers[0] as ResolvedPrecompLayer).composition?.frame;
    expect([0, 1, 2, 4, 5, 30].map(frameAt)).toEqual([0, 0, 1, 3, 4, 24]);
  });
});

describe("nestedFrame", () => {
  it("is exact for NTSC rates and large frames", () => {
    expect(nestedFrame(1000, { num: 30000, den: 1001 }, { num: 30, den: 1 })).toBe(1001);
    expect(nestedFrame(1001, { num: 30000, den: 1001 }, { num: 30, den: 1 })).toBe(1002);
    expect(nestedFrame(9_999_999, { num: 240, den: 1 }, { num: 60, den: 1 })).toBe(2_499_999);
    expect(nestedFrame(7, { num: 30, den: 1 }, { num: 60, den: 1 })).toBe(14);
  });

  it("floors negative frames", () => {
    expect(nestedFrame(-1, { num: 30, den: 1 }, { num: 24, den: 1 })).toBe(-1);
    expect(nestedFrame(-5, { num: 30, den: 1 }, { num: 24, den: 1 })).toBe(-4);
  });
});

describe("evaluateFrame: layer contents", () => {
  it("resolves text properties, clamping size and leading", () => {
    const text = layer("t", "text", {
      content: { value: "Hello" },
      box: {
        mode: "box",
        width: { keyframes: [kf(0, 100), kf(10, 200)] },
        height: prop(50),
        autoFit: true,
      },
      font: { family: "Inter", weight: 600, size: prop(48) },
      tracking: prop(-20),
      leading: prop(1.2),
      align: "center",
      textCase: "upper",
      animators: [],
      fill: { keyframes: [kf(0, "#000000"), kf(10, "#ffffff")] },
    });
    const t = single([composition("main", [text])], 10).layers[0];
    expect(t).toMatchObject({
      type: "text",
      content: "Hello",
      box: { mode: "box", width: 200, height: 50, autoFit: true },
      font: { family: "Inter", weight: 600, size: 48 },
      tracking: -20,
      leading: 1.2,
      align: "center",
      textCase: "upper",
      animators: [],
      fill: { r: 1, g: 1, b: 1, a: 1 },
    });
  });

  it("samples text animators at the layer frame, keyframes included", () => {
    const text = layer("t", "text", {
      content: { value: "Hello" },
      box: { mode: "point" },
      font: { family: "Inter", weight: 400, size: prop(48) },
      tracking: prop(0),
      leading: prop(1.2),
      align: "left",
      textCase: "none",
      fill: prop("#ffffff"),
      animators: [
        {
          name: "rise",
          selector: {
            unit: "characters",
            start: prop(0),
            end: { keyframes: [kf(0, 0), kf(10, 1)] },
            offset: prop(0),
            shape: "square",
            easeHigh: prop(0),
            easeLow: prop(0),
            order: "forward",
            seed: 4,
            amount: prop(1),
          },
          properties: { position: prop([0, 30]), opacity: { keyframes: [kf(0, 0), kf(10, 0.5)] } },
        },
      ],
    });
    const doc = [composition("main", [text])];
    const at = (frame: number) => {
      const t = single(doc, frame).layers[0];
      if (t?.type !== "text") throw new Error("expected a text layer");
      return t.animators[0];
    };
    expect(at(0)?.selector).toMatchObject({ end: 0, seed: 4, shape: "square" });
    expect(at(5)).toMatchObject({ name: "rise", position: [0, 30], opacity: 0.25, fill: null });
    expect(at(5)?.selector.end).toBeCloseTo(0.5, 12);
    expect(at(10)?.selector.end).toBe(1);
  });

  it("passes image, solid, adjustment and component layers through with their data", () => {
    const doc = project(
      [
        composition("main", [
          layer("img", "image", { assetId: "logo" }),
          solid("sol", { color: "#ff000080" }),
          layer("adj", "adjustment"),
          layer("cmp", "component", {
            componentId: "lower-third",
            componentVersion: "1.0.0",
            props: { title: "Hi" },
          }),
        ]),
      ],
      {
        assets: [
          {
            id: "logo",
            name: "logo",
            type: "image",
            uri: "assets/logo.png",
            sha256: "0".repeat(64),
            width: 10,
            height: 10,
          },
        ],
      },
    );
    const [img, sol, adj, cmp] = evaluateFrame(doc, 0).layers;
    expect(img).toMatchObject({ type: "image", assetId: "logo" });
    expect(sol).toMatchObject({
      type: "solid",
      width: 100,
      height: 100,
      color: { r: 1, g: 0, b: 0, a: 128 / 255 },
    });
    expect(adj).toMatchObject({ type: "adjustment" });
    expect(cmp).toMatchObject({
      type: "component",
      componentId: "lower-third",
      componentVersion: "1.0.0",
      props: { title: "Hi" },
    });
  });

  it("samples audio volume in layer time, at least 0", () => {
    const overshoot = { type: "bezier", x1: 0.3, y1: 2, x2: 0.7, y2: 2 };
    const doc = project(
      [
        composition("main", [
          layer("a", "audio", {
            assetId: "song",
            startFrame: 5,
            volume: { keyframes: [kf(0, 1, overshoot), kf(10, 0)] },
          }),
        ]),
      ],
      {
        assets: [
          {
            id: "song",
            name: "song",
            type: "audio",
            uri: "assets/song.mp3",
            sha256: "0".repeat(64),
            durationMs: 3000,
          },
        ],
      },
    );
    expect(evaluateFrame(doc, 10).audio).toEqual([
      { id: "a", assetId: "song", layerFrame: 5, volume: 0 },
    ]);
  });
});

describe("evaluateFrame: determinism", () => {
  const doc = deepFreeze(
    project([
      composition("main", [
        solid("a", {
          parent: "n",
          transform: transform({
            rotation: {
              keyframes: [kf(0, 0, { type: "spring", damping: 0.5, response: 0.5 }), kf(60, 360)],
            },
            skew: prop(12),
            anchorPoint: prop([50, 50]),
          }),
        }),
        layer("n", "null", {
          transform: transform({ position: { keyframes: [kf(0, [0, 0]), kf(89, [500, 300])] } }),
        }),
        layer("pc", "precomp", { compositionId: "inner", startFrame: 3 }),
        layer("pc2", "precomp", { compositionId: "inner", startFrame: 3 }),
      ]),
      composition(
        "inner",
        [
          solid("s", {
            transform: transform({ scale: { keyframes: [kf(0, [0, 0]), kf(30, [1, 1])] } }),
          }),
        ],
        {
          fps: { num: 24, den: 1 },
        },
      ),
      composition("ntsc", [layer("pi", "precomp", { compositionId: "inner" })], {
        fps: { num: 30000, den: 1001 },
      }),
    ]),
  );

  it("returns equal output for the same document and frame and never mutates the document", () => {
    for (const frame of [0, 7, 33, 89]) {
      expect(evaluateFrame(doc, frame)).toEqual(evaluateFrame(doc, frame));
      expect(evaluateFrame(doc, frame, "ntsc")).toEqual(evaluateFrame(doc, frame, "ntsc"));
    }
  });

  it("carries no state between calls", () => {
    const first = evaluateFrame(doc, 40);
    evaluateFrame(doc, 12);
    evaluateFrame(doc, 12, "ntsc");
    expect(evaluateFrame(doc, 40)).toEqual(first);
  });
});

describe("video layers", () => {
  const clip = (fps: { num: number; den: number }, frameCount: number) => ({
    id: "clip",
    name: "clip",
    type: "video",
    uri: `assets/${"0".repeat(64)}.json`,
    sha256: "0".repeat(64),
    width: 64,
    height: 36,
    fps,
    frameCount,
  });
  const at = (doc: ReturnType<typeof project>, frame: number) =>
    (evaluateFrame(doc, frame).layers[0] as { sourceFrame: number | null }).sourceFrame;

  it("maps layer time to source frames with exact rational time, nothing outside the clip", () => {
    // 24 fps footage in a 30 fps composition, starting at composition frame 10.
    const doc = project(
      [composition("main", [layer("v", "video", { assetId: "clip", startFrame: 10 })])],
      { assets: [clip({ num: 24, den: 1 }, 48)] },
    );
    expect([0, 9, 10, 11, 14, 15, 69, 70].map((f) => at(doc, f))).toEqual([
      null,
      null,
      0,
      0,
      3,
      4,
      47,
      null,
    ]);
  });

  it("maps NTSC rates exactly", () => {
    const doc = project(
      [
        composition("main", [layer("v", "video", { assetId: "clip" })], {
          fps: { num: 30000, den: 1001 },
        }),
      ],
      { assets: [clip({ num: 30000, den: 1001 }, 90)] },
    );
    expect([0, 1, 89].map((f) => at(doc, f))).toEqual([0, 1, 89]);
  });
});

describe("evaluateFrame: behaviors", () => {
  const b = (id: string, property: string, type: string, rest: Obj): Obj => ({
    id,
    name: id,
    enabled: true,
    property,
    type,
    ...rest,
  });
  const wiggle = (id: string, property: string, rest: Obj = {}) =>
    b(id, property, "wiggle", {
      frequency: prop(2),
      amplitude: prop(property === "position" || property === "scale" ? [20, 10] : 10),
      octaves: 2,
      seed: 7,
      linked: false,
      ...rest,
    });
  const oscillate = (id: string, property: string, rest: Obj = {}) =>
    b(id, property, "oscillate", {
      frequency: prop(7.5), // 4 frames per period at 30 fps
      amplitude: prop(10),
      phase: 0,
      waveform: "sine",
      ...rest,
    });
  const loopB = (property: string, mode: string, rest: Obj = {}) =>
    b(`loop-${property}-${mode}`, property, "loop", { direction: "out", mode, span: 0, ...rest });
  const inertiaB = (property: string, rest: Obj = {}) =>
    b(`inertia-${property}`, property, "inertia", {
      amplitude: 0.1,
      frequency: 1.25,
      decay: 3,
      ...rest,
    });
  const link = (id: string, property: string, layerId: string, from: string, rest: Obj = {}) =>
    b(id, property, "link", {
      source: { layer: layerId, property: from },
      multiply: 1,
      offset: property === "position" || property === "scale" ? [0, 0] : 0,
      delay: 0,
      ...rest,
    });
  const withBehaviors = (id: string, behaviors: Obj[], tf: Obj = {}, rest: Obj = {}) =>
    solid(id, { behaviors, transform: transform(tf), ...rest });
  const at = (doc: Obj[], frame: number, i = 0) => single(doc, frame).layers[i] as ResolvedLayer;
  const rotationTrack = (...keys: [number, number][]) => ({
    keyframes: keys.map(([f, v]) => kf(f, v)),
  });
  const long = { durationFrames: 100_000 };
  const longLayer = { outFrame: 100_000 };

  it("evaluates a layer with an empty or disabled-only list exactly like one without", () => {
    const tf = {
      position: { keyframes: [kf(0, [0, 0]), kf(60, [100, 50])] },
      rotation: rotationTrack([0, 0], [60, 90]),
    };
    const plain = single([composition("main", [solid("a", { transform: transform(tf) })])], 17);
    const empty = single([composition("main", [withBehaviors("a", [], tf)])], 17);
    const disabled = single(
      [
        composition("main", [
          withBehaviors(
            "a",
            [
              oscillate("o", "rotation", { enabled: false }),
              wiggle("w", "position", { enabled: false }),
              link("l", "opacity", "b", "opacity", { enabled: false }),
            ],
            tf,
          ),
          solid("b"),
        ]),
      ],
      17,
    );
    expect(empty).toEqual(plain);
    expect(disabled.layers[0]).toEqual(plain.layers[0]);
  });

  it("is deterministic: any frame order gives the same values, and the document is untouched", () => {
    const doc = deepFreeze(
      project([
        composition("main", [
          withBehaviors(
            "a",
            [wiggle("w", "position", { octaves: 3 }), oscillate("o", "rotation")],
            { rotation: prop(5) },
          ),
        ]),
      ]),
    );
    const frames = [30, 5, 60, 5, 89, 0, 30];
    const first = new Map(frames.map((f) => [f, evaluateFrame(doc, f)]));
    for (const f of [...frames].reverse()) expect(evaluateFrame(doc, f)).toEqual(first.get(f));
  });

  describe("wiggle", () => {
    const pos = (doc: Obj[], frame: number) => at(doc, frame).transform.position;
    const base = { position: prop([100, 200]) };

    it("stays within the amplitude of the base value over many frames", () => {
      const doc = [composition("main", [withBehaviors("a", [wiggle("w", "position")], base)])];
      let moved = false;
      for (let f = 0; f < 90; f++) {
        const [x, y] = pos(doc, f);
        expect(Math.abs(x - 100)).toBeLessThanOrEqual(20);
        expect(Math.abs(y - 200)).toBeLessThanOrEqual(10);
        if (x !== 100) moved = true;
      }
      expect(moved).toBe(true);
    });

    it("uses layer time, so startFrame shifts the noise", () => {
      const doc = (start: number) => [
        composition("main", [
          withBehaviors("a", [wiggle("w", "position")], base, { startFrame: start }),
        ]),
      ];
      expect(pos(doc(0), 40)).toEqual(pos(doc(10), 50));
      expect(pos(doc(0), 40)).not.toEqual(pos(doc(0), 41));
    });

    it("differs by seed and by octaves", () => {
      const run = (rest: Obj) =>
        pos([composition("main", [withBehaviors("a", [wiggle("w", "position", rest)], base)])], 11);
      expect(run({ seed: 1 })).not.toEqual(run({ seed: 2 }));
      expect(run({ octaves: 1 })).not.toEqual(run({ octaves: 4 }));
      expect(run({ seed: 4294967295 })).not.toEqual(run({ seed: 0 }));
    });

    it("gives linked axes the same noise, scaled by each amplitude (uniform scale wiggle)", () => {
      const doc = [
        composition("main", [
          withBehaviors(
            "a",
            [wiggle("w", "scale", { linked: true, amplitude: prop([0.4, 0.1]) })],
            {
              scale: prop([1, 1]),
            },
          ),
        ]),
      ];
      for (let f = 0; f < 60; f++) {
        const [sx, sy] = at(doc, f).transform.scale;
        expect((sx - 1) / 4).toBeCloseTo(sy - 1, 12);
      }
      const unlinked = [
        composition("main", [
          withBehaviors("a", [wiggle("w", "scale", { amplitude: prop([0.4, 0.4]) })], {
            scale: prop([1, 1]),
          }),
        ]),
      ];
      const [ux, uy] = at(unlinked, 7).transform.scale;
      expect(ux).not.toBe(uy);
    });

    it("samples an animated amplitude and frequency at the layer frame", () => {
      const quiet = [
        composition("main", [
          withBehaviors("a", [
            wiggle("w", "rotation", { amplitude: { keyframes: [kf(0, 0), kf(60, 30)] } }),
          ]),
        ]),
      ];
      expect(at(quiet, 0).transform.rotation).toBe(0);
      expect(Math.abs(at(quiet, 30).transform.rotation)).toBeLessThanOrEqual(15);
    });
  });

  describe("oscillate", () => {
    const rot = (waveform: string, frame: number, phase = 0) =>
      at(
        [
          composition("main", [
            withBehaviors("a", [oscillate("o", "rotation", { waveform, phase })], {
              rotation: prop(10),
            }),
          ]),
        ],
        frame,
      ).transform.rotation;

    it("adds the wave to the base value at quarter periods", () => {
      expect(rot("sine", 0)).toBe(10);
      expect(rot("sine", 1)).toBeCloseTo(20, 9);
      expect(rot("sine", 3)).toBeCloseTo(0, 9);
      expect(rot("sine", 0, 90)).toBeCloseTo(20, 9);
      expect(rot("triangle", 1)).toBeCloseTo(20, 9);
      expect(rot("triangle", 3)).toBeCloseTo(0, 9);
      expect(rot("square", 1)).toBe(20);
      expect(rot("square", 3)).toBe(0);
      expect(rot("sawtooth", 0)).toBe(0);
      expect(rot("sawtooth", 2)).toBeCloseTo(10, 9);
      expect(rot("sawtooth", 3)).toBeCloseTo(15, 9);
    });

    it("works on vectors with a vector amplitude", () => {
      const out = at(
        [
          composition("main", [
            withBehaviors("a", [oscillate("o", "position", { amplitude: prop([30, -6]) })], {
              position: prop([100, 100]),
            }),
          ]),
        ],
        1,
      ).transform.position;
      expect(out[0]).toBeCloseTo(130, 9);
      expect(out[1]).toBeCloseTo(94, 9);
    });

    it("rejects an amplitude of the wrong kind with a clear error", () => {
      const doc = jsonClone(
        project([composition("main", [withBehaviors("a", [oscillate("o", "rotation")])])]),
      );
      const tampered = doc.compositions[0]?.layers[0] as unknown as {
        behaviors: Record<string, unknown>[];
      };
      tampered.behaviors = [{ ...tampered.behaviors[0], amplitude: { value: [1, 2] } }];
      expect(() => evaluateFrame(doc, 0)).toThrow(/amplitude of 'o' must be a number/);
    });
  });

  describe("loop", () => {
    const track = { rotation: rotationTrack([0, 0], [30, 90]) };
    const rot = (loops: Obj[], frame: number, layerOverrides: Obj = {}, comp: Obj = {}) =>
      at([composition("main", [withBehaviors("a", loops, track, layerOverrides)], comp)], frame)
        .transform.rotation;

    it("plays nothing different inside the keyframes", () => {
      expect(rot([loopB("rotation", "cycle")], 15)).toBe(45);
      expect(rot([loopB("rotation", "cycle")], 30)).toBe(90);
    });

    it("cycles, ping-pongs, offsets and continues out", () => {
      expect(rot([loopB("rotation", "cycle")], 45)).toBe(45);
      expect(rot([loopB("rotation", "pingpong")], 45)).toBe(45);
      expect(rot([loopB("rotation", "pingpong")], 60)).toBe(0);
      expect(rot([loopB("rotation", "offset")], 45)).toBe(135);
      expect(rot([loopB("rotation", "offset")], 75)).toBe(225);
      expect(rot([loopB("rotation", "continue")], 60)).toBe(180);
    });

    it("does the same before the first keyframe with direction in", () => {
      const inward = (mode: string, frame: number) =>
        rot([loopB("rotation", mode, { direction: "in" })], frame, { startFrame: 40 });
      // comp frame 25 is layer frame -15.
      expect(inward("cycle", 25)).toBe(45);
      expect(inward("pingpong", 25)).toBe(45);
      expect(inward("offset", 25)).toBe(-45);
      expect(inward("continue", 25)).toBe(-45);
    });

    it("applies the span, and loops far past the end", () => {
      const keys = { rotation: rotationTrack([0, 0], [30, 30], [60, 90]) };
      const spanned = (span: number, frame: number) =>
        at(
          [
            composition(
              "main",
              [withBehaviors("a", [loopB("rotation", "cycle", { span })], keys, longLayer)],
              long,
            ),
          ],
          frame,
        ).transform.rotation;
      expect(spanned(1, 75)).toBe(60); // 30..60 repeats: 75 -> 45 -> 30 + 15 * 2
      expect(spanned(0, 75)).toBe(15); // 0..60 repeats: 75 -> 15
      expect(spanned(5, 75)).toBe(15);
      expect(spanned(1, 60 * 1000 + 45)).toBe(60);
    });

    it("does nothing on a property with one keyframe or a constant value", () => {
      const one = at(
        [
          composition("main", [
            withBehaviors("a", [loopB("rotation", "offset")], {
              rotation: rotationTrack([10, 33]),
            }),
          ]),
        ],
        50,
      );
      expect(one.transform.rotation).toBe(33);
      const constant = at(
        [
          composition("main", [
            withBehaviors("a", [loopB("rotation", "cycle")], { rotation: prop(5) }),
          ]),
        ],
        50,
      );
      expect(constant.transform.rotation).toBe(5);
    });

    it("loops X and Y of a separate position independently", () => {
      const sep = {
        position: {
          separate: {
            x: rotationTrack([0, 0], [30, 60]),
            y: rotationTrack([0, 0], [60, 30]),
          },
        },
      };
      const pos = (mode: string, frame: number) =>
        at(
          [
            composition(
              "main",
              [withBehaviors("a", [loopB("position", mode)], sep, longLayer)],
              long,
            ),
          ],
          frame,
        ).transform.position;
      expect(pos("cycle", 45)).toEqual([30, 22.5]);
      expect(pos("continue", 90)).toEqual([180, 45]);
    });

    it("continues a spatial path along its end tangent at its length per second", () => {
      const spatial = {
        position: {
          keyframes: [
            { ...kf(0, [0, 0]), spatial: { inTangent: [0, 0], outTangent: [0, 50] } },
            { ...kf(30, [100, 0]), spatial: { inTangent: [0, 50], outTangent: [0, 0] } },
          ],
        },
      };
      const length = cubicPath([0, 0], [0, 50], [100, 50], [100, 0]).length;
      const [x, y] = at(
        [composition("main", [withBehaviors("a", [loopB("position", "continue")], spatial)])],
        60,
      ).transform.position;
      expect(x).toBeCloseTo(100, 9);
      expect(y).toBeCloseTo(-length, 9);
    });
  });

  describe("inertia", () => {
    const pos = (kfs: unknown[], frame: number, rest: Obj = {}) =>
      at(
        [
          composition("main", [
            withBehaviors("a", [inertiaB("position", rest)], { position: { keyframes: kfs } }),
          ]),
        ],
        frame,
      ).transform.position;
    const ramp = [kf(0, [0, 0]), kf(30, [300, 0])];

    it("settles after a linear arrival with the formula's offset", () => {
      expect(pos(ramp, 30)).toEqual([300, 0]);
      // t = 0.2 s: sin(pi / 2) = 1; v = 300 units/s.
      expect(pos(ramp, 36)[0]).toBeCloseTo(300 + (300 * 0.1) / Math.exp(0.6), 9);
      expect(pos(ramp, 36)[1]).toBe(0);
      expect(Math.abs(pos(ramp, 80)[0] - 300)).toBeLessThan(Math.abs(pos(ramp, 36)[0] - 300));
    });

    it("adds nothing when the move arrives at rest", () => {
      const easeOut = { type: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
      expect(pos([kf(0, [0, 0], easeOut), kf(30, [300, 0])], 36)).toEqual([300, 0]);
      expect(pos([kf(0, [0, 0], { type: "hold" }), kf(30, [300, 0])], 36)).toEqual([300, 0]);
      const spring = { type: "spring", damping: 0.8, response: 0.5 };
      expect(pos([kf(0, [0, 0], spring), kf(60, [300, 0])], 70)).toEqual([300, 0]);
    });

    it("adds nothing before the second keyframe is reached", () => {
      expect(pos(ramp, 10)).toEqual([100, 0]);
    });
  });

  describe("link", () => {
    const src = (extra: Obj[] = [], tf: Obj = {}, rest: Obj = {}) =>
      withBehaviors("src", extra, { rotation: rotationTrack([0, 0], [89, 89]), ...tf }, rest);
    const dst = (behaviors: Obj[], tf: Obj = {}, rest: Obj = {}) =>
      withBehaviors("dst", behaviors, tf, rest);
    const rotationOf = (doc: Obj[], frame: number, id: string) =>
      (single(doc, frame).layers.find((l) => l.id === id) as ResolvedLayer).transform.rotation;

    it("is source * multiply + offset", () => {
      const doc = [
        composition("main", [
          dst([link("l", "rotation", "src", "rotation", { multiply: 2, offset: 5 })]),
          src(),
        ]),
      ];
      expect(rotationOf(doc, 10, "dst")).toBe(25);
      const vec = [
        composition("main", [
          dst([link("l", "position", "src", "position", { multiply: 0.5, offset: [1, -1] })]),
          src([], { position: { keyframes: [kf(0, [0, 0]), kf(60, [60, 120])] } }),
        ]),
      ];
      expect(at(vec, 30).transform.position).toEqual([16, 29]);
    });

    it("reads the source at frame minus delay, including before frame 0", () => {
      const doc = (delay: number) => [
        composition("main", [dst([link("l", "rotation", "src", "rotation", { delay })]), src()]),
      ];
      expect(rotationOf(doc(3), 10, "dst")).toBe(7);
      expect(rotationOf(doc(5), 2, "dst")).toBe(0); // frame -3: the track holds its first value
    });

    it("reads the source's own behaviors, with the same delay", () => {
      const doc = (delay: number) => [
        composition("main", [
          dst([link("l", "rotation", "src", "rotation", { delay })]),
          src([wiggle("w", "rotation"), oscillate("o", "rotation")], { rotation: prop(3) }),
        ]),
      ];
      const lagged = rotationOf(doc(4), 20, "dst");
      expect(lagged).toBe(rotationOf(doc(0), 16, "src"));
      expect(lagged).not.toBe(3);
    });

    it("reads the source's clamped value and its own parent space, not world", () => {
      const doc = [
        composition("main", [
          dst([link("l", "rotation", "src", "opacity", { multiply: 100 })]),
          src(
            [oscillate("o", "opacity", { amplitude: prop(5) })],
            { opacity: prop(0.5) },
            { parent: "p" },
          ),
          layer("p", "null", {
            transform: transform({ position: prop([500, 500]), rotation: prop(45) }),
          }),
        ]),
      ];
      expect([0, 1, 3].map((f) => rotationOf(doc, f, "dst"))).toEqual([50, 100, 0]);
      expect(single(doc, 0).layers[1]?.transform.position).toEqual([0, 0]);
    });

    it("can read another property of the same layer", () => {
      const doc = [
        composition("main", [
          withBehaviors("a", [link("l", "rotation", "a", "opacity", { multiply: 90 })], {
            opacity: prop(0.5),
          }),
        ]),
      ];
      expect(rotationOf(doc, 0, "a")).toBe(45);
    });

    it("lets behaviors on the linked property apply on top", () => {
      const doc = [
        composition("main", [
          dst([link("l", "rotation", "src", "rotation"), oscillate("o", "rotation")]),
          src(),
        ]),
      ];
      expect(rotationOf(doc, 1, "dst")).toBeCloseTo(1 + 10, 9);
    });

    it("resolves a chain of 1000 links without recursing", () => {
      const layers: Obj[] = [];
      for (let i = 999; i >= 0; i--)
        layers.push(
          i === 0
            ? withBehaviors("l0", [], { rotation: prop(10) })
            : withBehaviors(`l${i}`, [
                link("k", "rotation", `l${i - 1}`, "rotation", { offset: 1 }),
              ]),
        );
      const out = single([composition("main", layers)]);
      expect(out.layers).toHaveLength(1000);
      expect(out.layers[0]?.transform.rotation).toBe(1009);
      expect(out.layers[999]?.transform.rotation).toBe(10);
    });

    it("resolves a 300-link chain where every link has a delay", () => {
      const layers: Obj[] = [];
      for (let i = 299; i >= 0; i--)
        layers.push(
          i === 0
            ? withBehaviors("l0", [], { rotation: rotationTrack([0, 0], [89, 89]) })
            : withBehaviors(`l${i}`, [
                link("k", "rotation", `l${i - 1}`, "rotation", { delay: 1 }),
              ]),
        );
      const out = single([composition("main", layers)], 80);
      // The top of the chain reads layer 0 at frame 80 - 299: the track holds its first value.
      expect(out.layers[0]?.transform.rotation).toBe(0);
      expect(out.layers[298]?.transform.rotation).toBe(79); // l1 reads l0 at frame 79
    });

    it("refuses links that form a cycle instead of looping", () => {
      const doc = jsonClone(
        project([composition("main", [dst([link("l", "rotation", "src", "rotation")]), src()])]),
      );
      const srcLayer = doc.compositions[0]?.layers[1] as unknown as { behaviors: unknown[] };
      srcLayer.behaviors = [link("back", "rotation", "dst", "rotation", { delay: 1 })];
      expect(() => evaluateFrame(doc, 5)).toThrow(/links form a cycle/);
    });

    it("drives a child from a parent's behaviors through parenting", () => {
      const doc = [
        composition("main", [
          solid("child", { parent: "parent", transform: transform({ position: prop([10, 0]) }) }),
          withBehaviors("parent", [oscillate("o", "rotation", { amplitude: prop(90) })], {
            position: prop([100, 100]),
          }),
        ]),
      ];
      const out = single(doc, 1);
      const parent = out.layers[1] as ResolvedLayer;
      const child = out.layers[0] as ResolvedLayer;
      expect(parent.transform.rotation).toBeCloseTo(90, 9);
      expect(applyToPoint(child.matrix, [0, 0])[0]).toBeCloseTo(100, 9);
      expect(applyToPoint(child.matrix, [0, 0])[1]).toBeCloseTo(110, 9);
      expect(child.matrix).toEqual(multiply(parent.matrix, transformMatrix(child.transform)));
    });
  });

  describe("order and clamps", () => {
    it("clamps opacity to 0..1 and skew to +-85 after the behaviors", () => {
      const doc = [
        composition("main", [
          withBehaviors(
            "a",
            [
              oscillate("o1", "opacity", { amplitude: prop(2), waveform: "square" }),
              oscillate("o2", "skew", { amplitude: prop(200), waveform: "square" }),
            ],
            { opacity: prop(0.5), skew: prop(0) },
          ),
        ]),
      ];
      expect(at(doc, 1).transform.opacity).toBe(1);
      expect(at(doc, 3).transform.opacity).toBe(0);
      expect(at(doc, 1).transform.skew).toBe(85);
      expect(at(doc, 3).transform.skew).toBe(-85);
    });

    it("applies the base, inertia, link, then oscillators and wigglers, whatever the list order", () => {
      const ramp = rotationTrack([0, 0], [30, 90]);
      const a = at(
        [
          composition("main", [
            withBehaviors(
              "a",
              [
                oscillate("o", "rotation", { amplitude: prop(10) }),
                inertiaB("rotation"),
                loopB("rotation", "cycle"),
              ],
              { rotation: ramp },
            ),
          ]),
        ],
        37,
      );
      const b = at(
        [
          composition("main", [
            withBehaviors(
              "a",
              [
                loopB("rotation", "cycle"),
                inertiaB("rotation"),
                oscillate("o", "rotation", { amplitude: prop(10) }),
              ],
              { rotation: ramp },
            ),
          ]),
        ],
        37,
      );
      expect(a.transform.rotation).toBe(b.transform.rotation);
    });
  });
});
