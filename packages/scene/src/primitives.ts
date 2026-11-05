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

const JsonValueSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema).max(1000),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Iterative, so hostile nesting can never overflow the stack. It runs before the recursive
 * schema, so a too-deep value yields one clear, pathed issue instead of a nested union error.
 */
const checkJsonDepth = (value: unknown, ctx: z.RefinementCtx): void => {
  const stack: { value: unknown; depth: number; path: (string | number)[] }[] = [
    { value, depth: 0, path: [] },
  ];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || typeof node.value !== "object" || node.value === null) continue;
    if (node.depth >= MAX_JSON_DEPTH) {
      ctx.addIssue({
        code: "custom",
        path: node.path,
        message: `JSON nesting exceeds ${MAX_JSON_DEPTH} levels; flatten this value`,
        continue: false, // abort: later checks must not walk the unbounded input
      });
      return;
    }
    for (const [key, child] of Object.entries(node.value)) {
      stack.push({
        value: child,
        depth: node.depth + 1,
        path: [...node.path, Array.isArray(node.value) ? Number(key) : key],
      });
    }
  }
};

/** A JSON object (e.g. component props). The depth check runs once for the whole object, then the recursive schema. */
export const JsonObjectSchema: z.ZodType<Record<string, Json>> = z
  .unknown()
  .superRefine(checkJsonDepth)
  .pipe(z.record(z.string(), JsonValueSchema));

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
