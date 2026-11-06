import type { Animatable, Color, FrameRate, Keyframe, PositionTrack, Vec2 } from "@kynimo/scene";
import { mixColor, parseColor, type Rgba } from "./color.js";
import { segmentProgress } from "./easing.js";
import { lerp, lerpVector, type Vector } from "./mix.js";
import { cubicPath } from "./path.js";

/**
 * Mixes two keyframe values by progress. Must return `from`'s value at p = 0 and `to`'s at p = 1.
 * Constant values are sampled as `mix(value, value, 0)`.
 */
export type Mixer<T, R> = (from: T, to: T, p: number) => R;

/** Where a frame falls in a keyframe list: the segment's two keyframes and the eased progress between them. */
export interface SegmentSample<K> {
  from: K;
  to: K;
  /** Eased, unclamped progress from `from` to `to`. */
  progress: number;
}

/**
 * Finds the segment that contains `frame` (in layer time, like the keyframes) and its eased progress.
 * Before the first keyframe and from the last one on, both ends are that keyframe and progress is 0.
 * A keyframe's own frame always belongs to the segment it starts, so it renders its stored value.
 * Keyframes must be non-empty with strictly increasing frames, as the schema guarantees.
 */
export function sampleSegment<T, K extends Keyframe<T>>(
  keyframes: readonly K[],
  frame: number,
  fps: FrameRate,
): SegmentSample<K> {
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (first === undefined || last === undefined)
    throw new RangeError("a keyframe track needs at least one keyframe");
  if (frame <= first.frame) return { from: first, to: first, progress: 0 };
  if (frame >= last.frame) return { from: last, to: last, progress: 0 };
  // Largest i with keyframes[i].frame <= frame; first.frame < frame < last.frame here.
  let lo = 0;
  let hi = keyframes.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((keyframes[mid] as K).frame <= frame) lo = mid;
    else hi = mid;
  }
  const from = keyframes[lo] as K;
  const to = keyframes[hi] as K;
  const progress = segmentProgress(
    from.interpolation,
    frame - from.frame,
    to.frame - from.frame,
    fps,
  );
  return { from, to, progress };
}

/** Samples an animatable property at `frame` (layer time). Values outside the property's domain are not clamped. */
export function sampleTrack<T, R>(
  track: Animatable<T>,
  frame: number,
  fps: FrameRate,
  mix: Mixer<T, R>,
): R {
  if ("value" in track) return mix(track.value, track.value, 0);
  const { from, to, progress } = sampleSegment<T, Keyframe<T>>(track.keyframes, frame, fps);
  return mix(from.value, to.value, progress);
}

export const sampleNumber = (track: Animatable<number>, frame: number, fps: FrameRate): number =>
  sampleTrack(track, frame, fps, lerp);

export const sampleVector = <V extends Vector>(
  track: Animatable<V>,
  frame: number,
  fps: FrameRate,
): V => sampleTrack(track, frame, fps, lerpVector);

const mixHex: Mixer<Color, Rgba> = (from, to, p) => mixColor(parseColor(from), parseColor(to), p);

/** Samples a color property as float RGBA (OKLab mixing; see {@link mixColor}). */
export const sampleColor = (track: Animatable<Color>, frame: number, fps: FrameRate): Rgba =>
  sampleTrack(track, frame, fps, mixHex);

const isZero = (v: Vector) => v.every((x) => x === 0);

/**
 * Samples a position track. Keyframed segments with spatial handles follow the bezier motion
 * path `from → from + outTangent → to + inTangent → to` at arc-length speed; without handles
 * they move in a straight line. Separate tracks sample X and Y independently.
 */
export function samplePosition(track: PositionTrack, frame: number, fps: FrameRate): Vec2 {
  if ("value" in track) return track.value;
  if ("separate" in track)
    return [sampleNumber(track.separate.x, frame, fps), sampleNumber(track.separate.y, frame, fps)];
  const { from, to, progress } = sampleSegment(track.keyframes, frame, fps);
  if (from === to || progress === 0) return from.value;
  const out = from.spatial?.outTangent ?? [0, 0];
  const inn = to.spatial?.inTangent ?? [0, 0];
  if (isZero(out) && isZero(inn)) return lerpVector(from.value, to.value, progress);
  const control1: Vec2 = [from.value[0] + out[0], from.value[1] + out[1]];
  const control2: Vec2 = [to.value[0] + inn[0], to.value[1] + inn[1]];
  return cubicPath(from.value, control1, control2, to.value).at(progress);
}
