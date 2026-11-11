import { z } from "zod";
import { animatable } from "./keyframes.js";
import { ColorSchema, UnitIntervalSchema } from "./primitives.js";
import { sameLengthCheck } from "./shape.js";

export const MAX_GENERATOR_STOPS = 16;
export const MAX_AURORA_COLORS = 4;
export const MAX_NOISE_OCTAVES = 6;
export const MAX_GENERATOR_EVOLUTION = 1000;
export const MAX_GENERATOR_OFFSET = 8192;
/** Gradient start and end points stay within this many layer pixels of the origin. */
export const MAX_GENERATOR_POINT = 65536;
export const MIN_NOISE_SCALE = 8;
export const MAX_NOISE_SCALE = 4096;
export const MIN_PATTERN_SIZE = 2;
export const MAX_PATTERN_SIZE = 2048;
export const MAX_PATTERN_ANGLE = 3600;

const GeneratorStopsSchema = z
  .array(z.strictObject({ offset: UnitIntervalSchema, color: ColorSchema }))
  .min(2)
  .max(MAX_GENERATOR_STOPS)
  .refine(
    (stops) => stops.every((stop, i) => i === 0 || stop.offset >= (stops[i - 1]?.offset ?? 0)),
    { message: "gradient stops must be in non-decreasing offset order" },
  );

const seed = z.number().int().min(0).max(0xffffffff);
const color = animatable(ColorSchema);
const evolution = animatable(z.number().min(-MAX_GENERATOR_EVOLUTION).max(MAX_GENERATOR_EVOLUTION));
const axis = z.number().min(-MAX_GENERATOR_OFFSET).max(MAX_GENERATOR_OFFSET);
const offset = animatable(z.tuple([axis, axis]));
const pointAxis = z.number().min(-MAX_GENERATOR_POINT).max(MAX_GENERATOR_POINT);
const point = animatable(z.tuple([pointAxis, pointAxis]));

/** A procedural source that fills a generator layer. Points and sizes are in layer pixels. */
export const GeneratorSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("gradient"),
    kind: z.enum(["linear", "radial", "conic"]),
    start: point,
    end: point,
    stops: animatable(GeneratorStopsSchema, sameLengthCheck("gradient stops")),
  }),
  z.strictObject({
    type: z.literal("noise"),
    seed,
    /** Pixels per lattice cell. */
    scale: animatable(z.number().min(MIN_NOISE_SCALE).max(MAX_NOISE_SCALE)),
    octaves: z.number().int().min(1).max(MAX_NOISE_OCTAVES),
    evolution,
    offset,
    low: color,
    high: color,
  }),
  z.strictObject({
    type: z.literal("pattern"),
    kind: z.enum(["stripes", "checker", "dots", "grid"]),
    /** Period in pixels. */
    size: animatable(z.number().min(MIN_PATTERN_SIZE).max(MAX_PATTERN_SIZE)),
    thickness: animatable(UnitIntervalSchema),
    /** Degrees, clockwise on screen. */
    angle: animatable(z.number().min(-MAX_PATTERN_ANGLE).max(MAX_PATTERN_ANGLE)),
    offset,
    foreground: color,
    background: color,
  }),
  z.strictObject({
    type: z.literal("aurora"),
    seed,
    colors: z.array(color).min(2).max(MAX_AURORA_COLORS),
    /** One unit is one full loop. */
    evolution,
    softness: animatable(UnitIntervalSchema),
  }),
]);
export type Generator = z.infer<typeof GeneratorSchema>;
