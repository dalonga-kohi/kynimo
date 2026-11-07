import { evaluateFrame } from "@kynimo/engine";
import { describe, expect, it } from "vitest";
import { bindPaints } from "./binding.js";
import {
  composition,
  fill,
  group,
  type Obj,
  project,
  prop,
  rect,
  shapeLayer,
  solidPaint,
  stroke,
  transform,
} from "./fixtures.test-util.js";

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
