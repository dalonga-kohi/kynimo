import { describe, expect, it } from "vitest";
import {
  composition,
  groupTransform,
  issues,
  nullLayer,
  type Obj,
  project,
  prop,
  transform,
  visual,
} from "./fixtures.test-util.js";
import { MAX_KEYFRAMES, ProjectSchema, springSettleFrames } from "./index.js";

const linear = { type: "linear" } as const;
const kf = (frame: number, value: unknown, interpolation: Obj = linear, extra: Obj = {}): Obj => ({
  frame,
  value,
  interpolation,
  ...extra,
});

const doc = (layer: Obj, extra: Obj[] = []) =>
  project({ compositions: [composition("main", [layer]), ...extra] });
const withTransform = (t: Obj) => doc({ ...nullLayer("a"), transform: { ...transform(), ...t } });
const paths = (input: unknown) => issues(input).map((i) => i.path);

const SPRING = { type: "spring", damping: 0.5, response: 0.5 } as const;
const SETTLE = springSettleFrames(SPRING, { num: 30, den: 1 });

describe("keyframe tracks", () => {
  it("accepts every interpolation and survives a JSON round trip", () => {
    const rotation = {
      keyframes: [
        kf(0, 0, linear),
        kf(10, 90, { type: "bezier", x1: 0.2, y1: 0, x2: 0.2, y2: 1 }),
        kf(20, 180, { type: "hold" }),
        kf(30, 270, SPRING),
        kf(30 + SETTLE, 360),
      ],
    };
    const input = withTransform({ rotation });
    expect(issues(input)).toEqual([]);
    expect(JSON.parse(JSON.stringify(ProjectSchema.parse(input)))).toEqual(input);
  });

  it("still accepts constant { value } properties", () => {
    expect(issues(withTransform({ rotation: prop(45) }))).toEqual([]);
  });

  it("requires exactly one of value and keyframes, at the property's path", () => {
    const both = withTransform({ rotation: { value: 1, keyframes: [kf(0, 1)] } });
    const neither = withTransform({ rotation: {} });
    for (const input of [both, neither]) {
      expect(issues(input)).toEqual([
        {
          path: "compositions.0.layers.0.transform.rotation",
          message: expect.stringContaining("set exactly one of 'value', 'keyframes'"),
        },
      ]);
    }
  });

  it("keeps precise paths for bad keyframe values and unknown interpolations", () => {
    expect(paths(withTransform({ rotation: { keyframes: [kf(0, Number.NaN)] } }))).toEqual([
      "compositions.0.layers.0.transform.rotation.keyframes.0.value",
    ]);
    expect(
      paths(
        withTransform({
          rotation: { keyframes: [kf(0, 1, { type: "bezier", x1: 2, y1: 0, x2: 0, y2: 0 })] },
        }),
      ),
    ).toEqual(["compositions.0.layers.0.transform.rotation.keyframes.0.interpolation.x1"]);
    expect(
      paths(withTransform({ rotation: { keyframes: [kf(0, 1, { type: "ease-in" })] } })).length,
    ).toBe(1);
  });

  it("requires strictly increasing frames", () => {
    for (const frames of [
      [10, 10],
      [10, 5],
    ]) {
      const input = withTransform({ rotation: { keyframes: frames.map((f) => kf(f, 0)) } });
      expect(paths(input)).toEqual([
        "compositions.0.layers.0.transform.rotation.keyframes.1.frame",
      ]);
    }
  });

  it("rejects empty and oversized keyframe lists", () => {
    expect(paths(withTransform({ rotation: { keyframes: [] } }))).toEqual([
      "compositions.0.layers.0.transform.rotation.keyframes",
    ]);
    const many = Array.from({ length: MAX_KEYFRAMES + 1 }, (_, i) => kf(i, 0));
    expect(paths(withTransform({ rotation: { keyframes: many } }))).toEqual([
      "compositions.0.layers.0.transform.rotation.keyframes",
    ]);
  });
});

