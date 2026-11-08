import { type Composition, ProjectSchema, springSettleFrames } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { withLayerDefaults } from "./defaults.js";
import { describeMotion, summarizeValue } from "./motion.js";

const SIZE = { width: 1920, height: 1080, durationFrames: 90 } as never;

/** A validated composition built from layers given as add_layer bodies (ids filled in). */
function comp(layers: Record<string, unknown>[]): Composition {
  const project = ProjectSchema.parse({
    formatVersion: 3,
    name: "M",
    mainCompositionId: "main",
    style: null,
    assets: [],
    compositions: [
      {
        id: "main",
        name: "Main",
        width: 1920,
        height: 1080,
        fps: { num: 30, den: 1 },
        durationFrames: 90,
        background: null,
        markers: [],
        layers: layers.map((l, i) => ({ id: `l${i}`, ...(withLayerDefaults(l, SIZE) as object) })),
      },
      {
        id: "inner",
        name: "Inner",
        width: 100,
        height: 100,
        fps: { num: 30, den: 1 },
        durationFrames: 30,
        background: null,
        markers: [],
        layers: [],
      },
    ],
  });
  return project.compositions[0] as Composition;
}

const solid = (extra: Record<string, unknown> = {}) => ({
  type: "solid",
  name: "Box",
  width: 100,
  height: 100,
  color: "#ff0000",
  ...extra,
});

const ease = { type: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };

describe("describeMotion", () => {
  it("lists segments between keyframes in composition frames and seconds", () => {
    const c = comp([
      solid({
        startFrame: 10,
        transform: {
          opacity: {
            keyframes: [
              { frame: 0, value: 0, interpolation: ease },
              { frame: 15, value: 1, interpolation: { type: "hold" } },
              { frame: 45, value: 0.333333, interpolation: { type: "linear" } },
            ],
          },
        },
      }),
    ]);
    const [layer] = describeMotion(c).layers;
    expect(layer).toMatchObject({ id: "l0", name: "Box", index: 0, in_frame: 0, out_frame: 90 });
    expect(layer?.properties).toEqual([
      {
        property: "transform.opacity",
        segments: [
          {
            from_frame: 10,
            to_frame: 25,
            from_seconds: 0.333,
            to_seconds: 0.833,
            from: 0,
            to: 1,
            easing: ease,
          },
          {
            from_frame: 25,
            to_frame: 55,
            from_seconds: 0.833,
            to_seconds: 1.833,
            from: 1,
            to: 0.333,
            easing: { type: "hold" },
          },
        ],
      },
    ]);
  });

  it("reports springs with their settle frame, curved paths and single keyframes", () => {
    const spring = { damping: 0.6, response: 0.4 };
    const c = comp([
      solid({
        transform: {
          position: {
            keyframes: [
              {
                frame: 0,
                value: [0, 0],
                interpolation: { type: "spring", ...spring },
                spatial: { inTangent: [0, 0], outTangent: [50, 0] },
              },
              { frame: 60, value: [960.12345, 540], interpolation: { type: "linear" } },
            ],
          },
          rotation: { keyframes: [{ frame: 5, value: 45, interpolation: { type: "linear" } }] },
        },
      }),
    ]);
    const props = describeMotion(c).layers[0]?.properties;
    expect(props).toEqual([
      {
        property: "transform.position",
        segments: [
          expect.objectContaining({
            to: [960.123, 540],
            easing: {
              type: "spring",
              ...spring,
              settle_frame: springSettleFrames(spring, { num: 30, den: 1 }),
            },
            curved: true,
          }),
        ],
      },
      { property: "transform.rotation", segments: [], constant: 45 },
    ]);
  });

  it("filters by layer and window, flags hidden segments and notes precomp time", () => {
    const c = comp([
      solid({
        name: "Late",
        inFrame: 50,
        transform: {
          scale: {
            keyframes: [
              { frame: 0, value: [0, 0], interpolation: { type: "linear" } },
              { frame: 20, value: [100, 100], interpolation: { type: "linear" } },
              { frame: 70, value: [120, 120], interpolation: { type: "linear" } },
            ],
          },
        },
      }),
      { type: "precomp", name: "Inner", compositionId: "inner", startFrame: 30 },
    ]);
    const all = describeMotion(c);
    expect(all.layers[0]?.properties[0]?.segments.map((s) => s.outside_layer_range)).toEqual([
      true,
      undefined,
    ]);
    expect(all.layers[1]).toMatchObject({ precomp: { composition: "inner", time_offset: 30 } });

    const windowed = describeMotion(c, { from_frame: 40, to_frame: 89 });
    expect(windowed.layers[0]?.properties[0]?.segments.map((s) => s.from_frame)).toEqual([20]);
    expect(describeMotion(c, { layers: new Set(["l1"]) }).layers.map((l) => l.id)).toEqual(["l1"]);
    // A layer that ends before the window is left out.
    expect(describeMotion(c, { from_frame: 0, to_frame: 10 }).layers.map((l) => l.id)).toEqual([
      "l1",
    ]);
  });

  it("caps the listed segments and counts the rest", () => {
    const keyframes = Array.from({ length: 11 }, (_, i) => ({
      frame: i * 5,
      value: i,
      interpolation: { type: "linear" },
    }));
    const c = comp([solid({ transform: { rotation: { keyframes } } })]);
    const d = describeMotion(c, { maxSegments: 4 });
    expect(d.layers[0]?.properties[0]?.segments).toHaveLength(4);
    expect(d.truncated_segments).toBe(6);
  });
});

describe("summarizeValue", () => {
  it("rounds numbers and summarizes paths and large values", () => {
    expect(summarizeValue([1.23456, -0.0001])).toEqual([1.235, 0]);
    expect(summarizeValue({ closed: true, vertices: [{}, {}, {}] })).toEqual({
      path: "3 vertices",
      closed: true,
    });
    expect(summarizeValue("x".repeat(500))).toEqual({
      summary: "502 characters; get_layer shows the value",
    });
  });
});
