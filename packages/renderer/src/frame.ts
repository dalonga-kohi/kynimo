import {
  type Affine,
  affineApproximation,
  invert,
  multiply,
  type Projective,
  projectiveDepth,
  projectiveMultiply,
  type ResolvedComposition,
  type ResolvedLayer,
  type ResolvedSolidLayer,
} from "@kynimo/engine";
import { MAX_COMPOSITION_SIZE } from "@kynimo/scene";
import type { CanvasKit } from "canvaskit-wasm";
import { FrameShapeWork, MAX_FRAME_SHAPE_WORK } from "./binding.js";
import { activeEffect, effectPadding } from "./compositor/effects.js";
import { NEAR } from "./compositor/pipeline.js";
import { RenderError } from "./errors.js";
import type { FontLibrary } from "./fonts.js";
import type { ImageLibrary, VideoFrameLibrary } from "./images.js";
import { rasterizeMasks } from "./masks.js";
import type {
  FramePlan,
  PlannedFrameLayer,
  PlannedLayer,
  PlannedMotionSample,
  RasterImage,
  RenderWarning,
  SkippedLayer,
} from "./raster.js";
import { type LayerRasterScale, layerRasterRect, type Rect } from "./rect.js";
import { rasterizeShapeLayer } from "./shapes.js";
import { rasterize, toSkColor } from "./skia.js";
import {
  FrameTextWork,
  MAX_FRAME_ANIMATED_CLUSTERS,
  rasterizeTextLayer,
  textAnimatorWarnings,
  textWarnings,
} from "./text.js";

export { RenderError };

/** A component instance the engine started but left unevaluated: it was given no component host. */
const isUnevaluatedComponent = (layer: ResolvedLayer): boolean =>
  layer.type === "component" && layer.composition === null && layer.layerFrame >= 0;

/**
 * Raster pixels one frame may allocate, precomps included: 1 GiB of RGBA8, about 128 full 1080p
 * layers. Like the evaluation budget (ADR-0015), it keeps a small hostile document from exhausting
 * a worker's memory. Image assets are decoded once in the {@link ImageLibrary} and are not counted.
 */
export const MAX_FRAME_RASTER_PIXELS = 268_435_456;

interface Context {
  ck: CanvasKit;
  images: ImageLibrary;
  videos: VideoFrameLibrary | undefined;
  fonts: FontLibrary;
  /** Precomps shown at the same local frame share one resolved object (engine memo); plan it once. */
  nested: Map<ResolvedComposition, FramePlan>;
  limit: number;
  remaining: number;
  /** Shape path work, shared by every shape layer of the frame, precomps included (ADR-0034). */
  shapeWork: FrameShapeWork;
  /** Animated glyph clusters, shared the same way (ADR-0038). */
  textWork: FrameTextWork;
}

/**
 * Rasterizes every layer of an evaluated frame (ADR-0016's CPU half) into a {@link FramePlan} for
 * the compositor. Deterministic: same resolved frame, image bytes and font bytes → same plan.
 * Throws {@link RenderError} when an image layer's asset is not in `images`, when a text layer's
 * font family (or the bundled fallback font) is not in `fonts`, or when the frame would allocate
 * more than `maxRasterPixels` (default {@link MAX_FRAME_RASTER_PIXELS}) or its shape layers need
 * more than `maxShapeWork` units of path work (default {@link MAX_FRAME_SHAPE_WORK}, ADR-0034), or
 * its animated text needs more than `maxAnimatedGlyphs` glyphs (default
 * {@link MAX_FRAME_ANIMATED_CLUSTERS}, ADR-0038).
 */
export function rasterizeFrame(
  ck: CanvasKit,
  comp: ResolvedComposition,
  {
    images,
    fonts,
    videos,
  }: { images: ImageLibrary; fonts: FontLibrary; videos?: VideoFrameLibrary },
  {
    maxRasterPixels = MAX_FRAME_RASTER_PIXELS,
    maxShapeWork = MAX_FRAME_SHAPE_WORK,
    maxAnimatedGlyphs = MAX_FRAME_ANIMATED_CLUSTERS,
  }: { maxRasterPixels?: number; maxShapeWork?: number; maxAnimatedGlyphs?: number } = {},
): FramePlan {
  return planComposition(
    {
      ck,
      images,
      fonts,
      videos,
      nested: new Map(),
      limit: maxRasterPixels,
      remaining: maxRasterPixels,
      shapeWork: new FrameShapeWork(maxShapeWork),
      textWork: new FrameTextWork(maxAnimatedGlyphs),
    },
    comp,
  );
}

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
const IDENTITY_PROJECTIVE: Projective = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * The layer's shutter samples as placements, or `null` when it draws once: no blur, a matrix that
 * cannot be inverted, or nothing that changes across the shutter (then the plain path keeps it
 * byte-identical to an unblurred layer). A 2D layer's samples are placements relative to its
 * centre-frame placement; a 3D layer's carry the full raster → composition `projection` at the
 * sample (`rasterToLayer` takes its raster pixels to layer units), since a projective placement
 * has no delta that composes with a pixel offset.
 */
