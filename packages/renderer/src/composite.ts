import type { CanvasKit, Image } from "canvaskit-wasm";
import type { FramePlan, RasterImage } from "./raster.js";
import { rasterize, scoped, toSkColor, toSkMatrix } from "./skia.js";

/**
 * A Skia-only stand-in for the WebGL2 compositor: normal blending, layer opacity and bilinear
 * placement of layer-space rasters, bottom layer first. It lets tests and tools see whole frames
 * before the compositor exists. It is not the export path: blend modes, mattes, masks, mipmapped
 * minification and RGBA16F intermediates belong to the compositor (ADR-0016).
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
        paint.setAlphaf(layer.opacity);
        if (layer.space === "composition") {
          canvas.drawImage(toImage(layer.raster), layer.x, layer.y, paint);
          continue;
        }
        const raster =
          layer.type === "precomp" ? compositeReference(ck, layer.frame) : layer.raster;
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
