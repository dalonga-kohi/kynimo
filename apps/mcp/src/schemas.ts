import { MAX_PROPS_PER_COMPONENT } from "@kynimo/components";
import {
  AnimateInputSchema,
  DurationInput,
  EasingInput,
  MarkBeatsInputSchema,
  RetimeInputSchema,
  StaggerInputSchema,
  SyncToBeatsInputSchema,
} from "@kynimo/intent";
import {
  AssetIdSchema,
  ColorSchema,
  CompositionIdSchema,
  DeformPinIdSchema,
  DeformSchema,
  EffectIdSchema,
  ID_PATTERN,
  JsonObjectSchema,
  LayerIdSchema,
  LayerPatchSchema,
  LayerSchema,
  LayerSelectorSchema,
  MASK_MODES,
  MAX_BATCH_OPS,
  MAX_COMPOSITION_SIZE,
  MAX_DEFORM_PINS,
  MAX_DURATION_FRAMES,
  MAX_EFFECTS,
  MAX_LAYERS,
  MAX_SHAPE_ITEMS,
  MAX_TEXT_ANIMATORS,
  NameSchema,
  OpSchema,
  SemverSchema,
  ShaderDefinitionInputSchema,
  ShaderDefinitionSummarySchema,
  TRANSFORM_PROPERTIES,
  TRANSITION_KINDS,
  TrackMatteSchema,
} from "@kynimo/scene";
import { SCRIPT_LIMITS } from "@kynimo/script";
import { SVG_LIMITS } from "@kynimo/svg";
import { z } from "zod";
import { MAX_ASSET_BASE64 } from "./blobs.js";
import { MAX_BRIEF_SHOTS } from "./build-from-brief.js";
import { EXPORT_LIMITS } from "./export.js";
import { RENDER_LIMITS } from "./render.js";

/** Every layer type, from the schema itself so new types appear here automatically. */
export const LAYER_TYPES = LayerSchema.options.map((o) => o.shape.type.value) as [
  (typeof LayerSchema.options)[number]["shape"]["type"]["value"],
  ...(typeof LayerSchema.options)[number]["shape"]["type"]["value"][],
];

/**
 * Layer bodies are declared loosely in tool schemas: the exact union is ~40 KB of JSON Schema and
 * would be sent to the model on every connect. The server validates them fully (pathed errors),
 * and `get_layer_schema` returns the exact schema for one type on demand.
 */
export const LayerBodySchema = z
  .looseObject({ type: z.enum(LAYER_TYPES) })
  .describe(
    "A layer without its id. `type` picks the kind; call get_layer_schema for the exact fields of that type.",
  );

/** Transform tracks are declared loosely too (the per-property union inlines to ~15 KB). */
export const TrackBodySchema = z
  .looseObject({})
  .describe(
    "Either { value } for a constant, or { keyframes: [{ frame, value, interpolation }] } with frames in layer time. interpolation is { type: 'linear' | 'hold' } or { type: 'bezier', x1, y1, x2, y2 } or { type: 'spring', damping, response }. position keyframes may add `spatial: { inTangent, outTangent }` tangents (relative to the keyframe's value).",
  );

const MASK_TRACKS =
  "path: a track of { closed, vertices: [{ point, inTangent, outTangent }] } (tangents relative to the point; keyframed paths keep one vertex count); feather: [x, y] blur width >= 0; opacity: 0..1; expansion: grow (+) or shrink (-) in layer units. Each is { value } or { keyframes } in layer time.";

/** Mask bodies are declared loosely in `apply_ops`: their four tracks inline to several KB. */
export const MaskBodySchema = z
  .looseObject({})
  .describe(
    `A mask without its id: { name, mode: ${MASK_MODES.join(" | ")}, inverted, path, feather, opacity, expansion }. ${MASK_TRACKS}`,
  );

/** Behavior bodies are loose in `apply_ops` too; the server validates them in full (ADR-0039). */
export const BehaviorBodySchema = z
  .looseObject({})
  .describe(
    "A behavior without its id: { name, enabled, property, type: wiggle | oscillate | loop | inertia | link, ...parameters of that type }.",
  );

/**
 * Layer selectors in `apply_ops` ops are declared as one described id-or-selector: the full
 * selector schema is 436 characters and every op repeated it (ADR-0030 amendment). The server still
 * validates each op against the full `OpSchema`, so a bad selector is rejected with its exact path.
 */
export const CompactLayerSelectorSchema = z
  .union([z.string(), z.looseObject({})])
  .describe(
    "A layer: its id, or a selector { name, type, composition } matching exactly one layer (name may use * as a wildcard).",
  );

/**
 * Rebuilds `schema` with every `LayerSelectorSchema` inside it swapped for the compact one, found by
 * walking objects, unions, arrays, nullable and optional wrappers, so a new op with a selector is
 * covered without a list. Anything else passes through unchanged.
 */
function compactSelectors<T extends z.ZodType>(schema: T): z.ZodType {
  const s: z.ZodType = schema;
  if (s === (LayerSelectorSchema as z.ZodType)) return CompactLayerSelectorSchema;
  const walked = walk(s);
  // Only paths that hold a selector are rebuilt; every other schema is returned as it is.
  return walked === s ? s : withMeta(s, walked);
}

/** Zod 4 keeps `.describe()` and `.meta()` in a registry keyed by instance, so a rebuild drops them. */
function withMeta(from: z.ZodType, to: z.ZodType): z.ZodType {
  const meta = z.globalRegistry.get(from);
  return meta === undefined ? to : to.meta(meta);
}

