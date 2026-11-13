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
  /** uint32 seed derived from the document: hashWords(parentSeed, UTF-16 code units of layer.id); parentSeed is 0 in a document composition, else the enclosing instance's seed. */
  seed: number;
  /** Component nesting depth of this instance: 1 for an instance in a document composition. */
  depth: number;
}

/**
 * Turns a component instance into the subtree it draws, so the engine needs no knowledge of
 * components, packs or props (ADR-0012). Must be pure and deterministic in its arguments.
 */
export interface ComponentHost {
  /** Statically bounded program work charged to the frame before evaluation. */
  work?(layer: ComponentLayer): number;
  /**
   * Returns the instance's subtree for `ctx.frame` as a composition that already passed validation.
   * Throws RangeError with a clear message on an unknown component or invalid props.
   */
  evaluate(layer: ComponentLayer, ctx: ComponentContext): Composition;
}

/** Most component instances that may nest inside one another (an instance in a component's output). */
export const MAX_COMPONENT_DEPTH = 4;

/**
 * A component's output costs this many times what a plain evaluated layer does, because the host
 * validates it with the scene schema on top of evaluating it. Measured: about 17.5 ms per
 * 1000-layer instance against about 1.2 ms for a precomp of the same size.
 */
export const COMPONENT_COST_WEIGHT = 16;
