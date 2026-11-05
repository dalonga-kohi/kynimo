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

export const CompositionSchema = z.strictObject({
  id: CompositionIdSchema,
  name: NameSchema,
  width: z.number().int().min(1).max(MAX_COMPOSITION_SIZE),
  height: z.number().int().min(1).max(MAX_COMPOSITION_SIZE),
  /** Frame rate as an exact ratio, e.g. 30/1 or 30000/1001. All time is integer frames at this rate. */
  fps: z
    .strictObject({ num: z.number().int().positive(), den: z.number().int().positive() })
    .refine(
      (f) => f.num / f.den >= MIN_FPS && f.num / f.den <= MAX_FPS,
      `frame rate must be between ${MIN_FPS} and ${MAX_FPS} fps`,
    ),
  durationFrames: z.number().int().positive().max(MAX_DURATION_FRAMES),
  /** `null` is transparent. */
  background: ColorSchema.nullable(),
  /** Top-first: index 0 is drawn on top. */
  layers: z.array(LayerSchema).max(MAX_LAYERS),
  markers: z.array(MarkerSchema).max(MAX_MARKERS),
});
export type Composition = z.infer<typeof CompositionSchema>;
