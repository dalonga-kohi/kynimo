import type { Affine, ResolvedMask } from "@kynimo/engine";
import type { CanvasKit, Path } from "canvaskit-wasm";
import { bezierContour } from "./geometry.js";
import type { CoverageImage } from "./raster.js";
import { buildPath, type Own, rasterize, scoped, toSkMatrix } from "./skia.js";

/**
 * Gaussian sigma per unit of feather. A blurred edge rises from 7% to 93% coverage over 3σ, so
 * this makes that transition as wide as the feather value, centered on the path (ADR-0020).
 */
export const FEATHER_TO_SIGMA = 1 / 3;

/** Modes whose first mask starts from an empty layer; the others start from a full one (ADR-0020). */
const STARTS_EMPTY: ReadonlySet<ResolvedMask["mode"]> = new Set(["add", "lighten", "difference"]);

/**
 * Combines a layer's masks into one coverage raster of `width × height`, the layer's raster space
 * (ADR-0020). `toRaster` maps layer space, where mask paths, feather and expansion live, into it.
 * Each mask is rasterized and feathered by Skia, then the masks combine top-first in JavaScript.
 * Returns `null` when the masks leave every pixel fully covered (nothing to apply) and `"empty"`
 * when they cover nothing, so the layer can be left out.
 */
export function rasterizeMasks(
  ck: CanvasKit,
  masks: readonly ResolvedMask[],
  toRaster: Affine,
  width: number,
  height: number,
  /** Called with each raster size before it is allocated; may throw to refuse it. */
  reserve: (width: number, height: number) => void = () => {},
): CoverageImage | "empty" | null {
  const first = masks[0];
  if (first === undefined) return null;
  const size = width * height;
  const acc = new Float64Array(size).fill(STARTS_EMPTY.has(first.mode) ? 0 : 1);
  for (const mask of masks) {
    reserve(width, height);
    const alpha = rasterizeMask(ck, mask, toRaster, width, height);
    for (let i = 0; i < size; i++) {
      const raw = (alpha[i * 4 + 3] ?? 0) / 255;
      const c = (mask.inverted ? 1 - raw : raw) * mask.opacity;
      const a = acc[i] ?? 0;
      acc[i] = combine(mask.mode, a, c);
    }
  }
  reserve(width, height);
  const coverage = new Uint8Array(size);
  let full = true;
  let empty = true;
  for (let i = 0; i < size; i++) {
    const v = Math.round(Math.min(1, Math.max(0, acc[i] ?? 0)) * 255);
    coverage[i] = v;
    if (v !== 255) full = false;
    if (v !== 0) empty = false;
  }
  if (empty) return "empty";
  return full ? null : { width, height, coverage };
}

function combine(mode: ResolvedMask["mode"], a: number, c: number): number {
  switch (mode) {
    case "add":
      return a + c - a * c;
    case "subtract":
      return a * (1 - c);
    case "intersect":
      return a * c;
    case "lighten":
      return Math.max(a, c);
    case "darken":
      return Math.min(a, c);
    case "difference":
      return Math.abs(a - c);
  }
}

/** One mask's path coverage (before `inverted` and opacity) as RGBA8, coverage in alpha. */
function rasterizeMask(
  ck: CanvasKit,
  mask: ResolvedMask,
  toRaster: Affine,
  width: number,
  height: number,
): Uint8Array {
  return scoped((own) => {
    const path = expandedPath(ck, mask, own);
    const paint = own(new ck.Paint());
    paint.setAntiAlias(true);
    paint.setColor(ck.BLACK);
    const [fx, fy] = mask.feather;
    if (fx > 0 || fy > 0) {
      // A paint's image filter runs in the draw's local space, so the blur follows the layer's
      // rotation and scale: feather stays a layer-space width, as in After Effects.
      const blur = ck.ImageFilter.MakeBlur(
        fx * FEATHER_TO_SIGMA,
        fy * FEATHER_TO_SIGMA,
        ck.TileMode.Decal,
        null,
      );
      paint.setImageFilter(blur);
      blur.delete();
    }
    return rasterize(ck, width, height, (canvas) => {
      if (path === null) return;
      canvas.concat(toSkMatrix(toRaster));
      canvas.drawPath(path, paint);
    }).pixels;
  });
}

/**
 * The mask path grown or shrunk by `expansion` layer units: the union with, or difference from,
 * its stroke of twice that width with round joins. `null` when nothing is left.
 */
function expandedPath(ck: CanvasKit, mask: ResolvedMask, own: Own): Path | null {
  const path = own(buildPath(ck, [bezierContour(mask.path)], false));
  const e = mask.expansion;
  if (e === 0 || !mask.path.closed) return mask.path.closed ? path : null;
  const stroked = path.makeStroked({
    width: 2 * Math.abs(e),
    join: ck.StrokeJoin.Round,
    cap: ck.StrokeCap.Round,
  });
  if (stroked === null) return path;
  own(stroked);
  const result = ck.Path.MakeFromOp(path, stroked, e > 0 ? ck.PathOp.Union : ck.PathOp.Difference);
  return result === null ? null : own(result);
}
