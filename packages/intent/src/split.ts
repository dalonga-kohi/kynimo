import { cubicPath } from "@kynimo/engine";
import {
  type FrameRate,
  type Interpolation,
  type Keyframe,
  type PositionKeyframe,
  springSettleFrames,
  type Vec2,
} from "@kynimo/scene";
import { type InputPath, IntentError } from "./errors.js";

/**
 * Splitting the old segment that an `animate` window edge cuts, so the motion outside the window
 * is exactly what it was. A segment goes `a → b` under `a`'s interpolation (easing on time,
 * progress then mixes the values, or walks the spatial path by arc length). Cutting it at frame
 * `f` gives a left part `a → cut` and a right part `cut → b`, each described by the interpolation
 * and spatial tangents the keyframes at its ends need.
 */

const EPS = 1e-6;

type Point = readonly [number, number];

export interface SegmentHalf {
  interpolation: Interpolation;
}

export interface LeftHalf extends SegmentHalf {
  /** `a`'s new out tangent; undefined leaves `a`'s own. */
  outTangent?: Vec2;
  /** The in tangent of the key at the cut, relative to the cut's value. */
  inTangent?: Vec2;
}

export interface RightHalf extends SegmentHalf {
  /** The out tangent of the key at the cut, relative to the cut's value. */
  outTangent?: Vec2;
  /** `b`'s new in tangent; undefined leaves `b`'s own. */
  inTangent?: Vec2;
}

export interface SegmentCut {
  /** Eased progress of the cut frame within the segment (what the engine samples there). */
  progress: number;
  left: LeftHalf;
  right: RightHalf;
}

const mid = (p: Point, q: Point, t: number): Point => [
  p[0] + (q[0] - p[0]) * t,
  p[1] + (q[1] - p[1]) * t,
];

/** De Casteljau split of a cubic at `t`: the control polygons of both halves. */
function splitCubic(
  p: readonly [Point, Point, Point, Point],
  t: number,
): { left: [Point, Point, Point, Point]; right: [Point, Point, Point, Point]; point: Point } {
  const p01 = mid(p[0], p[1], t);
  const p12 = mid(p[1], p[2], t);
  const p23 = mid(p[2], p[3], t);
  const p012 = mid(p01, p12, t);
  const p123 = mid(p12, p23, t);
  const m = mid(p012, p123, t);
  return { left: [p[0], p01, p012, m], right: [m, p123, p23, p[3]], point: m };
}

