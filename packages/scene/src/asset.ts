import { z } from "zod";
import { FrameRateSchema } from "./composition.js";
import { FontFamilySchema, FontWeightSchema } from "./fonts.js";
import { AssetIdSchema } from "./ids.js";
import { NameSchema } from "./primitives.js";

const base = {
  id: AssetIdSchema,
  name: NameSchema,
  /**
   * Store-relative key (no scheme, no `..`), resolved by the asset store. Never a URL or
   * filesystem path, so a renderer or worker cannot be pointed at arbitrary hosts or files.
   */
  uri: z
    .string()
    .max(512)
    .regex(/^assets(\/[a-z0-9][a-z0-9_.-]*)+$/, "must be a store key like 'assets/logo.png'")
    .refine((u) => !u.includes("..") && !u.includes("//"), "must not contain '..' or '//'"),
  /** Content hash pins the exact bytes, so the same document renders the same pixels. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256"),
};

/** Most beats an audio asset stores (ADR-0052). */
export const MAX_BEATS = 1000;

const AudioBeatsSchema = z.strictObject({
  bpm: z.number().min(20).max(400),
  confidence: z.number().min(0).max(1),
  timesMs: z.array(z.number().int().nonnegative()).max(MAX_BEATS),
});
export type AudioBeats = z.infer<typeof AudioBeatsSchema>;

const audioShape = z.strictObject({
  ...base,
  type: z.literal("audio"),
  durationMs: z.number().int().positive(),
  /** Beats detected at upload (ADR-0052). Absent: uploaded before format 10, or no steady beat found. */
  beats: AudioBeatsSchema.optional(),
});

/**
 * Cross-field rules of an audio asset's beats. A function, not a refinement on the variant, because
 * zod cannot `.omit()` a refined object and asset ops derive an id-less input schema from the variants.
 */
export function checkAudioBeats(
  a: { durationMs: number; beats?: { timesMs: number[] } | undefined },
  ctx: z.core.$RefinementCtx,
): void {
  const times = a.beats?.timesMs ?? [];
  const issue = (message: string) =>
    ctx.addIssue({ code: "custom", path: ["beats", "timesMs"], message });
  if (times.some((t, i) => i > 0 && t <= (times[i - 1] as number)))
    issue("beats.timesMs must be strictly ascending");
  if (times.some((t) => t >= a.durationMs)) issue("beats.timesMs must be before durationMs");
}

export const AssetShapeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("image"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  /**
   * Footage, decoded at upload to constant-rate frames (ADR-0013, ADR-0032). `uri` and `sha256`
   * name the frame manifest, which pins every frame's bytes by hash; frame `n` shows at source
   * time n / fps.
   */
  z.strictObject({
    ...base,
    type: z.literal("video"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: FrameRateSchema,
    frameCount: z.number().int().positive(),
  }),
  audioShape,
  /**
   * A TrueType or OpenType font file (ADR-0019). Text layers name it by `family`. `weight` is the
   * range the file covers: one weight for a static font, the `wght` axis range for a variable font,
   * which is then set to the requested weight.
   */
  z.strictObject({
    ...base,
    type: z.literal("font"),
    family: FontFamilySchema,
    weight: z
      .strictObject({ min: FontWeightSchema, max: FontWeightSchema })
      .refine((w) => w.min <= w.max, "weight.min must not exceed weight.max"),
  }),
]);
export const AssetSchema = AssetShapeSchema.superRefine((a, ctx) => {
  if (a.type === "audio") checkAudioBeats(a, ctx);
});
export type Asset = z.infer<typeof AssetSchema>;