describe("spring segments", () => {
  const rotationWith = (nextFrame: number) =>
    withTransform({ rotation: { keyframes: [kf(10, 0, SPRING), kf(nextFrame, 90)] } });

  it("rejects a next keyframe before the settle frame and names the fix", () => {
    expect(issues(rotationWith(10 + SETTLE - 1))).toEqual([
      {
        path: "compositions.0.layers.0.transform.rotation.keyframes.1.frame",
        message: expect.stringMatching(
          new RegExp(`settles at frame ${10 + SETTLE}.*move it to frame ${10 + SETTLE}.*bezier`),
        ),
      },
    ]);
  });

  it("accepts a next keyframe exactly at the settle frame", () => {
    expect(issues(rotationWith(10 + SETTLE))).toEqual([]);
  });

  it("does not constrain a spring on the last keyframe", () => {
    expect(
      issues(withTransform({ rotation: { keyframes: [kf(0, 0), kf(5, 1, SPRING)] } })),
    ).toEqual([]);
  });

  it("uses the composition's frame rate", () => {
    const fast = { ...composition("main", [nullLayer("a")]), fps: { num: 120, den: 1 } };
    const layer = {
      ...nullLayer("a"),
      transform: { ...transform(), rotation: { keyframes: [kf(0, 0, SPRING), kf(SETTLE, 90)] } },
    };
    const input = project({ compositions: [{ ...fast, layers: [layer] }] });
    expect(paths(input)).toEqual(["compositions.0.layers.0.transform.rotation.keyframes.1.frame"]);
  });

  it("finds springs on any property, including inside shape groups", () => {
    const fill = {
      type: "fill",
      id: "f",
      name: "Fill",
      paint: { type: "solid", color: prop("#ffffff") },
      opacity: { keyframes: [kf(0, 0, SPRING), kf(1, 1)] },
      rule: "nonzero",
    };
    const group = { type: "group", id: "g", name: "G", transform: groupTransform(), items: [fill] };
    const input = doc({ ...visual("s"), type: "shape", contents: [group] });
    expect(paths(input)).toEqual([
      "compositions.0.layers.0.contents.0.items.0.opacity.keyframes.1.frame",
    ]);
  });

  it("ignores free-form component props that merely contain a keyframes key", () => {
    const layer = {
      ...visual("c"),
      type: "component",
      componentId: "x",
      componentVersion: "1.0.0",
      props: { keyframes: [kf(0, 0, SPRING), kf(1, 1)] },
    };
    expect(issues(doc(layer))).toEqual([]);
  });
});

describe("hostile and out-of-range springs", () => {
  it("reports only the range issue for an out-of-range spring, never a bogus settle frame", () => {
    for (const bad of [
      { type: "spring", damping: 0, response: 0.5 },
      { type: "spring", damping: 0.5, response: -1 },
      { type: "spring", damping: 1e150, response: 0.5 },
    ]) {
      const found = paths(withTransform({ rotation: { keyframes: [kf(0, 0, bad), kf(1, 1)] } }));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/keyframes\.0\.interpolation\.(damping|response)$/);
    }
  });

  it("does not accept keyframes on text content, which the engine cannot interpolate", () => {
    const text = {
      ...visual("t"),
      type: "text",
      content: { keyframes: [kf(0, "a"), kf(10, "b")] },
      box: { mode: "point" },
      font: { family: "Inter", weight: 400, size: prop(48) },
      tracking: prop(0),
      leading: prop(1.2),
      align: "left",
      textCase: "none",
      animators: [],
      fill: prop("#ffffff"),
    };
    expect(paths(doc(text))).toContain("compositions.0.layers.0.content");
  });
});

describe("out-of-range frame rate", () => {
  it("reports only the fps issue, not derived spring timing issues", () => {
    for (const fps of [
      { num: 1_000_000, den: 1 },
      { num: 30.5, den: 1 },
      { num: 0, den: 1 },
    ]) {
      const layer = {
        ...nullLayer("a"),
        transform: { ...transform(), rotation: { keyframes: [kf(0, 0, SPRING), kf(1, 1)] } },
      };
      const input = project({ compositions: [{ ...composition("main", [layer]), fps }] });
      expect(paths(input).every((p) => p.startsWith("compositions.0.fps"))).toBe(true);
      expect(paths(input).length).toBeGreaterThan(0);
    }
  });
});

describe("position", () => {
  it("accepts spatial motion path handles on position keyframes", () => {
    const position = {
      keyframes: [
        kf(0, [0, 0], linear, { spatial: { inTangent: [0, 0], outTangent: [100, 0] } }),
        kf(30, [300, 200], linear, { spatial: { inTangent: [-100, 0], outTangent: [0, 0] } }),
      ],
    };
    expect(issues(withTransform({ position }))).toEqual([]);
  });

  it("accepts separate X and Y tracks", () => {
    const position = { separate: { x: { keyframes: [kf(0, 0), kf(30, 300)] }, y: prop(540) } };
    expect(issues(withTransform({ position }))).toEqual([]);
  });

  it("requires exactly one position form", () => {
    const position = { value: [0, 0], separate: { x: prop(0), y: prop(0) } };
    expect(paths(withTransform({ position }))).toEqual([
      "compositions.0.layers.0.transform.position",
    ]);
  });

  it("rejects spatial handles on properties other than position", () => {
    const rotation = {
      keyframes: [kf(0, 0, linear, { spatial: { inTangent: [0, 0], outTangent: [0, 0] } })],
    };
    expect(paths(withTransform({ rotation }))).toEqual([
      "compositions.0.layers.0.transform.rotation.keyframes.0",
    ]);
  });
});

