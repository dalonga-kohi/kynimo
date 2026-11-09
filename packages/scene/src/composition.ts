import { z } from "zod";
import { CompositionIdSchema } from "./ids.js";
import { LayerSchema } from "./layer.js";
import {
  MAX_COMPOSITION_SIZE,
  MAX_DURATION_FRAMES,
  MAX_FPS,
  MAX_LAYERS,
  MIN_FPS,
} from "./limits.js";
import { ColorSchema, MAX_MARKERS, MarkerSchema, NameSchema } from "./primitives.js";

/** Positive integer num and den with a rate between MIN_FPS and MAX_FPS. Safe on any input. */
export const isValidFrameRate = (fps: { num: number; den: number }): boolean =>
  Number.isInteger(fps.num) &&
  Number.isInteger(fps.den) &&
  fps.num > 0 &&
  fps.den > 0 &&
  fps.num / fps.den >= MIN_FPS &&
  fps.num / fps.den <= MAX_FPS;

/** Frame rate as an exact ratio, e.g. 30/1 or 30000/1001. */
export const FrameRateSchema = z
  .strictObject({ num: z.number().int().positive(), den: z.number().int().positive() })
  .refine(isValidFrameRate, `frame rate must be between ${MIN_FPS} and ${MAX_FPS} fps`);

export const CompositionSchema = z.strictObject({
  id: CompositionIdSchema,
  name: NameSchema,
  width: z.number().int().min(1).max(MAX_COMPOSITION_SIZE),
  height: z.number().int().min(1).max(MAX_COMPOSITION_SIZE),
  /** Frame rate as an exact ratio, e.g. 30/1 or 30000/1001. All time is integer frames at this rate. */
  fps: FrameRateSchema,
  durationFrames: z.number().int().positive().max(MAX_DURATION_FRAMES),
  /** `null` is transparent. */
  background: ColorSchema.nullable(),
  /** Top-first: index 0 is drawn on top. */
  layers: z.array(LayerSchema).max(MAX_LAYERS),
  markers: z.array(MarkerSchema).max(MAX_MARKERS),
});
export type Composition = z.infer<typeof CompositionSchema>;
