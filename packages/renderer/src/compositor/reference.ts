import type { FramePlan, PlannedLayer, RasterImage } from "../raster.js";
import { blendPixel } from "./blend.js";
import {
  type Affine,
  invert,
  LUMA,
  levelOfDetail,
  matteChain,
  maxLevel,
  placement,
} from "./pipeline.js";

/** Premultiplied RGBA, 0..1, rows top to bottom. */
interface FloatImage {
  width: number;
  height: number;
  data: Float64Array;
}

const blank = (width: number, height: number): FloatImage => ({
  width,
  height,
  data: new Float64Array(width * height * 4),
});

/**
 * The compositor in plain JavaScript (ADR-0021): the specification the WebGL2 compositor is
 * tested against, and a way for Node tools and tests to see whole frames. Same pipeline as the
 * GPU, in float64 instead of RGBA16F: per layer, bottom first, raster × mask, placement (bilinear,
 * trilinear between box-filtered mips when minifying), × track matte, × opacity, then the blend
 * mode. The root background goes under the result, and the output is quantized to premultiplied
 * sRGB RGBA8. Slow (every layer touches every composition pixel); not the export path.
 */
export function compositeReference(plan: FramePlan): RasterImage {
  const acc = compositeFloat(plan, new Map());
  const out = new Uint8Array(acc.data.length);
  const bg = plan.background;
  for (let i = 0; i < acc.data.length; i += 4) {
    const a = acc.data[i + 3] ?? 0;
    const under = bg === null ? [0, 0, 0, 0] : [bg.r * bg.a, bg.g * bg.a, bg.b * bg.a, bg.a];
    for (let k = 0; k < 4; k++) {
      const v = (acc.data[i + k] ?? 0) + (under[k] ?? 0) * (1 - a);
      out[i + k] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return { width: plan.width, height: plan.height, pixels: out };
}

type Nested = Map<FramePlan, FloatImage>;

function compositeFloat(plan: FramePlan, nested: Nested): FloatImage {
  const acc = blank(plan.width, plan.height);
  for (let i = plan.layers.length - 1; i >= 0; i--) {
    const layer = plan.layers[i];
    if (layer === undefined) continue;
    const src = placed(layer, plan, nested);
    for (let p = 0; p < acc.data.length; p += 4)
      blendPixel(
        layer.blendMode,
        acc.data.slice(p, p + 4),
        src.data.subarray(p, p + 4),
        acc.data,
        p,
      );
  }
  return acc;
}

/** The layer in composition space with its matte and opacity applied, before blending. */
function placed(layer: PlannedLayer, comp: FramePlan, nested: Nested): FloatImage {
  const { chain, end } = matteChain(layer);
  let below: FloatImage | null = null; // the placed matte source of the layer being processed
  for (let i = chain.length - 1; i >= 0; i--) {
    const current = chain[i] as PlannedLayer;
    const img = place(source(current, nested), placement(current), comp.width, comp.height);
    const matted = i === chain.length - 1 ? (end === "none" ? "none" : "empty") : "source";
    const mode = current.matte?.mode;
    for (let p = 0; p < img.data.length; p += 4) {
      let factor = current.opacity;
      if (matted !== "none" && mode !== undefined) {
        const m = matted === "empty" || below === null ? null : below.data;
        const value =
          m === null
            ? 0
            : mode === "alpha" || mode === "alpha-inverted"
              ? (m[p + 3] ?? 0)
              : LUMA[0] * (m[p] ?? 0) + LUMA[1] * (m[p + 1] ?? 0) + LUMA[2] * (m[p + 2] ?? 0);
        factor *= mode.endsWith("inverted") ? 1 - value : value;
      }
      for (let k = 0; k < 4; k++) img.data[p + k] = (img.data[p + k] ?? 0) * factor;
    }
    below = img;
  }
  return below as FloatImage;
}

/** The layer's raster (or composited precomp) times its mask, in its raster space. */
function source(layer: PlannedLayer, nested: Nested): FloatImage {
  let img: FloatImage;
  if (layer.type === "precomp") {
    let frame = nested.get(layer.frame);
    if (frame === undefined) {
      frame = compositeFloat(layer.frame, nested);
      nested.set(layer.frame, frame);
    }
    img = { width: frame.width, height: frame.height, data: frame.data.slice() };
  } else {
    const { width, height, pixels } = layer.raster;
    img = blank(width, height);
    for (let i = 0; i < pixels.length; i++) img.data[i] = (pixels[i] ?? 0) / 255;
  }
  const mask = layer.mask;
  if (mask !== null)
    for (let i = 0; i < mask.coverage.length; i++) {
      const c = (mask.coverage[i] ?? 0) / 255;
      for (let k = i * 4; k < i * 4 + 4; k++) img.data[k] = (img.data[k] ?? 0) * c;
    }
  return img;
}

/** Next mip level: each texel is the mean of a 2×2 block; texels past the edge count as transparent. */
export function downsample(src: FloatImage): FloatImage {
  const width = Math.ceil(src.width / 2);
  const height = Math.ceil(src.height / 2);
  const out = blank(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let k = 0; k < 4; k++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) sum += texel(src, 2 * x + dx, 2 * y + dy, k);
        out.data[(y * width + x) * 4 + k] = sum / 4;
      }
  return out;
}

const texel = (img: FloatImage, x: number, y: number, k: number) =>
  x < 0 || y < 0 || x >= img.width || y >= img.height
    ? 0
    : (img.data[(y * img.width + x) * 4 + k] ?? 0);

/** Bilinear sample at texel-space point (x, y) (texel centers at i + 0.5), transparent outside. */
function bilinear(img: FloatImage, x: number, y: number, k: number): number {
  const u = x - 0.5;
  const v = y - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const top = texel(img, x0, y0, k) * (1 - fx) + texel(img, x0 + 1, y0, k) * fx;
  const bottom = texel(img, x0, y0 + 1, k) * (1 - fx) + texel(img, x0 + 1, y0 + 1, k) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Resamples `src` into a `width × height` composition through `matrix` (source → composition). */
function place(src: FloatImage, matrix: Affine, width: number, height: number): FloatImage {
  const out = blank(width, height);
  const inv = invert(matrix);
  if (inv === null) return out; // a degenerate transform covers no area
  const lod = levelOfDetail(inv, src.width, src.height);
  const k = Math.floor(lod);
  const t = lod - k;
  const levels = [src];
  for (let n = 1; n <= Math.min(k + 1, maxLevel(src.width, src.height)); n++)
    levels.push(downsample(levels[n - 1] as FloatImage));
  const lo = levels[k] as FloatImage;
  const hi = levels[Math.min(k + 1, levels.length - 1)] as FloatImage;
  const sLo = 2 ** -k;
  const sHi = 2 ** -Math.min(k + 1, levels.length - 1);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const qx = inv[0] * px + inv[2] * py + inv[4];
      const qy = inv[1] * px + inv[3] * py + inv[5];
      for (let c = 0; c < 4; c++) {
        const a = bilinear(lo, qx * sLo, qy * sLo, c);
        out.data[(y * width + x) * 4 + c] =
          t > 0 ? a * (1 - t) + bilinear(hi, qx * sHi, qy * sHi, c) * t : a;
      }
    }
  return out;
}
