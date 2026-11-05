import { z } from "zod";
import { AssetIdSchema } from "./ids.js";
import { NameSchema } from "./primitives.js";

const base = {
  id: AssetIdSchema,
  name: NameSchema,
  /** Opaque storage location; the asset store resolves it. */
  uri: z.string().min(1),
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
