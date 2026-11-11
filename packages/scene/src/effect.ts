import { z } from "zod";
import { EffectIdSchema } from "./ids.js";
import { animatable } from "./keyframes.js";
import { ColorSchema, NameSchema, UnitIntervalSchema } from "./primitives.js";

export const MAX_EFFECTS = 8;
export const MAX_EFFECT_RADIUS = 48;
export const MAX_SHADOW_OFFSET = 256;
/** Largest red/blue channel separation of chromatic aberration, in px at the raster edge. */
export const MAX_ABERRATION = 32;
export const MAX_GRAIN_SIZE = 8;
export const MIN_POSTERIZE_LEVELS = 2;
export const MAX_POSTERIZE_LEVELS = 32;
export const MIN_SCANLINE_SPACING = 2;
export const MAX_SCANLINE_SPACING = 64;
export const MAX_SCANLINE_OFFSET = 8192;
export const MAX_VIGNETTE_RADIUS = 2;
export const MIN_VIGNETTE_FEATHER = 0.01;
export const MAX_VIGNETTE_FEATHER = 2;

const radius = animatable(z.number().min(0).max(MAX_EFFECT_RADIUS));
const amount = animatable(UnitIntervalSchema);
const color = animatable(ColorSchema);
const correction = animatable(z.number().min(-1).max(1));
const offset = z.number().min(-MAX_SHADOW_OFFSET).max(MAX_SHADOW_OFFSET);
const metadata = { name: NameSchema.optional(), enabled: z.boolean().optional() };

const bodies = [
  z.strictObject({ ...metadata, type: z.literal("gaussian-blur"), radius }),
  z.strictObject({
    ...metadata,
    type: z.literal("drop-shadow"),
    radius,
    offset: animatable(z.tuple([offset, offset])),
    color,
    opacity: amount,
  }),
  z.strictObject({ ...metadata, type: z.literal("glow"), radius, color, intensity: amount }),
  z.strictObject({
    ...metadata,
    type: z.literal("brightness-contrast"),
    brightness: correction,
    contrast: correction,
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("hue-saturation"),
    hue: animatable(z.number().min(-360).max(360)),
    saturation: correction,
  }),
  z.strictObject({ ...metadata, type: z.literal("tint"), black: color, white: color, amount }),
  z.strictObject({ ...metadata, type: z.literal("fill"), color, amount }),
  z.strictObject({
    ...metadata,
    type: z.literal("vignette"),
    amount,
    radius: animatable(z.number().min(0).max(MAX_VIGNETTE_RADIUS)),
    feather: animatable(z.number().min(MIN_VIGNETTE_FEATHER).max(MAX_VIGNETTE_FEATHER)),
    color,
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("grain"),
    amount,
    size: z.number().int().min(1).max(MAX_GRAIN_SIZE),
    seed: z.number().int().min(0).max(0xffffffff),
    animated: z.boolean(),
    monochrome: z.boolean(),
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("chromatic-aberration"),
    amount: animatable(z.number().min(0).max(MAX_ABERRATION)),
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("posterize"),
    levels: animatable(z.number().min(MIN_POSTERIZE_LEVELS).max(MAX_POSTERIZE_LEVELS)),
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("scanlines"),
    amount,
    spacing: animatable(z.number().min(MIN_SCANLINE_SPACING).max(MAX_SCANLINE_SPACING)),
    thickness: amount,
    offset: animatable(z.number().min(-MAX_SCANLINE_OFFSET).max(MAX_SCANLINE_OFFSET)),
    color,
  }),
] as const;

/** The authoring body. Parameters are sampled in layer-local frames. */
export const EffectInputSchema = z.discriminatedUnion("type", bodies);
export type EffectInput = z.infer<typeof EffectInputSchema>;

const [blur, ...otherEffects] = bodies;
export const EffectSchema = z.discriminatedUnion("type", [
  blur.extend({ id: EffectIdSchema }),
  ...otherEffects.map((body) => body.extend({ id: EffectIdSchema })),
]);
export type Effect = z.infer<typeof EffectSchema>;
export const EffectStackSchema = z.array(EffectSchema).max(MAX_EFFECTS);
