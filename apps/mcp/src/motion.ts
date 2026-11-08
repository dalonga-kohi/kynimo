import { type Composition, type Layer, springSettleFrames } from "@kynimo/scene";
import { type RawKeyframe, walkTracks } from "./summary.js";

/** Segments one `describe_motion` reply lists; the rest are counted in `truncated_segments`. */
export const MAX_MOTION_SEGMENTS = 1000;

/** Values longer than this (as JSON) are summarized instead of listed. */
const MAX_VALUE_CHARS = 160;

export type Easing =
  | { type: "linear" }
  | { type: "hold" }
  | { type: "bezier"; x1: number; y1: number; x2: number; y2: number }
  | { type: "spring"; damping: number; response: number; settle_frame: number };

export interface MotionSegment {
  /** Composition frames. The value moves from `from` at `from_frame` to `to` at `to_frame`. */
  from_frame: number;
  to_frame: number;
  from_seconds: number;
  to_seconds: number;
  from: unknown;
  to: unknown;
  easing: Easing;
  /** Position only: the segment follows a curved spatial path. */
  curved?: true;
  /** The segment lies entirely outside the layer's in/out range, so it never shows. */
  outside_layer_range?: true;
}

export interface MotionProperty {
  property: string;
  /** Before its first keyframe and after its last, a property holds that keyframe's value. */
  segments: MotionSegment[];
  /** One keyframe: the property is constant at this value. */
  constant?: unknown;
}

export interface LayerMotion {
  id: string;
  name: string;
  type: Layer["type"];
  /** Top-first: 0 is drawn on top. */
  index: number;
  parent: string | null;
  hidden: boolean;
  /** Composition frames the layer shows on: in_frame up to (not including) out_frame. */
  in_frame: number;
  out_frame: number;
  /** Precomp layers: composition frame f shows frame f - time_offset of `composition`. */
  precomp?: { composition: string; time_offset: number };
  properties: MotionProperty[];
}

export interface MotionDescription {
  composition: string;
  fps: { num: number; den: number };
  duration_frames: number;
  duration_seconds: number;
  /** The window described, in composition frames (inclusive). */
  from_frame: number;
  to_frame: number;
  layers: LayerMotion[];
  truncated_segments: number;
}

export interface MotionOptions {
  /** Only these layers (ids), in stacking order. Default: every layer. */
  layers?: ReadonlySet<string>;
  from_frame?: number;
  to_frame?: number;
  maxSegments?: number;
}

const round = (n: number, digits = 3) => {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** A keyframe value as listed: numbers rounded, paths and other large values summarized. */
export function summarizeValue(value: unknown): unknown {
  if (typeof value === "number") return round(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const vertices = (value as { vertices?: unknown }).vertices;
    if (Array.isArray(vertices))
      return {
        path: `${vertices.length} vertices`,
        closed: (value as { closed?: unknown }).closed === true,
      };
  }
  const rounded = roundDeep(value);
  const json = JSON.stringify(rounded) ?? "null";
  return json.length > MAX_VALUE_CHARS
    ? { summary: `${json.length} characters; get_layer shows the value` }
    : rounded;
}

function roundDeep(value: unknown): unknown {
  if (typeof value === "number") return round(value);
  if (Array.isArray(value)) return value.map(roundDeep);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundDeep(v)]));
  return value;
}

function easing(kf: RawKeyframe, fps: Composition["fps"]): Easing {
  const i = kf.interpolation;
  switch (i.type) {
    case "hold":
      return { type: "hold" };
    case "bezier":
      return {
        type: "bezier",
        x1: i.x1 as number,
        y1: i.y1 as number,
        x2: i.x2 as number,
        y2: i.y2 as number,
      };
    case "spring": {
      const spring = { damping: i.damping as number, response: i.response as number };
      return { type: "spring", ...spring, settle_frame: springSettleFrames(spring, fps) };
    }
    default:
      return { type: "linear" };
  }
}

/** A non-zero spatial tangent: `a`'s out tangent or `b`'s in tangent bends the path between them. */
const tangent = (kf: RawKeyframe, side: "inTangent" | "outTangent"): boolean => {
  const t = (kf.spatial as Record<string, unknown> | undefined)?.[side];
  return Array.isArray(t) && t.some((c) => c !== 0);
};

/**
 * What animates when in one composition, from the keyframes themselves: per layer and property,
 * segments between consecutive keyframes in composition frames and seconds, with their values and
 * easing. Exact and cheap; nothing is evaluated or rendered.
 */
export function describeMotion(comp: Composition, options: MotionOptions = {}): MotionDescription {
  const fps = comp.fps;
  const seconds = (frame: number) => round((frame * fps.den) / fps.num);
  const from = options.from_frame ?? 0;
  const to = options.to_frame ?? comp.durationFrames - 1;
  const max = options.maxSegments ?? MAX_MOTION_SEGMENTS;
  let listed = 0;
  let truncated = 0;

  const layers: LayerMotion[] = [];
  comp.layers.forEach((layer, index) => {
    if (options.layers && !options.layers.has(layer.id)) return;
    // Layers not on screen during the window are left out.
    if (layer.outFrame <= from || layer.inFrame > to) return;
    const properties: MotionProperty[] = [];
    walkTracks(layer, (property, keyframes) => {
      const first = keyframes[0] as RawKeyframe;
      if (keyframes.length === 1) {
        properties.push({ property, segments: [], constant: summarizeValue(first.value) });
        return;
      }
      const segments: MotionSegment[] = [];
      for (let k = 0; k + 1 < keyframes.length; k++) {
        const a = keyframes[k] as RawKeyframe;
        const b = keyframes[k + 1] as RawKeyframe;
        const fromFrame = layer.startFrame + a.frame;
        const toFrame = layer.startFrame + b.frame;
        if (toFrame < from || fromFrame > to) continue;
        if (listed >= max) {
          truncated++;
          continue;
        }
        listed++;
        segments.push({
          from_frame: fromFrame,
          to_frame: toFrame,
          from_seconds: seconds(fromFrame),
          to_seconds: seconds(toFrame),
          from: summarizeValue(a.value),
          to: summarizeValue(b.value),
          easing: easing(a, fps),
          ...(tangent(a, "outTangent") || tangent(b, "inTangent") ? { curved: true as const } : {}),
          ...(toFrame < layer.inFrame || fromFrame >= layer.outFrame
            ? { outside_layer_range: true as const }
            : {}),
        });
      }
      if (segments.length > 0) properties.push({ property, segments });
    });
    layers.push({
      id: layer.id,
      name: layer.name,
      type: layer.type,
      index,
      parent: "parent" in layer ? layer.parent : null,
      hidden: layer.hidden,
      in_frame: layer.inFrame,
      out_frame: layer.outFrame,
      ...(layer.type === "precomp"
        ? { precomp: { composition: layer.compositionId, time_offset: layer.startFrame } }
        : {}),
      properties,
    });
  });

  return {
    composition: comp.id,
    fps,
    duration_frames: comp.durationFrames,
    duration_seconds: seconds(comp.durationFrames),
    from_frame: from,
    to_frame: to,
    layers,
    truncated_segments: truncated,
  };
}
