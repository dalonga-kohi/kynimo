import { z } from "zod";
import { animatable, PositionTrackSchema } from "./keyframes.js";
import { NumberSchema, UnitIntervalSchema, Vec2Schema } from "./primitives.js";

export { animatable } from "./keyframes.js";

/**
 * Transform. Scale is a ratio (1 = 100%, negative flips). Angles are degrees. Opacity is 0..1.
 * `rotation` turns about Z (the 2D rotation). `positionZ`, `rotationX` and `rotationY` only act on
 * 3D layers and cameras (ADR-0054); on a 2D layer they are kept but ignored, as in After Effects.
 * They are absent in older addLayer operations, so each defaults to 0.
 */
export const TransformSchema = z.strictObject({
  anchorPoint: animatable(Vec2Schema),
  position: PositionTrackSchema,
  positionZ: animatable(NumberSchema).default({ value: 0 }),
  scale: animatable(Vec2Schema),
  rotation: animatable(NumberSchema),
  rotationX: animatable(NumberSchema).default({ value: 0 }),
  rotationY: animatable(NumberSchema).default({ value: 0 }),
  skew: animatable(z.number().min(-85).max(85)),
  opacity: animatable(UnitIntervalSchema),
});
export type Transform = z.infer<typeof TransformSchema>;

/**
 * The transform of a shape group: the 2D properties only. Groups live inside a layer's own plane,
 * so they have no depth or X/Y rotation.
 */
export const GroupTransformSchema = TransformSchema.omit({
  positionZ: true,
  rotationX: true,
  rotationY: true,
});
export type GroupTransform = z.infer<typeof GroupTransformSchema>;

/** The transform's properties, in the order the schema lists them. */
export const TRANSFORM_PROPERTIES = [
  "anchorPoint",
  "position",
  "positionZ",
  "scale",
  "rotation",
  "rotationX",
  "rotationY",
  "skew",
  "opacity",
] as const satisfies readonly (keyof Transform)[];
export type TransformProperty = (typeof TRANSFORM_PROPERTIES)[number];
