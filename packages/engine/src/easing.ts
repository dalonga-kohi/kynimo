import {
  type FrameRate,
  type Interpolation,
  type SpringParams,
  springSettleFrames,
} from "@kynimo/scene";

const NEWTON_ITERATIONS = 8;
const BISECTION_ITERATIONS = 48;
const SOLVE_EPSILON = 1e-9;

/**
 * A CSS-style cubic-bezier easing: control points (0,0), (x1,y1), (x2,y2), (1,1).
 * Maps normalized time `x` in 0..1 to progress `y`, which may overshoot when y1/y2 are outside 0..1.
 * x1 and x2 must lie in 0..1 (the schema guarantees it), which keeps x(t) monotone so each
 * time has exactly one progress value.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  // Polynomial coefficients of B(t) = ((a t + b) t + c) t for each axis.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  // Fixed iteration counts keep the result identical on every run.
  const solveT = (x: number): number => {
    let t = x;
    for (let i = 0; i < NEWTON_ITERATIONS; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < SOLVE_EPSILON) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= err / slope;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < BISECTION_ITERATIONS; i++) {
      const value = sampleX(t);
      if (Math.abs(value - x) < SOLVE_EPSILON) return t;
      if (value < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solveT(x));
  };
}

/**
 * Progress (0 at the start, 1 at the target) of a spring released from rest at its keyframe,
 * `elapsedFrames` frames later. Uses the same model as `springSettleFrames` in `@kynimo/scene`:
 * a damped harmonic oscillator with damping ratio `damping` and natural period `response` seconds.
 * From the settle frame on it is exactly 1, so the segment ends on the next keyframe's value.
 */
export function springProgress(
  spring: SpringParams,
  elapsedFrames: number,
  fps: FrameRate,
): number {
  if (elapsedFrames <= 0) return 0;
  if (elapsedFrames >= springSettleFrames(spring, fps)) return 1;
  const t = (elapsedFrames * fps.den) / fps.num;
  const omega = (2 * Math.PI) / spring.response;
  const zeta = spring.damping;
  let deviation: number;
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    deviation =
      Math.exp(-zeta * omega * t) *
      (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
  } else if (zeta === 1) {
    deviation = (1 + omega * t) * Math.exp(-omega * t);
  } else {
    const root = Math.sqrt(zeta * zeta - 1);
    const slow = omega * (zeta - root);
    const fast = omega * (zeta + root);
    deviation = (fast * Math.exp(-slow * t) - slow * Math.exp(-fast * t)) / (fast - slow);
  }
  return 1 - deviation;
}

/**
 * Progress through one keyframe segment under the outgoing keyframe's interpolation.
 * `elapsedFrames` runs from 0 (at the outgoing keyframe) to `segmentFrames` (at the next one).
 * The result is unclamped: bezier and spring progress can overshoot 0..1.
 */
export function segmentProgress(
  interpolation: Interpolation,
  elapsedFrames: number,
  segmentFrames: number,
  fps: FrameRate,
): number {
  switch (interpolation.type) {
    case "hold":
      return 0;
    case "linear":
      return clampUnit(elapsedFrames / segmentFrames);
    case "bezier": {
      const { x1, y1, x2, y2 } = interpolation;
      return cubicBezier(x1, y1, x2, y2)(elapsedFrames / segmentFrames);
    }
    case "spring":
      return springProgress(interpolation, elapsedFrames, fps);
  }
}

const clampUnit = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