/** One rebuild step: the same schema (identical instance) when no selector is inside it. */
function walk(s: z.ZodType): z.ZodType {
  if (s instanceof z.ZodObject) {
    const fields = Object.entries(s.shape as z.ZodRawShape) as [string, z.ZodType][];
    const swapped = fields.map(([key, field]) => [key, compactSelectors(field)] as const);
    if (swapped.every(([key, next]) => next === s.shape[key])) return s;
    // safeExtend keeps the object's refinements; the field types change only for selectors.
    return (s as z.ZodObject<z.ZodRawShape>).safeExtend(Object.fromEntries(swapped));
  }
  if (s instanceof z.ZodNullable) {
    const inner = compactSelectors(s.unwrap() as z.ZodType);
    return inner === s.unwrap() ? s : inner.nullable();
  }
  if (s instanceof z.ZodOptional) {
    const inner = compactSelectors(s.unwrap() as z.ZodType);
    return inner === s.unwrap() ? s : inner.optional();
  }
  if (s instanceof z.ZodArray) {
    const element = compactSelectors(s.element as z.ZodType);
    if (element === s.element) return s;
    return z.array(element).check(...((s.def.checks ?? []) as never[]));
  }
  if (s instanceof z.ZodUnion) {
    const options = (s.options as z.ZodType[]).map(compactSelectors);
    if (options.every((o, i) => o === (s.options as z.ZodType[])[i])) return s;
    const tuple = options as [z.ZodType, z.ZodType, ...z.ZodType[]];
    // A discriminated union stays one (same discriminator), so it lists as before.
    const discriminator = (s.def as { discriminator?: string }).discriminator;
    return discriminator === undefined
      ? z.union(tuple)
      : z.discriminatedUnion(discriminator, tuple as unknown as [z.ZodObject, ...z.ZodObject[]]);
  }
  return s;
}

/**
 * `updateLayer`'s patch uses compact listings for camera tracks, the transition body and deform
 * pin tracks. The server validates each in full against `LayerPatchSchema`.
 */
export const CompactLayerPatchSchema = z
  .strictObject({
    ...LayerPatchSchema.shape,
    deform: z
      .strictObject({
        pins: z
          .array(
            z.strictObject({
              id: DeformPinIdSchema,
              rest: z.array(z.number()).length(2),
              position: z
                .looseObject({})
                .describe("{ value: [x, y] } or { keyframes } in layer time."),
            }),
          )
          .max(MAX_DEFORM_PINS),
        density: DeformSchema.shape.density.unwrap().optional(),
        iterations: DeformSchema.shape.iterations.unwrap().optional(),
      })
      .nullable()
      .optional(),
    zoom: z
      .looseObject({})
      .describe("Camera layers only: { value } or { keyframes } of a number 1..100000.")
      .optional(),
    pointOfInterest: z
      .looseObject({})
      .nullable()
      .describe(
        "Camera layers only: { value: [x, y, z] } or { keyframes }; null aims along the camera's own rotation.",
      )
      .optional(),
    transition: z
      .looseObject({})
      .nullable()
      .describe(
        "Drawn layers except adjustment: a built-in shader transition { kind, progress: { value } or { keyframes } (0..1), ...kind fields }, replacing the whole value; null removes it. add_transition builds one with defaults. Kinds: dissolve, noise-dissolve, wipe, clock, iris, blinds, pixelate, push, zoom, glitch.",
      )
      .optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "set at least one field");

type AnyOp = (typeof OpSchema.options)[number];
/** The op name of an option; setTransformTrack is itself a union of per-property variants. */
const opName = (o: AnyOp): string =>
  "shape" in o ? o.shape.op.value : (o.options[0]?.shape.op.value ?? "");
const compactOptions = OpSchema.options.map((o: AnyOp) => compactSelectors(compactBody(o)));

function compactBody(o: AnyOp) {
  const name = opName(o);
  // setTransformTrack: one variant per property, collapsed to one with a loose track.
  if (name === "setTransformTrack")
    return z.strictObject({
      op: z.literal("setTransformTrack"),
      layer: CompactLayerSelectorSchema,
      property: z.enum(TRANSFORM_PROPERTIES),
      track: TrackBodySchema,
    });
  const obj = o as z.ZodObject<z.ZodRawShape>;
  if (name === "addLayer") return obj.extend({ layer: LayerBodySchema });
  if (name === "addMask") return obj.extend({ mask: MaskBodySchema });
  if (name === "setEffects")
    return obj.extend({
      effects: z
        .array(z.looseObject({}))
        .max(MAX_EFFECTS)
        .describe(
          "Replaces the ordered effect stack. Items include id and type; see get_layer_schema for fields.",
        ),
    });
  if (name === "setGenerator")
    return obj.extend({
      generator: z
        .looseObject({})
        .describe("Replaces the body; see get_layer_schema('generator')."),
    });
  if (name === "updateLayer") return obj.extend({ set: CompactLayerPatchSchema });
  if (name === "addBehavior") return obj.extend({ behavior: BehaviorBodySchema });
  if (name === "updateBehavior")
    return obj.extend({
      set: z.looseObject({}).describe("Behavior fields to replace (not id or type)."),
    });
  if (name === "addAsset")
    return obj.extend({
      asset: z
        .looseObject({})
        .describe(
          "An asset entry without its id. Use upload_asset instead: it stores the bytes and derives these fields.",
        ),
    });
  if (name === "updateMask")
    return obj.extend({
      set: z.looseObject({}).describe("Any mask fields to replace (not id); see addMask.mask."),
    });
  if (name === "setTextAnimators")
    return obj.extend({
      animators: z
        .array(z.looseObject({}))
        .max(MAX_TEXT_ANIMATORS)
        .describe("Replaces the list; items as in get_layer_schema('text')."),
    });
  if (name === "setShapeContents")
    return obj.extend({
      contents: z
        .array(z.looseObject({}))
        .max(MAX_SHAPE_ITEMS)
        .describe("Replaces the list; items as in get_layer_schema('shape')."),
    });
  return o;
}

/**
 * The op union as tools declare it: exact except `addLayer.layer`, `setTransformTrack.track`,
 * `addMask.mask`, `updateMask.set`, the `zoom` and `pointOfInterest` tracks of `updateLayer.set`, `addBehavior.behavior`, `updateBehavior.set`, `addAsset.asset`,
 * `setTextAnimators.animators` items, `setShapeContents.contents` items
 * and every layer selector (`layer`, `parent`, `matte.layer`, `layers[]`, `target.layer`, ...), which
 * the server validates in full against `OpSchema` before anything is applied.
 */
export const CompactOpSchema = z.discriminatedUnion(
  "op",
  compactOptions as unknown as [AnyOp, ...AnyOp[]],
);

export const ProjectIdSchema = z
  .string()
  .min(1)
  .max(100)
  .describe("Project id from create_project or list_projects.");

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Client-chosen key, unique per write. Retrying with the same key and request returns the original result instead of applying twice.",
  );

