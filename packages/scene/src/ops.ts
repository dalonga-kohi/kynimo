import { z } from "zod";
import { CompositionIdSchema, LayerIdSchema, MarkerIdSchema } from "./ids.js";
import { type Layer, LayerSchema } from "./layer.js";
import { MarkerSchema, NameSchema } from "./primitives.js";
import { LayerSelectorSchema } from "./selectors.js";
import type { TransformSchema } from "./transform.js";

export const MAX_BATCH_OPS = 500;

/** A layer without its id: the id is supplied by the op or generated from the seeded counter. */
export type LayerInput = Layer extends infer L ? (L extends Layer ? Omit<L, "id"> : never) : never;

// Every member is a plain object schema, so `omit` is safe; the casts restore types zod cannot infer through the union.
type Omittable = { omit(mask: { id: true }): z.ZodType };
const LayerInputSchema = z.discriminatedUnion(
  "type",
  (LayerSchema.options as unknown as Omittable[]).map((o) => o.omit({ id: true })) as never,
) as unknown as z.ZodType<LayerInput>;

export const TRANSFORM_PROPERTIES = [
  "anchorPoint",
  "position",
  "scale",
  "rotation",
  "skew",
  "opacity",
] as const satisfies readonly (keyof z.infer<typeof TransformSchema>)[];

/** Layer fields `updateLayer` may change. Transform tracks have their own op. */
export const LayerPatchSchema = z
  .strictObject({
    name: NameSchema,
    inFrame: z.number().int(),
    outFrame: z.number().int(),
    startFrame: z.number().int(),
    hidden: z.boolean(),
    solo: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "set at least one field");

const addLayer = z.strictObject({
  op: z.literal("addLayer"),
  composition: CompositionIdSchema,
  /** Optional; generated from the seeded counter when omitted. */
  id: LayerIdSchema.optional(),
  layer: LayerInputSchema,
  /** Position in the composition, top-first. Default 0 (top). */
  index: z.number().int().nonnegative().optional(),
});

const updateLayer = z.strictObject({
  op: z.literal("updateLayer"),
  layer: LayerSelectorSchema,
  set: LayerPatchSchema,
});

const removeLayer = z.strictObject({ op: z.literal("removeLayer"), layer: LayerSelectorSchema });

/** Sets one transform property to a constant (`{ value }`) or to keyframes (`{ keyframes }`). */
const setTransformTrack = z.strictObject({
  op: z.literal("setTransformTrack"),
  layer: LayerSelectorSchema,
  property: z.enum(TRANSFORM_PROPERTIES),
  /** Validated against the property's own track schema when the op runs. */
  track: z.unknown(),
});

const reorderLayer = z.strictObject({
  op: z.literal("reorderLayer"),
  layer: LayerSelectorSchema,
  /** New position in its composition, top-first. */
  index: z.number().int().nonnegative(),
});

const setParent = z.strictObject({
  op: z.literal("setParent"),
  layer: LayerSelectorSchema,
  parent: LayerSelectorSchema.nullable(),
});

const addMarker = z.strictObject({
  op: z.literal("addMarker"),
  target: z.union([
    z.strictObject({ composition: CompositionIdSchema }),
    z.strictObject({ layer: LayerSelectorSchema }),
  ]),
  id: MarkerIdSchema.optional(),
  marker: MarkerSchema.omit({ id: true }),
});

const removeMarker = z.strictObject({ op: z.literal("removeMarker"), marker: MarkerIdSchema });

export const OpSchema = z.discriminatedUnion("op", [
  addLayer,
  updateLayer,
  removeLayer,
  setTransformTrack,
  reorderLayer,
  setParent,
  addMarker,
  removeMarker,
]);
export type Op = z.infer<typeof OpSchema>;

export const BatchSchema = z.array(OpSchema).max(MAX_BATCH_OPS);
