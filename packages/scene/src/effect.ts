import { z } from "zod";
import { EffectIdSchema } from "./ids.js";
import { animatable } from "./keyframes.js";
import { ColorSchema, NameSchema, UnitIntervalSchema } from "./primitives.js";

export const MAX_EFFECTS = 8;
export const MAX_EFFECT_RADIUS = 48;
export const MAX_SHADOW_OFFSET = 256;

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
