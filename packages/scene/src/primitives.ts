import { z } from "zod";

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

export const NameSchema = z.string().min(1).max(200);

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);

/** A named point (or span) in time on a composition or a layer. Beat markers are markers on audio layers. */
export const MarkerSchema = z.strictObject({
  frame: FrameSchema,
  durationFrames: DurationFramesSchema,
  name: z.string().max(200),
});
export type Marker = z.infer<typeof MarkerSchema>;
