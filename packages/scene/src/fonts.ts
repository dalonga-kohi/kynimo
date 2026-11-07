import { z } from "zod";

/**
 * Font families every Kynimo build ships, pinned by hash in the renderer (ADR-0019). Documents
 * depend on these names, so the list is part of the scene format: adding a family is additive,
 * removing or renaming one is a breaking format change.
 */
export const BUNDLED_FONT_FAMILIES = ["Inter", "Noto Sans"] as const;
export type BundledFontFamily = (typeof BUNDLED_FONT_FAMILIES)[number];

/** Draws characters the requested font lacks (ADR-0019); system fonts are never consulted. */
export const FALLBACK_FONT_FAMILY: BundledFontFamily = "Noto Sans";

export const isBundledFontFamily = (family: string): family is BundledFontFamily =>
  (BUNDLED_FONT_FAMILIES as readonly string[]).includes(family);

/** A family name as text layers and font assets spell it. Matched exactly, case included. */
export const FontFamilySchema = z
  .string()
  .min(1)
  .max(100)
  .refine((f) => f.trim() === f, "must not start or end with whitespace");

/** CSS-style font weight, 100–900 in steps of 100. */
export const FontWeightSchema = z.number().int().min(100).max(900).multipleOf(100);
