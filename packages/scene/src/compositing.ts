import { z } from "zod";
import { LayerIdSchema, MaskIdSchema } from "./ids.js";
import { MAX_COMPOSITION_SIZE } from "./limits.js";
import { NameSchema, UnitIntervalSchema } from "./primitives.js";
import { BezierPathSchema, pathMorphCheck } from "./shape.js";
import { animatable } from "./transform.js";

/**
 * How a layer combines with what is below it (ADR-0020). The first sixteen are the W3C
 * Compositing and Blending modes; the rest are the After Effects modes motion designers reach for.
 * Blending runs on sRGB-encoded values, as in After Effects' default working space (ADR-0016).
 */
export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "add",
  "subtract",
  "divide",
  "linear-burn",
  "linear-light",
  "vivid-light",
  "pin-light",
  "hard-mix",
] as const;
export const BlendModeSchema = z.enum(BLEND_MODES);
export type BlendMode = z.infer<typeof BlendModeSchema>;

/**
 * Track matte, After Effects 2023 model: any drawing layer of the same composition can be the
 * matte. The source keeps drawing according to its own `hidden` switch, and a hidden or unsoloed
 * layer still works as a matte. Outside the source's in/out range the matte is empty.
 */
export const TrackMatteSchema = z.strictObject({
  layerId: LayerIdSchema,
  mode: z.enum(["alpha", "alpha-inverted", "luma", "luma-inverted"]),
});
export type TrackMatte = z.infer<typeof TrackMatteSchema>;

export const MASK_MODES = [
  "add",
  "subtract",
  "intersect",
  "lighten",
  "darken",
  "difference",
  "none",
] as const;

/**
 * A mask path in layer space. Masks combine top-first in list order (ADR-0020); `none` masks are
 * kept but ignored. Feather is a per-axis blur width in layer units, expansion grows (positive) or
 * shrinks (negative) the path in layer units (at most the composition size limit either way), and `inverted` flips the path's coverage before
 * opacity scales it.
 */
export const MaskSchema = z.strictObject({
  id: MaskIdSchema,
  name: NameSchema,
  mode: z.enum(MASK_MODES),
  inverted: z.boolean(),
  path: animatable(BezierPathSchema, pathMorphCheck),
  feather: animatable(z.tuple([z.number().min(0).max(1000), z.number().min(0).max(1000)])),
  opacity: animatable(UnitIntervalSchema),
  expansion: animatable(z.number().min(-MAX_COMPOSITION_SIZE).max(MAX_COMPOSITION_SIZE)),
});
export type Mask = z.infer<typeof MaskSchema>;
export type MaskMode = Mask["mode"];

export const MAX_MASKS = 32;
