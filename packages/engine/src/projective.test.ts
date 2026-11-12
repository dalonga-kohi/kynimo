import { describe, expect, it } from "vitest";
import { type Affine, applyToPoint, multiply } from "./affine.js";
import {
  affineApproximation,
  affineToMat4,
  affineToProjective,
  lookAtRotation,
  MAT4_IDENTITY,
  type Mat4,
  mat4Invert,
  mat4Multiply,
  mat4RotateX,
  mat4RotateY,
  mat4RotateZ,
  mat4Scale,
  mat4Translate,
  type Projective,
  projectiveDepth,
  projectiveInvert,
  projectiveMultiply,
  projectLayerPlane,
  projectPoint,
} from "./projective.js";

const near = (a: readonly number[], b: readonly number[], digits = 9) => {
  expect(a).toHaveLength(b.length);
  a.forEach((v, i) => {
    expect(v).toBeCloseTo(b[i] as number, digits);
  });
};

/** Applies a Mat4 to a 3D point. */
const apply = (m: Mat4, [x, y, z]: readonly [number, number, number]) => [
  (m[0] as number) * x + (m[1] as number) * y + (m[2] as number) * z + (m[3] as number),
  (m[4] as number) * x + (m[5] as number) * y + (m[6] as number) * z + (m[7] as number),
  (m[8] as number) * x + (m[9] as number) * y + (m[10] as number) * z + (m[11] as number),
];

