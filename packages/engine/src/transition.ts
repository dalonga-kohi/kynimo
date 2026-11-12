import {
  type Animatable,
  type FrameRate,
  MAX_CLOCK_FEATHER,
  MAX_NOISE_DISSOLVE_SCALE,
  MAX_PIXELATE_CELL,
  MAX_TRANSITION_ANGLE,
  MAX_TRANSITION_FEATHER,
  MAX_TRANSITION_POINT,
  MAX_ZOOM_STRENGTH,
  MIN_NOISE_DISSOLVE_SCALE,
  MIN_PIXELATE_CELL,
  type Transition,
  type Vec2,
} from "@kynimo/scene";
import { samplePoint, sampleUnit } from "./properties.js";
import type { Point } from "./resolved.js";
import { sampleNumber } from "./track.js";

/** A {@link Transition} with every animatable sampled at the layer frame; constants are copied. */
export type ResolvedTransition =
  | { kind: "dissolve"; progress: number }
  | {
      kind: "noise-dissolve";
      progress: number;
      seed: number;
      scale: number;
      feather: number;
    }
  | { kind: "wipe"; progress: number; angle: number; feather: number }
  | {
      kind: "clock";
      progress: number;
      startAngle: number;
      clockwise: boolean;
      center: Point;
      feather: number;
    }
  | {
      kind: "iris";
      progress: number;
      shape: "circle" | "diamond" | "square";
      center: Point;
      feather: number;
    }
  | { kind: "blinds"; progress: number; count: number; angle: number; feather: number }
  | { kind: "pixelate"; progress: number; cell: number }
  | { kind: "push"; progress: number; angle: number }
  | { kind: "zoom"; progress: number; center: Point; strength: number }
  | { kind: "glitch"; progress: number; seed: number; bands: number; amount: number };

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** Samples a transition at `frame`, clamping easing overshoot to each field's domain. */
export function resolveTransition(
  transition: Transition,
  frame: number,
  fps: FrameRate,
): ResolvedTransition {
  const number = (track: Animatable<number>, min: number, max: number) =>
    clamp(sampleNumber(track, frame, fps), min, max);
  const unit = (track: Animatable<number>) => sampleUnit(track, frame, fps);
  const angle = (track: Animatable<number>) =>
    number(track, -MAX_TRANSITION_ANGLE, MAX_TRANSITION_ANGLE);
  const feather = (track: Animatable<number>) => number(track, 0, MAX_TRANSITION_FEATHER);
  const center = (track: Animatable<Vec2>): Point => {
    const [x, y] = samplePoint(track, frame, fps);
    return [
      clamp(x, -MAX_TRANSITION_POINT, MAX_TRANSITION_POINT),
      clamp(y, -MAX_TRANSITION_POINT, MAX_TRANSITION_POINT),
    ];
  };
  const progress = unit(transition.progress);
  switch (transition.kind) {
    case "dissolve":
      return { kind: "dissolve", progress };
    case "noise-dissolve":
      return {
        kind: "noise-dissolve",
        progress,
        seed: transition.seed,
        scale: number(transition.scale, MIN_NOISE_DISSOLVE_SCALE, MAX_NOISE_DISSOLVE_SCALE),
        feather: unit(transition.feather),
      };
    case "wipe":
      return {
        kind: "wipe",
        progress,
        angle: angle(transition.angle),
        feather: feather(transition.feather),
      };
    case "clock":
      return {
        kind: "clock",
        progress,
        startAngle: angle(transition.startAngle),
        clockwise: transition.clockwise,
        center: center(transition.center),
        feather: number(transition.feather, 0, MAX_CLOCK_FEATHER),
      };
    case "iris":
      return {
        kind: "iris",
        progress,
        shape: transition.shape,
        center: center(transition.center),
        feather: feather(transition.feather),
      };
    case "blinds":
      return {
        kind: "blinds",
        progress,
        count: transition.count,
        angle: angle(transition.angle),
        feather: unit(transition.feather),
      };
    case "pixelate":
      return {
        kind: "pixelate",
        progress,
        cell: number(transition.cell, MIN_PIXELATE_CELL, MAX_PIXELATE_CELL),
      };
    case "push":
      return { kind: "push", progress, angle: angle(transition.angle) };
    case "zoom":
      return {
        kind: "zoom",
        progress,
        center: center(transition.center),
        strength: number(transition.strength, 0, MAX_ZOOM_STRENGTH),
      };
    case "glitch":
      return {
        kind: "glitch",
        progress,
        seed: transition.seed,
        bands: transition.bands,
        amount: unit(transition.amount),
      };
  }
}
