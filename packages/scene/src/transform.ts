import { z } from "zod";
import { NumberSchema, UnitIntervalSchema, Vec2Schema } from "./primitives.js";

/**
 * Every animatable property is stored wrapped: `{ value }` today. Keyframe tracks
 * (schema v1 part 2) widen the wrapper to `{ value } | { keyframes }`, so documents
 * written now stay valid. Discrete properties (enums, booleans, counts) are not wrapped.
 */
export const animatable = <T extends z.ZodType>(value: T) => z.strictObject({ value });

/**
 * 2D transform. Scale is a ratio (1 = 100%, negative flips). Angles are degrees.
 * Opacity is 0..1.
 */
export const TransformSchema = z.strictObject({
  anchorPoint: animatable(Vec2Schema),
  position: animatable(Vec2Schema),
  scale: animatable(Vec2Schema),
  rotation: animatable(NumberSchema),
  skew: animatable(z.number().min(-85).max(85)),
  opacity: animatable(UnitIntervalSchema),
});
export type Transform = z.infer<typeof TransformSchema>;
