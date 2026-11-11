import {
  EffectIdSchema,
  type EffectInput,
  EffectInputSchema,
  type Layer,
  LayerSelectorSchema,
  MAX_EFFECTS,
  matchLayers,
  type Op,
  type Project,
} from "@kynimo/scene";
import { z } from "zod";
import { IntentError } from "./errors.js";

export const AddEffectInputSchema = z.strictObject({
  layer: LayerSelectorSchema,
  effect: EffectInputSchema,
  id: EffectIdSchema.optional(),
  index: z.number().int().nonnegative().optional(),
});

type AddEffectInput = z.infer<typeof AddEffectInputSchema>;
type SetEffects = Extract<Op, { op: "setEffects" }>;

/** Insert one effect without changing the order or identity of the existing effects. */
export function insertEffect(
  layer: Layer,
  effect: EffectInput,
  requestedId?: AddEffectInput["id"],
  index?: number,
): { op: SetEffects; id: NonNullable<AddEffectInput["id"]>; index: number } {
  if (!("effects" in layer))
    throw new IntentError(
      ["layer"],
      `'${layer.id}' is a ${layer.type} layer; use a drawing or adjustment layer`,
    );
  const stack = layer.effects;
  if (stack.length >= MAX_EFFECTS)
    throw new IntentError(
      ["effect"],
      `'${layer.id}' already has the maximum of ${MAX_EFFECTS} effects; remove one first`,
    );
  const at = index ?? stack.length;
  if (at > stack.length)
    throw new IntentError(["index"], `choose an index from 0 through ${stack.length}`);
  const taken = new Set<string>(stack.map((item) => item.id));
  if (requestedId !== undefined && taken.has(requestedId))
    throw new IntentError(
      ["id"],
      `'${requestedId}' is already in use on '${layer.id}'; choose a different id`,
    );
  let sequence = 1;
  while (taken.has(`effect-${sequence}`)) sequence++;
  const id = requestedId ?? EffectIdSchema.parse(`effect-${sequence}`);
  const effects = [...stack];
  effects.splice(at, 0, { ...effect, id });
  return { op: { op: "setEffects", layer: layer.id, effects }, id, index: at };
}

export function addEffect(doc: Project, input: AddEffectInput) {
  const layers = matchLayers(doc, input.layer);
  const target = layers[0];
  if (target === undefined || layers.length !== 1)
    throw new IntentError(
      ["layer"],
      `selector matched ${layers.length} layers; supply the id of one layer`,
    );
  const { op, id, index } = insertEffect(target.layer, input.effect, input.id, input.index);
  return {
    ops: [op],
    resolved: { layer: target.layer.id, effect_id: id, index },
  };
}
