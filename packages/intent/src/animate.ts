import { sampleNumber, samplePosition, sampleVector } from "@kynimo/engine";
import {
  type Animatable,
  type Interpolation,
  isVectorTransformProperty,
  type Keyframe,
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
import { IntentError } from "./errors.js";
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

type Value = number | Vec2;

const equal = (a: Value, b: Value): boolean =>
  typeof a === "number" || typeof b === "number" ? a === b : a[0] === b[0] && a[1] === b[1];

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

interface Endpoints {
  value?: Value;
  by?: Value;
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

function sample(
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
  let frames: number;
  if (easing.type === "spring") {
    if (input.duration !== undefined)
      throw new IntentError(
        ["duration"],
        "a spring's settle time sets the duration; drop duration or use a bezier easing",
      );
    frames = springSettleFrames(easing, fps);
  } else {
    frames = Math.max(1, durationFrames(input.duration ?? "base", pack, fps));
  }

  const ops: Op[] = [];
  const starts: number[] = [];
  for (const { layer, path } of targets) {
    if (!("transform" in layer))
      throw new IntentError(path, `a ${layer.type} layer has no transform to animate`);
    const track = layer.transform[property] as
      | Animatable<number>
      | Animatable<Vec2>
      | PositionTrack;
    if ("separate" in track)
      throw new IntentError(path, "position has separate X/Y tracks; set it with set_keyframes");
    const compositionStart = input.start ?? layer.inFrame;
    const s = compositionStart - layer.startFrame;
    const e = s + frames;
    starts.push(compositionStart);

    const resolveEnd = (end: Endpoints, at: number): Value => {
      if (end.value !== undefined) return end.value;
      const current = sample(property, track, at, fps);
      return end.by !== undefined ? add(current, end.by) : current;
    };
    const fromValue = resolveEnd(from, s);
    const toValue_ = resolveEnd(to, e);
    if (equal(fromValue, toValue_))
      throw new IntentError(
        [input.to !== undefined ? "to" : "from"],
        "from and to are equal; nothing would move",
      );

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
    ops.push({
      op: "setTransformTrack",
      layer: layer.id,
      property,
      track: { keyframes },
    } as Op);
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
