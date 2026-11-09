import { describe, expect, it } from "vitest";
import {
  type Affine,
  applyToPoint,
  IDENTITY,
  invert,
  multiply,
  transformMatrix,
} from "./affine.js";

const base = {
  anchorPoint: [0, 0],
  position: [0, 0],
  scale: [1, 1],
  rotation: 0,
  skew: 0,
} as const;

const close = (m: Affine, expected: number[]) => {
  for (const [i, x] of m.entries()) expect(x).toBeCloseTo(expected[i] as number, 12);
};

describe("transformMatrix", () => {
  it("is the identity for a default transform", () => {
    expect(transformMatrix(base)).toEqual(IDENTITY);
  });

  it("scales and rotates about the anchor point, then moves it to the position", () => {
    const m = transformMatrix({
      ...base,
      anchorPoint: [50, 50],
      position: [200, 100],
      scale: [2, 2],
    });
    expect(applyToPoint(m, [50, 50])).toEqual([200, 100]);
    expect(applyToPoint(m, [60, 50])).toEqual([220, 100]);
  });

  it("rotates clockwise on screen, exactly at right angles", () => {
    const m = transformMatrix({ ...base, rotation: 90 });
    expect(m).toEqual([0, 1, -1, 0, 0, 0]);
    expect(applyToPoint(m, [10, 0])).toEqual([0, 10]);
    expect(transformMatrix({ ...base, rotation: -270 })).toEqual(m);
    expect(transformMatrix({ ...base, rotation: 180 })).toEqual([-1, 0, -0, -1, 0, 0]);
  });

  it("leans the top edge right for positive skew, like After Effects", () => {
    const m = transformMatrix({ ...base, skew: 45 });
    // y is down: the top edge (y < 0) moves right, the bottom edge left.
    const [topX, topY] = applyToPoint(m, [0, -10]);
    const [bottomX] = applyToPoint(m, [0, 10]);
    expect(topX).toBeCloseTo(10, 12);
    expect(topY).toBe(-10);
    expect(bottomX).toBeCloseTo(-10, 12);
  });

  it("applies rotation · skew · scale in After Effects order", () => {
    const m = transformMatrix({ ...base, rotation: 30, skew: 45, scale: [2, 3] });
    const r = (30 * Math.PI) / 180;
    const rotate: Affine = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
    const skew: Affine = [1, 0, -1, 1, 0, 0]; // x' = x - tan(45°)·y
    const scale: Affine = [2, 0, 0, 3, 0, 0];
    close(m, [...multiply(rotate, multiply(skew, scale))]);
  });
});

describe("multiply", () => {
  it("applies the right-hand matrix first", () => {
    const translate: Affine = [1, 0, 0, 1, 10, 0];
    const scale: Affine = [2, 0, 0, 2, 0, 0];
    expect(applyToPoint(multiply(translate, scale), [1, 1])).toEqual([12, 2]);
    expect(applyToPoint(multiply(scale, translate), [1, 1])).toEqual([22, 2]);
  });
});

describe("invert", () => {
  it("undoes a transform, and has no answer for a collapsed one", () => {
    const m = transformMatrix({
      anchorPoint: [3, -2],
      position: [40, 10],
      scale: [2, -0.5],
      rotation: 33,
      skew: 12,
    });
    const inverse = invert(m);
    if (inverse === null) throw new Error("expected an inverse");
    const [x, y] = applyToPoint(inverse, applyToPoint(m, [7, 11]));
    expect(x).toBeCloseTo(7, 12);
    expect(y).toBeCloseTo(11, 12);
    expect(invert(IDENTITY)).toEqual(IDENTITY);
    expect(invert([0, 0, 0, 1, 5, 5])).toBeNull();
  });
});
