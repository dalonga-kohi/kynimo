/**
 * A 2D affine matrix `[a, b, c, d, e, f]` in canvas/DOMMatrix order:
 * `x' = a*x + c*y + e`, `y' = b*x + d*y + f`. Screen space: +x right, +y down, so positive
 * rotation turns clockwise. 3D (ADR-0013) adds a 4x4 type beside this one.
 */
export type Affine = readonly [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `m · n`: applies `n` first, then `m`. */
export function multiply(m: Affine, n: Affine): Affine {
  const [a, b, c, d, e, f] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

/** The inverse of `m`, or `null` when it has none (it collapses the plane onto a line or point). */
export function invert(m: Affine): Affine | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function applyToPoint(m: Affine, [x, y]: readonly [number, number]): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Sine and cosine of an angle in degrees, exact at multiples of 90° so right-angle turns stay pixel-exact. */
export function sinCos(degrees: number): [number, number] {
  const quarter = degrees / 90;
  if (Number.isInteger(quarter)) {
    const q = ((quarter % 4) + 4) % 4;
    return (
      [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ] as const
    )[q] as [number, number];
  }
  const rad = (degrees * Math.PI) / 180;
  return [Math.sin(rad), Math.cos(rad)];
}

export interface TransformValues {
  anchorPoint: readonly [number, number];
  position: readonly [number, number];
  scale: readonly [number, number];
  /** Degrees, clockwise. */
  rotation: number;
  /**
   * Degrees of horizontal shear about the anchor point. Positive skew leans the top edge right and
   * the bottom edge left, as in After Effects and Lottie (CSS `skewX(-skew)`).
   */
  skew: number;
}

/**
 * Local matrix of a layer or shape group, After Effects order:
 * `translate(position) · rotate(rotation) · skew(skew) · scale(scale) · translate(-anchorPoint)`.
 */
export function transformMatrix(t: TransformValues): Affine {
  const [sin, cos] = sinCos(t.rotation);
  const k = t.skew === 0 ? 0 : -Math.tan((t.skew * Math.PI) / 180);
  const [sx, sy] = t.scale;
  // rotate · shear(x' = x + k·y) · scale, written out; k = -tan(skew) gives the After Effects lean.
  const a = cos * sx;
  const b = sin * sx;
  const c = (cos * k - sin) * sy;
  const d = (sin * k + cos) * sy;
  const [ax, ay] = t.anchorPoint;
  return [a, b, c, d, t.position[0] - (a * ax + c * ay), t.position[1] - (b * ax + d * ay)];
}
