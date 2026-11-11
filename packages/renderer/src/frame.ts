import {
  type Affine,
  multiply,
  type ResolvedComposition,
  type ResolvedLayer,
  type ResolvedSolidLayer,
} from "@kynimo/engine";
import type { CanvasKit } from "canvaskit-wasm";
import { FrameShapeWork, MAX_FRAME_SHAPE_WORK } from "./binding.js";
import { LAYER_SUPPORT } from "./capabilities.js";
import { activeEffect } from "./compositor/effects.js";
import { RenderError } from "./errors.js";
import type { FontLibrary } from "./fonts.js";
import type { ImageLibrary, VideoFrameLibrary } from "./images.js";
import { rasterizeMasks } from "./masks.js";
import type {
  FramePlan,
  PlannedFrameLayer,
  PlannedLayer,
  RasterImage,
  RenderWarning,
  SkippedLayer,
} from "./raster.js";
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

/** Why a layer type is left out of frames: the capability manifest's reason, so the two never differ. */
function notYet(type: "component" | "generator"): string {
  const support = LAYER_SUPPORT[type];
  if (support.status !== "accepted")
    throw new RenderError(`${type} layers are marked renders but the renderer cannot draw them`);
  return support.reason;
}

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
  const warnings: RenderWarning[] = [];

  /** The layer's pixels without masks or matte; `null` when it draws nothing. */
  const planContent = (layer: ResolvedLayer): PlannedFrameLayer | null => {
    const { id, blendMode } = layer;
    const effects = layer.effects.filter(activeEffect);
    const base = {
      id,
      opacity: layer.transform.opacity,
      blendMode,
      mask: null,
      matte: null,
      ...(effects.length > 0 ? { effects } : {}),
    };
    switch (layer.type) {
      case "shape": {
        const drawn = rasterizeShapeLayer(
          ck,
          layer,
          comp.width,
          comp.height,
          reserve,
          ctx.shapeWork,
        );
        return drawn === null ? null : { ...base, type: "shape", space: "composition", ...drawn };
      }
      case "text": {
        warnings.push(...textWarnings(ck, ctx.fonts, layer), ...textAnimatorWarnings(layer));
        const drawn = rasterizeTextLayer(
          ck,
          ctx.fonts,
          layer,
          comp.width,
          comp.height,
          reserve,
          ctx.textWork,
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
          raster: solidRaster(ck, layer),
        };
      case "image": {
        const raster = ctx.images.get(layer.assetId);
        if (raster === undefined)
          throw new RenderError(
            `layer '${id}' shows image asset '${layer.assetId}', which was not loaded into the ImageLibrary`,
          );
        return { ...base, type: "image", space: "layer", matrix: layer.matrix, raster };
      }
      case "video": {
        if (layer.sourceFrame === null) return null;
        const raster = ctx.videos?.get(layer.assetId, layer.sourceFrame);
        if (raster === undefined)
          throw new RenderError(
            `layer '${id}' shows frame ${layer.sourceFrame} of video asset '${layer.assetId}', which was not loaded into the VideoFrameLibrary`,
          );
        // A decoded frame draws exactly like an image of its pixels.
        return { ...base, type: "image", space: "layer", matrix: layer.matrix, raster };
      }
      case "precomp": {
        if (layer.composition === null) return null;
        let frame = ctx.nested.get(layer.composition);
        if (frame === undefined) {
          frame = planComposition(ctx, layer.composition);
          ctx.nested.set(layer.composition, frame);
        }
        return { ...base, type: "precomp", space: "layer", matrix: layer.matrix, frame };
      }
      case "adjustment":
        return effects.length > 0 && base.opacity > 0
          ? { ...base, type: "adjustment", effects }
          : null;
      case "component":
      case "generator":
        skipped.push({ id, type: layer.type, reason: notYet(layer.type) });
        return null;
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
        reason: `its track matte source '${blocker.id}' is a ${blocker.type} layer, which cannot be drawn yet`,
      });
      planned.set(layer.id, null);
      return null;
    }
    let result = planContent(layer);
    if (result !== null && layer.masks.length > 0) {
      const { width, height, toRaster } =
        result.type === "adjustment"
          ? { width: comp.width, height: comp.height, toRaster: layer.matrix }
          : rasterSpace(result, layer.matrix);
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
 * The first layer along `layer`'s matte chain that the renderer cannot draw yet, if any. Chains are
 * finite: the schema rules out matte cycles.
 */
function undrawableMatteSource(layer: ResolvedLayer): ResolvedLayer | null {
  for (let s = layer.matte?.source ?? null; s !== null; s = s.matte?.source ?? null)
    if (s.type === "component" || s.type === "generator") return s;
  return null;
}

/** The size of a planned layer's raster space and the map from its layer space into it. */
function rasterSpace(
  layer: PlannedLayer,
  matrix: Affine,
): { width: number; height: number; toRaster: Affine } {
  if (layer.space === "composition")
    return {
      width: layer.raster.width,
      height: layer.raster.height,
      toRaster: multiply([1, 0, 0, 1, -layer.x, -layer.y], matrix),
    };
  const { width, height } = layer.type === "precomp" ? layer.frame : layer.raster;
  return { width, height, toRaster: [1, 0, 0, 1, 0, 0] };
}

function solidRaster(ck: CanvasKit, layer: ResolvedSolidLayer): RasterImage {
  return rasterize(ck, layer.width, layer.height, (canvas) => {
    canvas.clear(toSkColor(ck, layer.color));
  });
}
