import { z } from "zod";
import type { Composition } from "./composition.js";
import { CompositionIdSchema, LayerIdSchema } from "./ids.js";
import type { Layer, LayerType } from "./layer.js";
import type { Project } from "./project.js";

const LAYER_TYPES = [
  "shape",
  "text",
  "image",
  "solid",
  "null",
  "precomp",
  "adjustment",
  "component",
  "audio",
] as const satisfies readonly LayerType[];

/**
 * Addresses one layer: a bare string is a layer id; an object matches on any combination of
 * `name` (case-sensitive, `*` matches any run of characters), `type` and `composition`.
 * Operations need exactly one match; the change record always stores the concrete id.
 */
export const LayerSelectorSchema = z.union([
  LayerIdSchema,
  z
    .strictObject({
      name: z.string().min(1).max(200).optional(),
      type: z.enum(LAYER_TYPES).optional(),
      composition: CompositionIdSchema.optional(),
    })
    .refine(
      (s) => Object.keys(s).length > 0,
      "a selector object needs at least one of 'name', 'type', 'composition'",
    ),
]);
export type LayerSelector = z.infer<typeof LayerSelectorSchema>;

export interface LayerRef {
  composition: Composition;
  index: number;
  layer: Layer;
}

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s\\S]*")}$`,
  );

/** All layers matching the selector, in document order. */
export function matchLayers(doc: Project, selector: LayerSelector): LayerRef[] {
  const matches: LayerRef[] = [];
  const nameTest =
    typeof selector === "object" && selector.name !== undefined
      ? globToRegExp(selector.name)
      : undefined;
  for (const composition of doc.compositions) {
    if (typeof selector === "object" && selector.composition !== undefined) {
      if (composition.id !== selector.composition) continue;
    }
    composition.layers.forEach((layer, index) => {
      const ok =
        typeof selector === "string"
          ? layer.id === selector
          : (nameTest === undefined || nameTest.test(layer.name)) &&
            (selector.type === undefined || layer.type === selector.type);
      if (ok) matches.push({ composition, index, layer });
    });
  }
  return matches;
}
