import { z } from "zod";
import { animatable } from "./keyframes.js";
import { UnitIntervalSchema } from "./primitives.js";

/** Largest soft-edge width of a wipe or iris, in composition pixels. */
export const MAX_TRANSITION_FEATHER = 4096;
/** Largest magnitude of a transition center, in composition pixels. */
export const MAX_TRANSITION_POINT = 65536;
/** Largest magnitude of a transition angle, in degrees. */
export const MAX_TRANSITION_ANGLE = 3600;
export const MIN_PIXELATE_CELL = 2;
export const MAX_PIXELATE_CELL = 512;
export const MIN_NOISE_DISSOLVE_SCALE = 1;
export const MAX_NOISE_DISSOLVE_SCALE = 512;
export const MAX_ZOOM_STRENGTH = 8;
export const MIN_BLINDS = 2;
export const MAX_BLINDS = 128;
export const MIN_GLITCH_BANDS = 2;
export const MAX_GLITCH_BANDS = 256;
export const MAX_CLOCK_FEATHER = 180;

export const TRANSITION_KINDS = [
  "dissolve",
  "noise-dissolve",
  "wipe",
  "clock",
  "iris",
  "blinds",
  "pixelate",
  "push",
  "zoom",
  "glitch",
] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

const progress = animatable(UnitIntervalSchema);
const unit = animatable(UnitIntervalSchema);
const angle = animatable(z.number().min(-MAX_TRANSITION_ANGLE).max(MAX_TRANSITION_ANGLE));
const coordinate = z.number().min(-MAX_TRANSITION_POINT).max(MAX_TRANSITION_POINT);
const point = animatable(z.tuple([coordinate, coordinate]));
const featherPx = animatable(z.number().min(0).max(MAX_TRANSITION_FEATHER));
const seed = z.number().int().min(0).max(0xffffffff);

/**
 * A built-in shader transition on a drawn layer. Input A is everything composited beneath the
 * layer, input B is the layer composited normally over A, and the output is T(A, B, progress):
 * progress 0 is exactly A (layer invisible), 1 is exactly B (as if there were no transition).
 * Angles are degrees, clockwise on screen, 0 pointing toward +x unless noted. Points and pixel
 * sizes are in composition pixels.
 */
export const TransitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("dissolve"), progress }),
  z.strictObject({
    kind: z.literal("noise-dissolve"),
    progress,
    seed,
    /** Pixels per noise cell. */
    scale: animatable(z.number().min(MIN_NOISE_DISSOLVE_SCALE).max(MAX_NOISE_DISSOLVE_SCALE)),
    feather: unit,
  }),
  z.strictObject({
    kind: z.literal("wipe"),
    progress,
    /** Direction of travel. */
    angle,
    feather: featherPx,
  }),
  z.strictObject({
    kind: z.literal("clock"),
    progress,
    /** 0 is 12 o'clock, clockwise positive. */
    startAngle: angle,
    clockwise: z.boolean(),
    center: point,
    /** Degrees. */
    feather: animatable(z.number().min(0).max(MAX_CLOCK_FEATHER)),
  }),
  z.strictObject({
    kind: z.literal("iris"),
    progress,
    shape: z.enum(["circle", "diamond", "square"]),
    center: point,
    feather: featherPx,
  }),
  z.strictObject({
    kind: z.literal("blinds"),
    progress,
    count: z.number().int().min(MIN_BLINDS).max(MAX_BLINDS),
    /** Direction the slats open toward. */
    angle,
    /** Fraction of one slat. */
    feather: unit,
  }),
  z.strictObject({
    kind: z.literal("pixelate"),
    progress,
    /** Largest cell size in pixels, reached at progress 0.5. */
    cell: animatable(z.number().min(MIN_PIXELATE_CELL).max(MAX_PIXELATE_CELL)),
  }),
  z.strictObject({
    kind: z.literal("push"),
    progress,
    /** Direction B travels in. */
    angle,
  }),
  z.strictObject({
    kind: z.literal("zoom"),
    progress,
    center: point,
    strength: animatable(z.number().min(0).max(MAX_ZOOM_STRENGTH)),
  }),
  z.strictObject({
    kind: z.literal("glitch"),
    progress,
    seed,
    bands: z.number().int().min(MIN_GLITCH_BANDS).max(MAX_GLITCH_BANDS),
    amount: unit,
  }),
]);
export type Transition = z.infer<typeof TransitionSchema>;