const writeMeta = {
  project_id: ProjectIdSchema,
  base_version: z
    .number()
    .int()
    .positive()
    .describe(
      "The project version this write is based on; a stale version is rejected as a conflict.",
    ),
  idempotency_key: IdempotencyKeySchema,
};

export const ApplyOpsInput = z.object({
  ...writeMeta,
  ops: z
    .array(CompactOpSchema)
    .min(1)
    .max(MAX_BATCH_OPS)
    .describe(
      "Applied in order and atomically: all succeed and produce one new version, or nothing changes. Selectors resolve against the document as it stands when each op runs, so later ops see layers earlier ops added.",
    ),
});

export const AddLayerInput = z.object({
  ...writeMeta,
  composition: z.string().min(1).max(64).describe("Composition id, e.g. 'main'."),
  layer: LayerBodySchema.describe(
    "The layer without its id. Shared fields default: inFrame 0, outFrame = composition duration, startFrame 0, not hidden/solo, no markers, parent null, centered identity transform (fill per property), blendMode 'normal', no motion blur (motionBlur null), threeD false (positionZ, rotationX, rotationY 0), no matte, no masks, text without animators. camera: zoom, pointOfInterest and position default to a 50 mm camera looking at the centre. Type-specific fields (e.g. shape `contents`, text `content`, `box`, `font`, `tracking`, `leading`, `align`, `textCase`, `fill`) must be given; see get_layer_schema.",
  ),
  id: z.string().min(1).max(64).optional().describe("Optional layer id; generated when omitted."),
  index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Position, top-first. Default 0 (top)."),
});

export const UpdateLayerInput = z.object({
  ...writeMeta,
  layer: LayerSelectorSchema,
  set: CompactLayerPatchSchema,
});

export const SetKeyframesInput = z.object({
  ...writeMeta,
  layer: LayerSelectorSchema,
  property: z.enum(TRANSFORM_PROPERTIES),
  track: TrackBodySchema,
});

export const AddMaskInput = z.object({
  ...writeMeta,
  layer: LayerSelectorSchema,
  path: TrackBodySchema.describe(
    "Required. The mask path in layer space: { value: { closed, vertices: [{ point, inTangent, outTangent }] } } or keyframes of such paths with one vertex count. Tangents are relative to their point; [0, 0] makes a corner.",
  ),
  mode: z.enum(MASK_MODES).default("add").describe("How it combines with the masks above it."),
  inverted: z.boolean().default(false),
  feather: TrackBodySchema.optional().describe(
    "Per-axis blur width [x, y] in layer units, >= 0. Default { value: [0, 0] }.",
  ),
  opacity: TrackBodySchema.optional().describe("0..1. Default { value: 1 }."),
  expansion: TrackBodySchema.optional().describe(
    "Grows (+) or shrinks (-) the path in layer units. Default { value: 0 }.",
  ),
  name: z.string().min(1).max(200).optional().describe("Default: the given id, else 'Mask'."),
  id: z.string().min(1).max(64).optional().describe("Optional mask id, unique within the layer."),
  index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Position in the layer's masks (they combine top-first). Default: last."),
});

export const SetMatteInput = z.object({
  ...writeMeta,
  layer: LayerSelectorSchema.describe("The layer to matte."),
  matte: z
    .object({
      layer: LayerSelectorSchema.describe(
        "The matte source: a drawing layer of the same composition.",
      ),
      mode: TrackMatteSchema.shape.mode,
    })
    .nullable()
    .describe("null clears the matte."),
});

export const PrecomposeInput = z.object({
  ...writeMeta,
  layers: z
    .array(LayerSelectorSchema)
    .min(1)
    .max(MAX_LAYERS)
    .describe(
      "Layers of one composition to move into the new composition. Parents and track mattes must stay on one side: include the linked layers or clear the links first.",
    ),
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Name of the new composition and its layer. Default: '<topmost layer name> Comp'."),
  composition_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Id of the new composition; generated when omitted."),
  layer_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Id of the precomp layer that replaces them; generated when omitted."),
});

export const UndoRedoInput = z.object(writeMeta);

/** Intent tools: the same write fields with shorter descriptions, plus `dry_run`. */
const intentMeta = {
  project_id: ProjectIdSchema,
  base_version: writeMeta.base_version.describe("Project version this write is based on."),
  idempotency_key: IdempotencyKeySchema.describe(
    "Unique per write; a retry with the same key replays.",
  ),
  dry_run: z.boolean().optional().describe("Return the operations without writing."),
};