/** The curve parameter whose x is `x`; x(t) is monotone because x1 and x2 lie in 0..1. */
function solveParameter(x1: number, x2: number, x: number): number {
  const bx = (t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t;
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 64; i++) {
    const m = (lo + hi) / 2;
    if (bx(m) < x) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

const unit = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Cuts an easing curve at normalized time `t`. Returns the eased progress there and both parts
 * as curves on their own unit square (time and progress renormalized to 0..1).
 */
function splitBezier(
  bezier: Extract<Interpolation, { type: "bezier" }>,
  t: number,
  refuse: (message: string) => never,
): { progress: number; left: Interpolation; right: Interpolation } {
  const { x1, y1, x2, y2 } = bezier;
  const u = solveParameter(x1, x2, t);
  const { left, right, point } = splitCubic(
    [
      [0, 0],
      [x1, y1],
      [x2, y2],
      [1, 1],
    ],
    u,
  );
  const [X, Y] = point;
  const linear: Interpolation = { type: "linear" };
  const make = (
    c1: Point,
    c2: Point,
    ox: number,
    oy: number,
    sx: number,
    sy: number,
  ): Interpolation => {
    if (sx < EPS) return linear;
    if (Math.abs(sy) < EPS) {
      // The part starts and ends at the same progress: only a flat part has a curve to keep.
      if (Math.abs(c1[1] - oy) < EPS && Math.abs(c2[1] - oy) < EPS) return linear;
      return refuse(
        "the easing under this window edge crosses the same progress twice there, so it can't be split",
      );
    }
    const n1x = unit((c1[0] - ox) / sx);
    const n2x = unit((c2[0] - ox) / sx);
    const n1y = (c1[1] - oy) / sy;
    const n2y = (c2[1] - oy) / sy;
    if (Math.abs(n1y) > 5 || Math.abs(n2y) > 5)
      return refuse(
        "the easing under this window edge can't be split into two curves within the allowed overshoot; move the window edge or use a gentler easing",
      );
    return { type: "bezier", x1: n1x, y1: n1y, x2: n2x, y2: n2y };
  };
  return {
    progress: Y,
    left: make(left[1], left[2], 0, 0, X, Y),
    right: make(right[1], right[2], X, Y, 1 - X, 1 - Y),
  };
}

const isZero = (v: Vec2) => v[0] === 0 && v[1] === 0;

/**
 * Splits a position segment's spatial path at the arc-length fraction `progress`, the way the
 * engine walks it, so both halves pass through the same points. Tangents come back as offsets
 * from each key's value.
 */
function splitSpatial(
  a: PositionKeyframe,
  b: PositionKeyframe,
  progress: number,
  refuse: (message: string) => never,
): { aOut: Vec2; cutIn: Vec2; cutOut: Vec2; bIn: Vec2 } | undefined {
  const out = a.spatial?.outTangent ?? [0, 0];
  const inn = b.spatial?.inTangent ?? [0, 0];
  if (isZero(out) && isZero(inn)) return undefined;
  if (progress <= 0 || progress >= 1)
    return refuse(
      "the easing overshoots the motion path at this window edge; move the edge to where the motion is still on the path",
    );
  const p0: Point = [a.value[0], a.value[1]];
  const p1: Point = [a.value[0] + out[0], a.value[1] + out[1]];
  const p2: Point = [b.value[0] + inn[0], b.value[1] + inn[1]];
  const p3: Point = [b.value[0], b.value[1]];
  const path = cubicPath(p0, p1, p2, p3);
  const { left, right, point } = splitCubic([p0, p1, p2, p3], path.parameterAt(progress));
  return {
    aOut: [left[1][0] - p0[0], left[1][1] - p0[1]],
    cutIn: [left[2][0] - point[0], left[2][1] - point[1]],
    cutOut: [right[1][0] - point[0], right[1][1] - point[1]],
    bIn: [right[2][0] - p3[0], right[2][1] - p3[1]],
  };
}

/**
 * Cuts the segment `a → b` at the strictly inner `frame` (layer time). `where` names the window
 * edge and `layerStart` converts frames to composition time for messages; refusals point at `path`.
 */
export function cutSegment(
  a: Keyframe<number | Vec2> | PositionKeyframe,
  b: Keyframe<number | Vec2> | PositionKeyframe,
  frame: number,
  fps: FrameRate,
  edge: "start" | "end",
  layerStart: number,
  path: InputPath,
): SegmentCut {
  const refuse = (message: string): never => {
    throw new IntentError(path, message);
  };
  const t = (frame - a.frame) / (b.frame - a.frame);
  const position = Array.isArray(a.value) && a.value.length === 2;
  const spatial = (progress: number): ReturnType<typeof splitSpatial> | undefined => {
    if (!position) return undefined;
    return splitSpatial(a as PositionKeyframe, b as PositionKeyframe, progress, refuse);
  };
  const interp = a.interpolation;
  const finish = (progress: number, left: Interpolation, right: Interpolation): SegmentCut => {
    const split = spatial(progress);
    return {
      progress,
      left: {
        interpolation: left,
        ...(split ? { outTangent: split.aOut, inTangent: split.cutIn } : {}),
      },
      right: {
        interpolation: right,
        ...(split ? { outTangent: split.cutOut, inTangent: split.bIn } : {}),
      },
    };
  };

  switch (interp.type) {
    case "hold":
      return { progress: 0, left: { interpolation: interp }, right: { interpolation: interp } };
    case "linear":
      return finish(t, interp, interp);
    case "bezier": {
      const parts = splitBezier(interp, t, refuse);
      return finish(parts.progress, parts.left, parts.right);
    }
    case "spring": {
      const settle = springSettleFrames(interp, fps);
      const elapsed = frame - a.frame;
      if (elapsed < settle) {
        const at = layerStart + a.frame;
        return refuse(
          edge === "start"
            ? `the window starts inside a spring segment at frame ${at}; start at or after its settle frame ${at + settle}, or switch it to a bezier easing`
            : `the window ends inside a spring segment at frame ${at}; end at or after its settle frame ${at + settle}, or switch it to a bezier easing`,
        );
      }
      // Settled: the spring already reached b, so the left part is the whole segment and the
      // right part holds b's value.
      const wholeIn = (b as PositionKeyframe).spatial?.inTangent;
      return {
        progress: 1,
        left: {
          interpolation: interp,
          ...(position && wholeIn ? { inTangent: wholeIn } : {}),
        },
        right: {
          interpolation: { type: "linear" },
          ...(position ? { outTangent: [0, 0] as Vec2 } : {}),
        },
      };
    }
  }
}
