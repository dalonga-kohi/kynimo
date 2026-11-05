import { z } from "zod";
import { MarkerIdSchema } from "./ids.js";

/** Time is integer frames at the composition's frame rate. Seconds exist only at the API edge. */
export const FrameSchema = z.number().int();
export const DurationFramesSchema = z.number().int().nonnegative();

/** Finite numbers only: Zod rejects NaN and ±Infinity, which JSON cannot carry anyway. */
export const NumberSchema = z.number();
export const NonNegativeSchema = z.number().nonnegative();
export const PositiveSchema = z.number().positive();
export const UnitIntervalSchema = z.number().min(0).max(1);

export const Vec2Schema = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2Schema>;

/** sRGB hex, lowercase so equal colors have one canonical spelling: `#rrggbb` or `#rrggbbaa`. */
export const ColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/, "must be lowercase hex: #rrggbb or #rrggbbaa");
export type Color = z.infer<typeof ColorSchema>;

export const MAX_MARKERS = 1000;

export const NameSchema = z.string().min(1).max(200);

/** Maximum nesting of JSON values (component props). Deeper input is rejected, never recursed into. */
export const MAX_JSON_DEPTH = 16;
export const MAX_PROPS = 200;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const jsonAtDepth = (depth: number): z.ZodType<Json> => {
  const scalars = [z.string(), z.number(), z.boolean(), z.null()] as const;
  if (depth === 0) return z.union(scalars);
  const inner = jsonAtDepth(depth - 1);
  return z.union([...scalars, z.array(inner).max(1000), z.record(z.string(), inner)]);
};
export const JsonSchema: z.ZodType<Json> = jsonAtDepth(MAX_JSON_DEPTH);

export const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be a semantic version like 1.0.0");

/**
 * A named point (or span) in time. Composition markers are in composition frames.
 * Layer markers are in layer time and move with the layer: composition frame = layer.startFrame + frame.
 * Beat markers are markers on audio layers.
 */
export const MarkerSchema = z.strictObject({
  id: MarkerIdSchema,
  frame: FrameSchema,
  durationFrames: DurationFramesSchema,
  name: z.string().max(200),
});
export type Marker = z.infer<typeof MarkerSchema>;