/** Targets as the tools list them; the server validates them against the full selector schema. */
const Targets = z
  .union([
    z.string(),
    z.looseObject({}),
    z
      .array(z.union([z.string(), z.looseObject({})]))
      .min(1)
      .max(50),
  ])
  .describe(
    "Layer id, selector { name, type, composition } (name may use *), or a list, max 50. All must share a composition.",
  );

const Endpoint = z.union([z.number(), z.array(z.number()), z.looseObject({})]).optional();

export const AnimateToolInput = AnimateInputSchema.omit({
  layers: true,
  from: true,
  to: true,
  easing: true,
})
  .extend({
    ...intentMeta,
    layers: Targets,
    easing: z
      .union([EasingInput.options[0], z.looseObject({})])
      .optional()
      .describe("Token (default move) or { type: bezier | spring | linear | hold, ... }."),
    from: Endpoint.describe(
      "Number, [x, y] (scale: n means [n, n]) or { by: delta } on the current value. Default: current.",
    ),
    to: Endpoint.describe("Like from. Set at least one of from, to."),
  })
  .strip();

export const StaggerToolInput = StaggerInputSchema.omit({ layers: true })
  .extend({ ...intentMeta, layers: Targets })
  .strip();

export const RetimeToolInput = RetimeInputSchema.omit({ layers: true })
  .extend({ ...intentMeta, layers: Targets })
  .strip();

export const MarkBeatsToolInput = MarkBeatsInputSchema.extend({
  ...intentMeta,
  layer: LayerSelectorSchema.describe("The audio layer (id or selector matching one)."),
  grid: MarkBeatsInputSchema.shape.grid
    .unwrap()
    .extend({
      first_beat_frame: z.number().int().describe("Composition frame of the first beat."),
      count: MarkBeatsInputSchema.shape.grid
        .unwrap()
        .shape.count.describe("At most this many beats, counted from first_beat_frame."),
    })
    .optional()
    .describe("A bpm grid instead of the asset's detected beats."),
  replace: z.boolean().optional().describe("Remove the layer's markers first."),
}).strip();

export const SyncToBeatsToolInput = SyncToBeatsInputSchema.omit({ layers: true })
  .extend({
    ...intentMeta,
    layers: Targets,
    every: SyncToBeatsInputSchema.shape.every.describe(
      "Use every nth beat (4 = once a bar in 4/4).",
    ),
    phase: SyncToBeatsInputSchema.shape.phase.describe(
      "Which beat of each group of every to use, from 0.",
    ),
    max_distance: SyncToBeatsInputSchema.shape.max_distance.describe(
      "Frames; farther keyframes and cuts stay. Default: half the median beat gap.",
    ),
    window: SyncToBeatsInputSchema.shape.window.describe(
      "Only what sits inside these composition frames moves.",
    ),
    snap: SyncToBeatsInputSchema.shape.snap.describe("What to snap; default keyframes."),
  })
  .strip();

export const ApplyPresetToolInput = z.object({
  ...intentMeta,
  layers: Targets,
  preset: z.string().describe("A preset id from list_presets."),
  params: z.looseObject({}).optional().describe("The preset's params; see list_presets."),
  stagger: StaggerInputSchema.omit({ layers: true })
    .optional()
    .describe("Delay each successive layer's start."),
});

const BehaviorRequest = z.looseObject({ type: z.string() });

export const AddBehaviorInput = z.object({
  ...intentMeta,
  layer: LayerSelectorSchema,
  behavior: BehaviorBodySchema.describe(
    "{ type: wiggle | oscillate | loop | inertia | link, property, ...that type's fields }; name defaults to the type, enabled to true. Fields: kynimo://schema/ops (addBehavior).",
  ),
  id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Optional behavior id; generated when omitted."),
  index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Position in the layer's behaviors. Default: last."),
});

export const AddEffectInput = z.object({
  ...intentMeta,
  layer: CompactLayerSelectorSchema,
  effect: z
    .looseObject({ type: z.string() })
    .describe(
      "Effect without id. Types: gaussian-blur, drop-shadow, glow, brightness-contrast, hue-saturation, tint, fill, vignette, grain, chromatic-aberration, posterize, scanlines. Parameters are { value } or { keyframes } in layer time. See get_layer_schema (effects).",
    ),
  id: EffectIdSchema.optional(),
  index: z.number().int().nonnegative().optional().describe("Stack position; default appends."),
});

export const AddTransitionInput = z.object({
  ...intentMeta,
  layer: CompactLayerSelectorSchema,
  kind: z
    .enum(TRANSITION_KINDS)
    .describe("Transition kind; fields and limits: get_capabilities (transitions)."),
  edge: z
    .enum(["in", "out"])
    .optional()
    .describe(
      "in reveals the layer over what is beneath (first frames); out lets it give way (last frames). Default in. Angles mean the on-screen direction the edge travels; only when out is the first edge, it stores angle + 180 and inverts clockwise (a second edge keeps the existing angle/direction).",
    ),
  duration: DurationInput.optional().describe(
    "Token (fast, base, slow) or ms. Default base. Shrunk to fit the layer.",
  ),
  easing: z
    .union([EasingInput.options[0], z.looseObject({})])
    .optional()
    .describe("Token (default move) or { type: bezier | spring | linear | hold, ... }."),
  params: z
    .looseObject({})
    .optional()
    .describe(
      "Any of the kind's fields except kind and progress, e.g. { angle: { value: 90 } }; defaults fit the composition. Not allowed when the layer already has this transition.",
    ),
});

