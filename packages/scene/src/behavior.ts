import { z } from "zod";
import { BehaviorIdSchema, LayerIdSchema } from "./ids.js";
import { MAX_FPS } from "./limits.js";
import {
  NameSchema,
  NonNegativeSchema,
  NumberSchema,
  PositiveSchema,
  Vec2Schema,
} from "./primitives.js";
import { animatable, TRANSFORM_PROPERTIES } from "./transform.js";

/**
 * Largest behavior `frequency`, in Hz: more than one cycle per frame at the highest frame rate
 * only aliases.
 */
const FrequencySchema = NonNegativeSchema.max(MAX_FPS);

/** Behaviors per layer. */
export const MAX_BEHAVIORS = 16;

/** The behavior kinds (ADR-0039). */
export const BEHAVIOR_TYPES = ["wiggle", "oscillate", "loop", "inertia", "link"] as const;
export type BehaviorType = (typeof BEHAVIOR_TYPES)[number];

/** Transform properties whose value is `[x, y]`; the others are a single number. */
export const VECTOR_TRANSFORM_PROPERTIES = ["anchorPoint", "position", "scale"] as const;

/** True when the transform property holds `[x, y]` rather than a number. */
export const isVectorTransformProperty = (property: string): boolean =>
  (VECTOR_TRANSFORM_PROPERTIES as readonly string[]).includes(property);

export const BehaviorPropertySchema = z.enum(TRANSFORM_PROPERTIES);

/**
 * A value that adds to a property: a number for `rotation`, `skew` and `opacity`, `[x, y]` for
 * `anchorPoint`, `position` and `scale`. The schema accepts either; the project check refuses
 * the one that does not match the behavior's `property`.
 */
export const BehaviorAmountSchema = animatable(z.union([NumberSchema, Vec2Schema]));

/** Fields every behavior has. `property` is the transform property the behavior drives. */
const base = {
  id: BehaviorIdSchema,
  name: NameSchema,
  /** Disabled behaviors are skipped by evaluation but still validated. */
  enabled: z.boolean(),
  property: BehaviorPropertySchema,
};

/**
 * Smooth random motion. `frequency` is wiggles per second; `amplitude` is the largest offset, in
 * the property's units (a number, or `[x, y]` for vector properties); `octaves` stacks finer
 * noise; `seed` picks the noise. `linked` (vector properties only) gives both axes the same noise.
 */
export const WiggleBehaviorSchema = z.strictObject({
  ...base,
  type: z.literal("wiggle"),
  frequency: animatable(FrequencySchema),
  amplitude: BehaviorAmountSchema,
  octaves: z.number().int().min(1).max(8),
  seed: z.number().int().min(0).max(0xffffffff),
  linked: z.boolean(),
});

/**
 * A repeating wave. `frequency` is in Hz, `amplitude` in the property's units, `phase` in degrees.
 */
export const OscillateBehaviorSchema = z.strictObject({
  ...base,
  type: z.literal("oscillate"),
  frequency: animatable(FrequencySchema),
  amplitude: BehaviorAmountSchema,
  phase: NumberSchema,
  waveform: z.enum(["sine", "triangle", "square", "sawtooth"]),
});

/**
 * Keeps the property's keyframes going past their ends. `direction` `in` acts before the first
 * keyframe, `out` after the last. `span` is how many keyframe segments at that end repeat
 * (0 = all of them).
 */
export const LoopBehaviorSchema = z.strictObject({
  ...base,
  type: z.literal("loop"),
  direction: z.enum(["in", "out"]),
  mode: z.enum(["cycle", "pingpong", "offset", "continue"]),
  span: z.number().int().min(0),
});

/**
 * Overshoot and settle after a keyframe lands. `amplitude` is the overshoot in seconds of travel at
 * the arrival speed, `frequency` is in Hz and `decay` is per second (higher settles sooner).
 */
export const InertiaBehaviorSchema = z.strictObject({
  ...base,
  type: z.literal("inertia"),
  amplitude: NonNegativeSchema,
  frequency: PositiveSchema.max(MAX_FPS),
  decay: NonNegativeSchema,
});

/**
 * Drives the property from another layer's property of the same kind, in the same composition:
 * `source × multiply + offset`. `offset` has the property's kind. `delay` is in frames: the source
 * is read that many frames earlier.
 */
export const LinkBehaviorSchema = z.strictObject({
  ...base,
  type: z.literal("link"),
  source: z.strictObject({ layer: LayerIdSchema, property: BehaviorPropertySchema }),
  multiply: NumberSchema,
  offset: z.union([NumberSchema, Vec2Schema]),
  delay: z.number().int().min(0),
});

export const BehaviorSchema = z.discriminatedUnion("type", [
  WiggleBehaviorSchema,
  OscillateBehaviorSchema,
  LoopBehaviorSchema,
  InertiaBehaviorSchema,
  LinkBehaviorSchema,
]);
export type Behavior = z.infer<typeof BehaviorSchema>;
export type WiggleBehavior = z.infer<typeof WiggleBehaviorSchema>;
export type OscillateBehavior = z.infer<typeof OscillateBehaviorSchema>;
export type LoopBehavior = z.infer<typeof LoopBehaviorSchema>;
export type InertiaBehavior = z.infer<typeof InertiaBehaviorSchema>;
export type LinkBehavior = z.infer<typeof LinkBehaviorSchema>;
