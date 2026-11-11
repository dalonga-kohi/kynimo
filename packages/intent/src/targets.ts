import { type Composition, type Layer, matchLayers, type Project } from "@kynimo/scene";
import { type InputPath, IntentError } from "./errors.js";
import { MAX_TARGETS, type TargetsInput } from "./style.js";

export interface Target {
  composition: Composition;
  layer: Layer;
  /** Where the selector that matched this layer sits in the tool input. */
  path: InputPath;
}

/**
 * The layers a request addresses. Every selector must match at least one layer; matches are
 * deduped by id in the order given (document order within one selector); all layers must be in
 * one composition; at most {@link MAX_TARGETS} in total.
 */
export function resolveTargets(
  doc: Project,
  input: TargetsInput,
  base: InputPath = ["layers"],
): Target[] {
  const selectors = Array.isArray(input) ? input : [input];
  const seen = new Set<string>();
  const targets: Target[] = [];
  selectors.forEach((selector, i) => {
    const path = Array.isArray(input) ? [...base, i] : base;
    const matches = matchLayers(doc, selector);
    if (matches.length === 0) throw new IntentError(path, "no layer matches this selector");
    for (const m of matches) {
      if (seen.has(m.layer.id)) continue;
      seen.add(m.layer.id);
      targets.push({ composition: m.composition, layer: m.layer, path });
    }
  });
  if (targets.length > MAX_TARGETS)
    throw new IntentError(
      base,
      `at most ${MAX_TARGETS} layers per call (matched ${targets.length})`,
    );
  const first = targets[0];
  if (first !== undefined) {
    const other = targets.find((t) => t.composition.id !== first.composition.id);
    if (other !== undefined)
      throw new IntentError(
        other.path,
        `layers must share one composition ('${other.layer.id}' is in '${other.composition.id}', '${first.layer.id}' in '${first.composition.id}')`,
      );
  }
  return targets;
}
