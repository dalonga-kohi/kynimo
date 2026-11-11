import {
  type Animatable,
  type Color,
  type Effect,
  type FrameRate,
  MAX_EFFECT_RADIUS,
  MAX_SHADOW_OFFSET,
} from "@kynimo/scene";
import type { Rgba } from "./color.js";
import { samplePoint, sampleUnit } from "./properties.js";
import type { Point } from "./resolved.js";
import { sampleColor, sampleNumber } from "./track.js";

export type ResolvedEffect =
  | { type: "gaussian-blur"; radius: number }
  | { type: "drop-shadow"; radius: number; offset: Point; color: Rgba; opacity: number }
  | { type: "glow"; radius: number; color: Rgba; intensity: number }
  | { type: "brightness-contrast"; brightness: number; contrast: number }
  | { type: "hue-saturation"; hue: number; saturation: number }
  | { type: "tint"; black: Rgba; white: Rgba; amount: number }
  | { type: "fill"; color: Rgba; amount: number };

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** Resolves enabled effects in stack order, clamping easing overshoot to each field's domain. */
export function resolveEffects(
  effects: readonly Effect[],
  frame: number,
  fps: FrameRate,
): ResolvedEffect[] {
  const number = (track: Animatable<number>, min: number, max: number) =>
    clamp(sampleNumber(track, frame, fps), min, max);
  const color = (track: Animatable<Color>) => sampleColor(track, frame, fps);
  const unit = (track: Animatable<number>) => sampleUnit(track, frame, fps);
  const radius = (track: Animatable<number>) => number(track, 0, MAX_EFFECT_RADIUS);
  const correction = (track: Animatable<number>) => number(track, -1, 1);
  const out: ResolvedEffect[] = [];
  for (const effect of effects) {
    if (effect.enabled === false) continue;
    const { type } = effect;
    switch (type) {
      case "gaussian-blur":
        out.push({ type, radius: radius(effect.radius) });
        break;
      case "drop-shadow": {
        const [x, y] = samplePoint(effect.offset, frame, fps);
        out.push({
          type,
          radius: radius(effect.radius),
          offset: [
            clamp(x, -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET),
            clamp(y, -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET),
          ],
          color: color(effect.color),
          opacity: unit(effect.opacity),
        });
        break;
      }
      case "glow":
        out.push({
          type,
          radius: radius(effect.radius),
          color: color(effect.color),
          intensity: unit(effect.intensity),
        });
        break;
      case "brightness-contrast":
        out.push({
          type,
          brightness: correction(effect.brightness),
          contrast: correction(effect.contrast),
        });
        break;
      case "hue-saturation":
        out.push({
          type,
          hue: number(effect.hue, -360, 360),
          saturation: correction(effect.saturation),
        });
        break;
      case "tint":
        out.push({
          type,
          black: color(effect.black),
          white: color(effect.white),
          amount: unit(effect.amount),
        });
        break;
      case "fill":
        out.push({ type, color: color(effect.color), amount: unit(effect.amount) });
        break;
    }
  }
  return out;
}
