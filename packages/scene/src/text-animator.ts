import { z } from "zod";
import {
  ColorSchema,
  NameSchema,
  NonNegativeSchema,
  NumberSchema,
  UnitIntervalSchema,
  Vec2Schema,
} from "./primitives.js";
import { animatable } from "./transform.js";

/** Animators per text layer. */
export const MAX_TEXT_ANIMATORS = 8;

/** What a range selector counts: the unit its start and end fractions divide the text into. */
export const RANGE_UNITS = ["characters", "words", "lines"] as const;

/** The weight profile across the selected range (ADR-0038). */
export const RANGE_SHAPES = [
  "square",
  "ramp-up",
  "ramp-down",
  "triangle",
  "round",
  "smooth",
] as const;

/** Which unit the range reaches first. `random` is a seeded shuffle of the units. */
export const RANGE_ORDERS = ["forward", "reverse", "center-out", "edges-in", "random"] as const;

/**
 * Chooses how much of an animator applies to each unit of text (ADR-0038). `start`, `end` and
 * `offset` are fractions of the text, 0 at the first unit and 1 past the last; the selected
 * window runs from the smaller of `start` and `end` to the larger, shifted by `offset`. Units
 * the window only partly covers are partly selected, so sweeping `end` fades characters in one
 * by one. `easeHigh` and `easeLow` soften the top and bottom of the weight curve.
 */
export const RangeSelectorSchema = z.strictObject({
  unit: z.enum(RANGE_UNITS),
  start: animatable(UnitIntervalSchema),
  end: animatable(UnitIntervalSchema),
  offset: animatable(NumberSchema),
  shape: z.enum(RANGE_SHAPES),
  easeHigh: animatable(UnitIntervalSchema),
  easeLow: animatable(UnitIntervalSchema),
  order: z.enum(RANGE_ORDERS),
  /** Seeds the shuffle of `random` order; any order ignores it. */
  seed: z.number().int().min(0).max(0x7fffffff),
  /** Scales every weight; negative values push the properties the other way. */
  amount: animatable(z.number().min(-1).max(1)),
});
export type RangeSelector = z.infer<typeof RangeSelectorSchema>;

/**
 * What a selected unit changes, each at full weight. Absent properties change nothing.
 * `position` and `rotation` (degrees) add; `scale` and `opacity` are ratios the unit's own
 * value moves toward as its weight grows (1 = unchanged); `fill` blends toward the color;
 * `blur` (layer units) and `tracking` (thousandths of an em) add.
 */
export const AnimatorPropertiesSchema = z.strictObject({
  position: animatable(Vec2Schema).optional(),
  scale: animatable(Vec2Schema).optional(),
  rotation: animatable(NumberSchema).optional(),
  opacity: animatable(UnitIntervalSchema).optional(),
  fill: animatable(ColorSchema).optional(),
  blur: animatable(NonNegativeSchema).optional(),
  tracking: animatable(NumberSchema).optional(),
});
export type AnimatorProperties = z.infer<typeof AnimatorPropertiesSchema>;

export const TextAnimatorSchema = z.strictObject({
  name: NameSchema,
  selector: RangeSelectorSchema,
  properties: AnimatorPropertiesSchema,
});
export type TextAnimator = z.infer<typeof TextAnimatorSchema>;
