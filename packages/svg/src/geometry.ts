import type { BezierPath } from "@kynimo/scene";
import { apply, applyLinear, type Matrix } from "./affine.js";
import { KAPPA } from "./path-data.js";

export type Contour = BezierPath;

export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Geometry of one painted element, in its own coordinates. */
export type Geometry =
  | { kind: "rect"; x: number; y: number; width: number; height: number; radius: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { kind: "paths"; contours: Contour[] };

const v = (
  px: number,
  py: number,
  ix = 0,
  iy = 0,
  ox = 0,
  oy = 0,
): Contour["vertices"][number] => ({
  point: [px, py],
  inTangent: [ix, iy],
  outTangent: [ox, oy],
});

/** Rectangle with elliptical corners, clockwise from the end of the top-left corner (as SVG draws it). */
export function roundedRectContour(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  ry: number,
): Contour {
  if (!(rx > 0 && ry > 0)) {
    return {
      closed: true,
      vertices: [v(x, y), v(x + w, y), v(x + w, y + h), v(x, y + h)],
    };
  }
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  return {
    closed: true,
    vertices: [
      v(x + rx, y, -kx, 0, 0, 0),
      v(x + w - rx, y, 0, 0, kx, 0),
      v(x + w, y + ry, 0, -ky, 0, 0),
      v(x + w, y + h - ry, 0, 0, 0, ky),
      v(x + w - rx, y + h, kx, 0, 0, 0),
      v(x + rx, y + h, 0, 0, -kx, 0),
      v(x, y + h - ry, 0, ky, 0, 0),
      v(x, y + ry, 0, 0, 0, -ky),
    ],
  };
}

/** Ellipse as four cubic segments, clockwise from the rightmost point (as SVG draws it). */
export function ellipseContour(cx: number, cy: number, rx: number, ry: number): Contour {
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  return {
    closed: true,
    vertices: [
      v(cx + rx, cy, 0, -ky, 0, ky),
      v(cx, cy + ry, kx, 0, -kx, 0),
      v(cx - rx, cy, 0, ky, 0, -ky),
      v(cx, cy - ry, -kx, 0, kx, 0),
    ],
  };
}

/** Every geometry as bezier contours. */
export function contoursOf(g: Geometry): Contour[] {
  switch (g.kind) {
    case "paths":
      return g.contours;
    case "rect": {
      const r = Math.min(g.radius, g.width / 2, g.height / 2);
      return [roundedRectContour(g.x, g.y, g.width, g.height, r, r)];
    }
    case "ellipse":
      return [ellipseContour(g.cx, g.cy, g.rx, g.ry)];
  }
}

export function transformContour(c: Contour, m: Matrix): Contour {
  return {
    closed: c.closed,
    vertices: c.vertices.map((vx) => ({
      point: apply(m, vx.point),
      inTangent: applyLinear(m, vx.inTangent),
      outTangent: applyLinear(m, vx.outTangent),
    })),
  };
}

/** Values of a cubic bezier's derivative roots in (0, 1) for one axis. */
function extrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = p1 - p0;
  const b = p2 - p1;
  const c = p3 - p2;
  const qa = a - 2 * b + c;
  const qb = 2 * (b - a);
  const qc = a;
  const roots: number[] = [];
  if (Math.abs(qa) < 1e-12) {
    if (Math.abs(qb) > 1e-12) roots.push(-qc / qb);
  } else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-qb + s) / (2 * qa), (-qb - s) / (2 * qa));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

const at = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** Exact bounding box of contours (curve extrema included); `null` when there are no vertices. */
export function bboxOfContours(contours: Contour[]): Bbox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const add = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const c of contours) {
    const vs = c.vertices;
    for (const vx of vs) add(vx.point[0], vx.point[1]);
    const segments = c.closed ? vs.length : vs.length - 1;
    for (let i = 0; i < segments; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % vs.length];
      if (a === undefined || b === undefined) continue;
      const x0 = a.point[0];
      const y0 = a.point[1];
      const x1 = x0 + a.outTangent[0];
      const y1 = y0 + a.outTangent[1];
      const x3 = b.point[0];
      const y3 = b.point[1];
      const x2 = x3 + b.inTangent[0];
      const y2 = y3 + b.inTangent[1];
      for (const t of extrema(x0, x1, x2, x3)) add(at(x0, x1, x2, x3, t), at(y0, y1, y2, y3, t));
      for (const t of extrema(y0, y1, y2, y3)) add(at(x0, x1, x2, x3, t), at(y0, y1, y2, y3, t));
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function geometryBbox(g: Geometry): Bbox | null {
  switch (g.kind) {
    case "rect":
      return { x: g.x, y: g.y, width: g.width, height: g.height };
    case "ellipse":
      return { x: g.cx - g.rx, y: g.cy - g.ry, width: 2 * g.rx, height: 2 * g.ry };
    case "paths":
      return bboxOfContours(g.contours);
  }
}