/** What the import is, without the write fields. */
export const ImportSvgRequest = z.object({
  svg: z
    .string()
    .max(SVG_LIMITS.sourceBytes)
    .describe("SVG markup (\u2264512 KB). Becomes one editable shape layer."),
  composition: z.string().min(1).max(64).optional().describe("Composition id. Default: main."),
  layer_id: LayerIdSchema.optional().describe("Default: svg, svg-2, ..."),
  name: z.string().min(1).max(200).optional().describe("Default: the SVG <title>, else SVG."),
  position: z
    .array(z.number())
    .length(2)
    .optional()
    .describe("Layer position [x, y] in composition px. Default: centre."),
  width: z
    .number()
    .positive()
    .optional()
    .describe("On-screen width in px; height follows. Default: the SVG's own size."),
  index: z.number().int().nonnegative().optional().describe("Stack position; default 0 (top)."),
});

export const ImportSvgInput = ImportSvgRequest.extend(intentMeta);

const ComponentIdSchema = z.string().regex(ID_PATTERN);
const ComponentFrameSchema = z.number().int().min(0).max(MAX_DURATION_FRAMES);

export const AddComponentRequest = z.strictObject({
  component_id: ComponentIdSchema.describe("Built-in component id from list_components."),
  component_version: SemverSchema.optional().describe("Default: latest built-in version."),
  composition: CompositionIdSchema.optional().describe("Default: the main composition."),
  layer_id: LayerIdSchema.optional().describe("Generated when omitted."),
  name: NameSchema.optional().describe("Default: the component title."),
  in_frame: ComponentFrameSchema.optional().describe("First visible frame. Default: 0."),
  out_frame: ComponentFrameSchema.optional().describe(
    "Exclusive end frame. Default: the composition duration.",
  ),
  index: z.number().int().nonnegative().optional().describe("Stack position. Default: 0 (top)."),
  props: JsonObjectSchema.refine(
    (props) => Object.keys(props).length <= MAX_PROPS_PER_COMPONENT,
    `at most ${MAX_PROPS_PER_COMPONENT} props`,
  )
    .optional()
    .meta({
      type: "object",
      description: "See list_components for props and defaults.",
    }),
});

export const AddComponentInput = AddComponentRequest.extend(intentMeta);

const BriefOffset = z.number().int().min(0).max(MAX_DURATION_FRAMES);
const BriefShot = {
  duration_frames: z.number().int().min(1).max(MAX_DURATION_FRAMES),
  lower_third: z
    .strictObject({ title: z.string().min(1).max(120), subtitle: z.string().max(160).optional() })
    .optional(),
};
const BriefMedia = {
  asset_id: AssetIdSchema,
  fit: z.enum(["contain", "cover"]).optional().describe("Default: contain."),
};

export const BuildFromBriefRequest = z.strictObject({
  composition: CompositionIdSchema.optional().describe("Default: the main composition."),
  start_frame: BriefOffset.optional().describe("First frame of the storyboard. Default: 0."),
  background: z
    .enum(["style", "transparent"])
    .optional()
    .describe("Shared style background or no background layer. Default: style."),
  transition: z
    .enum(["cut", "wipe"])
    .optional()
    .describe("Between shots. A wipe falls back to a cut when there is no room. Default: cut."),
  shots: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({
          ...BriefShot,
          type: z.literal("headline"),
          text: z.string().min(1).max(500).describe("Headline copy. Use newlines for line breaks."),
        }),
        z.strictObject({
          ...BriefShot,
          type: z.literal("logo"),
          asset_id: AssetIdSchema.optional().describe("Uploaded image. Supply this or wordmark."),
          wordmark: z
            .string()
            .min(1)
            .max(60)
            .optional()
            .describe("Shown when no asset is supplied."),
          tagline: z.string().max(120).optional(),
        }),
        z.strictObject({ ...BriefShot, ...BriefMedia, type: z.literal("image") }),
        z.strictObject({
          ...BriefShot,
          ...BriefMedia,
          type: z.literal("video"),
          source_offset_frames: BriefOffset.optional().describe(
            "Trim from the start of the clip, in composition frames. Default: 0.",
          ),
        }),
      ]),
    )
    .min(1)
    .max(MAX_BRIEF_SHOTS),
});

export const BuildFromBriefInput = BuildFromBriefRequest.extend(intentMeta);

export const ListComponentsOutput = z.object({
  components: z.array(
    z.object({
      id: ComponentIdSchema,
      version: SemverSchema,
      title: NameSchema,
      description: z.string().min(1).max(1000),
      // Definitions validate each full descriptor at registration. Keep those variants out of tools/list.
      props: z.record(z.string(), z.looseObject({ type: z.string(), description: z.string() })),
    }),
  ),
});

export const CreateProjectInput = z.object({
  name: z.string().min(1).max(200),
  idempotency_key: IdempotencyKeySchema,
  width: z.number().int().min(1).max(MAX_COMPOSITION_SIZE).default(1920),
  height: z.number().int().min(1).max(MAX_COMPOSITION_SIZE).default(1080),
  fps: z
    .object({ num: z.number().int().positive(), den: z.number().int().positive() })
    .default({ num: 30, den: 1 })
    .describe("Exact ratio, e.g. { num: 30, den: 1 } or { num: 30000, den: 1001 }."),
  duration_frames: z.number().int().positive().max(MAX_DURATION_FRAMES).default(150),
  background: ColorSchema.nullable()
    .default("#000000")
    .describe("Hex color, or null for transparent."),
});

/**
 * Outputs are open objects: a later field is an addition clients must tolerate, and every field
 * added after v1 is optional, so stored outcomes from older builds still validate (ADR-0024).
 */
