import type { BezierPath, FrameRate, Paint, ShapeItem } from "@kynimo/scene";
import { type Affine, multiply } from "./affine.js";
import { mixColor, parseColor } from "./color.js";
import { lerp, lerpVector } from "./mix.js";
import {
  clampUnit,
  resolveTransform,
  sampleNonNegative,
  samplePoint,
  sampleSize,
  sampleUnit,
} from "./properties.js";
import type {
  Point,
  ResolvedBezierPath,
  ResolvedGradientStop,
  ResolvedPaint,
  ResolvedShapeItem,
} from "./resolved.js";
import { type Mixer, sampleColor, sampleNumber, sampleTrack } from "./track.js";

type Stops = { offset: number; color: string }[];

/** Mixes stop by stop (the schema guarantees equal counts), colors in OKLab like every other color. */
const mixStops: Mixer<Stops, ResolvedGradientStop[]> = (from, to, p) =>
  from.map((stop, i) => {
    const other = to[i] ?? stop;
    return {
      offset: lerp(stop.offset, other.offset, p),
      color: mixColor(parseColor(stop.color), parseColor(other.color), p),
    };
  });

/** Overshoot can push offsets outside 0..1 or out of order; clamp, then keep them non-decreasing. */
function sanitizeStops(stops: ResolvedGradientStop[]): ResolvedGradientStop[] {
  let floor = 0;
  for (const stop of stops) {
    floor = Math.max(floor, clampUnit(stop.offset));
    stop.offset = floor;
  }
  return stops;
}

/** Vertex by vertex; the schema guarantees the same topology on every keyframe. */
const mixPath: Mixer<BezierPath, ResolvedBezierPath> = (from, to, p) => ({
  closed: from.closed,
  vertices: from.vertices.map((v, i) => {
    const w = to.vertices[i] ?? v;
    return {
      point: lerpVector(v.point, w.point, p) as Point,
      inTangent: lerpVector(v.inTangent, w.inTangent, p) as Point,
      outTangent: lerpVector(v.outTangent, w.outTangent, p) as Point,
    };
  }),
});

function resolvePaint(paint: Paint, frame: number, fps: FrameRate): ResolvedPaint {
  switch (paint.type) {
    case "solid":
      return { type: "solid", color: sampleColor(paint.color, frame, fps) };
    case "linear-gradient":
      return {
        type: "linear-gradient",
        start: samplePoint(paint.start, frame, fps),
        end: samplePoint(paint.end, frame, fps),
        stops: sanitizeStops(sampleTrack(paint.stops, frame, fps, mixStops)),
      };
    case "radial-gradient":
      return {
        type: "radial-gradient",
        center: samplePoint(paint.center, frame, fps),
        radius: sampleNonNegative(paint.radius, frame, fps),
        stops: sanitizeStops(sampleTrack(paint.stops, frame, fps, mixStops)),
      };
  }
}

/**
 * Resolves shape contents at `frame` (layer time). `parent` maps the enclosing group's space to
 * layer space, so every group's `matrix` lands in layer space. Group depth is bounded by the schema.
 */
export function resolveShapeItems(
  items: readonly ShapeItem[],
  frame: number,
  fps: FrameRate,
  parent: Affine | null = null,
): ResolvedShapeItem[] {
  return items.map((item) => resolveItem(item, frame, fps, parent));
}

function resolveItem(
  item: ShapeItem,
  frame: number,
  fps: FrameRate,
  parent: Affine | null,
): ResolvedShapeItem {
  const { id, name } = item;
  switch (item.type) {
    case "rect":
      return {
        id,
        name,
        type: "rect",
        position: samplePoint(item.position, frame, fps),
        size: sampleSize(item.size, frame, fps),
        cornerRadius: sampleNonNegative(item.cornerRadius, frame, fps),
      };
    case "ellipse":
      return {
        id,
        name,
        type: "ellipse",
        position: samplePoint(item.position, frame, fps),
        size: sampleSize(item.size, frame, fps),
      };
    case "polygon":
      return {
        id,
        name,
        type: "polygon",
        position: samplePoint(item.position, frame, fps),
        points: item.points,
        radius: sampleNonNegative(item.radius, frame, fps),
        rotation: sampleNumber(item.rotation, frame, fps),
      };
    case "star":
      return {
        id,
        name,
        type: "star",
        position: samplePoint(item.position, frame, fps),
        points: item.points,
        outerRadius: sampleNonNegative(item.outerRadius, frame, fps),
        innerRadius: sampleNonNegative(item.innerRadius, frame, fps),
        rotation: sampleNumber(item.rotation, frame, fps),
      };
    case "path":
      return { id, name, type: "path", path: sampleTrack(item.path, frame, fps, mixPath) };
    case "fill":
      return {
        id,
        name,
        type: "fill",
        paint: resolvePaint(item.paint, frame, fps),
        opacity: sampleUnit(item.opacity, frame, fps),
        rule: item.rule,
      };
    case "stroke":
      return {
        id,
        name,
        type: "stroke",
        paint: resolvePaint(item.paint, frame, fps),
        opacity: sampleUnit(item.opacity, frame, fps),
        width: sampleNonNegative(item.width, frame, fps),
        cap: item.cap,
        join: item.join,
        miterLimit: item.miterLimit,
        dashes: item.dashes,
        dashOffset: sampleNumber(item.dashOffset, frame, fps),
      };
    case "group": {
      const local = resolveTransform(item.transform, frame, fps);
      const matrix = parent === null ? local.matrix : multiply(parent, local.matrix);
      return {
        id,
        name,
        type: "group",
        transform: local.transform,
        matrix,
        items: resolveShapeItems(item.items, frame, fps, matrix),
      };
    }
  }
}
