import { describe, expect, it } from "vitest";
import {
  composition,
  issues,
  nullLayer,
  type Obj,
  project,
  prop,
  visual,
} from "./fixtures.test-util.js";
import { BLEND_MODES, MAX_MASKS } from "./index.js";

const square = {
  closed: true,
  vertices: [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ].map((point) => ({ point, inTangent: [0, 0], outTangent: [0, 0] })),
};

const mask = (id: string, overrides: Obj = {}): Obj => ({
  id,
  name: id,
  mode: "add",
  inverted: false,
  path: prop(square),
  feather: prop([0, 0]),
  opacity: prop(1),
  expansion: prop(0),
  ...overrides,
});

const solid = (id: string, overrides: Obj = {}): Obj => ({
  ...visual(id),
  type: "solid",
  width: 100,
  height: 100,
  color: "#ff0000",
  ...overrides,
});

const adjustment = (id: string): Obj => ({ ...visual(id), type: "adjustment" });

const doc = (layers: Obj[]) => project({ compositions: [composition("main", layers)] });

describe("blend modes, track mattes and masks", () => {
  it("accepts every blend mode, every matte mode and animated masks", () => {
    const layers = BLEND_MODES.map((blendMode, i) => solid(`s${i}`, { blendMode }));
    const modes = ["alpha", "alpha-inverted", "luma", "luma-inverted"];
    modes.forEach((mode, i) => {
      layers.push(solid(`m${i}`, { matte: { layerId: "s0", mode } }));
    });
    layers.push(
      solid("masked", {
        masks: [
          mask("a"),
          mask("b", {
            mode: "subtract",
            inverted: true,
            path: {
              keyframes: [
                { frame: 0, value: square, interpolation: { type: "linear" } },
                { frame: 10, value: square, interpolation: { type: "hold" } },
              ],
            },
            feather: prop([4, 0]),
            opacity: prop(0.5),
            expansion: prop(-3),
          }),
        ],
      }),
    );
    expect(issues(doc(layers))).toEqual([]);
  });

  it("puts the new fields on drawing layers only, not on null layers", () => {
    expect(issues(doc([{ ...nullLayer("n"), blendMode: "normal" }]))).toMatchObject([
      { path: "compositions.0.layers.0", message: expect.stringContaining("blendMode") },
    ]);
    const { masks: _, ...noMasks } = solid("s");
    expect(issues(doc([noMasks]))).toMatchObject([{ path: "compositions.0.layers.0.masks" }]);
  });

  it("rejects unknown blend and mask modes, negative feather and out-of-range expansion", () => {
    const found = issues(
      doc([
        solid("a", { blendMode: "dissolve" }),
        solid("b", { masks: [mask("m", { mode: "union" })] }),
        solid("c", { masks: [mask("m", { feather: prop([-1, 0]) })] }),
        solid("d", { masks: [mask("m", { expansion: prop(-8193) })] }),
      ]),
    ).map((i) => i.path);
    expect(found).toEqual([
      "compositions.0.layers.0.blendMode",
      "compositions.0.layers.1.masks.0.mode",
      "compositions.0.layers.2.masks.0.feather.value.0",
      "compositions.0.layers.3.masks.0.expansion.value",
    ]);
  });

  it("requires mask ids unique within a layer, and at most MAX_MASKS masks", () => {
    expect(issues(doc([solid("s", { masks: [mask("m"), mask("m")] })]))).toMatchObject([
      {
        path: "compositions.0.layers.0.masks.1.id",
        message: expect.stringContaining("duplicate mask id 'm'"),
      },
    ]);
    // The same mask id on two layers is fine.
    expect(
      issues(doc([solid("a", { masks: [mask("m")] }), solid("b", { masks: [mask("m")] })])),
    ).toEqual([]);
    const many = Array.from({ length: MAX_MASKS + 1 }, (_, i) => mask(`m${i}`));
    expect(issues(doc([solid("s", { masks: many })]))).toMatchObject([
      { path: "compositions.0.layers.0.masks" },
    ]);
  });

  it("requires mask path keyframes to keep one topology", () => {
    const triangle = { ...square, vertices: square.vertices.slice(0, 3) };
    const path = {
      keyframes: [
        { frame: 0, value: square, interpolation: { type: "linear" } },
        { frame: 10, value: triangle, interpolation: { type: "linear" } },
      ],
    };
    expect(issues(doc([solid("s", { masks: [mask("m", { path })] })]))).toMatchObject([
      {
        path: "compositions.0.layers.0.masks.0.path.keyframes.1.value",
        message: expect.stringContaining("same vertex count"),
      },
    ]);
  });

  it("checks that a matte names another drawing layer of the same composition", () => {
    const matte = (layerId: string) => ({ layerId, mode: "alpha" });
    const found = issues(
      project({
        compositions: [
          composition("main", [
            solid("self", { matte: matte("self") }),
            solid("missing", { matte: matte("nope") }),
            solid("to-null", { matte: matte("n") }),
            solid("to-adjustment", { matte: matte("adj") }),
            solid("elsewhere", { matte: matte("other-layer") }),
            nullLayer("n"),
            adjustment("adj"),
          ]),
          composition("other", [solid("other-layer")]),
        ],
      }),
    );
    expect(found).toEqual([
      {
        path: "compositions.0.layers.0.matte.layerId",
        message: expect.stringContaining("a layer cannot be its own track matte"),
      },
      {
        path: "compositions.0.layers.1.matte.layerId",
        message: expect.stringContaining("'nope' is not a layer in composition 'main'"),
      },
      {
        path: "compositions.0.layers.2.matte.layerId",
        message: expect.stringContaining("'n' is a null layer"),
      },
      {
        path: "compositions.0.layers.3.matte.layerId",
        message: expect.stringContaining("'adj' is an adjustment layer"),
      },
      {
        path: "compositions.0.layers.4.matte.layerId",
        message: expect.stringContaining("'other-layer' is not a layer in composition 'main'"),
      },
    ]);
  });

  it("allows matte chains and reports each matte cycle once", () => {
    const matte = (layerId: string) => ({ layerId, mode: "luma" });
    expect(
      issues(
        doc([solid("a", { matte: matte("b") }), solid("b", { matte: matte("c") }), solid("c")]),
      ),
    ).toEqual([]);
    expect(
      issues(
        doc([
          solid("x", { matte: matte("a") }),
          solid("a", { matte: matte("b") }),
          solid("b", { matte: matte("c") }),
          solid("c", { matte: matte("a") }),
        ]),
      ),
    ).toEqual([
      {
        path: "compositions.0.layers.1.matte.layerId",
        message: "track matte cycle: a -> b -> c -> a; set matte to null on one of these layers",
      },
    ]);
  });
});
