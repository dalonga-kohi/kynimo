import { z } from "zod";
import { EffectIdSchema } from "./ids.js";
import { animatable } from "./keyframes.js";
import { ColorSchema, NameSchema, UnitIntervalSchema } from "./primitives.js";

export const MAX_EFFECTS = 8;
export const MAX_EFFECT_RADIUS = 48;
export const MAX_SHADOW_OFFSET = 256;
/** Largest red/blue channel separation of chromatic aberration, in px at the raster edge. */
export const MAX_ABERRATION = 32;

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
    radius: animatable(z.number().min(0).max(2)),
    feather: animatable(z.number().min(0.01).max(2)),
    color,
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("grain"),
    amount,
    size: z.number().int().min(1).max(8),
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
    levels: animatable(z.number().min(2).max(32)),
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("scanlines"),
    amount,
    spacing: animatable(z.number().min(2).max(64)),
    thickness: amount,
    offset: animatable(z.number().min(-8192).max(8192)),
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
