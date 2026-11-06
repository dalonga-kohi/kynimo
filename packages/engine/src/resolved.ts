import type { Json } from "@kynimo/scene";
import type { Affine } from "./affine.js";
import type { Rgba } from "./color.js";

/**
 * The output of {@link evaluateFrame}: plain values only, no tracks. Everything the renderer
 * needs to draw one frame, and nothing that can change between two evaluations of it.
 * The whole tree is read-only: it shares objects with the document (constant positions, dash
 * arrays, component props) and between precomp instances, so copy before changing anything.
 */

export type Point = readonly [number, number];

/** Sampled local transform values, clamped to their domains (opacity 0..1, skew ±85°). */
export interface ResolvedTransform {
  anchorPoint: Point;
  position: Point;
  scale: Point;
  rotation: number;
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

interface LayerBase {
  id: string;
  name: string;
  /** Content time: `frame - startFrame`. Keyframes were sampled at this frame. */
  layerFrame: number;
  /** The layer's own transform. Opacity is not inherited from parents (After Effects parenting). */
  transform: ResolvedTransform;
  /** Layer space → composition space, including every parent's transform. */
  matrix: Affine;
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
}

export interface ResolvedImageLayer extends LayerBase {
  type: "image";
  assetId: string;
}

export interface ResolvedSolidLayer extends LayerBase {
  type: "solid";
  width: number;
  height: number;
  color: Rgba;
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

/** Effects arrive in M4; until then an adjustment layer changes nothing. */
export interface ResolvedAdjustmentLayer extends LayerBase {
  type: "adjustment";
}

/** Component evaluation arrives in M6; until then the instance is passed through unevaluated. */
export interface ResolvedComponentLayer extends LayerBase {
  type: "component";
  componentId: string;
  componentVersion: string;
  props: Readonly<Record<string, Json>>;
}

export type ResolvedLayer =
  | ResolvedShapeLayer
  | ResolvedTextLayer
  | ResolvedImageLayer
  | ResolvedSolidLayer
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
      type: "group";
      transform: ResolvedTransform;
      /** Group space → layer space, including enclosing groups. */
      matrix: Affine;
      items: ResolvedShapeItem[];
    });