const ErrorItem = z.looseObject({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

export const DefineShaderInput = ShaderDefinitionInputSchema.extend({
  project_id: ProjectIdSchema,
  idempotency_key: IdempotencyKeySchema,
}).describe(
  "One immutable project shader. The source is a bounded GLSL ES 3.00 body with typed locals and a final return vec4.",
);

export const DefineShaderOutput = z.looseObject({
  project_id: ProjectIdSchema,
  definition: ShaderDefinitionSummarySchema,
  created: z.boolean(),
  replayed: z.boolean(),
});

export const ListDefinitionsOutput = z.looseObject({
  definitions: z.array(ShaderDefinitionSummarySchema),
});

export const WriteOutput = z.looseObject({
  project_id: z.string(),
  version: z.number().int(),
  changed: z.boolean(),
  layers_added: z.array(z.string()),
  layers_removed: z.array(z.string()),
  layers_changed: z.array(z.string()),
  markers_added: z.array(z.string()),
  markers_removed: z.array(z.string()),
  /** Added after v1, so optional (ADR-0024). */
  compositions_added: z.array(z.string()).optional(),
  compositions_removed: z.array(z.string()).optional(),
  assets_added: z.array(z.string()).optional(),
  assets_removed: z.array(z.string()).optional(),
  replayed: z.boolean(),
});

/** What the intent tools list of their reply; the rest of the write result is there too. */
export const IntentWriteOutput = z.looseObject({
  version: z.number().int(),
  changed: z.boolean(),
  replayed: z.boolean(),
  dry_run: z.boolean().optional(),
  ops: z.array(z.looseObject({})).optional(),
  resolved: z.looseObject({}).optional(),
});

/** What the script is, without the write fields. */
export const RunScriptRequest = z.object({
  source: z.string().max(SCRIPT_LIMITS.sourceBytes),
  seed: z.number().int().min(0).max(0xffffffff).optional(),
});

export const RunScriptInput = RunScriptRequest.extend({
  ...intentMeta,
  source: RunScriptRequest.shape.source.describe(
    "TypeScript (types are erased, not checked). Uses the global `kynimo`; see kynimo://sdk.",
  ),
  seed: RunScriptRequest.shape.seed.describe("uint32 for kynimo.random(); default 0."),
});

export const RunScriptOutput = IntentWriteOutput.extend({
  op_count: z.number().int().optional(),
  motion: z.looseObject({}).optional(),
});

export const GetScriptInput = z.object({
  project_id: ProjectIdSchema,
  version: z
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .optional()
    .describe("A version a run_script wrote; default the latest."),
});

export const GetScriptOutput = z.looseObject({
  project_id: z.string(),
  version: z.number().int(),
  seed: z.number(),
  source: z.string(),
  script_versions: z.array(z.number().int()),
});

export const ListPresetsOutput = z.looseObject({ presets: z.array(z.looseObject({})) });

/** An add_behavior call as the server validates it, without the write fields. */
export const AddBehaviorRequest = AddBehaviorInput.omit({
  project_id: true,
  base_version: true,
  idempotency_key: true,
  dry_run: true,
}).extend({ behavior: BehaviorRequest });

const ProjectMetaOutput = z.looseObject({
  id: z.string(),
  name: z.string(),
  version: z.number().int(),
});

export const CreateProjectOutput = ProjectMetaOutput.extend({ replayed: z.boolean() });
export const ListProjectsOutput = z.looseObject({ projects: z.array(ProjectMetaOutput) });

const Fps = z.looseObject({ num: z.number(), den: z.number() });

export const GetProjectOutput = z.looseObject({
  project_id: z.string(),
  name: z.string(),
  version: z.number().int(),
  format_version: z.number().int(),
  main_composition_id: z.string(),
  style: z.looseObject({ packId: z.string(), version: z.string() }).nullable(),
  assets: z.number().int(),
  compositions: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      width: z.number(),
      height: z.number(),
      fps: Fps,
      duration_frames: z.number(),
      layers: z.number(),
    }),
  ),
});

const LayerSummaryOutput = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.enum(LAYER_TYPES),
  index: z.number().int(),
  parent: z.string().nullable(),
  in_frame: z.number(),
  out_frame: z.number(),
  start_frame: z.number(),
  hidden: z.boolean(),
  animated: z.array(
    z.looseObject({
      property: z.string(),
      keyframes: z.number().int(),
      first_frame: z.number(),
      last_frame: z.number(),
    }),
  ),
});

export const GetSceneOutput = z.looseObject({
  project_id: z.string(),
  version: z.number().int(),
  detail: z.enum(["summary", "full"]),
  compositions: z
    .array(
      z.looseObject({
        id: z.string(),
        name: z.string(),
        main: z.boolean(),
        width: z.number(),
        height: z.number(),
        fps: Fps,
        duration_frames: z.number(),
        markers: z.number(),
        layers: z.array(LayerSummaryOutput),
      }),
    )
    .optional(),
  document: z.record(z.string(), z.unknown()).optional(),
});

export const FindLayersOutput = z.looseObject({
  project_id: z.string(),
  version: z.number().int(),
  total: z.number().int(),
  layers: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      type: z.enum(LAYER_TYPES),
      composition: z.string(),
      index: z.number().int(),
    }),
  ),
});

export const GetLayerOutput = z.looseObject({
  project_id: z.string(),
  version: z.number().int(),
  composition: z.string(),
  index: z.number().int(),
  layer: z.record(z.string(), z.unknown()),
});

