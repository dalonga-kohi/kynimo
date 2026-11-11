import type { ComponentLayer, Composition, FrameRate } from "@kynimo/scene";

/** Everything the engine tells a component host about one instance on one frame. */
export interface ComponentContext {
  /** Layer-local frame (composition frame - layer.startFrame), >= 0. */
  frame: number;
  /** The containing composition's frame rate. */
  fps: FrameRate;
  /** layer.outFrame - layer.startFrame: frames from the instance's start to its out point. */
  durationFrames: number;
  /** Size of the containing composition. */
  width: number;
  height: number;
  /** uint32 seed derived from the document: hashWords(0, UTF-16 code units of layer.id). */
  seed: number;
  /** Component nesting depth of this instance: 1 for an instance in a document composition. */
  depth: number;
}

/**
 * Turns a component instance into the subtree it draws, so the engine needs no knowledge of
 * components, packs or props (ADR-0012). Must be pure and deterministic in its arguments.
 */
export interface ComponentHost {
  /**
   * Returns the instance's subtree for `ctx.frame` as a composition that already passed validation.
   * Throws RangeError with a clear message on an unknown component or invalid props.
   */
  evaluate(layer: ComponentLayer, ctx: ComponentContext): Composition;
}

/** Most component instances that may nest inside one another (an instance in a component's output). */
export const MAX_COMPONENT_DEPTH = 4;