function planMotion(
  layer: ResolvedLayer,
  rasterToLayer: Projective = IDENTITY_PROJECTIVE,
): PlannedMotionSample[] | null {
  const motion = layer.motion;
  if (motion === null) return null;
  const centre = layer.projection;
  if (centre !== null) {
    const still = motion.every(
      (s) =>
        s.opacity === layer.transform.opacity &&
        (s.projection ?? centre).every((v, i) => v === centre[i]),
    );
    if (still) return null;
    return motion.map((s) => ({
      delta: IDENTITY,
      opacity: s.opacity,
      projection: projectiveMultiply(s.projection ?? centre, rasterToLayer),
    }));
  }
  const inverse = invert(layer.matrix);
  if (inverse === null || !inverse.every(Number.isFinite)) return null;
  const still = motion.every(
    (s) => s.opacity === layer.transform.opacity && s.matrix.every((v, i) => v === layer.matrix[i]),
  );
  if (still) return null;
  return motion.map((s) => ({ delta: multiply(s.matrix, inverse), opacity: s.opacity }));
}

/** The most a 3D vector layer is magnified: 2^3 raster pixels per layer unit. */
const MAX_VECTOR_LEVEL = 3;

/**
 * The resolution scale (a power of two) of a 3D shape or text layer's layer-space raster, or `null`
 * when the layer is entirely behind the camera. With effects it is one raster pixel per layer unit
 * like an image, so effect parameters stay in layer units; otherwise it follows the largest
 * magnification of the projection over `bounds` (1x to 8x). Either way it shrinks, below 1x if
 * need be, until the raster (plus the effect `padding` the compositor adds) fits the size limit.
 */
function vectorScale(
  projection: Projective,
  bounds: Rect,
  effects: boolean,
  [padX, padY]: [number, number],
): number | null {
  const [l, t, r, b] = bounds;
  let magnification = 0;
  let inFront = false;
  for (const corner of [
    [l, t],
    [r, t],
    [l, b],
    [r, b],
  ] as const) {
    if (!(projectiveDepth(projection, corner) > NEAR)) continue;
    inFront = true;
    const jacobian = affineApproximation(projection, corner);
    if (jacobian === null) continue;
    magnification = Math.max(
      magnification,
      Math.hypot(jacobian[0], jacobian[1]),
      Math.hypot(jacobian[2], jacobian[3]),
    );
  }
  if (!inFront) return null;
  let k = 0;
  if (!effects && magnification > 1)
    k = Math.min(MAX_VECTOR_LEVEL, Math.max(0, Math.ceil(Math.log2(magnification))));
  for (; k > -32; k--) {
    const [x0, y0, x1, y1] = layerRasterRect(bounds, 2 ** k);
    if (x1 - x0 <= MAX_COMPOSITION_SIZE - 2 * padX && y1 - y0 <= MAX_COMPOSITION_SIZE - 2 * padY)
      return 2 ** k;
  }
  return null;
}