export const GetLayerSchemaOutput = z.looseObject({
  type: z.enum(LAYER_TYPES),
  schema: z.record(z.string(), z.unknown()),
});

/** Open, like every output, and minimal: the manifest gains entries as features ship. */
export const GetCapabilitiesOutput = z.looseObject({
  scene_format_version: z.number(),
  layer_types: z.record(z.string(), z.unknown()),
});

export const WriteOutcomeOutput = z.looseObject({
  status: z.enum(["applied", "rejected", "expired", "unknown"]),
  version: z.number().int().optional(),
  result: WriteOutput.omit({ replayed: true })
    .extend({
      definition: ShaderDefinitionSummarySchema.optional(),
      definition_created: z.boolean().optional(),
    })
    .optional(),
  kind: z.string().optional(),
  message: z.string().optional(),
  errors: z.array(ErrorItem).optional(),
  current_version: z.number().int().optional(),
});

const L = RENDER_LIMITS;
const FrameSchema = z.number().int().min(0).max(MAX_DURATION_FRAMES);
const CompositionField = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe("Composition id. Default: the main composition.");

export const RenderFramesInput = z.object({
  project_id: ProjectIdSchema,
  composition: CompositionField,
  frames: z
    .array(FrameSchema)
    .min(1)
    .max(L.maxFrames, `at most ${L.maxFrames} frames per call; split them over several calls`)
    .describe(
      `Composition frames to render, 1 to ${L.maxFrames}. For an overview of a whole animation use render_contact_sheet.`,
    ),
  max_size: z
    .number()
    .int()
    .min(L.minSize)
    .max(L.maxSize, `max_size is at most ${L.maxSize}`)
    .default(L.defaultSize)
    .describe(
      `Longest edge of each image in pixels (${L.minSize} to ${L.maxSize}). Larger compositions are downscaled, never upscaled.`,
    ),
});

export const RenderContactSheetInput = z.object({
  project_id: ProjectIdSchema,
  composition: CompositionField,
  frames: z
    .array(FrameSchema)
    .min(L.minCells)
    .max(L.maxCells, `at most ${L.maxCells} cells per sheet; use several sheets`)
    .optional()
    .describe(
      `Frames to show, ${L.minCells} to ${L.maxCells}. Default: \`count\` frames spread evenly from from_frame to to_frame.`,
    ),
  count: z
    .number()
    .int()
    .min(L.minCells)
    .max(L.maxCells, `count is at most ${L.maxCells}`)
    .default(L.defaultCells)
    .describe("How many evenly spaced frames to show when `frames` is not given."),
  from_frame: FrameSchema.optional().describe("First sampled frame. Default 0."),
  to_frame: FrameSchema.optional().describe(
    "Last sampled frame (included). Default: the last frame.",
  ),
  columns: z
    .number()
    .int()
    .min(1)
    .max(L.maxColumns)
    .optional()
    .describe("Cells per row. Default: about square."),
  cell_size: z
    .number()
    .int()
    .min(L.minSize)
    .max(L.maxCellSize, `cell_size is at most ${L.maxCellSize}`)
    .default(L.defaultCellSize)
    .describe(
      `Longest edge of each cell in pixels (${L.minSize} to ${L.maxCellSize}). The whole sheet may be at most ${L.maxSheetSize} px per side.`,
    ),
});

const RenderReportsOutput = {
  skipped: z.array(
    z.looseObject({
      layer: z.string(),
      type: z.string(),
      reason: z.string(),
      frames: z.array(z.number().int()),
    }),
  ),
  warnings: z.array(
    z.looseObject({
      layer: z.string(),
      kind: z.string(),
      message: z.string(),
      codepoints: z.array(z.number().int()),
      frames: z.array(z.number().int()),
    }),
  ),
};

export const RenderFramesOutput = z.looseObject({
  project_id: z.string(),
  version: z.number().int(),
  composition: z.string(),
  frames: z.array(
    z.looseObject({
      frame: z.number().int(),
      width: z.number().int(),
      height: z.number().int(),
      pixels_sha256: z.string(),
      png_sha256: z.string(),
      cached: z.boolean(),
    }),
  ),
  ...RenderReportsOutput,
});

export const RenderContactSheetOutput = z.looseObject({
  project_id: z.string(),
  version: z.number().int(),
  composition: z.string(),
  frames: z.array(z.number().int()),
  width: z.number().int(),
  height: z.number().int(),
  columns: z.number().int(),
  rows: z.number().int(),
  cell_width: z.number().int(),
  cell_height: z.number().int(),
  pixels_sha256: z.string(),
  png_sha256: z.string(),
  cached: z.boolean(),
  ...RenderReportsOutput,
});

export const DescribeMotionInput = z.object({
  project_id: ProjectIdSchema,
  composition: CompositionField,
  layer: LayerSelectorSchema.optional().describe(
    "Only the layers this selector matches (plus the parents that move them).",
  ),
  from_frame: FrameSchema.optional().describe(
    "Start of the window (composition frame). Default 0.",
  ),
  to_frame: FrameSchema.optional().describe(
    "End of the window (included). Default: the last frame.",
  ),
});

