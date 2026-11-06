import { describe, expect, it } from "vitest";
import { applyToPoint } from "./affine.js";
import { evaluateFrame } from "./evaluate.js";
import { composition, layer, type Obj, project, prop, transform } from "./fixtures.test-util.js";
import type { ResolvedShapeItem, ResolvedShapeLayer } from "./resolved.js";

const linear = { type: "linear" };
/** Progress below 0 (undershoots rising tracks) and above 1 (overshoots falling ones). */
const under = { type: "bezier", x1: 0.3, y1: -2, x2: 0.7, y2: -2 };
const over = { type: "bezier", x1: 0.3, y1: 2, x2: 0.7, y2: 2 };
const kf = (frame: number, value: unknown, interpolation: Obj = linear) => ({
  frame,
  value,
  interpolation,
});
const item = (id: string, type: string, fields: Obj) => ({ id, name: id, type, ...fields });

const contentsAt = (contents: Obj[], frame: number): ResolvedShapeItem[] => {
  const doc = project([composition("main", [layer("s", "shape", { contents })])]);
  return (evaluateFrame(doc, frame).layers[0] as ResolvedShapeLayer).contents;
};

describe("shape contents", () => {
  it("resolves geometry, clamping sizes and radii at 0", () => {
    const [rect, ellipse, polygon, star] = contentsAt(
      [
        item("r", "rect", {
          position: prop([1, 2]),
          size: { keyframes: [kf(0, [10, 10], over), kf(10, [0, 20])] },
          cornerRadius: { keyframes: [kf(0, 4, over), kf(10, 0)] },
        }),
        item("e", "ellipse", { position: prop([0, 0]), size: prop([30, 40]) }),
        item("p", "polygon", {
          position: prop([0, 0]),
          points: 6,
          radius: prop(50),
          rotation: prop(15),
        }),
        item("st", "star", {
          position: prop([0, 0]),
          points: 5,
          outerRadius: prop(50),
          innerRadius: prop(20),
          rotation: prop(0),
        }),
      ],
      5,
    );
    expect(rect).toMatchObject({ type: "rect", position: [1, 2], cornerRadius: 0 });
    if (rect?.type !== "rect") throw new Error("expected rect");
    expect(rect.size[0]).toBe(0);
    expect(rect.size[1]).toBeGreaterThan(10);
    expect(ellipse).toMatchObject({ type: "ellipse", size: [30, 40] });
    expect(polygon).toMatchObject({ type: "polygon", points: 6, radius: 50, rotation: 15 });
    expect(star).toMatchObject({ type: "star", points: 5, outerRadius: 50, innerRadius: 20 });
  });

  it("morphs paths vertex by vertex", () => {
    const vertex = (x: number) => ({ point: [x, 0], inTangent: [0, 0], outTangent: [x, x] });
    const [path] = contentsAt(
      [
        item("p", "path", {
          path: {
            keyframes: [
              kf(0, { closed: true, vertices: [vertex(0), vertex(10)] }),
              kf(10, { closed: true, vertices: [vertex(20), vertex(30)] }),
            ],
          },
        }),
      ],
      5,
    );
    expect(path).toEqual({
      id: "p",
      name: "p",
      type: "path",
      path: {
        closed: true,
        vertices: [
          { point: [10, 0], inTangent: [0, 0], outTangent: [10, 10] },
          { point: [20, 0], inTangent: [0, 0], outTangent: [20, 20] },
        ],
      },
    });
  });

  it("resolves fills and strokes with clamped opacity and width", () => {
    const [fill, stroke] = contentsAt(
      [
        item("f", "fill", {
          paint: { type: "solid", color: prop("#00ff00") },
          opacity: { keyframes: [kf(0, 0, under), kf(10, 1)] },
          rule: "evenodd",
        }),
        item("k", "stroke", {
          paint: { type: "solid", color: prop("#0000ff") },
          opacity: prop(0.5),
          width: { keyframes: [kf(0, 2, over), kf(10, 0)] },
          cap: "round",
          join: "bevel",
          miterLimit: 4,
          dashes: [4, 2],
          dashOffset: prop(-3),
        }),
      ],
      5,
    );
    expect(fill).toMatchObject({
      type: "fill",
      paint: { type: "solid", color: { r: 0, g: 1, b: 0, a: 1 } },
      opacity: 0,
      rule: "evenodd",
    });
    expect(stroke).toMatchObject({
      type: "stroke",
      opacity: 0.5,
      width: 0,
      cap: "round",
      join: "bevel",
      miterLimit: 4,
      dashes: [4, 2],
      dashOffset: -3,
    });
  });

  it("keeps gradient stop offsets in 0..1 and in order under overshoot", () => {
    const stops = (a: number, b: number) => [
      { offset: a, color: "#000000" },
      { offset: b, color: "#ffffff" },
    ];
    const [fill] = contentsAt(
      [
        item("f", "fill", {
          paint: {
            type: "linear-gradient",
            start: prop([0, 0]),
            end: prop([100, 0]),
            // Progress is -1.375 at frame 5: raw offsets 0.8125 and -0.05, crossed and out of range.
            stops: { keyframes: [kf(0, stops(0.4, 0.5), under), kf(10, stops(0.1, 0.9))] },
          },
          opacity: prop(1),
          rule: "nonzero",
        }),
      ],
      5,
    );
    if (fill?.type !== "fill" || fill.paint.type !== "linear-gradient")
      throw new Error("expected gradient fill");
    const offsets = fill.paint.stops.map((s) => s.offset);
    expect(offsets[0]).toBeCloseTo(0.8125, 12);
    expect(offsets[1]).toBe(offsets[0]);
    expect(fill.paint.start).toEqual([0, 0]);
  });

  it("resolves radial gradients with a non-negative radius", () => {
    const [fill] = contentsAt(
      [
        item("f", "fill", {
          paint: {
            type: "radial-gradient",
            center: prop([5, 5]),
            radius: prop(20),
            stops: prop([
              { offset: 0, color: "#ff0000" },
              { offset: 1, color: "#0000ff" },
            ]),
          },
          opacity: prop(1),
          rule: "nonzero",
        }),
      ],
      0,
    );
    expect(fill).toMatchObject({
      paint: {
        type: "radial-gradient",
        center: [5, 5],
        radius: 20,
        stops: [
          { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      },
    });
  });

  it("gives each group a matrix into layer space, through enclosing groups", () => {
    const group = (id: string, position: [number, number], items: Obj[]) =>
      item(id, "group", { transform: transform({ position: prop(position) }), items });
    const [outer] = contentsAt(
      [
        group(
          "outer",
          [100, 0],
          [
            group(
              "inner",
              [0, 50],
              [item("e", "ellipse", { position: prop([0, 0]), size: prop([1, 1]) })],
            ),
          ],
        ),
      ],
      0,
    );
    if (outer?.type !== "group") throw new Error("expected group");
    const inner = outer.items[0];
    if (inner?.type !== "group") throw new Error("expected inner group");
    expect(applyToPoint(outer.matrix, [0, 0])).toEqual([100, 0]);
    expect(applyToPoint(inner.matrix, [0, 0])).toEqual([100, 50]);
    expect(inner.transform.position).toEqual([0, 50]);
  });
});
