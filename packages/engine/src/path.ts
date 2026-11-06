import { lerp, type Vector } from "./mix.js";

/**
 * Chords per segment in the arc-length table. Fixed, so a path samples identically everywhere;
 * changing it shifts rendered positions slightly and counts as a rendering change.
 */
export const ARC_LENGTH_SAMPLES = 128;

/** A spatial path parameterized by distance: `at(p)` is the point at fraction `p` of its length. */
export interface MotionPath<V extends Vector> {
  readonly length: number;
  /** `p` in 0..1 walks the path at constant speed; outside 0..1 it continues along the end tangent. */
  at(p: number): Readonly<V>;
}

const sub = (a: Vector, b: Vector) => a.map((x, i) => x - (b[i] as number));
const norm = (v: Vector) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

/** The first non-zero direction among `candidates`, normalized; zero if all are zero. */
function direction(candidates: Vector[]): number[] {
  for (const v of candidates) {
    const n = norm(v);
    if (n > 0) return v.map((x) => x / n);
  }
  return (candidates[0] ?? []).map(() => 0);
}

/**
 * A cubic bezier motion path from `p0` to `p3` with control points `p1` and `p2`, in any dimension.
 * Position keyframes build it as `p1 = from + outTangent`, `p2 = to + inTangent`.
 * Parameterized by arc length so that temporal easing controls speed along the path exactly.
 */
export function cubicPath<V extends Vector>(p0: V, p1: V, p2: V, p3: V): MotionPath<V> {
  const dims = p0.length;
  if (p1.length !== dims || p2.length !== dims || p3.length !== dims)
    throw new RangeError("all control points of a path must have the same dimension");

  const point = (t: number): V => {
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    return p0.map(
      (x, i) => w0 * x + w1 * (p1[i] as number) + w2 * (p2[i] as number) + w3 * (p3[i] as number),
    ) as unknown as V;
  };

  // cumulative[i] = length of the polyline through point(0) … point(i / N).
  const cumulative = new Float64Array(ARC_LENGTH_SAMPLES + 1);
  let previous: Vector = p0;
  for (let i = 1; i <= ARC_LENGTH_SAMPLES; i++) {
    const current = point(i / ARC_LENGTH_SAMPLES);
    cumulative[i] = (cumulative[i - 1] as number) + norm(sub(current, previous));
    previous = current;
  }
  const length = cumulative[ARC_LENGTH_SAMPLES] as number;
  const startDir = direction([sub(p1, p0), sub(p2, p0), sub(p3, p0)]);
  const endDir = direction([sub(p3, p2), sub(p3, p1), sub(p3, p0)]);

  const along = (origin: V, dir: number[], distance: number): V =>
    origin.map((x, i) => x + (dir[i] as number) * distance) as unknown as V;

  return {
    length,
    at(p) {
      if (p === 0 || length === 0) return p0;
      if (p === 1) return p3;
      if (p < 0) return along(p0, startDir, p * length);
      if (p > 1) return along(p3, endDir, (p - 1) * length);
      const target = p * length;
      // Largest i with cumulative[i] <= target.
      let lo = 0;
      let hi = ARC_LENGTH_SAMPLES;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((cumulative[mid] as number) <= target) lo = mid;
        else hi = mid;
      }
      const start = cumulative[lo] as number;
      const span = (cumulative[hi] as number) - start;
      const local = span > 0 ? (target - start) / span : 0;
      return point(lerp(lo, hi, local) / ARC_LENGTH_SAMPLES);
    },
  };
}
