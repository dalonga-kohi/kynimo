import type { BlendMode, Json, MaskMode, TrackMatte } from "@kynimo/scene";
import type { Affine } from "./affine.js";
import type { Rgba } from "./color.js";
import type { ResolvedEffect } from "./effect.js";
import type { ResolvedGenerator } from "./generator.js";
import type { Projective } from "./projective.js";

export type { ResolvedEffect } from "./effect.js";
export type { ResolvedGenerator } from "./generator.js";

import type { ResolvedTextAnimator } from "./text-animator.js";

/**
 * The output of {@link evaluateFrame}: plain values only, no tracks. Everything the renderer
 * needs to draw one frame, and nothing that can change between two evaluations of it.
 * The whole tree is read-only: it shares objects with the document (constant positions, dash
 * arrays, component props) and between precomp instances, so copy before changing anything.
 */

export type Point = readonly [number, number];

/**
 * Sampled local transform values, clamped to their domains (opacity 0..1, skew ±85°).
 * `positionZ`, `rotationX` and `rotationY` are sampled for every layer but only act on 3D layers
 * and cameras (ADR-0054); they are 0 for shape groups.
 */
export interface ResolvedTransform {
  anchorPoint: Point;
  position: Point;
  positionZ: number;
  scale: Point;
  rotation: number;
  rotationX: number;
  rotationY: number;
  skew: number;
  opacity: number;
}

export interface ResolvedComposition {
  id: string;
  width: number;
  height: number;
  fps: { num: number; den: number };
  /** The composition frame that was evaluated. */
  frame: number;
  /** Only the evaluated root composition has one; nested compositions render transparent, as in After Effects. */
  background: Rgba | null;
  /** Visual layers that draw on this frame, top-first. Null layers and hidden, unsoloed or out-of-range layers are left out. */
  layers: ResolvedLayer[];
  /** Audio layers that play on this frame. Mixing is the export pipeline's job (M7). */
  audio: ResolvedAudio[];
}

/**
 * The layer at one shutter sample (ADR-0053): its layer → composition matrix and its own
 * (transform) opacity at that sub-frame time.
 */
export interface MotionSample {
  /** For a 3D layer, an approximation of `projection`: see {@link LayerBase.matrix}. */
  matrix: Affine;
  /** The sample's {@link LayerBase.projection}: `null` for a 2D layer. Camera motion is sampled at the same time. */
  projection: Projective | null;
  opacity: number;
}

interface LayerBase {
  id: string;
  name: string;
  /** Content time: `frame - startFrame`. Keyframes were sampled at this frame. */
  layerFrame: number;
  /** The layer's own transform. Opacity is not inherited from parents (After Effects parenting). */
  transform: ResolvedTransform;
  /**
   * Layer space → composition space, including every parent's transform. For a 3D layer this is
   * approximate (the first-order affine approximation of `projection` at the layer's anchor point,
   * or the 2D world matrix when the anchor is behind the camera): use `projection` when non-null.
   */
  matrix: Affine;
  /**
   * 3D layers only (ADR-0054): layer space (the z = 0 plane) → composition pixels through the
   * active camera, with `W` the camera-space depth. Never normalized. `null` for a 2D layer.
   */
  projection: Projective | null;
  /** How the layer combines with what is below it (ADR-0020). Ignored while it serves as a matte. */
  blendMode: BlendMode;
  /** Active masks in document order (`none` masks are left out). Empty: the layer is unmasked. */
  masks: ResolvedMask[];
  /** Active effects in document order, with parameters sampled in layer time. */
  effects: ResolvedEffect[];
  matte: ResolvedMatte | null;
  /**
   * Transform motion blur: the layer's placements at the shutter samples, in time order, to be drawn
   * and averaged. `null` when blur is off, the shutter angle is 0 or the layer is an adjustment layer.
   * Visibility, range and content are decided at `frame`, not per sample.
   */
  motion: readonly MotionSample[] | null;
}

/**
 * A mask sampled at the layer's frame, in layer space. `feather` is a per-axis blur width and
 * `expansion` grows (positive) or shrinks (negative) the path, both in layer units.
 */
export interface ResolvedMask {
  id: string;
  mode: Exclude<MaskMode, "none">;
  inverted: boolean;
  path: ResolvedBezierPath;
  feather: Point;
  opacity: number;
  expansion: number;
}

/**
 * The layer whose alpha or luma mattes this one, resolved at this frame with its own masks and
 * matte. It is resolved even when it is hidden or unsoloed (it may not be in the composition's
 * `layers`); `source` is `null` when the frame is outside its in/out range, which is an empty matte.
 * A layer that is both drawn and used as a matte is one shared object.
 */
export interface ResolvedMatte {
  layerId: string;
  mode: TrackMatte["mode"];
  source: ResolvedLayer | null;
}

export interface ResolvedShapeLayer extends LayerBase {
  type: "shape";
  contents: ResolvedShapeItem[];
}

