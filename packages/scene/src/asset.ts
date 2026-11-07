import { z } from "zod";
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

/** Video assets (pre-decoded to frames, ADR-0013) arrive with the asset pipeline: adding that variant is additive. */
export const AssetSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("image"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("audio"),
    durationMs: z.number().int().positive(),
  }),
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
export type Asset = z.infer<typeof AssetSchema>;
