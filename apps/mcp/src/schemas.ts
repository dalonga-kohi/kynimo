import {
  ColorSchema,
  LayerPatchSchema,
  LayerSchema,
  LayerSelectorSchema,
  MAX_BATCH_OPS,
  MAX_COMPOSITION_SIZE,
  MAX_DURATION_FRAMES,
  OpSchema,
  TRANSFORM_PROPERTIES,
} from "@kynimo/scene";
import { z } from "zod";

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
    "Either { value } for a constant, or { keyframes: [{ frame, value, interpolation }] } with frames in layer time. interpolation is { type: 'linear' | 'hold' } or { type: 'bezier', x1, y1, x2, y2 } or { type: 'spring', damping, response }. position keyframes may add `spatial: { in, out }` tangents.",
  );

type AnyOp = (typeof OpSchema.options)[number];
const compactOptions = OpSchema.options.map((o: AnyOp) => {
  if (!("shape" in o))
    // setTransformTrack: one variant per property, collapsed to one with a loose track.
    return z.strictObject({
      op: z.literal("setTransformTrack"),
      layer: LayerSelectorSchema,
      property: z.enum(TRANSFORM_PROPERTIES),
      track: TrackBodySchema,
    });
  return o.shape.op.value === "addLayer"
    ? (o as z.ZodObject<z.ZodRawShape>).extend({ layer: LayerBodySchema })
    : o;
}) as unknown as [AnyOp, ...AnyOp[]];

/**
 * The op union as tools declare it: exact except `addLayer.layer` and `setTransformTrack.track`,
 * which the server validates in full against `OpSchema` before anything is applied.
 */
export const CompactOpSchema = z.discriminatedUnion("op", compactOptions);

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
    "The layer without its id. Shared fields default: inFrame 0, outFrame = composition duration, startFrame 0, not hidden/solo, no markers, parent null, centered identity transform (fill per property), blendMode 'normal', no matte, no masks. Type-specific fields (e.g. shape `contents`, text `content`/`font`) must be given; see get_layer_schema.",
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
  set: LayerPatchSchema,
});

export const SetKeyframesInput = z.object({
  ...writeMeta,
  layer: LayerSelectorSchema,
  property: z.enum(TRANSFORM_PROPERTIES),
  track: TrackBodySchema,
});

export const UndoRedoInput = z.object(writeMeta);

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

const ErrorItem = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

export const WriteOutput = z.object({
  project_id: z.string(),
  version: z.number().int(),
  changed: z.boolean(),
  layers_added: z.array(z.string()),
  layers_removed: z.array(z.string()),
  layers_changed: z.array(z.string()),
  markers_added: z.array(z.string()),
  markers_removed: z.array(z.string()),
  replayed: z.boolean(),
});

const ProjectMetaOutput = z.object({ id: z.string(), name: z.string(), version: z.number().int() });

export const CreateProjectOutput = ProjectMetaOutput.extend({ replayed: z.boolean() });
export const ListProjectsOutput = z.object({ projects: z.array(ProjectMetaOutput) });

const Fps = z.object({ num: z.number(), den: z.number() });

export const GetProjectOutput = z.object({
  project_id: z.string(),
  name: z.string(),
  version: z.number().int(),
  format_version: z.number().int(),
  main_composition_id: z.string(),
  style: z.object({ packId: z.string(), version: z.string() }).nullable(),
  assets: z.number().int(),
  compositions: z.array(
    z.object({
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

const LayerSummaryOutput = z.object({
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
    z.object({
      property: z.string(),
      keyframes: z.number().int(),
      first_frame: z.number(),
      last_frame: z.number(),
    }),
  ),
});

export const GetSceneOutput = z.object({
  project_id: z.string(),
  version: z.number().int(),
  detail: z.enum(["summary", "full"]),
  compositions: z
    .array(
      z.object({
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

export const FindLayersOutput = z.object({
  project_id: z.string(),
  version: z.number().int(),
  total: z.number().int(),
  layers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(LAYER_TYPES),
      composition: z.string(),
      index: z.number().int(),
    }),
  ),
});

export const GetLayerOutput = z.object({
  project_id: z.string(),
  version: z.number().int(),
  composition: z.string(),
  index: z.number().int(),
  layer: z.record(z.string(), z.unknown()),
});

export const GetLayerSchemaOutput = z.object({
  type: z.enum(LAYER_TYPES),
  schema: z.record(z.string(), z.unknown()),
});

export const WriteOutcomeOutput = z.object({
  status: z.enum(["applied", "rejected", "expired", "unknown"]),
  version: z.number().int().optional(),
  result: WriteOutput.omit({ replayed: true }).optional(),
  kind: z.string().optional(),
  message: z.string().optional(),
  errors: z.array(ErrorItem).optional(),
  current_version: z.number().int().optional(),
});
