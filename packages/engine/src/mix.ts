/** An N-dimensional vector (2D today, 3D later). Read-only so callers can pass schema tuples. */
export type Vector = readonly number[];

/**
 * Linear mix of two numbers by progress `p` (unclamped, so overshoot extrapolates).
 * Exact at both ends and when `a === b`, so a keyframe always renders its stored value.
 */
export function lerp(a: number, b: number, p: number): number {
  if (p === 0) return a;
  if (p === 1) return b;
  return a + (b - a) * p;
}

/** Component-wise {@link lerp}. Both vectors must have the same dimension. */
export function lerpVector<V extends Vector>(a: V, b: V, p: number): V {
  if (a.length !== b.length)
    throw new RangeError(`cannot mix a ${a.length}D vector with a ${b.length}D vector`);
  return a.map((x, i) => lerp(x, b[i] as number, p)) as unknown as V;
}

/** Clamps to 0..1. */
export const clampUnit = (x: number): number => Math.min(1, Math.max(0, x));
