import { z } from "zod";
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

/** Video assets (pre-decoded to frames) are `v1.x`: adding that variant later is additive. */
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
]);
export type Asset = z.infer<typeof AssetSchema>;
