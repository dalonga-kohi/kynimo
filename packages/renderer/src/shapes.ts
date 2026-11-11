import { type Affine, multiply, type ResolvedPaint, type ResolvedShapeLayer } from "@kynimo/engine";
import type { CanvasKit, Paint, Path } from "canvaskit-wasm";
import { bindPaints, FrameShapeWork, type PaintItem, type PaintOp } from "./binding.js";
import { effectPadding } from "./compositor/effects.js";
import type { RasterImage } from "./raster.js";
import { cropToComposition, type Rect, transformRect, union } from "./rect.js";
import { buildPath, type Own, rasterize, scoped, toSkColor, toSkMatrix } from "./skia.js";

/**
 * Rasterizes a shape layer in composition space (ADR-0016), cropped to its bounds within the
 * `width × height` composition. Returns `null` when nothing visible lands inside it.
 */
export function rasterizeShapeLayer(
  ck: CanvasKit,
  layer: ResolvedShapeLayer,
  width: number,
  height: number,
  /** Called with the raster size before it is allocated; may throw to refuse it. */
  reserve: (width: number, height: number) => void = () => {},
  /** The frame's shared path work budget (ADR-0034). */
  work: FrameShapeWork = new FrameShapeWork(),
): { x: number; y: number; raster: RasterImage } | null {
  return scoped((own) => {
    const draws: { path: Path; paint: Paint; matrix: Affine }[] = [];
    let bounds: Rect | null = null;
    for (const op of bindPaints(layer.contents, work)) {
      const matrix = multiply(layer.matrix, op.matrix);
      const path = own(
        buildPath(ck, op.contours, op.paint.type === "fill" && op.paint.rule === "evenodd"),
      );
      const paint = makePaint(ck, op.paint, op.opacity, own);
      if (paint === null) continue;
      const local = paintBounds(ck, op, path, own);
      if (local === null) continue;
      const box = transformRect(matrix, local);
      if (box === null) continue;
      draws.push({ path, paint, matrix });
      bounds = bounds === null ? box : union(bounds, box);
    }
    if (bounds === null) return null;
    const crop = cropToComposition(bounds, width, height, effectPadding(layer.effects));
    if (crop === null) return null;
    const [x0, y0, x1, y1] = crop;
    reserve(x1 - x0, y1 - y0);
    const raster = rasterize(ck, x1 - x0, y1 - y0, (canvas) => {
      for (const draw of draws) {
        canvas.save();
        canvas.translate(-x0, -y0);
        canvas.concat(toSkMatrix(draw.matrix));
        canvas.drawPath(draw.path, draw.paint);
        canvas.restore();
      }
    });
    return { x: x0, y: y0, raster };
  });
}

/** `null` when the paint can draw nothing: no opacity, a zero-width stroke, a zero radius. */
function makePaint(ck: CanvasKit, item: PaintItem, groupOpacity: number, own: Own): Paint | null {
  const opacity = item.opacity * groupOpacity;
  if (opacity <= 0) return null;
  // Skia draws a zero-width stroke as a one-pixel hairline; After Effects draws nothing.
  if (item.type === "stroke" && item.width <= 0) return null;
  const paint = own(new ck.Paint());
  paint.setAntiAlias(true);
  if (!applyPaint(ck, paint, item.paint, opacity)) return null;
  if (item.type === "stroke") {
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(item.width);
    paint.setStrokeCap(strokeCap(ck, item.cap));
    paint.setStrokeJoin(strokeJoin(ck, item.join));
    paint.setStrokeMiter(item.miterLimit);
    const dash = dashPattern(item.dashes, item.dashOffset);
    if (dash !== null) {
      const effect = own(ck.PathEffect.MakeDash(dash.intervals, dash.phase));
      paint.setPathEffect(effect);
    }
  }
  return paint;
}

type Stroke = Extract<PaintItem, { type: "stroke" }>;

const strokeCap = (ck: CanvasKit, cap: Stroke["cap"]) =>
  ({ butt: ck.StrokeCap.Butt, round: ck.StrokeCap.Round, square: ck.StrokeCap.Square })[cap];

const strokeJoin = (ck: CanvasKit, join: Stroke["join"]) =>
  ({ miter: ck.StrokeJoin.Miter, round: ck.StrokeJoin.Round, bevel: ck.StrokeJoin.Bevel })[join];

/** Sets color or gradient shader; returns false when the paint is invisible. */
function applyPaint(ck: CanvasKit, paint: Paint, source: ResolvedPaint, opacity: number): boolean {
  if (source.type === "solid") {
    if (source.color.a <= 0) return false;
    paint.setColor(toSkColor(ck, source.color, opacity));
    return true;
  }
  const colors = source.stops.map((s) => toSkColor(ck, s.color));
  const offsets = source.stops.map((s) => s.offset);
  const shader =
    source.type === "linear-gradient"
      ? ck.Shader.MakeLinearGradient(
          [...source.start],
          [...source.end],
          colors,
          offsets,
          ck.TileMode.Clamp,
        )
      : source.radius > 0
        ? ck.Shader.MakeRadialGradient(
            [...source.center],
            source.radius,
            colors,
            offsets,
            ck.TileMode.Clamp,
          )
        : null;
  if (shader === null) return false;
  // The paint owns its shader from here on; deleting our handle keeps no dangling reference.
  paint.setShader(shader);
  shader.delete();
  paint.setAlphaf(opacity);
  return true;
}

/**
 * SVG dash semantics: an odd list repeats once to become even, and a pattern with no length
 * draws a solid stroke. Skia wants a phase within one pattern length.
 */
export function dashPattern(
  dashes: readonly number[],
  offset: number,
): { intervals: number[]; phase: number } | null {
  if (dashes.length === 0) return null;
  const intervals = dashes.length % 2 === 0 ? [...dashes] : [...dashes, ...dashes];
  const total = intervals.reduce((sum, d) => sum + d, 0);
  if (!(total > 0) || !Number.isFinite(total)) return null;
  const phase = ((offset % total) + total) % total;
  return { intervals, phase };
}

/**
 * Bounds in paint space; strokes are widened by their full outline, joins and caps included.
 * Dashing adds a cap at every dash end, which can reach past the undashed outline at a beveled
 * or over-limit corner, so dashed strokes also cover the path outset by the cap's reach.
 */
function paintBounds(ck: CanvasKit, op: PaintOp, path: Path, own: Own): Rect | null {
  let source = path;
  let capBox: Rect | null = null;
  if (op.paint.type === "stroke") {
    const { width, cap, join, miterLimit, dashes, dashOffset } = op.paint;
    if (cap !== "butt" && dashPattern(dashes, dashOffset) !== null && !path.isEmpty()) {
      const reach = cap === "round" ? width / 2 : (width / 2) * Math.SQRT2;
      const [l, t, r, b] = path.computeTightBounds();
      if (l !== undefined && t !== undefined && r !== undefined && b !== undefined)
        capBox = [l - reach, t - reach, r + reach, b + reach];
    }
    const stroked = path.makeStroked({
      width,
      miter_limit: miterLimit,
      cap: strokeCap(ck, cap),
      join: strokeJoin(ck, join),
    });
    if (stroked === null) return null;
    source = own(stroked);
  }
  if (source.isEmpty()) return capBox;
  const [l, t, r, b] = source.computeTightBounds();
  if (l === undefined || t === undefined || r === undefined || b === undefined) return capBox;
  return capBox === null ? [l, t, r, b] : union(capBox, [l, t, r, b]);
}
