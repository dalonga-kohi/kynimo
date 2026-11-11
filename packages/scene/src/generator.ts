import { z } from "zod";
import { animatable } from "./keyframes.js";
import { ColorSchema, UnitIntervalSchema, Vec2Schema } from "./primitives.js";
import { sameLengthCheck } from "./shape.js";

export const MAX_GENERATOR_STOPS = 16;
export const MAX_AURORA_COLORS = 4;
export const MAX_NOISE_OCTAVES = 6;
export const MAX_GENERATOR_EVOLUTION = 1000;
export const MAX_GENERATOR_OFFSET = 8192;

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

/** A procedural source that fills a generator layer. Points and sizes are in layer pixels. */
export const GeneratorSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("gradient"),
    kind: z.enum(["linear", "radial", "conic"]),
    start: animatable(Vec2Schema),
    end: animatable(Vec2Schema),
    stops: animatable(GeneratorStopsSchema, sameLengthCheck("gradient stops")),
  }),
  z.strictObject({
    type: z.literal("noise"),
    seed,
    /** Pixels per lattice cell. */
    scale: animatable(z.number().min(8).max(4096)),
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
    size: animatable(z.number().min(2).max(2048)),
    thickness: animatable(UnitIntervalSchema),
    /** Degrees, clockwise on screen. */
    angle: animatable(z.number().min(-3600).max(3600)),
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
