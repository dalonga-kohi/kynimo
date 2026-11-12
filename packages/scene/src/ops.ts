import { z } from "zod";
import { type Asset, AssetShapeSchema, checkAudioBeats } from "./asset.js";
import {
  type Behavior,
  BehaviorAmountSchema,
  BehaviorPropertySchema,
  BehaviorSchema,
  LoopBehaviorSchema,
  OscillateBehaviorSchema,
} from "./behavior.js";
import { MaskSchema, TrackMatteSchema } from "./compositing.js";
import { EffectStackSchema } from "./effect.js";
import { GeneratorSchema } from "./generator.js";
import {
  AssetIdSchema,
  BehaviorIdSchema,
  CompositionIdSchema,
  LayerIdSchema,
  MarkerIdSchema,
  MaskIdSchema,
} from "./ids.js";
import type { Animatable, PositionTrack } from "./keyframes.js";
import { CameraLayerSchema, type Layer, LayerSchema, MotionBlurSchema } from "./layer.js";
import { MAX_LAYERS } from "./limits.js";
import {
  MarkerSchema,
  NameSchema,
  NonNegativeSchema,
  NumberSchema,
  PositiveSchema,
  Vec2Schema,
} from "./primitives.js";
import { LayerSelectorSchema } from "./selectors.js";
import { MAX_SHAPE_ITEMS, ShapeItemSchema } from "./shape.js";
import { MAX_TEXT_ANIMATORS, TextAnimatorSchema } from "./text-animator.js";
import {
  animatable,
  TRANSFORM_PROPERTIES,
  type TransformProperty,
  TransformSchema,
} from "./transform.js";
import { TransitionSchema } from "./transition.js";

export const MAX_BATCH_OPS = 500;

/** A layer without its id: the id is supplied by the op or generated from the seeded counter. */
export type LayerInput = Layer extends infer L ? (L extends Layer ? Omit<L, "id"> : never) : never;

// Every member is a plain object schema, so `omit` is safe; the casts restore types zod cannot infer through the union.
type Omittable = { omit(mask: { id: true }): z.ZodType };
const LayerInputSchema = z.discriminatedUnion(
  "type",
  (LayerSchema.options as unknown as Omittable[]).map((o) => o.omit({ id: true })) as never,
) as unknown as z.ZodType<LayerInput>;

