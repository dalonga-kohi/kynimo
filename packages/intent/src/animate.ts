import { sampleNumber, samplePosition, sampleVector } from "@kynimo/engine";
import type { GuidelinePack } from "@kynimo/guidelines";
import {
  type Animatable,
  type FrameRate,
  type Interpolation,
  isVectorTransformProperty,
  type Keyframe,
  type Layer,
  type Op,
  type PositionKeyframe,
  type PositionTrack,
  type Project,
  springSettleFrames,
  TRANSFORM_PROPERTIES,
  type TransformProperty,
  type Vec2,
  Vec2Schema,
} from "@kynimo/scene";
import { z } from "zod";
import { type InputPath, IntentError } from "./errors.js";
import {
  DurationInput,
  durationFrames,
  EasingInput,
  interpolation,
  resolveStyle,
  TargetsInput,
} from "./style.js";
import { resolveTargets, type Target } from "./targets.js";

const Quantity = z.union([z.number(), Vec2Schema]);
const Endpoint = z.union([Quantity, z.strictObject({ by: Quantity })]);

export const AnimateInput = z.strictObject({
  layers: TargetsInput,
  property: z.enum(TRANSFORM_PROPERTIES),
  from: Endpoint.optional(),
  to: Endpoint.optional(),
  start: z.number().int().optional(),
  duration: DurationInput.optional(),
  easing: EasingInput.optional(),
});
export type AnimateInput = z.infer<typeof AnimateInput>;

export interface AnimateResolved {
  /** Composition frame each layer's animation starts at, per target in order. */
  start_frames: number[];
  duration_frames: number;
  easing: Interpolation;
  style: { packId: string; version: string; pinned: boolean };
}

export type Value = number | Vec2;

const equal = (a: Value, b: Value): boolean =>
  typeof a === "number" || typeof b === "number" ? a === b : a[0] === b[0] && a[1] === b[1];

const multiply = (a: Value, b: Value): Value =>
  typeof a === "number" ? a * (b as number) : [a[0] * (b as Vec2)[0], a[1] * (b as Vec2)[1]];

const add = (a: Value, b: Value): Value =>
  typeof a === "number" ? a + (b as number) : [a[0] + (b as Vec2)[0], a[1] + (b as Vec2)[1]];

/** A value of the property's kind; `scale` also takes a number n as `[n, n]`. */
function toValue(property: TransformProperty, raw: unknown, path: (string | number)[]): Value {
  if (isVectorTransformProperty(property)) {
    if (Array.isArray(raw)) return raw as Vec2;
    if (typeof raw === "number" && property === "scale") return [raw, raw];
    throw new IntentError(
      path,
      `${property} takes [x, y]${property === "scale" ? " or a number" : ""}`,
    );
  }
  if (typeof raw === "number") return raw;
  throw new IntentError(path, `${property} takes a single number`);
}

export interface Endpoints {
  value?: Value;
  by?: Value;
  /** Multiplies the current value (componentwise for vectors). */
  times?: Value;
}

function parseEndpoint(
  property: TransformProperty,
  raw: z.infer<typeof Endpoint> | undefined,
  key: "from" | "to",
): Endpoints {
  if (raw === undefined) return {};
  if (typeof raw === "object" && !Array.isArray(raw))
    return { by: toValue(property, raw.by, [key, "by"]) };
  return { value: toValue(property, raw, [key]) };
}

export function sample(
  property: TransformProperty,
  track: Animatable<number> | Animatable<Vec2> | PositionTrack,
  frame: number,
  fps: Target["composition"]["fps"],
): Value {
  if (property === "position")
    return [...samplePosition(track as PositionTrack, frame, fps)] as Vec2;
  if (isVectorTransformProperty(property))
    return [...sampleVector(track as Animatable<Vec2>, frame, fps)] as Vec2;
  return sampleNumber(track as Animatable<number>, frame, fps);
}

export interface TransformWindow {
  /** Composition frame the window opens at. */
  start: number;
  frames: number;
  easing: Interpolation;
  fps: Target["composition"]["fps"];
  /** Where a refusal about the layer itself points. */
  path: InputPath;
  /** Where "from and to are equal" points. */
  equalPath: InputPath;
}

/**
 * One layer's `setTransformTrack`: keyframes inside the window `[start, start + frames]` are
 * replaced by a start and an end keyframe, the ones outside stay. An endpoint that is omitted is
 * the track's current value at that edge; `by` adds to it and `times` multiplies it.
 * Shared by `animate` and the presets.
 */
