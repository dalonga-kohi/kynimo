import type { Point, ResolvedBezierPath, ResolvedShapeItem } from "@kynimo/engine";
import { type Affine, applyToPoint } from "@kynimo/engine";

/**
 * Shape geometry as plain contours, built in JavaScript so start points and directions are ours
 * (they decide where dashes start, and trim paths in M4), not whatever Skia's helpers pick.
 * Conventions follow After Effects and Lottie: every primitive is centered on `position` and runs
 * clockwise on screen (+y down); rectangles start on the right edge at the top, ellipses, polygons
 * and stars at the top.
 */

export type Segment =
  | { kind: "line"; to: Point }
  | { kind: "cubic"; c1: Point; c2: Point; to: Point };

export interface Contour {
  start: Point;
  segments: Segment[];
  closed: boolean;
}

/** Control-point distance for a quarter circle of radius 1 drawn with one cubic. */
export const KAPPA = 0.5519150244935105;

export type GeometryItem = Extract<
  ResolvedShapeItem,
  { type: "rect" | "ellipse" | "polygon" | "star" | "path" }
>;

export function isGeometry(item: ResolvedShapeItem): item is GeometryItem {
  return (
    item.type === "rect" ||
    item.type === "ellipse" ||
    item.type === "polygon" ||
    item.type === "star" ||
    item.type === "path"
  );
}

export function itemContour(item: GeometryItem): Contour {
  switch (item.type) {
    case "rect":
      return rectContour(item.position, item.size, item.cornerRadius);
    case "ellipse":
      return ellipseContour(item.position, item.size);
    case "polygon":
      return polyContour(item.position, item.points, () => item.radius, item.rotation);
    case "star":
      return polyContour(
        item.position,
        item.points * 2,
        (i) => (i % 2 === 0 ? item.outerRadius : item.innerRadius),
        item.rotation,
      );
    case "path":
      return bezierContour(item.path);
  }
}

/** The corner radius is clamped to half the shorter side, as in After Effects. */
export function rectContour([x, y]: Point, [w, h]: Point, cornerRadius: number): Contour {
  const l = x - w / 2;
  const r = x + w / 2;
  const t = y - h / 2;
  const b = y + h / 2;
  const rad = Math.min(cornerRadius, w / 2, h / 2);
  if (rad <= 0)
    return {
      start: [r, t],
      segments: [
        { kind: "line", to: [r, b] },
        { kind: "line", to: [l, b] },
        { kind: "line", to: [l, t] },
      ],
      closed: true,
    };
  const k = rad * (1 - KAPPA);
  const segments: Segment[] = [];
  const line = (to: Point, from: Point) => {
    if (to[0] !== from[0] || to[1] !== from[1]) segments.push({ kind: "line", to });
  };
  line([r, b - rad], [r, t + rad]);
  segments.push({ kind: "cubic", c1: [r, b - k], c2: [r - k, b], to: [r - rad, b] });
  line([l + rad, b], [r - rad, b]);
  segments.push({ kind: "cubic", c1: [l + k, b], c2: [l, b - k], to: [l, b - rad] });
  line([l, t + rad], [l, b - rad]);
  segments.push({ kind: "cubic", c1: [l, t + k], c2: [l + k, t], to: [l + rad, t] });
  line([r - rad, t], [l + rad, t]);
  segments.push({ kind: "cubic", c1: [r - k, t], c2: [r, t + k], to: [r, t + rad] });
  return { start: [r, t + rad], segments, closed: true };
}

export function ellipseContour([x, y]: Point, [w, h]: Point): Contour {
  const rx = w / 2;
  const ry = h / 2;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    start: [x, y - ry],
    segments: [
      { kind: "cubic", c1: [x + kx, y - ry], c2: [x + rx, y - ky], to: [x + rx, y] },
      { kind: "cubic", c1: [x + rx, y + ky], c2: [x + kx, y + ry], to: [x, y + ry] },
      { kind: "cubic", c1: [x - kx, y + ry], c2: [x - rx, y + ky], to: [x - rx, y] },
      { kind: "cubic", c1: [x - rx, y - ky], c2: [x - kx, y - ry], to: [x, y - ry] },
    ],
    closed: true,
  };
}

/** Regular polygon (or star, with alternating radii), first vertex straight up at rotation 0. */
function polyContour(
  [x, y]: Point,
  count: number,
  radius: (i: number) => number,
  rotation: number,
): Contour {
  const vertex = (i: number): Point => {
    const angle = ((rotation - 90 + (i * 360) / count) * Math.PI) / 180;
    const rad = radius(i);
    return [x + rad * Math.cos(angle), y + rad * Math.sin(angle)];
  };
  const segments: Segment[] = [];
  for (let i = 1; i < count; i++) segments.push({ kind: "line", to: vertex(i) });
  return { start: vertex(0), segments, closed: true };
}

/** Tangents are relative to their vertex; a segment with both handles at zero is a straight line. */
export function bezierContour(path: ResolvedBezierPath): Contour {
  const { vertices } = path;
  const first = vertices[0];
  if (first === undefined) return { start: [0, 0], segments: [], closed: false };
  const segments: Segment[] = [];
  const connect = (from: (typeof vertices)[number], to: (typeof vertices)[number]) => {
    const [ox, oy] = from.outTangent;
    const [ix, iy] = to.inTangent;
    if (ox === 0 && oy === 0 && ix === 0 && iy === 0) segments.push({ kind: "line", to: to.point });
    else
      segments.push({
        kind: "cubic",
        c1: [from.point[0] + ox, from.point[1] + oy],
        c2: [to.point[0] + ix, to.point[1] + iy],
        to: to.point,
      });
  };
  for (let i = 1; i < vertices.length; i++)
    connect(vertices[i - 1] as (typeof vertices)[number], vertices[i] as (typeof vertices)[number]);
  if (path.closed) connect(vertices[vertices.length - 1] as (typeof vertices)[number], first);
  return { start: first.point, segments, closed: path.closed };
}

/** Affine maps send cubic Béziers to cubic Béziers, so transforming the control points is exact. */
export function transformContour(m: Affine, contour: Contour): Contour {
  const p = (point: Point): Point => applyToPoint(m, point);
  return {
    start: p(contour.start),
    closed: contour.closed,
    segments: contour.segments.map((s) =>
      s.kind === "line"
        ? { kind: "line", to: p(s.to) }
        : { kind: "cubic", c1: p(s.c1), c2: p(s.c2), to: p(s.to) },
    ),
  };
}
