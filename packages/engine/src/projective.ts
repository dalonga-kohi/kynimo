import { type Affine, sinCos } from "./affine.js";

/**
 * 4x4 matrix for 3D layers and cameras (ADR-0054), row-major, applied to column vectors:
 * `p' = M · p`. Composition space: +x right, +y down, +z away from the viewer (into the screen).
 */
export type Mat4 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const MAT4_IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** `a · b`: applies `b` first, then `a`. */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = new Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      out[r * 4 + c] =
        (a[r * 4] as number) * (b[c] as number) +
        (a[r * 4 + 1] as number) * (b[4 + c] as number) +
        (a[r * 4 + 2] as number) * (b[8 + c] as number) +
        (a[r * 4 + 3] as number) * (b[12 + c] as number);
  return out as unknown as Mat4;
}

/** The inverse of `m`, or `null` when it is singular or not finite. */
export function mat4Invert(m: Mat4): Mat4 | null {
  // Gauss-Jordan elimination with partial pivoting on [m | I].
  const a: number[][] = [];
  for (let r = 0; r < 4; r++) {
    const row: number[] = [];
    for (let c = 0; c < 4; c++) row.push(m[r * 4 + c] as number);
    for (let c = 0; c < 4; c++) row.push(r === c ? 1 : 0);
    a.push(row);
  }
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++)
      if (
        Math.abs((a[r] as number[])[col] as number) >
        Math.abs((a[pivot] as number[])[col] as number)
      )
        pivot = r;
    const pivotRow = a[pivot] as number[];
    const p = pivotRow[col] as number;
    if (p === 0 || !Number.isFinite(p)) return null;
    a[pivot] = a[col] as number[];
    a[col] = pivotRow;
    for (let c = 0; c < 8; c++) pivotRow[c] = (pivotRow[c] as number) / p;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const row = a[r] as number[];
      const f = row[col] as number;
      if (f === 0) continue;
      for (let c = 0; c < 8; c++) row[c] = (row[c] as number) - f * (pivotRow[c] as number);
    }
  }
  const out: number[] = [];
  for (let r = 0; r < 4; r++) for (let c = 4; c < 8; c++) out.push((a[r] as number[])[c] as number);
  return out.every(Number.isFinite) ? (out as unknown as Mat4) : null;
}

/** Embeds a 2D affine in the z = 0 plane; z is left untouched. */
export function affineToMat4([a, b, c, d, e, f]: Affine): Mat4 {
  return [a, c, 0, e, b, d, 0, f, 0, 0, 1, 0, 0, 0, 0, 1];
}

export const mat4Translate = (x: number, y: number, z: number): Mat4 => [
  1,
  0,
  0,
  x,
  0,
  1,
  0,
  y,
  0,
  0,
  1,
  z,
  0,
  0,
  0,
  1,
];

export const mat4Scale = (x: number, y: number, z: number): Mat4 => [
  x,
  0,
  0,
  0,
  0,
  y,
  0,
  0,
  0,
  0,
  z,
  0,
  0,
  0,
  0,
  1,
];

/**
 * Rotation about X by `degrees`. Positive turns the top edge (-y) toward +z, away from the default
 * camera: `y' = y·cos + z·sin`, `z' = -y·sin + z·cos`.
 */
