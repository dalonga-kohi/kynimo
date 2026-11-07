import type { Affine, Rgba } from "@kynimo/engine";
import type { Canvas, CanvasKit, EmbindObject, Path } from "canvaskit-wasm";
import type { Contour } from "./geometry.js";
import type { RasterImage } from "./raster.js";

/** Our `[a, b, c, d, e, f]` affine as the row-major 3×3 matrix CanvasKit takes. */
export const toSkMatrix = ([a, b, c, d, e, f]: Affine): number[] => [a, c, e, b, d, f, 0, 0, 1];

export const toSkColor = (ck: CanvasKit, { r, g, b, a }: Rgba, alpha = 1) =>
  ck.Color4f(r, g, b, a * alpha);

export function buildPath(ck: CanvasKit, contours: readonly Contour[], evenOdd: boolean): Path {
  const builder = new ck.PathBuilder();
  builder.setFillType(evenOdd ? ck.FillType.EvenOdd : ck.FillType.Winding);
  for (const contour of contours) {
    builder.moveTo(contour.start[0], contour.start[1]);
    for (const s of contour.segments)
      if (s.kind === "line") builder.lineTo(s.to[0], s.to[1]);
      else builder.cubicTo(s.c1[0], s.c1[1], s.c2[0], s.c2[1], s.to[0], s.to[1]);
    if (contour.closed) builder.close();
  }
  return builder.detachAndDelete();
}

/** Registers a CanvasKit object for deletion when the enclosing {@link scoped} call ends. */
export type Own = <O extends EmbindObject<string>>(o: O) => O;

/** Runs `fn`, then deletes every CanvasKit object it registered, even when it throws. */
export function scoped<T>(fn: (own: Own) => T): T {
  const owned: EmbindObject<string>[] = [];
  try {
    return fn((o) => {
      owned.push(o);
      return o;
    });
  } finally {
    for (const o of owned.reverse()) o.delete();
  }
}

/**
 * Draws onto a fresh transparent `width × height` raster surface and reads it back as
 * premultiplied sRGB RGBA8.
 */
export function rasterize(
  ck: CanvasKit,
  width: number,
  height: number,
  draw: (canvas: Canvas) => void,
): RasterImage {
  const surface = ck.MakeSurface(width, height);
  if (surface === null) throw new RangeError(`cannot allocate a ${width}×${height} raster surface`);
  try {
    const canvas = surface.getCanvas();
    canvas.clear(ck.TRANSPARENT);
    draw(canvas);
    const pixels = canvas.readPixels(0, 0, {
      width,
      height,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Premul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (!(pixels instanceof Uint8Array)) throw new Error("CanvasKit returned no RGBA8 pixels");
    return { width, height, pixels };
  } finally {
    surface.delete();
  }
}
