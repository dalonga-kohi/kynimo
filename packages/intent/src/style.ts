import {
  DISTANCE_TOKENS,
  type DistanceToken,
  DURATION_TOKENS,
  type DurationToken,
  EASING_TOKENS,
  type EasingToken,
  findPack,
  type GuidelinePack,
  interpolationFor,
  keynote,
  millisecondsToFrames,
  SPRING_TOKENS,
  type SpringToken,
  STAGGER_TOKENS,
  type StaggerToken,
  scaleFor,
  durationFrames as tokenDurationFrames,
} from "@kynimo/guidelines";
import {
  type Composition,
  type FrameRate,
  type Interpolation,
  InterpolationSchema,
  LayerSelectorSchema,
  MAX_COMPOSITION_SIZE,
  type Project,
} from "@kynimo/scene";
import { z } from "zod";
import { IntentError } from "./errors.js";

export interface ResolvedStyle {
  pack: GuidelinePack;
  ref: { packId: string; version: string };
  /** False when the document pins no style and Keynote's latest stands in. */
  pinned: boolean;
}

/** The pack whose tokens an intent resolves against: the pinned one, or Keynote's latest when none is pinned. */
export function resolveStyle(doc: Project): ResolvedStyle {
  if (doc.style === null) {
    return { pack: keynote, ref: { packId: keynote.id, version: keynote.version }, pinned: false };
  }
  const pack = findPack(doc.style);
  if (pack === undefined)
    throw new IntentError(
      [],
      `the pinned style ${doc.style.packId}@${doc.style.version} isn't in this build`,
    );
  return { pack, ref: { packId: doc.style.packId, version: doc.style.version }, pinned: true };
}

export const DurationInput = z.union([
  z.enum(DURATION_TOKENS),
  z.number().int().min(1).max(60_000),
]);
export type DurationInput = z.infer<typeof DurationInput>;

export const StaggerOffsetInput = z.union([
  z.enum(STAGGER_TOKENS),
  z.number().int().min(0).max(10_000),
]);
export type StaggerOffsetInput = z.infer<typeof StaggerOffsetInput>;

export const EasingInput = z.union([
  z.enum([...EASING_TOKENS, ...SPRING_TOKENS]),
  InterpolationSchema,
]);
export type EasingInput = z.infer<typeof EasingInput>;

export const DistanceInput = z.union([
  z.enum(DISTANCE_TOKENS),
  z.number().min(0).max(MAX_COMPOSITION_SIZE),
]);
export type DistanceInput = z.infer<typeof DistanceInput>;

export const MAX_TARGETS = 50;
export const TargetsInput = z.union([
  LayerSelectorSchema,
  z.array(LayerSelectorSchema).min(1).max(MAX_TARGETS),
]);
export type TargetsInput = z.infer<typeof TargetsInput>;

/** A duration or stagger offset as frames: a token from the pack, or whole milliseconds. */
export function durationFrames(input: DurationInput, pack: GuidelinePack, fps: FrameRate): number {
  return typeof input === "number"
    ? millisecondsToFrames(input, fps)
    : tokenDurationFrames(pack, input as DurationToken, fps);
}

/** A stagger offset in whole milliseconds. */
export function offsetMilliseconds(input: StaggerOffsetInput, pack: GuidelinePack): number {
  return typeof input === "number" ? input : pack.motion.stagger[input as StaggerToken];
}

/** An easing token, spring token or explicit interpolation as a keyframe interpolation. */
export function interpolation(input: EasingInput, pack: GuidelinePack): Interpolation {
  return typeof input === "string"
    ? interpolationFor(pack, input as EasingToken | SpringToken)
    : input;
}

/** A distance in composition pixels: a token is px at 1080 scaled to the composition, a number is already pixels. */
export function distancePx(
  input: DistanceInput,
  pack: GuidelinePack,
  composition: Pick<Composition, "width" | "height">,
): number {
  return typeof input === "number"
    ? input
    : pack.motion.distance[input as DistanceToken] * scaleFor(composition);
}