export function mat4RotateX(degrees: number): Mat4 {
  const [s, c] = sinCos(degrees);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

/**
 * Rotation about Y by `degrees`. Positive turns the right edge (+x) toward +z, away from the
 * default camera: `x' = x·cos - z·sin`, `z' = x·sin + z·cos`.
 */
export function mat4RotateY(degrees: number): Mat4 {
  const [s, c] = sinCos(degrees);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

/** Rotation about Z by `degrees`, clockwise on screen like the 2D rotation. */
export function mat4RotateZ(degrees: number): Mat4 {
  const [s, c] = sinCos(degrees);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * A plane-to-plane projective map (homography), row-major, applied to column vectors:
 * `X = m0·x + m1·y + m2`, `Y = m3·x + m4·y + m5`, `W = m6·x + m7·y + m8`, and the point is
 * `(X/W, Y/W)`. `W` is the camera-space depth in composition pixels, and the matrix is never
 * normalized (never divide by `m8`): the renderer clips against `W` to keep geometry behind the
 * camera out.
 */
export type Projective = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** `m · n`: applies `n` first, then `m`. */
export function projectiveMultiply(m: Projective, n: Projective): Projective {
  const out: number[] = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      out[r * 3 + c] =
        (m[r * 3] as number) * (n[c] as number) +
        (m[r * 3 + 1] as number) * (n[3 + c] as number) +
        (m[r * 3 + 2] as number) * (n[6 + c] as number);
  return out as unknown as Projective;
}

/** The true inverse (adjugate over determinant, not normalized), or `null` when singular or not finite. */
export function projectiveInvert(m: Projective): Projective | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0 || !Number.isFinite(det)) return null;
  const out = [
    A / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    C / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  return out.every(Number.isFinite) ? (out as unknown as Projective) : null;
}

/** Applies `m` to a point: `[X/W, Y/W]`. `W` is not checked; callers clip points with `W <= 0` first. */
export function projectPoint(m: Projective, [x, y]: readonly [number, number]): [number, number] {
  const w = (m[6] as number) * x + (m[7] as number) * y + (m[8] as number);
  return [
    ((m[0] as number) * x + (m[1] as number) * y + (m[2] as number)) / w,
    ((m[3] as number) * x + (m[4] as number) * y + (m[5] as number)) / w,
  ];
}

/** The depth `W` of a point under `m`. */
export const projectiveDepth = (m: Projective, [x, y]: readonly [number, number]): number =>
  (m[6] as number) * x + (m[7] as number) * y + (m[8] as number);

/** An affine as a projective map with `W = 1`. */
export function affineToProjective([a, b, c, d, e, f]: Affine): Projective {
  return [a, c, e, b, d, f, 0, 0, 1];
}

/**
 * The rotation that turns +z toward the direction `(dx, dy, dz)`, keeping +y (down) as close to
 * world +y as possible. A zero (or non-finite) direction gives the identity. When the direction is
 * parallel to ±y, world +z is the reference axis instead, so the result is still defined.
 */
export function lookAtRotation(dx: number, dy: number, dz: number): Mat4 {
  const length = Math.hypot(dx, dy, dz);
  if (length === 0 || !Number.isFinite(length)) return MAT4_IDENTITY;
  const z: [number, number, number] = [dx / length, dy / length, dz / length];
  // x = reference × z, y = z × x; the reference is +y unless z is (nearly) parallel to it.
  const cross = (r: readonly [number, number, number]): [number, number, number] => [
    r[1] * z[2] - r[2] * z[1],
    r[2] * z[0] - r[0] * z[2],
    r[0] * z[1] - r[1] * z[0],
  ];
  let x = cross([0, 1, 0]);
  let n = Math.hypot(x[0], x[1], x[2]);
  if (n < 1e-9) {
    x = cross([0, 0, 1]);
    n = Math.hypot(x[0], x[1], x[2]);
  }
  x = [x[0] / n, x[1] / n, x[2] / n];
  const y: [number, number, number] = [
    z[1] * x[2] - z[2] * x[1],
    z[2] * x[0] - z[0] * x[2],
    z[0] * x[1] - z[1] * x[0],
  ];
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, 0, 0, 0, 1];
}

/**
 * Projects the z = 0 plane of a layer through a camera. `cameraFromLayer` is `view · world`
 * (layer space → camera space); the result maps layer-space `(x, y)` to composition pixels with
 * `W` the camera-space depth `z_c`: `x_s = zoom · x_c / z_c + width / 2`, `y_s = zoom · y_c / z_c +
 * height / 2`. Never normalized.
 */
export function projectLayerPlane(
  cameraFromLayer: Mat4,
  zoom: number,
  width: number,
  height: number,
): Projective {
  const row = (r: number) => [
    cameraFromLayer[r * 4] as number,
    cameraFromLayer[r * 4 + 1] as number,
    cameraFromLayer[r * 4 + 3] as number,
  ];
  const [xx, xy, xt] = row(0) as [number, number, number];
  const [yx, yy, yt] = row(1) as [number, number, number];
  const [zx, zy, zt] = row(2) as [number, number, number];
  const cx = width / 2;
  const cy = height / 2;
  return [
    zoom * xx + cx * zx,
    zoom * xy + cx * zy,
    zoom * xt + cx * zt,
    zoom * yx + cy * zx,
    zoom * yy + cy * zy,
    zoom * yt + cy * zt,
    zx,
    zy,
    zt,
  ];
}

/**
 * The first-order affine approximation of `m` at `at` (the Jacobian of `(X/W, Y/W)` plus the
 * offset that makes it exact at `at`), or `null` when `W` is not positive there.
 */
export function affineApproximation(m: Projective, at: readonly [number, number]): Affine | null {
  const [x, y] = at;
  const w = projectiveDepth(m, at);
  if (!(w > 0)) return null;
  const px = (m[0] as number) * x + (m[1] as number) * y + (m[2] as number);
  const py = (m[3] as number) * x + (m[4] as number) * y + (m[5] as number);
  const a = ((m[0] as number) * w - px * (m[6] as number)) / (w * w);
  const c = ((m[1] as number) * w - px * (m[7] as number)) / (w * w);
  const b = ((m[3] as number) * w - py * (m[6] as number)) / (w * w);
  const d = ((m[4] as number) * w - py * (m[7] as number)) / (w * w);
  return [a, b, c, d, px / w - (a * x + c * y), py / w - (b * x + d * y)];
}
