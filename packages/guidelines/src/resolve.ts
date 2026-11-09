import type { FrameRate, Interpolation } from "@kynimo/scene";
import {
  COLOR_ROLES,
  DISTANCE_TOKENS,
  DURATION_TOKENS,
  type DurationToken,
  EASING_TOKENS,
  type EasingToken,
  type GuidelinePack,
  REFERENCE_HEIGHT,
  SPACING_TOKENS,
  SPRING_TOKENS,
  type SpringToken,
  STAGGER_TOKENS,
  type StaggerToken,
  TYPE_ROLES,
} from "./pack.js";

/**
 * Milliseconds as whole frames at a frame rate: rounded to the nearest frame, half up, in
 * integer arithmetic so every platform agrees. A non-zero time is at least one frame.
 */
export function millisecondsToFrames(ms: number, fps: FrameRate): number {
  if (ms <= 0) return 0;
  const denominator = fps.den * 1000;
  return Math.max(1, Math.floor((2 * ms * fps.num + denominator) / (2 * denominator)));
}

export const durationFrames = (pack: GuidelinePack, token: DurationToken, fps: FrameRate): number =>
  millisecondsToFrames(pack.motion.durations[token], fps);

export const staggerFrames = (pack: GuidelinePack, token: StaggerToken, fps: FrameRate): number =>
  millisecondsToFrames(pack.motion.stagger[token], fps);

/** The keyframe interpolation an easing or spring token stands for. */
export function interpolationFor(
  pack: GuidelinePack,
  token: EasingToken | SpringToken,
): Interpolation {
  if ((SPRING_TOKENS as readonly string[]).includes(token)) {
    return { type: "spring", ...pack.motion.springs[token as SpringToken] };
  }
  return pack.motion.easings[token as EasingToken];
}

/**
 * Factor from the pack's reference pixels to a composition's pixels. It follows the shorter
 * side, so type keeps its weight in the frame on vertical and square videos.
 */
export const scaleFor = (composition: { width: number; height: number }): number =>
  Math.min(composition.width, composition.height) / REFERENCE_HEIGHT;

export interface TokenEntry {
  /** Dotted name, e.g. `motion.easings.enter`. */
  name: string;
  group: "color" | "type" | "layout" | "motion";
  value: unknown;
  unit?: "ms" | "px@1080" | "fraction";
}

/** Every token of a pack as a flat, stably ordered list: what `get_tokens` and the token resource return. */
export function listTokens(pack: GuidelinePack): TokenEntry[] {
  const out: TokenEntry[] = [];
  for (const r of COLOR_ROLES)
    out.push({ name: `color.${r}`, group: "color", value: pack.color[r] });
  for (const r of TYPE_ROLES) out.push({ name: `type.${r}`, group: "type", value: pack.type[r] });
  out.push(
    { name: "layout.margin", group: "layout", value: pack.layout.margin, unit: "fraction" },
    { name: "layout.columns", group: "layout", value: pack.layout.columns },
    { name: "layout.gutter", group: "layout", value: pack.layout.gutter, unit: "px@1080" },
    {
      name: "layout.cornerRadius",
      group: "layout",
      value: pack.layout.cornerRadius,
      unit: "px@1080",
    },
  );
  for (const t of SPACING_TOKENS) {
    out.push({
      name: `layout.spacing.${t}`,
      group: "layout",
      value: pack.layout.spacing[t],
      unit: "px@1080",
    });
  }
  const { motion } = pack;
  for (const t of DURATION_TOKENS) {
    out.push({
      name: `motion.durations.${t}`,
      group: "motion",
      value: motion.durations[t],
      unit: "ms",
    });
  }
  for (const t of EASING_TOKENS) {
    out.push({ name: `motion.easings.${t}`, group: "motion", value: motion.easings[t] });
  }
  for (const t of SPRING_TOKENS) {
    out.push({ name: `motion.springs.${t}`, group: "motion", value: motion.springs[t] });
  }
  for (const t of STAGGER_TOKENS) {
    out.push({
      name: `motion.stagger.${t}`,
      group: "motion",
      value: motion.stagger[t],
      unit: "ms",
    });
  }
  for (const t of DISTANCE_TOKENS) {
    out.push({
      name: `motion.distance.${t}`,
      group: "motion",
      value: motion.distance[t],
      unit: "px@1080",
    });
  }
  out.push({ name: "motion.enterScale", group: "motion", value: motion.enterScale });
  return out;
}
