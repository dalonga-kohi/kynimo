import type { Affine, Rgba } from "@kynimo/engine";

/**
 * Pixels for the compositor to upload as a texture: 8-bit RGBA, premultiplied alpha, sRGB-encoded,
 * rows top to bottom with no padding (`pixels.length === width * height * 4`). Read-only: image
 * layers that show the same asset share one raster.
 */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface PlannedBase {
  id: string;
  /** Layer opacity, applied by the compositor (it belongs to the layer, not its pixels). */
  opacity: number;
}

/**
 * Vector layers are rasterized in composition space with their transform applied, so they stay
 * sharp at any scale (ADR-0016). The raster covers only the layer's bounds within the composition,
 * with its top-left corner at the whole-pixel offset (`x`, `y`): placing it needs no resampling.
 */
export interface PlannedShapeLayer extends PlannedBase {
  type: "shape";
  space: "composition";
  x: number;
  y: number;
  raster: RasterImage;
}

/**
 * Image and solid layers are rasterized in layer space (one pixel per layer unit, origin at the
 * top-left corner) and placed by the compositor with `matrix` (layer → composition space).
 */
export interface PlannedLayerSpaceLayer extends PlannedBase {
  type: "image" | "solid";
  space: "layer";
  matrix: Affine;
  raster: RasterImage;
}

/** A precomp is composited on its own at its composition size, then placed like an image. */
export interface PlannedPrecompLayer extends PlannedBase {
  type: "precomp";
  space: "layer";
  matrix: Affine;
  frame: FramePlan;
}

export type PlannedLayer = PlannedShapeLayer | PlannedLayerSpaceLayer | PlannedPrecompLayer;

/** A layer the renderer cannot draw yet. It is left out of the frame, never drawn wrong. */
export interface SkippedLayer {
  id: string;
  type: "text" | "adjustment" | "component";
  reason: string;
}

/** What the compositor needs to draw one frame of one composition. */
export interface FramePlan {
  width: number;
  height: number;
  /** Straight-alpha sRGB; `null` renders transparent (nested compositions). */
  background: Rgba | null;
  /** Top-first, like the resolved layers. Layers that cover no pixels are left out. */
  layers: PlannedLayer[];
  skipped: SkippedLayer[];
}
