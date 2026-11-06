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
import type { ResolvedLayer, ResolvedPrecompLayer } from "./resolved.js";

const linear = { type: "linear" };
const kf = (frame: number, value: unknown, interpolation: Obj = linear) => ({
  frame,
  value,
  interpolation,
});
const ids = (layers: readonly ResolvedLayer[]) => layers.map((l) => l.id);
const single = (doc: Obj[], frame = 0) => evaluateFrame(project(doc), frame);

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
    // main: 999 placements of c1 at distinct offsets plus one shape layer (1,000 units);
    // c1: 1,000 solids, evaluated at 999 frames (999,000 units). Total: exactly 1,000,000.
    const rect = {
      id: "r",
      name: "r",
      type: "rect",
      position: prop([0, 0]),
      size: prop([1, 1]),
      cornerRadius: prop(0),
    };
    const placements = Array.from({ length: 999 }, (_, i) =>
      precomp(`a${i}`, "c1", { startFrame: -i, inFrame: 0 }),
    );
    const c1 = composition(
      "c1",
      Array.from({ length: 1000 }, (_, i) => solid(`s${i}`)),
      { durationFrames: 1000 },
    );
    const doc = (contents: Obj[]) =>
      project([composition("main", [...placements, layer("extra", "shape", { contents })]), c1]);
    expect(evaluateFrame(doc([]), 0).layers).toHaveLength(1000);
    // One rect in main's shape layer is exactly one more unit.
    expect(() => evaluateFrame(doc([rect]), 0)).toThrow(RangeError);
  }, 20_000);

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
      fill: { r: 1, g: 1, b: 1, a: 1 },
    });
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