export function expandTransformTrack(
  layer: Layer,
  property: TransformProperty,
  from: Endpoints,
  to: Endpoints,
  window: TransformWindow,
): Op {
  const { frames, easing, fps } = window;
  if (!("transform" in layer))
    throw new IntentError(window.path, `a ${layer.type} layer has no transform to animate`);
  const track = layer.transform[property] as Animatable<number> | Animatable<Vec2> | PositionTrack;
  if ("separate" in track)
    throw new IntentError(
      window.path,
      "position has separate X/Y tracks; set it with set_keyframes",
    );
  const s = window.start - layer.startFrame;
  const e = s + frames;

  const resolveEnd = (end: Endpoints, at: number): Value => {
    if (end.value !== undefined) return end.value;
    const current = sample(property, track, at, fps);
    if (end.by !== undefined) return add(current, end.by);
    if (end.times !== undefined) return multiply(current, end.times);
    return current;
  };
  const fromValue = resolveEnd(from, s);
  const toValue_ = resolveEnd(to, e);
  if (equal(fromValue, toValue_))
    throw new IntentError(window.equalPath, "from and to are equal; nothing would move");

  const old = "keyframes" in track ? (track.keyframes as Keyframe<Value>[]) : [];
  const kept = old.filter((k) => k.frame < s || k.frame > e);
  const hasLater = kept.some((k) => k.frame > e);
  const lastAtOrBefore = [...old].reverse().find((k) => k.frame <= e);
  const endInterpolation: Interpolation = hasLater
    ? (lastAtOrBefore?.interpolation ?? { type: "linear" })
    : { type: "hold" };
  const keyframes = [
    ...kept.filter((k) => k.frame < s),
    { frame: s, value: fromValue, interpolation: easing },
    { frame: e, value: toValue_, interpolation: endInterpolation },
    ...kept.filter((k) => k.frame > e),
  ] as (Keyframe<Value> | PositionKeyframe)[];
  return { op: "setTransformTrack", layer: layer.id, property, track: { keyframes } } as Op;
}

/** The window length for an easing: a spring's settle time, else the duration (default `fallback`). */
export function windowFrames(
  easing: Interpolation,
  duration: DurationInput | undefined,
  fallback: DurationInput,
  pack: GuidelinePack,
  fps: FrameRate,
  durationPath: InputPath,
): number {
  if (easing.type === "spring") {
    if (duration !== undefined)
      throw new IntentError(
        durationPath,
        "a spring's settle time sets the duration; drop duration or use a bezier easing",
      );
    return springSettleFrames(easing, fps);
  }
  return Math.max(1, durationFrames(duration ?? fallback, pack, fps));
}

/**
 * Expands "move this property over a window" into one `setTransformTrack` per layer. Keyframes
 * inside the window `[start, start + duration]` are replaced by a start and an end keyframe; the
 * ones outside stay. Omitted `from` / `to` are the current animated value at that edge of the
 * window; `{ by }` adds to it.
 */
export function animate(
  doc: Project,
  input: AnimateInput,
): { ops: Op[]; resolved: AnimateResolved } {
  const { pack, ref, pinned } = resolveStyle(doc);
  const targets = resolveTargets(doc, input.layers);
  const { property } = input;
  if (input.from === undefined && input.to === undefined)
    throw new IntentError([], "set at least one of 'from' and 'to'");
  const from = parseEndpoint(property, input.from, "from");
  const to = parseEndpoint(property, input.to, "to");

  const fps = (targets[0] as Target).composition.fps;
  const easing = interpolation(input.easing ?? "move", pack);
  const frames = windowFrames(easing, input.duration, "base", pack, fps, ["duration"]);

  const ops: Op[] = [];
  const starts: number[] = [];
  for (const { layer, path } of targets) {
    const compositionStart = input.start ?? layer.inFrame;
    starts.push(compositionStart);
    ops.push(
      expandTransformTrack(layer, property, from, to, {
        start: compositionStart,
        frames,
        easing,
        fps,
        path,
        equalPath: [input.to !== undefined ? "to" : "from"],
      }),
    );
  }
  return {
    ops,
    resolved: {
      start_frames: starts,
      duration_frames: frames,
      easing,
      style: { ...ref, pinned },
    },
  };
}
