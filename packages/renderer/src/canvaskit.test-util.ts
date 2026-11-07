import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type CanvasKit, loadCanvasKit } from "./canvaskit.js";
import type { RasterImage } from "./raster.js";

const require = createRequire(import.meta.url);
const bin = dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));

/** A fresh CanvasKit instance, loaded from the package like the renderer loads it. */
export const freshCanvasKit = () => loadCanvasKit({ locateFile: (file) => join(bin, file) });

let shared: Promise<CanvasKit> | undefined;
export const canvasKit = () => {
  shared ??= freshCanvasKit();
  return shared;
};

/** The `full` build has the PNG/JPEG encoders the default build leaves out; tests use it only to make fixtures. */
let encoder: Promise<CanvasKit> | undefined;
export async function encodeImage(
  width: number,
  height: number,
  rgba: (x: number, y: number) => [number, number, number, number],
  format: "png" | "jpeg",
): Promise<Uint8Array> {
  encoder ??= (
    require("canvaskit-wasm/bin/full/canvaskit.js") as (o: object) => Promise<CanvasKit>
  )({ locateFile: (file: string) => join(bin, "full", file) });
  const ck = await encoder;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) pixels.set(rgba(x, y), (y * width + x) * 4);
  const image = ck.MakeImage(
    {
      width,
      height,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    },
    pixels,
    width * 4,
  );
  if (image === null) throw new Error("fixture image failed");
  try {
    const bytes = image.encodeToBytes(
      format === "png" ? ck.ImageFormat.PNG : ck.ImageFormat.JPEG,
      100,
    );
    if (bytes === null) throw new Error("fixture encode failed");
    return bytes;
  } finally {
    image.delete();
  }
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Premultiplied RGBA8 at (x, y). */
export function pixel(raster: RasterImage, x: number, y: number): [number, number, number, number] {
  const i = (y * raster.width + x) * 4;
  const p = raster.pixels;
  return [p[i] ?? -1, p[i + 1] ?? -1, p[i + 2] ?? -1, p[i + 3] ?? -1];
}
