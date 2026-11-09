import { evaluateFrame } from "@kynimo/engine";
import { describe, expect, it } from "vitest";
import { bindPaints, MAX_SHAPE_LAYER_WORK } from "./binding.js";
import { RenderError } from "./errors.js";
import {
  composition,
  ellipse,
  fill,
  group,
  type Obj,
  project,
  prop,
  rect,
  repeater,
  roundCorners,
  shapeLayer,
  solidPaint,
  stroke,
  transform,
  trim,
} from "./fixtures.test-util.js";
import { contourLength } from "./operators.js";

const ops = (contents: Obj[]) => {
  const frame = evaluateFrame(project([composition("main", [shapeLayer("s", contents)])]), 0);
  const layer = frame.layers[0];
  if (layer?.type !== "shape") throw new Error("expected a shape layer");
  return bindPaints(layer.contents);
};

describe("bindPaints (After Effects semantics)", () => {
  it("paints only the geometry listed above the paint", () => {
    const result = ops([rect([0, 0], [10, 10]), fill(), rect([50, 50], [10, 10])]);
    expect(result).toHaveLength(1);
    expect(result[0]?.contours).toHaveLength(1);
    expect(result[0]?.contours[0]?.start).toEqual([5, -5]);
  });

  it("fills several paths as one compound path", () => {
    const result = ops([rect([0, 0], [10, 10]), rect([0, 0], [4, 4]), fill()]);
    expect(result[0]?.contours).toHaveLength(2);
  });

  it("draws lower items first, so a stroke listed above a fill lands on top", () => {
    const result = ops([rect([0, 0], [10, 10]), stroke(solidPaint("#ffffff"), 2), fill()]);
    expect(result.map((op) => op.paint.type)).toEqual(["fill", "stroke"]);
  });

  it("drops paints with no geometry above them", () => {
    expect(ops([fill(), rect([0, 0], [10, 10])])).toEqual([]);
  });

  it("lets an enclosing paint reach into groups above it, in that group's transform", () => {
    const moved = group([rect([0, 0], [10, 10])], transform({ position: prop([100, 0]) }));
    const result = ops([moved, fill()]);
    expect(result).toHaveLength(1);
    expect(result[0]?.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(result[0]?.contours[0]?.start).toEqual([105, -5]);
  });

  it("keeps a group's own paints in group space, drawn at the group's place in the order", () => {
    const scaled = group(
      [rect([0, 0], [10, 10]), stroke(solidPaint("#ffffff"), 1)],
      transform({ scale: prop([2, 2]) }),
    );
    const result = ops([fill(solidPaint("#00ff00")), scaled, fill()]);
    // Bottom-first: the root fill (below the group), then the group's stroke.
    expect(result.map((op) => op.paint.type)).toEqual(["fill", "stroke"]);
    expect(result[1]?.matrix).toEqual([2, 0, 0, 2, 0, 0]);
    expect(result[1]?.contours[0]?.start).toEqual([5, -5]);
    expect(result[0]?.contours[0]?.start).toEqual([10, -10]);
  });

  it("multiplies the opacities of the groups that hold a paint, not of groups it reaches into", () => {
    const faded = (items: Obj[], opacity: number) =>
      group(items, transform({ opacity: prop(opacity) }));
    const result = ops([
      faded([faded([rect([0, 0], [10, 10]), fill()], 0.5)], 0.4),
      stroke(solidPaint("#ffffff"), 1),
    ]);
    expect(result.map((op) => [op.paint.type, op.opacity])).toEqual([
      ["stroke", 1],
      ["fill", 0.2],
    ]);
  });
});

describe("path operators (After Effects semantics)", () => {
  const box = () => rect([0, 0], [20, 10]); // perimeter 60

  it("trims the paths above it for every paint, including paints listed above the trim", () => {
    const [strokeOp, fillOp] = ops([box(), stroke(solidPaint("#ffffff"), 2), fill(), trim(0, 0.5)])
      .slice()
      .reverse();
    for (const op of [strokeOp, fillOp]) {
      expect(op?.contours).toHaveLength(1);
      expect(op?.contours[0]?.closed).toBe(false);
      expect(contourLength(op?.contours[0] as never)).toBe(30);
    }
  });

  it("leaves paths below it alone", () => {
    const [op] = ops([trim(0, 0.5), box(), fill()]);
    expect(op?.contours[0]?.closed).toBe(true);
    expect(contourLength(op?.contours[0] as never)).toBe(60);
  });

  it("reaches into groups above it, in its own space, and their paints see the result", () => {
    // The inner group doubles everything; the trim measures in the outer space, where the
    // rectangle's perimeter is 120, and the group's own stroke draws the trimmed path.
    const scaled = group(
      [box(), stroke(solidPaint("#ffffff"), 1)],
      transform({ scale: prop([2, 2]), rotation: prop(30) }),
    );
    const [inner] = ops([scaled, trim(0, 0.25)]);
    expect(inner?.contours).toHaveLength(1);
    expect(contourLength(inner?.contours[0] as never)).toBeCloseTo(15, 9);
  });

  it("does not reach into sibling groups below it or out of its own group", () => {
    const trimmed = group([box(), trim(0, 0.5)]);
    const [outer] = ops([trimmed, rect([0, 0], [4, 4]), fill()]);
    const lengths = outer?.contours.map((c) => contourLength(c));
    expect(lengths).toEqual([30, 16]);
  });

  it("applies operators in order: round then trim differs from trim then round", () => {
    const first = ops([box(), roundCorners(3), trim(0, 0.5), fill()]);
    const second = ops([box(), trim(0, 0.5), roundCorners(3), fill()]);
    expect(contourLength(first[0]?.contours[0] as never)).not.toBeCloseTo(
      contourLength(second[0]?.contours[0] as never),
      3,
    );
  });

  it("keeps the exact coordinates of paths no operator changes", () => {
    const moved = group([box()], transform({ rotation: prop(17), scale: prop([1.3, 0.7]) }));
    const plain = ops([moved, fill()]);
    const withFullTrim = ops([moved, trim(0, 1), fill()]);
    const geometry = (r: typeof plain) => r.map(({ contours, matrix }) => ({ contours, matrix }));
    expect(geometry(withFullTrim)).toEqual(geometry(plain));
  });
});

describe("repeater", () => {
  const offsets = (result: ReturnType<typeof ops>) =>
    result.map((op) => [op.matrix[4], op.matrix[5]]);

  it("draws one group per copy, each stepped once more, later copies on top", () => {
    const result = ops([
      rect([0, 0], [10, 10]),
      fill(),
      repeater(3, {
        position: prop([20, 0]),
        startOpacity: prop(1),
        endOpacity: prop(0.5),
      }),
    ]);
    // Bottom-first: copy 0 draws first, so copy 2 lands on top.
    expect(offsets(result)).toEqual([
      [0, 0],
      [20, 0],
      [40, 0],
    ]);
    expect(result.map((op) => op.opacity)).toEqual([1, 0.75, 0.5]);
    const below = ops([
      rect([0, 0], [10, 10]),
      fill(),
      repeater(3, { position: prop([20, 0]) }, { composite: "below" }),
    ]);
    expect(offsets(below)).toEqual([
      [40, 0],
      [20, 0],
      [0, 0],
    ]);
  });

  it("composes steps, so position and rotation together walk a circle", () => {
    const result = ops([
      rect([0, 0], [2, 2]),
      fill(),
      repeater(4, { position: prop([10, 0]), rotation: prop(90) }),
    ]);
    expect(offsets(result)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
  });

  it("shifts copies by the offset, and fades a fractional last copy in", () => {
    const shifted = ops([
      rect([0, 0], [2, 2]),
      fill(),
      repeater(2, { position: prop([10, 0]) }, { offset: prop(-1.5) }),
    ]);
    expect(offsets(shifted)).toEqual([
      [-15, 0],
      [-5, 0],
    ]);
    const fading = ops([rect([0, 0], [2, 2]), fill(), repeater(2.25, { endOpacity: prop(0) })]);
    // Opacity runs over copies 0..1.25: 1, 0.2, then 0 for the third copy (and a quarter of it).
    const [a, b, c] = fading.map((op) => op.opacity);
    expect([a, c]).toEqual([1, 0]);
    expect(b).toBeCloseTo(0.2, 12);
    expect(ops([rect([0, 0], [2, 2]), fill(), repeater(0)])).toEqual([]);
  });

  it("is painted as one compound path by a paint below it", () => {
    const [op] = ops([rect([0, 0], [2, 2]), repeater(5, { position: prop([4, 0]) }), fill()]);
    expect(op?.contours).toHaveLength(5);
    expect(op?.opacity).toBe(1);
    expect(op?.contours.map((c) => c.start[0])).toEqual([17, 13, 9, 5, 1]);
  });

  it("skips copies at negative powers of a collapsing step, and copies that overflow", () => {
    // Scale 0 has no inverse: offset -2 asks for powers -2, -1 (skipped), then 0 and 1.
    const collapsing = ops([
      rect([0, 0], [2, 2]),
      fill(),
      repeater(4, { position: prop([10, 0]), scale: prop([0, 0]) }, { offset: prop(-2) }),
    ]);
    expect(offsets(collapsing)).toEqual([
      [0, 0],
      [10, 0],
    ]);
    // 4^512 = 2^1024 overflows to Infinity: copies 512 and up are not drawn.
    const growing = ops([rect([0, 0], [2, 2]), fill(), repeater(1000, { scale: prop([4, 4]) })]);
    expect(growing).toHaveLength(512);
    expect(growing.every((op) => op.matrix.every(Number.isFinite))).toBe(true);
  });
});

describe("path work budget", () => {
  /** An open zig-zag path of `n` cubic vertices. */
  const heavyPath = (n: number) => ({
    id: "heavy",
    name: "heavy",
    type: "path",
    path: prop({
      closed: false,
      vertices: Array.from({ length: n }, (_, i) => ({
        point: [i, i % 2],
        inTangent: [-0.3, 0.5],
        outTangent: [0.3, -0.5],
      })),
    }),
  });

  const refuses = (contents: Obj[]) => {
    expect(() => ops(contents)).toThrow(RenderError);
    expect(() => ops(contents)).toThrow(String(MAX_SHAPE_LAYER_WORK));
  };

  it("refuses nested repeaters that multiply into millions of items", () => {
    refuses([rect([0, 0], [1, 1]), fill(), repeater(1000), repeater(1000)]);
  });

  it("refuses many paints below a repeater of a detailed path", () => {
    refuses([heavyPath(1000), repeater(1000), ...Array.from({ length: 400 }, () => fill())]);
  });

  it("refuses operators below a repeater that would each walk every copy", () => {
    refuses([heavyPath(1000), repeater(1000), trim(0, 0.5), trim(0, 0.5), fill()]);
  });

  it("refuses stacked wrapping trims that double the contours each time", () => {
    const wrapping = Array.from({ length: 30 }, () => trim(0, 0.99, { offset: prop(180) }));
    refuses([rect([0, 0], [20, 10]), ...wrapping, fill()]);
  });

  it("leaves room for ordinary heavy layers", () => {
    const result = ops([
      group([rect([0, 0], [8, 8]), roundCorners(2), fill(), stroke(solidPaint("#ffffff"), 1)]),
      repeater(1000, { position: prop([3, 0]) }),
    ]);
    expect(result).toHaveLength(2000);
  });
});

describe("operators through transformed groups", () => {
  it("drops paths an operator reaches through a collapsed group", () => {
    const flat = group([rect([0, 0], [10, 10])], transform({ scale: prop([0, 1]) }));
    const [untrimmed] = ops([flat, stroke(solidPaint("#ffffff"), 1)]);
    expect(untrimmed?.contours).toHaveLength(1);
    const [trimmed] = ops([flat, trim(0, 0.5), stroke(solidPaint("#ffffff"), 1)]);
    expect(trimmed?.contours).toEqual([]);
  });

  it("maps back only the contours an operator changed", () => {
    const turned = group(
      [rect([0, 0], [10, 10]), ellipse([0, 0], [4, 4])],
      transform({ rotation: prop(31) }),
    );
    const plain = ops([turned, fill()]);
    // Round corners changes the rectangle but leaves the ellipse's contour object untouched.
    const rounded = ops([turned, roundCorners(1), fill()]);
    expect(rounded[0]?.contours[1]).toEqual(plain[0]?.contours[1]);
  });
});
