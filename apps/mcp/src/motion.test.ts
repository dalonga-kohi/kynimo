import {
  type Project,
  ProjectSchema,
  SCENE_FORMAT_VERSION,
  springSettleFrames,
} from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { withLayerDefaults } from "./defaults.js";
import { describeMotion, type MotionOptions, summarizeValue } from "./motion.js";

const SIZE = { width: 1920, height: 1080, durationFrames: 90 } as never;

/** A validated project whose main composition holds these add_layer bodies (ids l0, l1, …). */
function comp(layers: Record<string, unknown>[], innerFps = 30): Project {
  return ProjectSchema.parse({
    formatVersion: SCENE_FORMAT_VERSION,
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

describe("text animators", () => {
  const linear = { type: "linear" };
  const textBody = (animators: unknown[]) => ({
    type: "text",
    name: "Title",
    content: { value: "Hello world" },
    box: { mode: "point" },
    font: { family: "Inter", weight: 600, size: { value: 64 } },
    tracking: { value: 0 },
    leading: { value: 1.2 },
    align: "left",
    textCase: "none",
    fill: { value: "#ffffff" },
    animators,
  });
  const animator = (name: string, selector: Record<string, unknown>, properties: object) => ({
    name,
    selector: {
      unit: "words",
      start: { value: 0 },
      end: { value: 1 },
      offset: { value: 0 },
      shape: "square",
      easeHigh: { value: 0 },
      easeLow: { value: 0 },
      order: "forward",
      seed: 0,
      amount: { value: 1 },
      ...selector,
    },
    properties,
  });

  it("describes each animator in one line and lists its keyframed selector as motion", () => {
    const sweep = animator(
      "rise",
      {
        end: {
          keyframes: [
            { frame: 0, value: 0, interpolation: linear },
            { frame: 20, value: 1, interpolation: linear },
          ],
        },
      },
      { position: { value: [0, 40] }, opacity: { value: 0 } },
    );
    const shuffled = animator(
      "pop",
      { unit: "characters", order: "random", seed: 7, offset: { value: 0.25 } },
      { scale: { value: [0, 0] } },
    );
    const l = describe_(comp([textBody([sweep, shuffled])])).layers[0];
    expect(l?.animators).toEqual([
      "rise: position, opacity by word, square range 0..animated",
      "pop: scale by character, square range 0..1 offset 0.25, random order (seed 7)",
    ]);
    expect(l?.properties.map((p) => p.property)).toEqual(["animators.0.selector.end"]);
    expect(describe_(comp([textBody([])])).layers[0]).not.toHaveProperty("animators");
  });
});

describe("behaviors", () => {
  const linear = { type: "linear" };
  const kf = (...frames: [number, unknown][]) => ({
    keyframes: frames.map(([frame, value]) => ({ frame, value, interpolation: linear })),
  });
  let n = 0;
  const b = (type: string, property: string, extra: Record<string, unknown>) => ({
    id: `b${n++}`,
    name: type,
    enabled: true,
    property,
    type,
    ...extra,
  });
  const lines = (behaviors: unknown[], transform: Record<string, unknown> = {}, extra = {}) =>
    describe_(comp([solid({ behaviors, transform, ...extra })])).layers[0]?.behaviors;

  it("describes wiggle and oscillate in one line each, with neutral parts left out", () => {
    expect(
      lines([
        b("wiggle", "position", {
          frequency: { value: 2 },
          amplitude: { value: [20, 0] },
          octaves: 2,
          seed: 7,
          linked: false,
        }),
        b("wiggle", "scale", {
          frequency: { value: 1.5 },
          amplitude: { value: [0.1, 0.25] },
          octaves: 1,
          seed: 0,
          linked: true,
        }),
        b("oscillate", "rotation", {
          frequency: { value: 0.5 },
          amplitude: { value: 15 },
          phase: 90,
          waveform: "sine",
        }),
        b("oscillate", "opacity", {
          frequency: { value: 1 },
          amplitude: { value: 0.2 },
          phase: 0,
          waveform: "triangle",
        }),
      ]),
    ).toEqual([
      "wiggle position ±[20, 0] at 2 Hz, 2 octaves, seed 7",
      "wiggle scale ±[0.1, 0.25] at 1.5 Hz, 1 octave, seed 0, linked",
      "oscillate rotation ±15 at 0.5 Hz, sine, phase 90°",
      "oscillate opacity ±0.2 at 1 Hz, triangle",
    ]);
  });

  it("says animated for keyframed parameters", () => {
    expect(
      lines([
        b("oscillate", "rotation", {
          frequency: kf([0, 1], [30, 2]),
          amplitude: kf([0, 5], [30, 10]),
          phase: 0,
          waveform: "square",
        }),
      ]),
    ).toEqual(["oscillate rotation ±animated at animated frequency, square"]);
  });

  /** Each behavior on a layer of its own (a property takes one loop, one link), listed in order. */
  const each = (behaviors: unknown[], transform: Record<string, unknown> = {}) =>
    describe_(comp([...behaviors.map((x) => solid({ behaviors: [x], transform })), solid()]))
      .layers.slice(0, behaviors.length)
      .flatMap((l) => l.behaviors ?? []);

  it("describes loops and says when there are too few keyframes", () => {
    const loop = (property: string, direction: string, mode: string, span: number) =>
      b("loop", property, { direction, mode, span });
    expect(
      each(
        [
          loop("position", "out", "cycle", 0),
          loop("position", "out", "pingpong", 2),
          loop("position", "in", "offset", 1),
          loop("rotation", "out", "continue", 0),
          loop("scale", "out", "cycle", 0),
          loop("opacity", "out", "cycle", 0),
        ],
        {
          position: kf([0, [0, 0]], [10, [100, 0]], [20, [100, 100]]),
          rotation: { value: 0 },
          scale: kf([0, [1, 1]]),
          opacity: kf([0, 0], [10, 1]),
        },
      ),
    ).toEqual([
      "loop out on position: cycle, all keyframes",
      "loop out on position: pingpong, last 2 segments",
      "loop in on position: offset, first 1 segment",
      "loop out on rotation: continue, all keyframes — no effect: needs at least two keyframes",
      "loop out on scale: cycle, all keyframes — no effect: needs at least two keyframes",
      "loop out on opacity: cycle, all keyframes",
    ]);
  });

  it("checks both axes of a separate position", () => {
    const loop = b("loop", "position", { direction: "out", mode: "cycle", span: 0 });
    const separate = (x: unknown, y: unknown) => ({ position: { separate: { x, y } } });
    expect(lines([loop], separate({ value: 0 }, kf([0, 0], [10, 5])))).toEqual([
      "loop out on position: cycle, all keyframes",
    ]);
    expect(lines([loop], separate({ value: 0 }, { value: 5 }))).toEqual([
      "loop out on position: cycle, all keyframes — no effect: needs at least two keyframes",
    ]);
  });

  it("describes inertia and links, leaving neutral multiply, offset and delay out", () => {
    const link = (extra: Record<string, unknown>, property = "rotation") =>
      b("link", property, {
        source: { layer: "l5", property },
        multiply: 1,
        offset: property === "position" ? [0, 0] : 0,
        delay: 0,
        ...extra,
      });
    expect(
      each([
        b("inertia", "scale", { amplitude: 0.05, frequency: 4, decay: 8 }),
        link({ multiply: -1, offset: 5, delay: 10 }),
        link({}),
        link({ delay: 1 }),
        link({ offset: [3, -4] }, "position"),
      ]),
    ).toEqual([
      "inertia on scale: amplitude 0.05 s, 4 Hz, decay 8/s",
      "link rotation ← 'l5'.rotation × -1 + 5, 10 frames later",
      "link rotation ← 'l5'.rotation",
      "link rotation ← 'l5'.rotation, 1 frame later",
      "link position ← 'l5'.position + [3, -4]",
    ]);
  });

  it("marks disabled behaviors and lists none for layers without", () => {
    expect(
      lines([
        {
          ...b("inertia", "position", { amplitude: 0.1, frequency: 2, decay: 3 }),
          enabled: false,
        },
      ]),
    ).toEqual(["inertia on position: amplitude 0.1 s, 2 Hz, decay 3/s (disabled)"]);
    expect(describe_(comp([solid()])).layers[0]).not.toHaveProperty("behaviors");
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
