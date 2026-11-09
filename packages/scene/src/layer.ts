import { z } from "zod";
import { BlendModeSchema, MAX_MASKS, MaskSchema, TrackMatteSchema } from "./compositing.js";
import { FontFamilySchema, FontWeightSchema } from "./fonts.js";
import { AssetIdSchema, CompositionIdSchema, ID_PATTERN, LayerIdSchema } from "./ids.js";
import { MAX_COMPOSITION_SIZE } from "./limits.js";
import {
  ColorSchema,
  FrameSchema,
  JsonObjectSchema,
  MAX_MARKERS,
  MAX_PROPS,
  MarkerSchema,
  NameSchema,
  NonNegativeSchema,
  NumberSchema,
  PositiveSchema,
  SemverSchema,
} from "./primitives.js";
import { MAX_SHAPE_ITEMS, ShapeItemSchema } from "./shape.js";
import { animatable, TransformSchema } from "./transform.js";

/**
 * Timing. A layer is visible on frames `inFrame <= f < outFrame` (composition frames).
 * `startFrame` is the composition frame at which the layer's own content begins, so
 * trimming or sliding a layer never changes what its content does at a given content time.
 */
const timing = {
  inFrame: FrameSchema,
  outFrame: FrameSchema,
  startFrame: FrameSchema,
};

/** Metadata the renderer ignores. */
const EditorMetaSchema = z.strictObject({
  locked: z.boolean(),
  shy: z.boolean(),
  label: ColorSchema.nullable(),
});

const common = {
  id: LayerIdSchema,
  name: NameSchema,
  ...timing,
  /** Render switches. On an audio layer, `hidden` mutes it. */
  hidden: z.boolean(),
  solo: z.boolean(),
  editor: EditorMetaSchema,
  markers: z.array(MarkerSchema).max(MAX_MARKERS),
};

/** Layers that draw: they have a transform and may be parented to another visual layer. */
const visual = {
  ...common,
  parent: LayerIdSchema.nullable(),
  transform: TransformSchema,
};

/**
 * Layers that put pixels in the frame: everything visual but null layers. Order of operations
 * follows After Effects (ADR-0020): masks, then (M4) effects, then the transform, the track matte,
 * opacity and finally the blend mode against the layers below.
 */
const drawn = {
  ...visual,
  blendMode: BlendModeSchema,
  matte: TrackMatteSchema.nullable(),
  masks: z.array(MaskSchema).max(MAX_MASKS),
};

export const ShapeLayerSchema = z.strictObject({
  ...drawn,
  type: z.literal("shape"),
  contents: z.array(ShapeItemSchema).max(MAX_SHAPE_ITEMS),
});

const TextBoxSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("point") }),
  z.strictObject({
    mode: z.literal("box"),
    width: animatable(PositiveSchema),
    height: animatable(PositiveSchema),
    autoFit: z.boolean(),
  }),
]);

/** `font.family` names a bundled family or a font asset of the project (ADR-0019). */
export const TextLayerSchema = z.strictObject({
  ...drawn,
  type: z.literal("text"),
  /**
   * Constant for now, but wrapped as `{ value }`: keyframed source text is `v1.x` and will allow
   * only hold keyframes (strings cannot be interpolated), a loosening that needs no migration.
   */
  content: z.strictObject({ value: z.string().max(10_000) }),
  box: TextBoxSchema,
  font: z.strictObject({
    family: FontFamilySchema,
    weight: FontWeightSchema,
    size: animatable(PositiveSchema),
  }),
  /** Letter spacing in thousandths of an em. */
  tracking: animatable(NumberSchema),
  /** Line height as a multiple of font size. */
  leading: animatable(PositiveSchema),
  align: z.enum(["left", "center", "right", "justify"]),
  textCase: z.enum(["none", "upper", "lower"]),
  fill: animatable(ColorSchema),
});

export const ImageLayerSchema = z.strictObject({
  ...drawn,
  type: z.literal("image"),
  assetId: AssetIdSchema,
});

/** Footage: shows the video asset's frame at the layer's time (ADR-0032), nothing outside it. */
export const VideoLayerSchema = z.strictObject({
  ...drawn,
  type: z.literal("video"),
  assetId: AssetIdSchema,
});

export const SolidLayerSchema = z.strictObject({
  ...drawn,
  type: z.literal("solid"),
  width: z.number().int().min(1).max(MAX_COMPOSITION_SIZE),
  height: z.number().int().min(1).max(MAX_COMPOSITION_SIZE),
  color: ColorSchema,
});

/** Invisible parent or controller. */
export const NullLayerSchema = z.strictObject({ ...visual, type: z.literal("null") });

export const PrecompLayerSchema = z.strictObject({
  ...drawn,
  type: z.literal("precomp"),
  compositionId: CompositionIdSchema,
});

/** Effects on an adjustment layer apply to everything below it (effects arrive in M4). */
export const AdjustmentLayerSchema = z.strictObject({ ...drawn, type: z.literal("adjustment") });

/** Instance of a component. `props` are validated against the component's own schema (M6). */
export const ComponentLayerSchema = z.strictObject({
  ...drawn,
  type: z.literal("component"),
  componentId: z.string().regex(ID_PATTERN),
  /** Pinned like the style pack: a new component version never changes an existing document. */
  componentVersion: SemverSchema,
  props: JsonObjectSchema.refine(
    (p) => Object.keys(p).length <= MAX_PROPS,
    `at most ${MAX_PROPS} props`,
  ),
});

/** Audio has no transform and no parent. Beat markers are markers on this layer. */
export const AudioLayerSchema = z.strictObject({
  ...common,
  type: z.literal("audio"),
  assetId: AssetIdSchema,
  /** Linear gain; 1 is unity. */
  volume: animatable(NonNegativeSchema),
});

/** Layers are listed top-first: index 0 is drawn on top. */
export const LayerSchema = z.discriminatedUnion("type", [
  ShapeLayerSchema,
  TextLayerSchema,
  ImageLayerSchema,
  VideoLayerSchema,
  SolidLayerSchema,
  NullLayerSchema,
  PrecompLayerSchema,
  AdjustmentLayerSchema,
  ComponentLayerSchema,
  AudioLayerSchema,
]);
export type Layer = z.infer<typeof LayerSchema>;
export type LayerType = Layer["type"];
