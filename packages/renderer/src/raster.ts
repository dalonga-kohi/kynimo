import type {
  Affine,
  ResolvedEffect,
  ResolvedGenerator,
  ResolvedLayer,
  Rgba,
} from "@kynimo/engine";
import type { BlendMode, TrackMatte } from "@kynimo/scene";

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

/**
 * One coverage value per pixel (0 = masked out, 255 = kept), rows top to bottom with no padding
 * (`coverage.length === width * height`). Same size and space as the layer's raster.
 */
export interface CoverageImage {
  readonly width: number;
  readonly height: number;
  readonly coverage: Uint8Array;
}

interface PlannedBase {
  id: string;
  /** Layer opacity, applied by the compositor (it belongs to the layer, not its pixels). */
  opacity: number;
  /** Ignored while the layer serves as a matte. */
  blendMode: BlendMode;
  /**
   * The layer's masks combined (ADR-0020), in the layer's raster space: the compositor multiplies
   * the raster (or, for a precomp, the composited nested frame) by it before anything else.
   * `null` when the layer has no masks or they keep every pixel.
   */
  mask: CoverageImage | null;
  matte: PlannedMatte | null;
  /** Parameters already sampled in layer time. Omitted means no effects. */
  effects?: readonly ResolvedEffect[];
}

/**
 * The layer whose alpha or luma mattes this one, planned with its own mask and matte; it may not
 * be in the plan's `layers` (a hidden source). `source` is `null` for an empty matte: the source
 * is outside its time range, draws nothing, or cannot be drawn yet. A layer that is both drawn
 * and a matte is one shared object.
 */
export interface PlannedMatte {
  layerId: string;
  mode: TrackMatte["mode"];
  source: PlannedLayer | null;
}

/**
 * Vector layers (shapes and text) are rasterized in composition space with their transform
 * applied, so they stay sharp at any scale (ADR-0016). The raster covers the layer's bounds
 * within the composition plus the effect stack's reach. Its whole-pixel offset (`x`, `y`)
 * needs no resampling during placement.
 */
export interface PlannedVectorLayer extends PlannedBase {
  type: "shape" | "text";
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

/**
 * A generator is drawn on the GPU (or by the reference compositor) at `width × height` in layer
 * space, so it has no CPU raster (ADR-0045), and is then placed like an image.
 */
export interface PlannedGeneratorLayer extends PlannedBase {
  type: "generator";
  space: "layer";
  matrix: Affine;
  width: number;
  height: number;
  generator: ResolvedGenerator;
}

export type PlannedLayer =
  | PlannedVectorLayer
  | PlannedLayerSpaceLayer
  | PlannedPrecompLayer
  | PlannedGeneratorLayer;

export interface PlannedAdjustmentLayer extends PlannedBase {
  type: "adjustment";
  effects: readonly ResolvedEffect[];
}

export type PlannedFrameLayer = PlannedLayer | PlannedAdjustmentLayer;

/**
 * A layer the renderer cannot draw yet. It is left out of the frame. That includes a component
 * layer and any layer whose track matte chain reaches one.
 */
export interface SkippedLayer {
  id: string;
  type: ResolvedLayer["type"];
  reason: string;
}

/**
 * Content that draws, or would draw, other than the document asks: characters drawn with the
 * fallback font, or with no font at all (missing-glyph boxes). Reported per layer content, even
 * where this frame hides it. Agents act on these (ADR-0018, fidelity).
 */
export interface RenderWarning {
  id: string;
  kind: "font-fallback" | "missing-glyphs" | "animator-blur";
  /** The affected characters, ascending; at most 32. */
  codepoints: number[];
  message: string;
}

/** What the compositor needs to draw one frame of one composition. */
export interface FramePlan {
  width: number;
  height: number;
  /** Straight-alpha sRGB; `null` renders transparent (nested compositions). */
  background: Rgba | null;
  /** Top-first, like the resolved layers. Layers that cover no pixels (masks included) are left out. */
  layers: PlannedFrameLayer[];
  skipped: SkippedLayer[];
  /** Per composition, like `skipped`: nested plans hold their own. */
  warnings: RenderWarning[];
}
