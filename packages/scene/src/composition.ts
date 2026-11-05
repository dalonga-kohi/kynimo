import { z } from "zod";
import { CompositionIdSchema } from "./ids.js";
import { LayerSchema } from "./layer.js";
import { ColorSchema, MarkerSchema, NameSchema } from "./primitives.js";

export const MAX_COMPOSITION_SIZE = 8192;
export const MAX_FPS = 240;

export const CompositionSchema = z.strictObject({
  id: CompositionIdSchema,
  name: NameSchema,
  width: z.number().int().min(1).max(MAX_COMPOSITION_SIZE),
  height: z.number().int().min(1).max(MAX_COMPOSITION_SIZE),
  /** Frames per second. All time inside the composition is integer frames at this rate. */
  fps: z.number().positive().max(MAX_FPS),
  durationFrames: z.number().int().positive(),
  /** `null` is transparent. */
  background: ColorSchema.nullable(),
  /** Top-first: index 0 is drawn on top. */
  layers: z.array(LayerSchema),
  markers: z.array(MarkerSchema),
});
export type Composition = z.infer<typeof CompositionSchema>;
