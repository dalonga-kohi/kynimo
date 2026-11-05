import { z } from "zod";

/**
 * Ids are opaque, lowercase, caller-supplied strings. Operations generate them
 * from a seeded counter (never random), so they stay deterministic and readable
 * in agent output. Layer ids are unique across the whole project.
 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const ID_MESSAGE =
  "must be 1-64 characters: lowercase letters, digits, '-' or '_', starting with a letter or digit";

const id = <B extends string>(_brand: B) => z.string().regex(ID_PATTERN, ID_MESSAGE).brand<B>();

export const AssetIdSchema = id("AssetId");
export type AssetId = z.infer<typeof AssetIdSchema>;

export const CompositionIdSchema = id("CompositionId");
export type CompositionId = z.infer<typeof CompositionIdSchema>;

export const LayerIdSchema = id("LayerId");
export type LayerId = z.infer<typeof LayerIdSchema>;

/** Id of an item inside a shape layer's contents tree. Unique within its layer. */
export const ShapeItemIdSchema = id("ShapeItemId");
export type ShapeItemId = z.infer<typeof ShapeItemIdSchema>;
