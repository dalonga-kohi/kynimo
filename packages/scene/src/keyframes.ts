import { z } from "zod";
import type { Vec2 } from "./primitives.js";
import { FrameSchema, NumberSchema, Vec2Schema } from "./primitives.js";

export const MAX_KEYFRAMES = 2000;

/**
 * How a keyframe moves toward the next one. The interpolation belongs to the outgoing
 * keyframe; on the last keyframe it has no effect.
 * - `bezier`: a cubic-bezier easing curve on normalized time, like CSS (x in 0..1, y may overshoot).
 * - `spring`: runs to the next keyframe's value and lasts `springSettleFrames` frames
 *   (see spring.ts), so the next keyframe must sit at or after the settle frame.
 */
export const InterpolationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("linear") }),
  z.strictObject({ type: z.literal("hold") }),
  z.strictObject({
    type: z.literal("bezier"),
    x1: z.number().min(0).max(1),
    y1: z.number().min(-5).max(5),
    x2: z.number().min(0).max(1),
    y2: z.number().min(-5).max(5),
  }),
  z.strictObject({
    type: z.literal("spring"),
    damping: z.number().min(0.1).max(10),
    response: z.number().min(0.05).max(10),
  }),
]);
export type Interpolation = z.infer<typeof InterpolationSchema>;

/** Keyframe times are in layer time, like layer markers: composition frame = layer.startFrame + frame. */
export interface Keyframe<T> {
  frame: number;
  value: T;
  interpolation: Interpolation;
}

/** A property is either constant (`value`) or driven by keyframes. */
export type Animatable<T> = { value: T } | { keyframes: Keyframe<T>[] };

export type KeyframeCheck<T> = (keyframes: Keyframe<T>[], ctx: z.RefinementCtx) => void;

const exactlyOne = (keys: Record<string, unknown>, ctx: z.RefinementCtx, names: string[]) => {
  const present = names.filter((n) => keys[n] !== undefined);
  if (present.length !== 1)
    ctx.addIssue({
      code: "custom",
      message: `set exactly one of ${names.map((n) => `'${n}'`).join(", ")} (found ${present.length === 0 ? "none" : present.map((n) => `'${n}'`).join(", ")})`,
    });
};

const keyframeArray = <T extends z.ZodType>(
  value: T,
  extra: z.ZodRawShape,
  check?: KeyframeCheck<z.output<T>>,
) =>
  z
    .array(
      z.strictObject({ frame: FrameSchema, value, interpolation: InterpolationSchema, ...extra }),
    )
    .min(1)
    .max(MAX_KEYFRAMES)
    .superRefine((keyframes, ctx) => {
      keyframes.forEach((kf, i) => {
        const prev = keyframes[i - 1];
        if (prev !== undefined && kf.frame <= prev.frame)
          ctx.addIssue({
            code: "custom",
            path: [i, "frame"],
            message: `keyframe frames must be strictly increasing (frame ${kf.frame} follows ${prev.frame}); move or remove one`,
          });
      });
      check?.(keyframes as unknown as Keyframe<z.output<T>>[], ctx);
    });

/**
 * An animatable property: `{ value }` or `{ keyframes }`. Written as one object with optional
 * keys plus an exactly-one check (not a union) so errors keep their precise path.
 */
export const animatable = <T extends z.ZodType>(
  value: T,
  check?: KeyframeCheck<z.output<T>>,
): z.ZodType<Animatable<z.output<T>>> =>
  z
    .strictObject({
      value: value.optional(),
      keyframes: keyframeArray(value, {}, check).optional(),
    })
    .superRefine((track, ctx) =>
      exactlyOne(track, ctx, ["value", "keyframes"]),
    ) as unknown as z.ZodType<Animatable<z.output<T>>>;

/** Spatial tangents of a position keyframe, as offsets from the keyframe value (motion path handles). */
export interface SpatialHandles {
  inTangent: Vec2;
  outTangent: Vec2;
}
export type PositionKeyframe = Keyframe<Vec2> & { spatial?: SpatialHandles };

/**
 * Position is the one property that can be animated three ways: constant, keyframed (optionally
 * along a spatial bezier motion path), or split into separate X and Y tracks.
 */
export type PositionTrack =
  | { value: Vec2 }
  | { keyframes: PositionKeyframe[] }
  | { separate: { x: Animatable<number>; y: Animatable<number> } };

export const PositionTrackSchema = z
  .strictObject({
    value: Vec2Schema.optional(),
    keyframes: keyframeArray(Vec2Schema, {
      spatial: z.strictObject({ inTangent: Vec2Schema, outTangent: Vec2Schema }).optional(),
    }).optional(),
    separate: z
      .strictObject({ x: animatable(NumberSchema), y: animatable(NumberSchema) })
      .optional(),
  })
  .superRefine((track, ctx) =>
    exactlyOne(track, ctx, ["value", "keyframes", "separate"]),
  ) as unknown as z.ZodType<PositionTrack>;
