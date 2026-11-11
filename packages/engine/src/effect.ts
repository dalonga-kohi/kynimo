import {
  type Animatable,
  type Color,
  type Effect,
  type FrameRate,
  MAX_ABERRATION,
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
  | { type: "fill"; color: Rgba; amount: number }
  | { type: "vignette"; amount: number; radius: number; feather: number; color: Rgba }
  | {
      type: "grain";
      amount: number;
      size: number;
      seed: number;
      /** The layer-local frame that seeds the pattern: its floor when animated, 0 otherwise. */
      frame: number;
      monochrome: boolean;
    }
  | { type: "chromatic-aberration"; amount: number }
  | { type: "posterize"; levels: number }
  | {
      type: "scanlines";
      amount: number;
      spacing: number;
      thickness: number;
      /** The scroll offset reduced into [0, spacing). */
      offset: number;
      color: Rgba;
    };

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
      case "vignette":
        out.push({
          type,
          amount: unit(effect.amount),
          radius: number(effect.radius, 0, 2),
          feather: number(effect.feather, 0.01, 2),
          color: color(effect.color),
        });
        break;
      case "grain":
        out.push({
          type,
          amount: unit(effect.amount),
          size: effect.size,
          seed: effect.seed,
          frame: effect.animated ? Math.floor(frame) : 0,
          monochrome: effect.monochrome,
        });
        break;
      case "chromatic-aberration":
        out.push({ type, amount: number(effect.amount, 0, MAX_ABERRATION) });
        break;
      case "posterize":
        out.push({ type, levels: Math.round(number(effect.levels, 2, 32)) });
        break;
      case "scanlines": {
        const spacing = number(effect.spacing, 2, 64);
        const scroll = number(effect.offset, -8192, 8192);
        // Float64 remainder of a floored division stays in [0, spacing) even for negative scrolls.
        let offset = scroll - spacing * Math.floor(scroll / spacing);
        if (offset >= spacing) offset = 0;
        out.push({
          type,
          amount: unit(effect.amount),
          spacing,
          thickness: unit(effect.thickness),
          offset,
          color: color(effect.color),
        });
        break;
      }
    }
  }
  return out;
}