/** Layer fields `updateLayer` may change. Transform tracks have their own op. */
export const LayerPatchSchema = z
  .strictObject({
    name: NameSchema,
    inFrame: z.number().int(),
    outFrame: z.number().int(),
    startFrame: z.number().int(),
    hidden: z.boolean(),
    solo: z.boolean(),
    /** Drawn layers only; `null` turns it off, `{}` is the defaults. */
    motionBlur: MotionBlurSchema.nullable(),
    /** Drawn layers only (not adjustment); replaces the whole transition, `null` removes it. */
    transition: TransitionSchema.nullable(),
    /** Layers with a transform but not adjustment (true), camera or audio layers: puts the layer in 3D space (ADR-0054). */
    threeD: z.boolean(),
    /** Camera layers only (ADR-0054). */
    zoom: CameraLayerSchema.shape.zoom,
    /** Camera layers only; `null` aims along the camera's own rotation. */
    pointOfInterest: CameraLayerSchema.shape.pointOfInterest,
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

const setEffects = z.strictObject({
  op: z.literal("setEffects"),
  layer: LayerSelectorSchema,
  effects: EffectStackSchema,
});

const setGenerator = z.strictObject({
  op: z.literal("setGenerator"),
  layer: LayerSelectorSchema,
  generator: GeneratorSchema,
});

/** A behavior without its id: the id is supplied by the op or generated from the seeded counter. */
export type BehaviorInput = Behavior extends infer B
  ? B extends Behavior
    ? Omit<B, "id">
    : never
  : never;
export const BehaviorInputSchema = z.discriminatedUnion(
  "type",
  (BehaviorSchema.options as unknown as Omittable[]).map((o) => o.omit({ id: true })) as never,
) as unknown as z.ZodType<BehaviorInput>;

const addBehavior = z.strictObject({
  op: z.literal("addBehavior"),
  layer: LayerSelectorSchema,
  /** Optional; generated from the seeded counter when omitted. Unique within the layer. */
  id: BehaviorIdSchema.optional(),
  behavior: BehaviorInputSchema,
  /** Position in the layer's behavior list. Default: the end. */
  index: z.number().int().nonnegative().optional(),
});

/**
 * Behavior fields `updateBehavior` may change, whichever the behavior's type has; fields the type
 * lacks are refused when the op runs, and the merged behavior is validated whole. The type itself
 * can't change. Tracks are replaced whole.
 */
export const BehaviorPatchSchema = z
  .strictObject({
    name: NameSchema,
    enabled: z.boolean(),
    property: BehaviorPropertySchema,
    frequency: z.union([animatable(NonNegativeSchema), PositiveSchema]),
    amplitude: z.union([BehaviorAmountSchema, NonNegativeSchema]),
    octaves: z.number().int(),
    seed: z.number().int(),
    linked: z.boolean(),
    phase: NumberSchema,
    waveform: OscillateBehaviorSchema.shape.waveform,
    direction: LoopBehaviorSchema.shape.direction,
    mode: LoopBehaviorSchema.shape.mode,
    span: z.number().int(),
    decay: NumberSchema,
    source: z.strictObject({ layer: LayerIdSchema, property: BehaviorPropertySchema }),
    multiply: NumberSchema,
    offset: z.union([NumberSchema, Vec2Schema]),
    delay: z.number().int(),
    /** Present only to be refused with a clear message. */
    type: z.string(),
  })
  .partial()
  .superRefine((p, ctx) => {
    if (Object.keys(p).length === 0)
      ctx.addIssue({ code: "custom", message: "set at least one field" });
    if (p.type !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: "a behavior's type can't change; remove it and add a new behavior",
      });
  });

const updateBehavior = z.strictObject({
  op: z.literal("updateBehavior"),
  layer: LayerSelectorSchema,
  behavior: BehaviorIdSchema,
  set: BehaviorPatchSchema,
});

const removeBehavior = z.strictObject({
  op: z.literal("removeBehavior"),
  layer: LayerSelectorSchema,
  behavior: BehaviorIdSchema,
});

/** Replaces a text layer's animator list whole (ADR-0038); the resulting layer is validated whole. */
const setTextAnimators = z.strictObject({
  op: z.literal("setTextAnimators"),
  layer: LayerSelectorSchema,
  animators: z.array(TextAnimatorSchema).max(MAX_TEXT_ANIMATORS),
});

/** Replaces a shape layer's contents whole; the resulting document is validated whole. */
const setShapeContents = z.strictObject({
  op: z.literal("setShapeContents"),
  layer: LayerSelectorSchema,
  contents: z.array(ShapeItemSchema).max(MAX_SHAPE_ITEMS),
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
 * the whole duration with an identity transform. Blend modes and adjustment layers that move
 * see only the backdrop inside the new composition.
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

/** An asset without its id: the id is supplied by the op or generated from the seeded counter. */
export type AssetInput = Asset extends infer A ? (A extends Asset ? Omit<A, "id"> : never) : never;
const AssetInputSchema = (
  z.discriminatedUnion(
    "type",
    (AssetShapeSchema.options as unknown as Omittable[]).map((o) => o.omit({ id: true })) as never,
  ) as unknown as z.ZodType<AssetInput>
).superRefine((a, ctx) => {
  if (a.type === "audio") checkAudioBeats(a, ctx);
});

/**
 * Adds an asset entry (appended to the project's list). The bytes live in the asset store; the
 * entry pins them by `sha256`. Normally written by `upload_asset`, which derives the fields.
 */
const addAsset = z.strictObject({
  op: z.literal("addAsset"),
  /** Optional; generated (`asset-N`) from the seeded counter when omitted. */
  id: AssetIdSchema.optional(),
  asset: AssetInputSchema,
});

/** Removes an asset entry no layer uses. Its bytes stay in the asset store. */
const removeAsset = z.strictObject({ op: z.literal("removeAsset"), asset: AssetIdSchema });

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
  setEffects,
  setGenerator,
  addBehavior,
  updateBehavior,
  removeBehavior,
  setTextAnimators,
  setShapeContents,
  setMatte,
  precompose,
  addAsset,
  removeAsset,
]);
export type Op = z.infer<typeof OpSchema>;

export const BatchSchema = z.array(OpSchema).max(MAX_BATCH_OPS);