function planComposition(ctx: Context, comp: ResolvedComposition): FramePlan {
  const { ck } = ctx;
  const reserve = (width: number, height: number) => {
    ctx.remaining -= width * height;
    if (ctx.remaining < 0)
      throw new RenderError(
        `the frame of composition '${comp.id}' needs more than ${ctx.limit} raster pixels; use fewer or smaller layers`,
      );
  };
  const skipped: SkippedLayer[] = [];
  /** Where a 3D shape or text layer's layer space lands in its raster, for its masks. */
  const rasterToMask = new WeakMap<PlannedLayer, Affine>();
  const warnings: RenderWarning[] = [];

  /** The layer's pixels without masks or matte; `null` when it draws nothing. */
  const planContent = (layer: ResolvedLayer): PlannedFrameLayer | null => {
    const { id, blendMode } = layer;
    const effects = layer.effects.filter(activeEffect);
    const motion = planMotion(layer);
    const base = {
      id,
      opacity: layer.transform.opacity,
      blendMode,
      mask: null,
      matte: null,
      motion,
      ...(effects.length > 0 ? { effects } : {}),
      // Progress 1 is exactly the plain layer, so it is planned as no transition at all.
      ...(layer.transition !== null && layer.transition.progress < 1
        ? { transition: layer.transition }
        : {}),
    };
    // A 3D layer is placed by its projection (raster = layer units unless noted).
    const projection = layer.projection;
    const threeD = projection === null ? {} : { projection };
    /**
     * A 3D shape or text layer is rasterized in layer space, so the projection can place it without
     * resampling a composition-space raster: `scale` is chosen from its bounds (see `vectorScale`).
     */
    const vector = (
      draw: (layerSpace: LayerRasterScale) => { x: number; y: number; raster: RasterImage } | null,
      type: "shape" | "text",
    ): PlannedFrameLayer | null => {
      if (projection === null) return null;
      let scale = 1;
      const drawn = draw((bounds) => {
        const chosen = vectorScale(projection, bounds, effects.length > 0, effectPadding(effects));
        if (chosen !== null) scale = chosen;
        return chosen;
      });
      if (drawn === null) return null;
      const { x, y, raster } = drawn;
      const toLayer: Projective = [1 / scale, 0, x / scale, 0, 1 / scale, y / scale, 0, 0, 1];
      base.motion = planMotion(layer, toLayer);
      const result: PlannedFrameLayer = {
        ...base,
        type,
        space: "layer",
        matrix: IDENTITY,
        projection: projectiveMultiply(projection, toLayer),
        raster,
      };
      rasterToMask.set(result, [scale, 0, 0, scale, -x, -y]);
      return result;
    };
    switch (layer.type) {
      case "shape": {
        if (projection !== null)
          return vector(
            (layerSpace) =>
              rasterizeShapeLayer(
                ck,
                layer,
                comp.width,
                comp.height,
                reserve,
                ctx.shapeWork,
                null,
                layerSpace,
              ),
            "shape",
          );
        const drawn = rasterizeShapeLayer(
          ck,
          layer,
          comp.width,
          comp.height,
          reserve,
          ctx.shapeWork,
          motion,
        );
        return drawn === null ? null : { ...base, type: "shape", space: "composition", ...drawn };
      }
      case "text": {
        warnings.push(...textWarnings(ck, ctx.fonts, layer), ...textAnimatorWarnings(layer));
        if (projection !== null)
          return vector(
            (layerSpace) =>
              rasterizeTextLayer(
                ck,
                ctx.fonts,
                layer,
                comp.width,
                comp.height,
                reserve,
                ctx.textWork,
                null,
                layerSpace,
              ),
            "text",
          );
        const drawn = rasterizeTextLayer(
          ck,
          ctx.fonts,
          layer,
          comp.width,
          comp.height,
          reserve,
          ctx.textWork,
          motion,
        );
        return drawn === null ? null : { ...base, type: "text", space: "composition", ...drawn };
      }
      case "solid":
        reserve(layer.width, layer.height);
        return {
          ...base,
          type: "solid",
          space: "layer",
          matrix: layer.matrix,
          ...threeD,
          raster: solidRaster(ck, layer),
        };
      case "image": {
        const raster = ctx.images.get(layer.assetId);
        if (raster === undefined)
          throw new RenderError(
            `layer '${id}' shows image asset '${layer.assetId}', which was not loaded into the ImageLibrary`,
          );
        return { ...base, type: "image", space: "layer", matrix: layer.matrix, ...threeD, raster };
      }
      case "video": {
        if (layer.sourceFrame === null) return null;
        const raster = ctx.videos?.get(layer.assetId, layer.sourceFrame);
        if (raster === undefined)
          throw new RenderError(
            `layer '${id}' shows frame ${layer.sourceFrame} of video asset '${layer.assetId}', which was not loaded into the VideoFrameLibrary`,
          );
        // A decoded frame draws exactly like an image of its pixels.
        return { ...base, type: "image", space: "layer", matrix: layer.matrix, ...threeD, raster };
      }
      case "precomp":
      case "component": {
        // A component instance's evaluated subtree is drawn exactly like a precomp's composition.
        if (layer.composition === null) {
          if (isUnevaluatedComponent(layer))
            skipped.push({
              id,
              type: layer.type,
              reason: "component layer was not evaluated (no component host)",
            });
          return null;
        }
        let frame = ctx.nested.get(layer.composition);
        if (frame === undefined) {
          frame = planComposition(ctx, layer.composition);
          ctx.nested.set(layer.composition, frame);
        }
        return { ...base, type: "precomp", space: "layer", matrix: layer.matrix, ...threeD, frame };
      }
      case "adjustment":
        return effects.length > 0 && base.opacity > 0
          ? { ...base, type: "adjustment", effects }
          : null;
      case "generator":
        // The GPU target is as big as a solid's raster, so it counts against the same limit.
        reserve(layer.width, layer.height);
        return {
          ...base,
          type: "generator",
          space: "layer",
          matrix: layer.matrix,
          ...threeD,
          width: layer.width,
          height: layer.height,
          generator: layer.generator,
        };
    }
  };

  /** Planned once per layer: a layer that is both drawn and a matte source is one object. */
  const planned = new Map<string, PlannedFrameLayer | null>();
  const plan = (layer: ResolvedLayer): PlannedFrameLayer | null => {
    if (planned.has(layer.id)) return planned.get(layer.id) ?? null;
    const blocker = undrawableMatteSource(layer);
    if (blocker !== null) {
      // An empty matte would hide (or fully show) the layer: drawn wrong, so leave it out instead.
      skipped.push({
        id: layer.id,
        type: layer.type,
        reason: `its track matte source '${blocker.id}' is a component layer that was not evaluated (no component host)`,
      });
      planned.set(layer.id, null);
      return null;
    }
    let result = planContent(layer);
    if (result !== null && layer.masks.length > 0) {
      const { width, height, toRaster } =
        result.type === "adjustment"
          ? { width: comp.width, height: comp.height, toRaster: layer.matrix }
          : rasterSpace(result, layer.matrix, rasterToMask.get(result));
      const mask = rasterizeMasks(ck, layer.masks, toRaster, width, height, reserve);
      if (mask === "empty") result = null;
      else result.mask = mask;
    }
    planned.set(layer.id, result);
    return result;
  };

  const layers: PlannedFrameLayer[] = [];
  const pending: { resolved: ResolvedLayer; planned: PlannedFrameLayer }[] = [];
  for (const layer of comp.layers) {
    const result = plan(layer);
    if (result === null) continue;
    layers.push(result);
    pending.push({ resolved: layer, planned: result });
  }
  // Mattes, linked in a second pass like the engine's: no recursion along chains.
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const matte = next.resolved.matte;
    if (matte === null) continue;
    let source: PlannedLayer | null = null;
    if (matte.source !== null) {
      const known = planned.has(matte.source.id);
      const result = plan(matte.source);
      source = result?.type === "adjustment" ? null : result;
      if (!known && source !== null) pending.push({ resolved: matte.source, planned: source });
    }
    next.planned.matte = { layerId: matte.layerId, mode: matte.mode, source };
  }

  return {
    width: comp.width,
    height: comp.height,
    background: comp.background,
    layers,
    skipped,
    warnings,
  };
}

