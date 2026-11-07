import type { CanvasKit, Image } from "canvaskit-wasm";
import { RenderError } from "./errors.js";
import type { CoverageImage, FramePlan, RasterImage } from "./raster.js";
import { rasterize, scoped, toSkColor, toSkMatrix } from "./skia.js";

/**
 * A Skia-only stand-in for the WebGL2 compositor: masks, layer opacity, normal blending and
 * bilinear placement of layer-space rasters, bottom layer first. It lets tests and tools see whole
 * frames before the compositor exists. It is not the export path: blend modes, track mattes,
 * mipmapped minification and RGBA16F intermediates belong to the compositor (ADR-0016). Throws
 * {@link RenderError} on a layer it would draw wrong (another blend mode, a matte) rather than
 * drawing it as if it were normal.
 */
export function compositeReference(ck: CanvasKit, plan: FramePlan): RasterImage {
  return scoped((own) => {
    const toImage = (raster: RasterImage): Image => {
      const image = ck.MakeImage(
        {
          width: raster.width,
          height: raster.height,
          colorType: ck.ColorType.RGBA_8888,
          alphaType: ck.AlphaType.Premul,
          colorSpace: ck.ColorSpace.SRGB,
        },
        raster.pixels,
        raster.width * 4,
      );
      if (image === null) throw new Error("CanvasKit could not wrap a raster as an image");
      return own(image);
    };
    const paint = own(new ck.Paint());
    return rasterize(ck, plan.width, plan.height, (canvas) => {
      if (plan.background !== null) canvas.clear(toSkColor(ck, plan.background));
      for (let i = plan.layers.length - 1; i >= 0; i--) {
        const layer = plan.layers[i];
        if (layer === undefined) continue;
        if (layer.blendMode !== "normal" || layer.matte !== null)
          throw new RenderError(
            `layer '${layer.id}' uses ${layer.matte !== null ? "a track matte" : `the '${layer.blendMode}' blend mode`}, which compositeReference does not draw; the WebGL2 compositor does`,
          );
        paint.setAlphaf(layer.opacity);
        if (layer.space === "composition") {
          canvas.drawImage(toImage(masked(layer.raster, layer.mask)), layer.x, layer.y, paint);
          continue;
        }
        const raster = masked(
          layer.type === "precomp" ? compositeReference(ck, layer.frame) : layer.raster,
          layer.mask,
        );
        canvas.save();
        canvas.concat(toSkMatrix(layer.matrix));
        canvas.drawImageOptions(
          toImage(raster),
          0,
          0,
          ck.FilterMode.Linear,
          ck.MipmapMode.None,
          paint,
        );
        canvas.restore();
      }
    });
  });
}

/** The raster with every premultiplied channel scaled by the mask's coverage; a copy. */
export function masked(raster: RasterImage, mask: CoverageImage | null): RasterImage {
  if (mask === null) return raster;
  const pixels = new Uint8Array(raster.pixels.length);
  const src = raster.pixels;
  const cov = mask.coverage;
  for (let i = 0; i < cov.length; i++) {
    const c = cov[i] ?? 0;
    for (let k = i * 4; k < i * 4 + 4; k++) pixels[k] = Math.round(((src[k] ?? 0) * c) / 255);
  }
  return { width: raster.width, height: raster.height, pixels };
}
