import type { Animatable, FrameRate, GroupTransform, Transform, Vec2 } from "@kynimo/scene";
import { type Affine, transformMatrix } from "./affine.js";
import { clampUnit } from "./mix.js";
import type { Point, ResolvedTransform } from "./resolved.js";
import { sampleNumber, samplePosition, sampleVector } from "./track.js";

/**
 * Per-property domain clamps (ADR-0014: easing may overshoot, only the property knows its range).
 * Applied after sampling, so a stored keyframe value is never changed.
 */
export const atLeastZero = (x: number): number => Math.max(0, x);
export const clampSkew = (x: number): number => Math.min(85, Math.max(-85, x));
export { clampUnit };

export const samplePoint = (track: Animatable<Vec2>, frame: number, fps: FrameRate): Point =>
  sampleVector(track, frame, fps);

/** A size vector, each component at least 0. */
export const sampleSize = (track: Animatable<Vec2>, frame: number, fps: FrameRate): Point => {
  const [w, h] = sampleVector(track, frame, fps);
  return w >= 0 && h >= 0 ? [w, h] : [atLeastZero(w), atLeastZero(h)];
};

export const sampleNonNegative = (track: Animatable<number>, frame: number, fps: FrameRate) =>
  atLeastZero(sampleNumber(track, frame, fps));

export const sampleUnit = (track: Animatable<number>, frame: number, fps: FrameRate) =>
  clampUnit(sampleNumber(track, frame, fps));

/** Samples a transform at `frame` (layer time) and builds its local matrix. */
export function resolveTransform(
  t: Transform | GroupTransform,
  frame: number,
  fps: FrameRate,
): { transform: ResolvedTransform; matrix: Affine } {
  const transform: ResolvedTransform = {
    anchorPoint: samplePoint(t.anchorPoint, frame, fps),
    position: samplePosition(t.position, frame, fps) as Point,
    positionZ: "positionZ" in t ? sampleNumber(t.positionZ, frame, fps) : 0,
    scale: samplePoint(t.scale, frame, fps),
    rotation: sampleNumber(t.rotation, frame, fps),
    rotationX: "rotationX" in t ? sampleNumber(t.rotationX, frame, fps) : 0,
    rotationY: "rotationY" in t ? sampleNumber(t.rotationY, frame, fps) : 0,
    skew: clampSkew(sampleNumber(t.skew, frame, fps)),
    opacity: sampleUnit(t.opacity, frame, fps),
  };
  return { transform, matrix: transformMatrix(transform) };
}
