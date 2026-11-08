import { describe, expect, it } from "vitest";
import { evaluateFrame } from "./evaluate.js";
import { composition, layer, type Obj, project, prop, solid } from "./fixtures.test-util.js";
import type { ResolvedLayer, ResolvedPrecompLayer } from "./resolved.js";

const kf = (frame: number, value: unknown) => ({
  frame,
  value,
  interpolation: { type: "linear" },
});

const box = (size: number) => ({
  closed: true,
  vertices: [
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ].map((point) => ({ point, inTangent: [0, 0], outTangent: [0, 0] })),
});

const mask = (id: string, overrides: Obj = {}): Obj => ({
  id,
  name: id,
  mode: "add",
  inverted: false,
  path: prop(box(10)),
  feather: prop([0, 0]),
  opacity: prop(1),
  expansion: prop(0),
  ...overrides,
});

const matte = (layerId: string, mode = "alpha") => ({ layerId, mode });
const frame0 = (layers: Obj[], frame = 0) =>
  evaluateFrame(project([composition("main", layers)]), frame);
const byId = (layers: readonly ResolvedLayer[], id: string) =>
  layers.find((l) => l.id === id) as ResolvedLayer;

describe("evaluateFrame: blend modes and masks", () => {
  it("passes the blend mode through and defaults to unmasked, unmatted", () => {
    const [a, b] = frame0([solid("a", { blendMode: "multiply" }), solid("b")]).layers;
    expect(a).toMatchObject({ blendMode: "multiply", masks: [], matte: null });
    expect(b).toMatchObject({ blendMode: "normal", masks: [], matte: null });
  });

  it("samples masks in layer time and leaves out `none` masks", () => {
    const [s] = frame0(
      [
        solid("s", {
          startFrame: -5,
          masks: [
            mask("off", { mode: "none" }),
            mask("m", {
              mode: "subtract",
              inverted: true,
              path: { keyframes: [kf(0, box(0)), kf(10, box(20))] },
              feather: { keyframes: [kf(0, [0, 4]), kf(10, [10, 4])] },
              opacity: { keyframes: [kf(0, 0), kf(10, 1)] },
              expansion: { keyframes: [kf(0, -6), kf(10, 6)] },
            }),
          ],
        }),
      ],
      0,
    ).layers;
    expect(s?.masks).toEqual([
      {
        id: "m",
        mode: "subtract",
        inverted: true,
        path: {
          closed: true,
          vertices: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ].map((point) => ({ point, inTangent: [0, 0], outTangent: [0, 0] })),
        },
        feather: [5, 4],
        opacity: 0.5,
        expansion: 0,
      },
    ]);
  });
});

describe("evaluateFrame: track mattes", () => {
  it("resolves a hidden matte source without drawing it", () => {
    const comp = frame0([solid("t", { matte: matte("m", "luma") }), solid("m", { hidden: true })]);
    expect(comp.layers.map((l) => l.id)).toEqual(["t"]);
    expect(comp.layers[0]?.matte).toMatchObject({
      layerId: "m",
      mode: "luma",
      source: { id: "m", type: "solid" },
    });
  });

  it("shares one object when the source is also drawn", () => {
    const comp = frame0([solid("t", { matte: matte("m") }), solid("m")]);
    expect(comp.layers[0]?.matte?.source).toBe(comp.layers[1]);
  });

  it("keeps a matte on a soloed layer even though its source is not soloed", () => {
    const comp = frame0([solid("t", { solo: true, matte: matte("m") }), solid("m")]);
    expect(comp.layers.map((l) => l.id)).toEqual(["t"]);
    expect(comp.layers[0]?.matte?.source?.id).toBe("m");
  });

  it("gives an empty matte (null source) outside the source's in/out range", () => {
    const comp = frame0([solid("t", { matte: matte("m") }), solid("m", { inFrame: 5 })]);
    expect(comp.layers[0]?.matte).toEqual({ layerId: "m", mode: "alpha", source: null });
  });

  it("resolves matte chains through hidden layers, each at its own layer time and masks", () => {
    const comp = frame0([
      solid("a", { matte: matte("b") }),
      solid("b", { hidden: true, matte: matte("c", "alpha-inverted"), masks: [mask("mb")] }),
      solid("c", {
        hidden: true,
        startFrame: -3,
        transform: {
          anchorPoint: prop([0, 0]),
          position: { keyframes: [kf(0, [0, 0]), kf(10, [10, 0])] },
          scale: prop([1, 1]),
          rotation: prop(0),
          skew: prop(0),
          opacity: prop(1),
        },
      }),
    ]);
    const b = comp.layers[0]?.matte?.source;
    expect(b?.masks.map((m) => m.id)).toEqual(["mb"]);
    expect(b?.matte).toMatchObject({ mode: "alpha-inverted", source: { id: "c", layerFrame: 3 } });
    expect(b?.matte?.source?.transform.position).toEqual([3, 0]);
  });

  it("resolves mattes inside precomps against that composition's layers", () => {
    const doc = project([
      composition("main", [layer("p", "precomp", { compositionId: "inner" })]),
      composition("inner", [solid("t", { matte: matte("m") }), solid("m", { hidden: true })]),
    ]);
    const p = evaluateFrame(doc, 0).layers[0] as ResolvedPrecompLayer;
    const inner = p.composition?.layers ?? [];
    expect(byId(inner, "t").matte?.source?.id).toBe("m");
  });

  it("is deterministic with mattes and masks", () => {
    const doc = project([
      composition("main", [
        solid("t", { matte: matte("m"), masks: [mask("x", { feather: prop([2, 3]) })] }),
        solid("m", { hidden: true, matte: matte("n") }),
        solid("n"),
      ]),
    ]);
    expect(evaluateFrame(doc, 4)).toEqual(evaluateFrame(doc, 4));
  });

  it("charges mask vertices inside precomps against the work budget", () => {
    const many = (n: number) => ({
      closed: true,
      vertices: Array.from({ length: n }, (_, i) => ({
        point: [i, i % 2],
        inTangent: [0, 0],
        outTangent: [0, 0],
      })),
    });
    const masks = Array.from({ length: 32 }, (_, i) => mask(`m${i}`, { path: prop(many(1000)) }));
    const doc = project([
      composition(
        "main",
        Array.from({ length: 40 }, (_, i) =>
          layer(`p${i}`, "precomp", { compositionId: "c", startFrame: -i }),
        ),
      ),
      composition("c", [solid("s", { masks })], { durationFrames: 100 }),
    ]);
    expect(() => evaluateFrame(doc, 0)).toThrow(/units of work/);
    // Heavy by design, like the budget tests in evaluate.test.ts; CI runs every package at once.
  }, 20_000);
});
