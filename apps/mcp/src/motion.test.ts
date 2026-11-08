import { type Project, ProjectSchema, springSettleFrames } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { withLayerDefaults } from "./defaults.js";
import { describeMotion, type MotionOptions, summarizeValue } from "./motion.js";

const SIZE = { width: 1920, height: 1080, durationFrames: 90 } as never;

/** A validated project whose main composition holds these add_layer bodies (ids l0, l1, …). */
function comp(layers: Record<string, unknown>[], innerFps = 30): Project {
  return ProjectSchema.parse({
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
        fps: { num: innerFps, den: 1 },
        durationFrames: 30,
        background: null,
        markers: [],
        layers: [],
      },
    ],
  });
}

/** describe_motion of the main composition. */
const describe_ = (doc: Project, options?: MotionOptions) =>
  describeMotion(doc, doc.compositions[0] as Project["compositions"][number], options);

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
    const [layer] = describe_(c).layers;
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
    const props = describe_(c).layers[0]?.properties;
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
    const all = describe_(c);
    expect(all.layers[0]?.properties[0]?.segments.map((s) => s.outside_layer_range)).toEqual([
      true,
      undefined,
    ]);
    expect(all.layers[1]).toMatchObject({ precomp: { composition: "inner", time_offset: 30 } });

    const windowed = describe_(c, { from_frame: 40, to_frame: 89 });
    expect(windowed.layers[0]?.properties[0]?.segments.map((s) => s.from_frame)).toEqual([20]);
    expect(describe_(c, { layers: new Set(["l1"]) }).layers.map((l) => l.id)).toEqual(["l1"]);
    // A layer that starts after the window is left out.
    expect(describe_(c, { from_frame: 0, to_frame: 10 }).layers.map((l) => l.id)).toEqual(["l1"]);
  });

  it("caps the listed segments and counts the rest", () => {
    const keyframes = Array.from({ length: 11 }, (_, i) => ({
      frame: i * 5,
      value: i,
      interpolation: { type: "linear" },
    }));
    const c = comp([solid({ transform: { rotation: { keyframes } } })]);
    const d = describe_(c, { maxSegments: 4 });
    expect(d.layers[0]?.properties[0]?.segments).toHaveLength(4);
    expect(d.truncated_segments).toBe(6);
  });
});

describe("describeMotion: review regressions", () => {
  const linear = { type: "linear" };

  it("gives a spring's settle frame in composition frames", () => {
    const spring = { damping: 0.6, response: 0.4 };
    const c = comp([
      solid({
        startFrame: 10,
        transform: {
          rotation: {
            keyframes: [
              { frame: 20, value: 0, interpolation: { type: "spring", ...spring } },
              { frame: 60, value: 90, interpolation: linear },
            ],
          },
        },
      }),
    ]);
    const [segment] = describe_(c).layers[0]?.properties[0]?.segments ?? [];
    expect(segment?.from_frame).toBe(30);
    expect(segment?.easing).toEqual({
      type: "spring",
      ...spring,
      settle_frame: 30 + springSettleFrames(spring, { num: 30, den: 1 }),
    });
  });

  it("keeps the parents that move listed layers, even off screen or filtered out", () => {
    const c = comp([
      {
        type: "null",
        name: "Rig",
        outFrame: 10,
        transform: {
          position: {
            keyframes: [
              { frame: 20, value: [0, 0], interpolation: linear },
              { frame: 60, value: [100, 0], interpolation: linear },
            ],
          },
        },
      },
      solid({ name: "Logo", parent: "l0" }),
      solid({ name: "Other" }),
    ]);
    const windowed = describe_(c, { from_frame: 20, to_frame: 60 });
    expect(windowed.layers.map((l) => [l.id, l.parent_of_listed])).toEqual([
      ["l0", true],
      ["l1", undefined],
      ["l2", undefined],
    ]);
    expect(windowed.layers[0]?.properties[0]?.segments).toHaveLength(1);
    const selected = describe_(c, { layers: new Set(["l1"]) });
    expect(selected.layers.map((l) => l.id)).toEqual(["l0", "l1"]);
  });

  it("leaves out a layer that ends before the window", () => {
    const c = comp([solid({ outFrame: 10 }), solid({ name: "B" })]);
    expect(describe_(c, { from_frame: 10 }).layers.map((l) => l.id)).toEqual(["l1"]);
  });

  it("flags curves from either tangent, and not zero tangents", () => {
    const kf = (frame: number, spatial: { inTangent: number[]; outTangent: number[] }) => ({
      frame,
      value: [frame, 0],
      interpolation: linear,
      spatial,
    });
    const zero = { inTangent: [0, 0], outTangent: [0, 0] };
    const c = comp([
      solid({
        transform: {
          position: {
            keyframes: [
              kf(0, zero),
              kf(10, { inTangent: [5, 0], outTangent: [0, 0] }),
              kf(20, zero),
            ],
          },
        },
      }),
    ]);
    expect(describe_(c).layers[0]?.properties[0]?.segments.map((s) => s.curved)).toEqual([
      true,
      undefined,
    ]);
  });

  it("flags a segment ending where the layer starts, and gives the nested frame rate", () => {
    const c = comp(
      [
        solid({
          inFrame: 20,
          transform: {
            opacity: {
              keyframes: [
                { frame: 0, value: 0, interpolation: linear },
                { frame: 20, value: 1, interpolation: linear },
                { frame: 40, value: 0, interpolation: linear },
              ],
            },
          },
        }),
        { type: "precomp", name: "Inner", compositionId: "inner", startFrame: 5 },
      ],
      60,
    );
    const d = describe_(c);
    expect(d.layers[0]?.properties[0]?.segments.map((s) => s.outside_layer_range)).toEqual([
      true,
      undefined,
    ]);
    expect(d.layers[1]?.precomp).toEqual({
      composition: "inner",
      time_offset: 5,
      fps: { num: 60, den: 1 },
    });
  });

  it("keeps cut properties with their own truncated count", () => {
    const keyframes = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ frame: i * 5, value: i, interpolation: linear }));
    const c = comp([
      solid({ transform: { rotation: { keyframes: keyframes(4) } } }),
      solid({ name: "B", transform: { rotation: { keyframes: keyframes(3) } } }),
    ]);
    const d = describe_(c, { maxSegments: 2 });
    expect(d.truncated_segments).toBe(3);
    expect(
      d.layers.map((l) => l.properties.map((p) => [p.segments.length, p.truncated_segments])),
    ).toEqual([[[2, 1]], [[0, 2]]]);
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
