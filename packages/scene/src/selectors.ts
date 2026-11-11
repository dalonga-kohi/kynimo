import { z } from "zod";
import type { Composition } from "./composition.js";
import { CompositionIdSchema, LayerIdSchema } from "./ids.js";
import type { Layer, LayerType } from "./layer.js";
import type { Project } from "./project.js";

const LAYER_TYPES = [
  "shape",
  "text",
  "image",
  "video",
  "solid",
  "generator",
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

/**
 * `*` matches any run of characters. Greedy two-pointer match with backtracking only to the last
 * star: O(name x pattern), no regex, so a hostile pattern cannot hang the server.
 */
export function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** All layers matching the selector, in document order. */
export function matchLayers(doc: Project, selector: LayerSelector): LayerRef[] {
  const matches: LayerRef[] = [];
  const name = typeof selector === "object" ? selector.name : undefined;
  for (const composition of doc.compositions) {
    if (typeof selector === "object" && selector.composition !== undefined) {
      if (composition.id !== selector.composition) continue;
    }
    composition.layers.forEach((layer, index) => {
      const ok =
        typeof selector === "string"
          ? layer.id === selector
          : (name === undefined || globMatch(name, layer.name)) &&
            (selector.type === undefined || layer.type === selector.type);
      if (ok) matches.push({ composition, index, layer });
    });
  }
  return matches;
}