describe("Mat4", () => {
  it("multiplies with the right operand applied first", () => {
    const m = mat4Multiply(mat4Translate(10, 0, 0), mat4Scale(2, 2, 2));
    near(apply(m, [1, 1, 1]), [12, 2, 2]);
    near(mat4Multiply(MAT4_IDENTITY, m), m);
  });

  it("inverts a rotation and translation, and refuses a singular or non-finite matrix", () => {
    const m = mat4Multiply(mat4Translate(3, -4, 5), mat4Multiply(mat4RotateX(30), mat4RotateY(50)));
    const inv = mat4Invert(m) as Mat4;
    near(mat4Multiply(m, inv), MAT4_IDENTITY);
    expect(mat4Invert(mat4Scale(1, 0, 1))).toBeNull();
    expect(mat4Invert(mat4Translate(Number.POSITIVE_INFINITY, 0, 0))).toBeNull();
  });

  it("rotations are exact at multiples of 90 degrees", () => {
    expect([...mat4RotateZ(90)].map((v) => v + 0)).toEqual([
      0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    expect([...mat4RotateX(180)].map((v) => v + 0)).toEqual([
      1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1,
    ]);
    expect(mat4RotateY(270)[2]).toBe(1);
  });

  it("positive rotateX sends the top edge (-y) to +z; positive rotateY sends the right edge (+x) to +z", () => {
    const top = apply(mat4RotateX(30), [0, -1, 0]);
    expect(top[2]).toBeGreaterThan(0);
    const bottom = apply(mat4RotateX(30), [0, 1, 0]);
    expect(bottom[2]).toBeLessThan(0);
    const right = apply(mat4RotateY(30), [1, 0, 0]);
    expect(right[2]).toBeGreaterThan(0);
    const left = apply(mat4RotateY(30), [-1, 0, 0]);
    expect(left[2]).toBeLessThan(0);
  });

  it("rotateZ matches the 2D clockwise rotation", () => {
    near(apply(mat4RotateZ(90), [1, 0, 0]), [0, 1, 0]);
  });

  it("affineToMat4 embeds an affine in the z = 0 plane and leaves z alone", () => {
    const a: Affine = [2, 1, -1, 3, 10, 20];
    const m = affineToMat4(a);
    const [x, y] = applyToPoint(a, [4, 5]);
    near(apply(m, [4, 5, 0]), [x, y, 0]);
    near(apply(m, [4, 5, 7]), [x, y, 7]);
  });
});

describe("Projective", () => {
  const p: Projective = [2, 0.5, 10, -1, 3, 4, 0.001, 0.002, 1.5];

  it("projects a point as (X/W, Y/W) and reports W as depth", () => {
    const [x, y] = projectPoint(p, [100, 200]);
    const w = 0.001 * 100 + 0.002 * 200 + 1.5;
    expect(x).toBeCloseTo((2 * 100 + 0.5 * 200 + 10) / w, 12);
    expect(y).toBeCloseTo((-1 * 100 + 3 * 200 + 4) / w, 12);
    expect(projectiveDepth(p, [100, 200])).toBeCloseTo(w, 12);
  });

  it("multiplies with the right operand applied first, and inverts truly (not normalized)", () => {
    const q: Projective = [1, 0, 5, 0, 1, -7, 0, 0, 1];
    const [x, y] = projectPoint(projectiveMultiply(p, q), [3, 4]);
    const [qx, qy] = projectPoint(q, [3, 4]);
    const [ex, ey] = projectPoint(p, [qx, qy]);
    expect(x).toBeCloseTo(ex, 9);
    expect(y).toBeCloseTo(ey, 9);
    const inv = projectiveInvert(p) as Projective;
    near(projectiveMultiply(p, inv), [1, 0, 0, 0, 1, 0, 0, 0, 1], 9);
  });

  it("refuses to invert a singular or non-finite matrix", () => {
    expect(projectiveInvert([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
    expect(projectiveInvert([Number.NaN, 0, 0, 0, 1, 0, 0, 0, 1])).toBeNull();
  });

  it("embeds an affine with W = 1", () => {
    const a: Affine = [2, 1, -1, 3, 10, 20];
    const m = affineToProjective(a);
    expect(m[8]).toBe(1);
    near(projectPoint(m, [4, 5]), applyToPoint(a, [4, 5]));
    near(
      projectPoint(projectiveMultiply(affineToProjective(a), affineToProjective(a)), [1, 1]),
      applyToPoint(multiply(a, a), [1, 1]),
    );
  });
});

describe("lookAtRotation", () => {
  it("is the identity for a zero or non-finite direction", () => {
    expect(lookAtRotation(0, 0, 0)).toEqual(MAT4_IDENTITY);
    expect(lookAtRotation(Number.NaN, 0, 1)).toEqual(MAT4_IDENTITY);
  });

  it("is the identity when looking straight along +z", () => {
    near(lookAtRotation(0, 0, 9), MAT4_IDENTITY);
  });

  it("turns +z toward the direction and keeps +y as close to +y as possible", () => {
    const m = lookAtRotation(3, 0, 0);
    near(apply(m, [0, 0, 1]), [1, 0, 0]);
    near(apply(m, [0, 1, 0]), [0, 1, 0]);
    const tilted = lookAtRotation(0, 1, 1);
    const z = apply(tilted, [0, 0, 1]);
    near(z, [0, Math.SQRT1_2, Math.SQRT1_2]);
    const y = apply(tilted, [0, 1, 0]);
    expect(y[1]).toBeGreaterThan(0);
  });

  it("is a proper rotation", () => {
    const m = lookAtRotation(1, 2, 3);
    near(mat4Multiply(m, mat4Invert(m) as Mat4), MAT4_IDENTITY);
    const x = apply(m, [1, 0, 0]);
    const y = apply(m, [0, 1, 0]);
    expect(Math.hypot(x[0] as number, x[1] as number, x[2] as number)).toBeCloseTo(1, 12);
    expect(Math.hypot(y[0] as number, y[1] as number, y[2] as number)).toBeCloseTo(1, 12);
    expect(
      (x[0] as number) * (y[0] as number) +
        (x[1] as number) * (y[1] as number) +
        (x[2] as number) * (y[2] as number),
    ).toBeCloseTo(0, 12);
  });

  it("uses world +z as the reference axis when the direction is parallel to +y (looking down)", () => {
    const m = lookAtRotation(0, 3, 0);
    near(apply(m, [0, 0, 1]), [0, 1, 0]);
    near(apply(m, [1, 0, 0]), [-1, 0, 0]);
    near(apply(m, [0, 1, 0]), [0, 0, 1]);
  });

  it("uses world +z as the reference axis when the direction is parallel to -y (looking up)", () => {
    const m = lookAtRotation(0, -2, 0);
    near(apply(m, [0, 0, 1]), [0, -1, 0]);
    near(apply(m, [1, 0, 0]), [1, 0, 0]);
    near(apply(m, [0, 1, 0]), [0, 0, 1]);
  });
});

describe("projectLayerPlane and affineApproximation", () => {
  it("with the default camera view an untouched layer maps to itself, W = zoom", () => {
    const zoom = 1000;
    const view = mat4Translate(-960, -540, zoom);
    const p = projectLayerPlane(view, zoom, 1920, 1080);
    expect(projectiveDepth(p, [0, 0])).toBe(zoom);
    near(projectPoint(p, [123, 456]), [960 + 123 - 960, 540 + 456 - 540]);
  });

  it("scales about the screen center for a layer twice as far", () => {
    const zoom = 1000;
    const view = mat4Multiply(mat4Translate(-960, -540, zoom), mat4Translate(0, 0, zoom));
    const p = projectLayerPlane(view, zoom, 1920, 1080);
    near(projectPoint(p, [960 + 100, 540]), [960 + 50, 540]);
  });

  it("approximates a projection exactly at the point and to first order around it", () => {
    const p: Projective = [900, 20, 100, 10, 800, 50, 0.1, 0.2, 700];
    const at: [number, number] = [30, 40];
    const a = affineApproximation(p, at) as Affine;
    near(applyToPoint(a, at), projectPoint(p, at), 9);
    const eps = 1e-3;
    near(applyToPoint(a, [at[0] + eps, at[1]]), projectPoint(p, [at[0] + eps, at[1]]), 4);
    near(applyToPoint(a, [at[0], at[1] + eps]), projectPoint(p, [at[0], at[1] + eps]), 4);
  });

  it("has no approximation when the point is not in front of the camera", () => {
    expect(affineApproximation([1, 0, 0, 0, 1, 0, 0, 0, -1], [0, 0])).toBeNull();
    expect(affineApproximation([1, 0, 0, 0, 1, 0, 0, 0, 0], [0, 0])).toBeNull();
  });
});
