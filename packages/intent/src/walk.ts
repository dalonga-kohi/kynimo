import {
  type FrameRate,
  type Keyframe,
  type Layer,
  type Op,
  springSettleFrames,
  TRANSFORM_PROPERTIES,
  type TransformProperty,
} from "@kynimo/scene";
import { type InputPath, IntentError } from "./errors.js";

type Json = unknown;
type Obj = Record<string, Json>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Layer fields that hold no animatable tracks (free-form data or metadata). */
const SKIPPED = new Set(["props", "markers", "editor"]);

/** Layer fields whose tracks an op can write back. */
const WRITABLE = new Set([
  "transform",
  "masks",
  "effects",
  "generator",
  "behaviors",
  "animators",
  "contents",
  "transition",
  "deform",
]);

export interface KeyframeTrack {
  /** Path from the layer to the `keyframes` list, e.g. `["transform", "position", "keyframes"]`. */
  path: (string | number)[];
  keyframes: Keyframe<unknown>[];
}

/** `transform.position` for a track path: the path without its trailing `keyframes`. */
export const trackName = (path: readonly (string | number)[]): string =>
  path.slice(0, -1).join(".");

const unwritable = (path: InputPath): never => {
  throw new IntentError(
    [],
    `${path.slice(0, -1).join(".")} has keyframes that no operation can write back; this layer can't be restructured in time by an intent tool`,
  );
};

/**
 * Rebuilds `node` with every keyframe list passed through `fn`. Tracks are found structurally (any
 * object with a `keyframes` array), as the project check does, so no animatable field is missed.
 */
function rewrite(
  node: Json,
  path: InputPath,
  fn: (keyframes: Keyframe<unknown>[], path: InputPath) => Keyframe<unknown>[],
): Json {
  if (Array.isArray(node)) return node.map((item, i) => rewrite(item, [...path, i], fn));
  if (!isObject(node)) return node;
  const out: Obj = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "keyframes" && Array.isArray(value)) {
      if (!WRITABLE.has(String(path[0]))) unwritable([...path, key]);
      out[key] = fn(value as Keyframe<unknown>[], [...path, key]);
    } else if (path.length === 0 && SKIPPED.has(key)) {
      out[key] = value;
    } else {
      out[key] = rewrite(value, [...path, key], fn);
    }
  }
  return out;
}

/** Every keyframe list in the layer's animatable fields, in field order. Throws `IntentError` (no path) on a field no op can write. */
export function listKeyframeTracks(layer: Layer): KeyframeTrack[] {
  const tracks: KeyframeTrack[] = [];
  rewrite(layer, [], (keyframes, path) => {
    tracks.push({ path, keyframes });
    return keyframes;
  });
  return tracks;
}

/**
 * Rewrites the `frame` of every keyframe of the layer's animatable fields: transform tracks
 * (including separate X/Y), mask paths, feather, opacity and expansion, text animator selectors
 * and properties, shape contents (recursively), effects, generators, behavior tracks, transition
 * parameters and puppet pins. Times stay in layer time.
 * Throws `IntentError` (no path) if a keyframed field exists that no operation can write back
 * (a text layer's font size, an audio layer's volume, ...), instead of skipping it.
 */
export function mapLayerKeyframes(layer: Layer, fn: (frame: number) => number): Layer {
  return rewrite(layer, [], (keyframes) =>
    keyframes.map((k) => ({ ...k, frame: fn(k.frame) })),
  ) as Layer;
}

function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** The changed keys of two objects, as a patch of the `after` values. */
function changedFields(before: Obj, after: Obj, keys: readonly string[]): Obj {
  const set: Obj = {};
  for (const k of keys) if (!deepEqual(before[k], after[k])) set[k] = after[k];
  return set;
}

/**
 * The operations that turn `before` into `after`, two versions of one layer whose keyframes (and
 * only those) differ.
 */