/**
 * The first layer along `layer`'s matte chain that the renderer cannot draw yet (an unevaluated component), if any. Chains are
 * finite: the schema rules out matte cycles.
 */
function undrawableMatteSource(layer: ResolvedLayer): ResolvedLayer | null {
  for (let s = layer.matte?.source ?? null; s !== null; s = s.matte?.source ?? null)
    if (isUnevaluatedComponent(s)) return s;
  return null;
}

/** The size of a planned layer's raster space and the map from its layer space into it. */
function rasterSpace(
  layer: PlannedLayer,
  matrix: Affine,
  /** Set for a 3D vector layer: its raster is layer space at a resolution scale. */
  layerToRaster?: Affine,
): { width: number; height: number; toRaster: Affine } {
  if (layer.space === "composition")
    return {
      width: layer.raster.width,
      height: layer.raster.height,
      toRaster: multiply([1, 0, 0, 1, -layer.x, -layer.y], matrix),
    };
  const { width, height } =
    layer.type === "precomp" ? layer.frame : layer.type === "generator" ? layer : layer.raster;
  return { width, height, toRaster: layerToRaster ?? IDENTITY };
}

function solidRaster(ck: CanvasKit, layer: ResolvedSolidLayer): RasterImage {
  return rasterize(ck, layer.width, layer.height, (canvas) => {
    canvas.clear(toSkColor(ck, layer.color));
  });
}
