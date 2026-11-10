import { z } from "zod";
import { animatable, PositionTrackSchema } from "./keyframes.js";
import { NumberSchema, UnitIntervalSchema, Vec2Schema } from "./primitives.js";

export { animatable } from "./keyframes.js";

/**
 * 2D transform. Scale is a ratio (1 = 100%, negative flips). Angles are degrees.
 * Opacity is 0..1.
 */
export const TransformSchema = z.strictObject({
  anchorPoint: animatable(Vec2Schema),
  position: PositionTrackSchema,
  scale: animatable(Vec2Schema),
  rotation: animatable(NumberSchema),
  skew: animatable(z.number().min(-85).max(85)),
  opacity: animatable(UnitIntervalSchema),
});
export type Transform = z.infer<typeof TransformSchema>;

/** The transform's properties, in the order the schema lists them. */
export const TRANSFORM_PROPERTIES = [
  "anchorPoint",
  "position",
  "scale",
  "rotation",
  "skew",
  "opacity",
] as const satisfies readonly (keyof Transform)[];
export type TransformProperty = (typeof TRANSFORM_PROPERTIES)[number];