describe("morphing and gradients", () => {
  const vertex = { point: [0, 0], inTangent: [0, 0], outTangent: [0, 0] };
  const pathOf = (n: number, closed = true) => ({
    closed,
    vertices: Array.from({ length: n }, () => vertex),
  });
  const shapeWithPath = (frames: [number, unknown][]) =>
    doc({
      ...visual("s"),
      type: "shape",
      contents: [
        { type: "path", id: "p", name: "P", path: { keyframes: frames.map(([f, v]) => kf(f, v)) } },
      ],
    });

  it("accepts a morph between paths with equal topology", () => {
    expect(
      issues(
        shapeWithPath([
          [0, pathOf(4)],
          [20, pathOf(4)],
        ]),
      ),
    ).toEqual([]);
  });

  it("rejects a morph with different vertex counts or closed flags, at the offending keyframe", () => {
    for (const other of [pathOf(5), pathOf(4, false)]) {
      expect(
        issues(
          shapeWithPath([
            [0, pathOf(4)],
            [20, other],
          ]),
        ),
      ).toEqual([
        {
          path: "compositions.0.layers.0.contents.0.path.keyframes.1.value",
          message: expect.stringContaining("same vertex count"),
        },
      ]);
    }
  });

  it("rejects animating gradient stops to a different stop count", () => {
    const two = [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#ffffff" },
    ];
    const three = [...two.slice(0, 1), { offset: 0.5, color: "#888888" }, ...two.slice(1)];
    const fill = {
      type: "fill",
      id: "f",
      name: "F",
      opacity: prop(1),
      rule: "nonzero",
      paint: {
        type: "linear-gradient",
        start: prop([0, 0]),
        end: prop([1, 0]),
        stops: { keyframes: [kf(0, two), kf(10, three)] },
      },
    };
    expect(paths(doc({ ...visual("s"), type: "shape", contents: [fill] }))).toEqual([
      "compositions.0.layers.0.contents.0.paint.stops.keyframes.1.value",
    ]);
  });
});

describe("precomp cycles", () => {
  const precomp = (id: string, target: string): Obj => ({
    ...visual(id),
    type: "precomp",
    compositionId: target,
  });
  const comps = (...defs: [string, Obj[]][]) => defs.map(([id, layers]) => composition(id, layers));

  it("rejects a precomp that references its own composition", () => {
    const input = project({ compositions: comps(["main", [precomp("self", "main")]]) });
    expect(issues(input)).toEqual([
      {
        path: "compositions.0.layers.0.compositionId",
        message: expect.stringMatching(/precomp cycle.*main -> main/),
      },
    ]);
  });

  it("rejects an indirect cycle once, at the layer that closes it", () => {
    const input = project({
      compositions: comps(
        ["main", [precomp("p1", "a")]],
        ["a", [precomp("p2", "b")]],
        ["b", [precomp("p3", "a")]],
      ),
    });
    const found = issues(input);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("compositions.2.layers.0.compositionId");
    expect(found[0]?.message).toContain("a -> b -> a");
  });

  it("keeps cycle error output small when many layers close a long loop", () => {
    const n = 200;
    const names = Array.from({ length: n }, (_, i) => `c${i}-${"x".repeat(50)}`);
    const defs: [string, Obj[]][] = names.map((id, i) => {
      if (i < n - 1) return [id, [precomp(`p${i}`, names[i + 1] as string)]];
      return [id, Array.from({ length: 900 }, (_, k) => precomp(`back${k}`, names[0] as string))];
    });
    const input = project({ mainCompositionId: names[0], compositions: comps(...defs) });
    const result = ProjectSchema.safeParse(input);
    expect(result.success).toBe(false);
    const inputSize = JSON.stringify(input).length;
    expect(JSON.stringify(result.error?.issues).length).toBeLessThan(inputSize);
  });

  it("handles an unreachable cycle and a long acyclic chain", () => {
    const chain = Array.from(
      { length: 150 },
      (_, i) => [`k${i}`, i < 149 ? [precomp(`q${i}`, `k${i + 1}`)] : []] as [string, Obj[]],
    );
    const lone = project({
      compositions: comps(
        ["main", []],
        ["u", [precomp("pu", "v")]],
        ["v", [precomp("pv", "u")]],
        ...chain,
      ),
    });
    expect(paths(lone)).toEqual(["compositions.2.layers.0.compositionId"]);
    expect(issues(project({ compositions: comps(["main", []], ...chain) }))).toEqual([]);
  });

  it("accepts shared and nested precomps that do not form a cycle", () => {
    const input = project({
      compositions: comps(
        ["main", [precomp("p1", "a"), precomp("p2", "b")]],
        ["a", [precomp("p3", "c")]],
        ["b", [precomp("p4", "c")]],
        ["c", []],
      ),
    });
    expect(issues(input)).toEqual([]);
  });
});
