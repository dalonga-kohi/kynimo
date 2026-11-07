import type { ResolvedComposition, ResolvedSolidLayer } from "@kynimo/engine";
import type { CanvasKit } from "canvaskit-wasm";
import type { ImageLibrary } from "./images.js";
import type { FramePlan, PlannedLayer, RasterImage, SkippedLayer } from "./raster.js";
import { rasterizeShapeLayer } from "./shapes.js";
import { rasterize, toSkColor } from "./skia.js";

export class RenderError extends Error {
  override name = "RenderError";
}

const NOT_YET: Record<SkippedLayer["type"], string> = {
  text: "text rendering arrives with the M2 text item",
  adjustment: "adjustment layers apply effects, which arrive in M4",
  component: "component evaluation arrives in M6",
};

/**
 * Raster pixels one frame may allocate, precomps included: 1 GiB of RGBA8, about 128 full 1080p
 * layers. Like the evaluation budget (ADR-0015), it keeps a small hostile document from exhausting
 * a worker's memory. Image assets are decoded once in the {@link ImageLibrary} and are not counted.
 */
export const MAX_FRAME_RASTER_PIXELS = 268_435_456;

interface Context {
  ck: CanvasKit;
  images: ImageLibrary;
  /** Precomps shown at the same local frame share one resolved object (engine memo); plan it once. */
  nested: Map<ResolvedComposition, FramePlan>;
  limit: number;
  remaining: number;
}

/**
 * Rasterizes every layer of an evaluated frame (ADR-0016's CPU half) into a {@link FramePlan} for
 * the compositor. Deterministic: same resolved frame and same image bytes → same plan.
 * Throws {@link RenderError} when an image layer's asset is not in `images`, or when the frame
 * would allocate more than `maxRasterPixels` (default {@link MAX_FRAME_RASTER_PIXELS}).
 */
export function rasterizeFrame(
  ck: CanvasKit,
  comp: ResolvedComposition,
  images: ImageLibrary,
  { maxRasterPixels = MAX_FRAME_RASTER_PIXELS }: { maxRasterPixels?: number } = {},
): FramePlan {
  return planComposition(
    { ck, images, nested: new Map(), limit: maxRasterPixels, remaining: maxRasterPixels },
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
  const layers: PlannedLayer[] = [];
  const skipped: SkippedLayer[] = [];
  for (const layer of comp.layers) {
    const { id } = layer;
    const opacity = layer.transform.opacity;
    switch (layer.type) {
      case "shape": {
        const drawn = rasterizeShapeLayer(ck, layer, comp.width, comp.height, reserve);
        if (drawn !== null)
          layers.push({ type: "shape", space: "composition", id, opacity, ...drawn });
        break;
      }
      case "solid":
        reserve(layer.width, layer.height);
        layers.push({
          type: "solid",
          space: "layer",
          id,
          opacity,
          matrix: layer.matrix,
          raster: solidRaster(ck, layer),
        });
        break;
      case "image": {
        const raster = ctx.images.get(layer.assetId);
        if (raster === undefined)
          throw new RenderError(
            `layer '${id}' shows image asset '${layer.assetId}', which was not loaded into the ImageLibrary`,
          );
        layers.push({ type: "image", space: "layer", id, opacity, matrix: layer.matrix, raster });
        break;
      }
      case "precomp": {
        if (layer.composition === null) break;
        let frame = ctx.nested.get(layer.composition);
        if (frame === undefined) {
          frame = planComposition(ctx, layer.composition);
          ctx.nested.set(layer.composition, frame);
        }
        layers.push({ type: "precomp", space: "layer", id, opacity, matrix: layer.matrix, frame });
        break;
      }
      case "text":
      case "adjustment":
      case "component":
        skipped.push({ id, type: layer.type, reason: NOT_YET[layer.type] });
        break;
    }
  }
  return { width: comp.width, height: comp.height, background: comp.background, layers, skipped };
}

function solidRaster(ck: CanvasKit, layer: ResolvedSolidLayer): RasterImage {
  return rasterize(ck, layer.width, layer.height, (canvas) => {
    canvas.clear(toSkColor(ck, layer.color));
  });
}
