import { numberPattern } from "./numbers.js";

/** `[a, b, c, d, e, f]` in canvas order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m · n`: applies `n` first. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export const apply = (m: Matrix, [x, y]: readonly [number, number]): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** Linear part only: for tangents (offsets). */
export const applyLinear = (m: Matrix, [x, y]: readonly [number, number]): [number, number] => [
  m[0] * x + m[2] * y,
  m[1] * x + m[3] * y,
];

export const determinant = (m: Matrix): number => m[0] * m[3] - m[1] * m[2];

export const isIdentity = (m: Matrix): boolean =>
  m.every((v, i) => Math.abs(v - (IDENTITY[i] ?? 0)) < 1e-12);

/** Equal scale on both axes and no shear (rotation and uniform scale; a flip counts as uniform). */
export function isSimilarity(m: Matrix): boolean {
  const lenX = Math.hypot(m[0], m[1]);
  const lenY = Math.hypot(m[2], m[3]);
  const dot = m[0] * m[2] + m[1] * m[3];
  const scale = Math.max(lenX, lenY, 1e-12);
  return Math.abs(lenX - lenY) <= 1e-6 * scale && Math.abs(dot) <= 1e-6 * scale * scale;
}

/** Sine and cosine in degrees, exact at multiples of 90. */
function sinCos(degrees: number): [number, number] {
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

const rotation = (deg: number): Matrix => {
  const [s, c] = sinCos(deg);
  return [c, s, -s, c, 0, 0];
};

/** Parses an SVG `transform` list. `undefined` when any part is invalid (SVG then ignores it). */
export function parseTransform(source: string): Matrix | undefined {
  const re = /\s*,?\s*([a-zA-Z]+)\s*\(([^()]*)\)/y;
  const num = numberPattern();
  let m: Matrix = IDENTITY;
  let i = 0;
  const text = source.trim();
  if (text === "") return IDENTITY;
  while (i < text.length) {
    re.lastIndex = i;
    const match = re.exec(text);
    if (match === null) return undefined;
    i = re.lastIndex;
    const name = match[1] ?? "";
    const body = match[2] ?? "";
    const args: number[] = [];
    let j = 0;
    const skip = (): void => {
      while (j < body.length && /[\s,]/.test(body[j] ?? "")) j++;
    };
    skip();
    while (j < body.length) {
      num.lastIndex = j;
      const nm = num.exec(body);
      if (nm === null) return undefined;
      const v = Number(nm[0]);
      if (!Number.isFinite(v)) return undefined;
      args.push(v);
      j = num.lastIndex;
      skip();
    }
    const a = (k: number): number => args[k] ?? 0;
    let t: Matrix;
    switch (name) {
      case "matrix":
        if (args.length !== 6) return undefined;
        t = [a(0), a(1), a(2), a(3), a(4), a(5)];
        break;
      case "translate":
        if (args.length !== 1 && args.length !== 2) return undefined;
        t = [1, 0, 0, 1, a(0), a(1)];
        break;
      case "scale":
        if (args.length !== 1 && args.length !== 2) return undefined;
        t = [a(0), 0, 0, args.length === 1 ? a(0) : a(1), 0, 0];
        break;
      case "rotate": {
        if (args.length !== 1 && args.length !== 3) return undefined;
        const r = rotation(a(0));
        t =
          args.length === 1
            ? r
            : multiply(multiply([1, 0, 0, 1, a(1), a(2)], r), [1, 0, 0, 1, -a(1), -a(2)]);
        break;
      }
      case "skewX": {
        if (args.length !== 1) return undefined;
        t = [1, 0, Math.tan((a(0) * Math.PI) / 180), 1, 0, 0];
        break;
      }
      case "skewY": {
        if (args.length !== 1) return undefined;
        t = [1, Math.tan((a(0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      }
      default:
        return undefined;
    }
    m = multiply(m, t);
  }
  return m;
}

export interface DecomposedTransform {
  position: [number, number];
  /** Degrees, clockwise. */
  rotation: number;
  /** Degrees, as the scene transform's `skew`. */
  skew: number;
  scale: [number, number];
}

/** Largest skew the scene transform carries. */
export const MAX_SKEW = 85;

/**
 * Splits a matrix into the scene transform's values with `anchorPoint` `[0, 0]`, inverting
 * `translate(position) · rotate · shear(k = -tan(skew)) · scale`. `null` when the matrix is
 * singular or needs a skew beyond ±85 degrees; the caller then bakes it into the geometry.
 */
export function decompose(m: Matrix): DecomposedTransform | null {
  const [a, b, c, d, e, f] = m;
  const sx = Math.hypot(a, b);
  const det = a * d - b * c;
  if (!(sx > 1e-9) || !(Math.abs(det) > 1e-12)) return null;
  const sy = det / sx;
  const k = (a * c + b * d) / (sx * sy);
  const skew = (-Math.atan(k) * 180) / Math.PI;
  if (Math.abs(skew) > MAX_SKEW) return null;
  const rot = (Math.atan2(b, a) * 180) / Math.PI;
  return { position: [e, f], rotation: rot, skew, scale: [sx, sy] };
}