export interface ResolvedTextLayer extends LayerBase {
  type: "text";
  content: string;
  box: { mode: "point" } | { mode: "box"; width: number; height: number; autoFit: boolean };
  font: { family: string; weight: number; size: number };
  tracking: number;
  leading: number;
  align: "left" | "center" | "right" | "justify";
  textCase: "none" | "upper" | "lower";
  fill: Rgba;
  /** Sampled animators in list order; empty draws the layer as one paragraph (ADR-0038). */
  animators: ResolvedTextAnimator[];
}

export interface ResolvedImageLayer extends LayerBase {
  type: "image";
  assetId: string;
}

/** Footage at one source frame; `sourceFrame` is null when the layer time is outside the clip. */
export interface ResolvedVideoLayer extends LayerBase {
  type: "video";
  assetId: string;
  sourceFrame: number | null;
}

export interface ResolvedSolidLayer extends LayerBase {
  type: "solid";
  width: number;
  height: number;
  color: Rgba;
}

/** A procedural source of `width` x `height` layer units, sampled at the layer's frame. */
export interface ResolvedGeneratorLayer extends LayerBase {
  type: "generator";
  width: number;
  height: number;
  generator: ResolvedGenerator;
}

export interface ResolvedPrecompLayer extends LayerBase {
  type: "precomp";
  compositionId: string;
  /**
   * The referenced composition at its local frame, or `null` when that frame falls outside it.
   * Precomps shown at the same local frame share one object: treat it as read-only.
   */
  composition: ResolvedComposition | null;
}

/** Filters the accumulated pixels below it in the same composition. */
export interface ResolvedAdjustmentLayer extends LayerBase {
  type: "adjustment";
}

/** A component instance: its pinned reference and raw props, plus the subtree the host evaluated for it. */
export interface ResolvedComponentLayer extends LayerBase {
  type: "component";
  componentId: string;
  componentVersion: string;
  props: Readonly<Record<string, Json>>;
  /**
   * The instance's subtree at its local frame (a precomp-like nested composition, never shared), or
   * `null` when no component host was given or the instance has not started yet at this frame.
   */
  composition: ResolvedComposition | null;
}

export type ResolvedLayer =
  | ResolvedShapeLayer
  | ResolvedTextLayer
  | ResolvedImageLayer
  | ResolvedVideoLayer
  | ResolvedSolidLayer
  | ResolvedGeneratorLayer
  | ResolvedPrecompLayer
  | ResolvedAdjustmentLayer
  | ResolvedComponentLayer;

export interface ResolvedAudio {
  id: string;
  assetId: string;
  layerFrame: number;
  /** Linear gain, at least 0. */
  volume: number;
}

export interface ResolvedGradientStop {
  offset: number;
  color: Rgba;
}

export type ResolvedPaint =
  | { type: "solid"; color: Rgba }
  | { type: "linear-gradient"; start: Point; end: Point; stops: ResolvedGradientStop[] }
  | { type: "radial-gradient"; center: Point; radius: number; stops: ResolvedGradientStop[] };

export interface ResolvedBezierPath {
  closed: boolean;
  vertices: { point: Point; inTangent: Point; outTangent: Point }[];
}

interface ItemBase {
  id: string;
  name: string;
}

export type ResolvedShapeItem =
  | (ItemBase & { type: "rect"; position: Point; size: Point; cornerRadius: number })
  | (ItemBase & { type: "ellipse"; position: Point; size: Point })
  | (ItemBase & {
      type: "polygon";
      position: Point;
      points: number;
      radius: number;
      rotation: number;
    })
  | (ItemBase & {
      type: "star";
      position: Point;
      points: number;
      outerRadius: number;
      innerRadius: number;
      rotation: number;
    })
  | (ItemBase & { type: "path"; path: ResolvedBezierPath })
  | (ItemBase & {
      type: "fill";
      paint: ResolvedPaint;
      opacity: number;
      rule: "nonzero" | "evenodd";
    })
  | (ItemBase & {
      type: "stroke";
      paint: ResolvedPaint;
      opacity: number;
      width: number;
      cap: "butt" | "round" | "square";
      join: "miter" | "round" | "bevel";
      miterLimit: number;
      dashes: readonly number[];
      dashOffset: number;
    })
  | (ItemBase & {
      type: "trim";
      /** 0..1 each, in stored order (the renderer takes the smaller as the start). */
      start: number;
      end: number;
      /** Degrees. */
      offset: number;
      mode: "simultaneous" | "individual";
    })
  | (ItemBase & { type: "round-corners"; radius: number })
  | (ItemBase & {
      type: "repeater";
      /** 0..MAX_REPEATER_COPIES, fractional while a count animates. */
      copies: number;
      offset: number;
      composite: "above" | "below";
      anchorPoint: Point;
      position: Point;
      scale: Point;
      rotation: number;
      startOpacity: number;
      endOpacity: number;
    })
  | (ItemBase & {
      type: "group";
      transform: ResolvedTransform;
      /** Group space → layer space, including enclosing groups. */
      matrix: Affine;
      items: ResolvedShapeItem[];
    });