export function diffLayerOps(before: Layer, after: Layer): Op[] {
  const ops: Op[] = [];
  const layer = before.id;
  if ("transform" in before && "transform" in after) {
    for (const property of TRANSFORM_PROPERTIES as readonly TransformProperty[]) {
      if (!deepEqual(before.transform[property], after.transform[property]))
        ops.push({
          op: "setTransformTrack",
          layer,
          property,
          track: after.transform[property],
        } as Op);
    }
  }
  if ("masks" in before && "masks" in after) {
    before.masks.forEach((mask, i) => {
      const next = after.masks[i];
      if (next === undefined) return;
      const set = changedFields(mask, next, ["path", "feather", "opacity", "expansion"]);
      if (Object.keys(set).length > 0)
        ops.push({ op: "updateMask", layer, mask: mask.id, set } as Op);
    });
  }
  if ("behaviors" in before && "behaviors" in after) {
    before.behaviors.forEach((behavior, i) => {
      const next = after.behaviors[i];
      if (next === undefined) return;
      const keys = Object.keys(next).filter((k) => k !== "id" && k !== "type");
      const set = changedFields(behavior, next, keys);
      if (Object.keys(set).length > 0)
        ops.push({ op: "updateBehavior", layer, behavior: behavior.id, set } as Op);
    });
  }
  if ("effects" in before && "effects" in after && !deepEqual(before.effects, after.effects))
    ops.push({ op: "setEffects", layer, effects: after.effects });
  if (
    "transition" in before &&
    "transition" in after &&
    !deepEqual(before.transition, after.transition)
  )
    ops.push({ op: "updateLayer", layer, set: { transition: after.transition } });
  if ("deform" in before && "deform" in after && !deepEqual(before.deform, after.deform))
    ops.push({ op: "updateLayer", layer, set: { deform: after.deform } });
  if (before.type === "generator" && after.type === "generator") {
    if (!deepEqual(before.generator, after.generator))
      ops.push({ op: "setGenerator", layer, generator: after.generator });
  }
  if (before.type === "text" && after.type === "text") {
    if (!deepEqual(before.animators, after.animators))
      ops.push({ op: "setTextAnimators", layer, animators: after.animators });
  }
  if (before.type === "shape" && after.type === "shape") {
    if (!deepEqual(before.contents, after.contents))
      ops.push({ op: "setShapeContents", layer, contents: after.contents });
  }
  return ops;
}

/**
 * Refuses a keyframe move that makes two keyframes of a track collide or swap, or that squeezes a
 * spring segment below its settle time. `before` and `after` are the layer's tracks before and
 * after the move (same order, as listed by {@link listKeyframeTracks}); the hints say what the
 * caller should do about it (a function gets the factor by which the segment must stay as long).
 */
export function checkMovedTracks(
  layer: Layer,
  before: KeyframeTrack[],
  after: KeyframeTrack[],
  fps: FrameRate,
  path: InputPath,
  hint: {
    collision: string;
    spring: string | ((needed: number) => string);
    /** Appended after the frames a message names (e.g. when they are on a layer slid by the same call). */
    frameNote?: string;
  },
): void {
  before.forEach((track, t) => {
    const next = after[t]?.keyframes ?? [];
    const name = `${layer.id}.${trackName(track.path)}`;
    for (let j = 1; j < next.length; j++) {
      const prev = next[j - 1];
      const cur = next[j];
      if (prev === undefined || cur === undefined) continue;
      if (cur.frame <= prev.frame)
        throw new IntentError(
          path,
          `${name}: keyframes at frames ${(track.keyframes[j - 1]?.frame ?? 0) + layer.startFrame} and ${(track.keyframes[j]?.frame ?? 0) + layer.startFrame}${hint.frameNote ?? ""} would ${cur.frame === prev.frame ? "land on the same frame" : "change order"}; ${hint.collision}`,
        );
    }
    for (let j = 0; j + 1 < next.length; j++) {
      const cur = next[j];
      const following = next[j + 1];
      if (cur?.interpolation.type !== "spring" || following === undefined) continue;
      const settle = springSettleFrames(cur.interpolation, fps);
      const gap = following.frame - cur.frame;
      if (gap >= settle) continue;
      const original = (track.keyframes[j + 1]?.frame ?? 0) - (track.keyframes[j]?.frame ?? 0);
      const needed = Math.ceil((settle / original) * 100) / 100;
      throw new IntentError(
        path,
        `${name}: the spring at frame ${cur.frame + layer.startFrame}${hint.frameNote ?? ""} needs ${settle} frames to settle but the next keyframe is ${gap} frames later; ${
          typeof hint.spring === "function" ? hint.spring(needed) : hint.spring
        }`,
      );
    }
  });
}
