import { z } from "zod";
import { MaskSchema, TrackMatteSchema } from "./compositing.js";
import { CompositionIdSchema, LayerIdSchema, MarkerIdSchema, MaskIdSchema } from "./ids.js";
import type { Animatable, PositionTrack } from "./keyframes.js";
import { type Layer, LayerSchema } from "./layer.js";
import { MAX_LAYERS } from "./limits.js";
import { MarkerSchema, NameSchema } from "./primitives.js";
import { LayerSelectorSchema } from "./selectors.js";
import { TransformSchema } from "./transform.js";

export const MAX_BATCH_OPS = 500;

/** A layer without its id: the id is supplied by the op or generated from the seeded counter. */
export type LayerInput = Layer extends infer L ? (L extends Layer ? Omit<L, "id"> : never) : never;

// Every member is a plain object schema, so `omit` is safe; the casts restore types zod cannot infer through the union.
type Omittable = { omit(mask: { id: true }): z.ZodType };
const LayerInputSchema = z.discriminatedUnion(
  "type",
  (LayerSchema.options as unknown as Omittable[]).map((o) => o.omit({ id: true })) as never,
) as unknown as z.ZodType<LayerInput>;

export type TransformProperty = (typeof TRANSFORM_PROPERTIES)[number];
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
// One variant per property so each `track` has its own schema; the casts only restore the static type.
type TrackVariant = z.ZodObject<
  {
    op: z.ZodLiteral<"setTransformTrack">;
    layer: typeof LayerSelectorSchema;
    property: z.ZodLiteral<TransformProperty>;
    track: z.ZodType<Animatable<unknown> | PositionTrack>;
  },
  z.core.$strict
>;
const setTransformTrack = z.discriminatedUnion(
  "property",
  TRANSFORM_PROPERTIES.map((property) =>
    z.strictObject({
      op: z.literal("setTransformTrack"),
      layer: LayerSelectorSchema,
      property: z.literal(property),
      track: TransformSchema.shape[property],
    }),
  ) as unknown as [TrackVariant, ...TrackVariant[]],
);

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

/** A mask without its id: the id is supplied by the op or generated from the seeded counter. */
export const MaskInputSchema = MaskSchema.omit({ id: true });

const addMask = z.strictObject({
  op: z.literal("addMask"),
  layer: LayerSelectorSchema,
  /** Optional; generated from the seeded counter when omitted. Unique within the layer. */
  id: MaskIdSchema.optional(),
  mask: MaskInputSchema,
  /** Position in the layer's mask list (masks combine top-first). Default: the end. */
  index: z.number().int().nonnegative().optional(),
});

/** Mask fields `updateMask` may change; tracks are replaced whole. */
export const MaskPatchSchema = MaskInputSchema.partial().refine(
  (p) => Object.keys(p).length > 0,
  "set at least one field",
);

const updateMask = z.strictObject({
  op: z.literal("updateMask"),
  layer: LayerSelectorSchema,
  mask: MaskIdSchema,
  set: MaskPatchSchema,
});

const removeMask = z.strictObject({
  op: z.literal("removeMask"),
  layer: LayerSelectorSchema,
  mask: MaskIdSchema,
});

/** Sets or clears a layer's track matte. The source is a layer of the same composition. */
const setMatte = z.strictObject({
  op: z.literal("setMatte"),
  layer: LayerSelectorSchema,
  matte: z
    .strictObject({ layer: LayerSelectorSchema, mode: TrackMatteSchema.shape.mode })
    .nullable(),
});

/**
 * Moves layers of one composition into a new composition and puts a precomp layer of it where
 * the topmost of them was (After Effects "move all attributes"). The new composition copies the
 * source's size, frame rate and duration with a transparent background; the precomp layer spans
 * the whole duration with an identity transform, so the frame looks the same as long as the moved
 * layers blend normally: other blend modes then blend inside the new composition (as in After Effects).
 */
const precompose = z.strictObject({
  op: z.literal("precompose"),
  layers: z.array(LayerSelectorSchema).min(1).max(MAX_LAYERS),
  /** Id of the new composition; generated (`comp-N`) when omitted. */
  id: CompositionIdSchema.optional(),
  /** Name of the new composition and its precomp layer. Default: "<topmost layer name> Comp". */
  name: NameSchema.optional(),
  /** Id of the precomp layer; generated when omitted. */
  layerId: LayerIdSchema.optional(),
});

export const OpSchema = z.discriminatedUnion("op", [
  addLayer,
  updateLayer,
  removeLayer,
  setTransformTrack,
  reorderLayer,
  setParent,
  addMarker,
  removeMarker,
  addMask,
  updateMask,
  removeMask,
  setMatte,
  precompose,
]);
export type Op = z.infer<typeof OpSchema>;

export const BatchSchema = z.array(OpSchema).max(MAX_BATCH_OPS);
