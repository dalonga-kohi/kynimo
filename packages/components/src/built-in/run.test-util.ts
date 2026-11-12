import {
  assignUnits,
  evaluateFrame,
  hardLineStarts,
  type ResolvedComponentLayer,
  type ResolvedComposition,
  type ResolvedLayer,
  type ResolvedTextAnimator,
  type ResolvedTextLayer,
  rangeWeights,
  textClusters,
} from "@kynimo/engine";
import type { GuidelinePack } from "@kynimo/guidelines";
import { instance, type Obj, project } from "../fixtures.test-util.js";
import { createComponentHost } from "../host.js";

export interface RunOptions {
  /** Layer-local frame to evaluate. */
  frame?: number;
  /** Frames the instance lasts. */
  duration?: number;
  width?: number;
  height?: number;
  pack?: GuidelinePack | null;
  /** Id of the instance layer: it seeds the component's random numbers. */
  id?: string;
  /** Raw assets of the project (see `imageAsset`). */
  assets?: Obj[];
}

/** Evaluates one instance of a built-in component and returns the composition it drew. */
export function run(
  componentId: string,
  props: Obj = {},
  {
    frame = 0,
    duration = 150,
    width = 1920,
    height = 1080,
    pack = null,
    id = "inst",
    assets = [],
  }: RunOptions = {},
): ResolvedComposition {
  const doc = project(
    [instance(id, props, { componentId, componentVersion: "1.0.0", outFrame: duration })],
    { style: pack === null ? null : { packId: pack.id, version: pack.version }, assets },
    { width, height, durationFrames: Math.max(duration, 1) },
  );
  const out = evaluateFrame(doc, frame, undefined, { components: createComponentHost(doc) });
  const layer = out.layers[0] as ResolvedComponentLayer;
  if (layer.composition === null) throw new Error("the instance was not evaluated");
  return layer.composition;
}

/** The frames a matrix test visits for an instance of `duration` frames: first, early, middle and last. */
export const framesOf = (duration: number): number[] => [
  ...new Set([0, Math.floor(duration * 0.1), Math.floor(duration / 2), duration - 1]),
];

export const layerById = (comp: ResolvedComposition, id: string): ResolvedLayer | undefined =>
  comp.layers.find((l) => l.id === id);

export function textById(comp: ResolvedComposition, id: string): ResolvedTextLayer {
  const layer = layerById(comp, id);
  if (layer?.type !== "text") throw new Error(`no text layer '${id}'`);
  return layer;
}

/** The weight of every unit of a text layer under one of its animators (1 = fully selected). */
export function weightsOf(layer: ResolvedTextLayer, animator: ResolvedTextAnimator): number[] {
  const { count } = assignUnits(
    layer.content,
    textClusters(layer.content),
    animator.selector.unit,
    hardLineStarts(layer.content),
  );
  return rangeWeights(animator.selector, count);
}