const MotionValue = z.unknown();
export const DescribeMotionOutput = z.looseObject({
  project_id: z.string(),
  version: z.number().int(),
  composition: z.string(),
  fps: Fps,
  duration_frames: z.number().int(),
  duration_seconds: z.number(),
  from_frame: z.number().int(),
  to_frame: z.number().int(),
  layers: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      type: z.enum(LAYER_TYPES),
      index: z.number().int(),
      parent: z.string().nullable(),
      hidden: z.boolean(),
      in_frame: z.number().int(),
      out_frame: z.number().int(),
      precomp: z
        .looseObject({ composition: z.string(), time_offset: z.number().int(), fps: Fps })
        .optional(),
      parent_of_listed: z.literal(true).optional(),
      animators: z.array(z.string()).optional(),
      behaviors: z.array(z.string()).optional(),
      properties: z.array(
        z.looseObject({
          property: z.string(),
          constant: MotionValue.optional(),
          truncated_segments: z.number().int().optional(),
          segments: z.array(
            z.looseObject({
              from_frame: z.number().int(),
              to_frame: z.number().int(),
              from_seconds: z.number(),
              to_seconds: z.number(),
              from: MotionValue,
              to: MotionValue,
              easing: z.looseObject({ type: z.enum(["linear", "hold", "bezier", "spring"]) }),
              curved: z.literal(true).optional(),
              outside_layer_range: z.literal(true).optional(),
            }),
          ),
        }),
      ),
    }),
  ),
  truncated_segments: z.number().int(),
});

export const UploadAssetInput = z.object({
  ...writeMeta,
  name: z.string().min(1).max(200).describe("Display name, e.g. the file name."),
  data: z
    .string()
    .min(1)
    .max(MAX_ASSET_BASE64)
    .describe(
      "The file, base64-encoded, at most 8 MB decoded: PNG/JPEG image, TTF/OTF font, video (MP4, MOV, WebM, MKV; up to 60 s, decoded to frames at most 1920 px and 60 fps) or audio (WAV, MP3, FLAC, Ogg, M4A). Type and metadata are read from the file.",
    ),
  id: z.string().min(1).max(64).optional().describe("Optional asset id; generated when omitted."),
  family: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Fonts only: the family text layers name it by. Default: the family the file declares.",
    ),
});

const AssetOutput = z.looseObject({ id: z.string(), type: z.string(), sha256: z.string() });

export const UploadAssetOutput = WriteOutput.extend({
  asset: AssetOutput,
  /** A video's own sound, extracted into an audio asset; place it with an audio layer. */
  audio_asset: AssetOutput.optional(),
});

export const ListAssetsOutput = z.looseObject({
  project_id: z.string(),
  version: z.number().int(),
  assets: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      sha256: z.string(),
      bpm: z.number().optional(),
      beat_count: z.number().int().optional(),
      used_by: z.array(z.string()),
    }),
  ),
});

const X = EXPORT_LIMITS;

export const ExportInput = z.object({
  project_id: ProjectIdSchema,
  idempotency_key: IdempotencyKeySchema,
  composition: CompositionField,
  format: z
    .enum(["mp4", "webm", "gif"])
    .default("mp4")
    .describe(
      `mp4: H.264 + AAC, no transparency. webm: VP9 + Opus, keeps transparency. gif: no sound, 256 colors. At most ${X.maxSeconds} s (gif ${X.gifMaxSeconds} s).`,
    ),
  from_frame: FrameSchema.optional().describe("First frame. Default 0."),
  to_frame: FrameSchema.optional().describe("Last frame (included). Default: the last frame."),
  max_size: z
    .number()
    .int()
    .min(X.minSize)
    .max(X.maxSize)
    .optional()
    .describe(
      `Longest edge in pixels (${X.minSize} to ${X.maxSize}; gif at most ${X.gifMaxSize}). Default: the composition's (at most ${X.maxSize}; gif ${X.gifDefaultSize}). Never upscaled.`,
    ),
});

export const RenderPreviewClipInput = z.object({
  project_id: ProjectIdSchema,
  composition: CompositionField,
  from_frame: FrameSchema.optional().describe("First frame. Default 0."),
  to_frame: FrameSchema.optional().describe(
    `Last frame (included). Default: the last frame. At most ${X.previewMaxSeconds} s.`,
  ),
  max_size: z
    .number()
    .int()
    .min(X.minSize)
    .max(X.previewMaxSize)
    .optional()
    .describe(
      `Longest edge in pixels (${X.minSize} to ${X.previewMaxSize}). Default ${X.previewDefaultSize}. Never upscaled.`,
    ),
});

const JobIdSchema = z
  .string()
  .regex(/^j-[0-9a-f]{32}$/)
  .describe("The job id returned by export or render_preview_clip.");

export const GetExportStatusInput = z.object({
  job_id: JobIdSchema,
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(25)
    .default(0)
    .describe(
      "Wait up to this long for the job to finish before answering. 10–20 while it runs saves calls.",
    ),
});

export const CancelExportInput = z.object({ job_id: JobIdSchema });

/** Declared loosely, like the layer bodies: the listing is sent to the model on every connect. */
const ExportResultOutput = z.looseObject({
  format: z.enum(["mp4", "webm", "gif"]),
  frames: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  url: z.string().optional(),
  path: z.string().optional(),
  expires_at: z.string(),
  cached: z.boolean(),
  fidelity: z.array(
    z.looseObject({
      kind: z.enum(["dropped", "flattened", "approximated"]),
      feature: z.string(),
      detail: z.string(),
    }),
  ),
  skipped: z.array(z.looseObject({ layer: z.string() })),
  warnings: z.array(z.looseObject({ layer: z.string() })),
});

export const JobOutput = z.looseObject({
  job_id: z.string(),
  kind: z.enum(["export", "preview"]),
  project_id: z.string(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.looseObject({
    phase: z.enum(["queued", "rendering", "encoding", "storing", "done"]),
    frames_done: z.number().int(),
    frames_total: z.number().int(),
  }),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  replayed: z.boolean().optional(),
  result: ExportResultOutput.optional(),
  error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
});

export const CancelExportOutput = JobOutput.extend({ cancelled: z.boolean() });
