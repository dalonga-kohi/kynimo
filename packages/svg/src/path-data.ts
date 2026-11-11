import type { BezierPath } from "@kynimo/scene";
import { numberPattern } from "./numbers.js";

export type Vertex = BezierPath["vertices"][number];
export type Contour = BezierPath;

export interface ParsedPathData {
  /** Contours in order; may contain contours with a single vertex. */
  contours: Contour[];
  /** The data stopped making sense; everything before the error is kept, as browsers do. */
  error: boolean;
}

/** Bezier circle approximation constant for a quarter turn. */
export const KAPPA = 0.5522847498307936;

const ARGS: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};

const EPS = 1e-9;

const vertex = (x: number, y: number): Vertex => ({
  point: [x, y],
  inTangent: [0, 0],
  outTangent: [0, 0],
});

/**
 * Arc endpoint form to cubic segments, per the SVG implementation notes F.6.5 and F.6.6.
 * Returns `[c1x, c1y, c2x, c2y, x, y]` per segment (each at most 90 degrees); a zero radius
 * gives a straight line, returned as no segments (`null`).
 */
export function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  rotation: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): [number, number, number, number, number, number][] | null {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return null;
  const phi = (rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / count;
  const t = (4 / 3) * Math.tan(step / 4);
  const map = (ux: number, uy: number): [number, number] => [
    cosPhi * rx * ux - sinPhi * ry * uy + cx,
    sinPhi * rx * ux + cosPhi * ry * uy + cy,
  ];
  const out: [number, number, number, number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const a1 = theta1 + i * step;
    const a2 = a1 + step;
    const cos1 = Math.cos(a1);
    const sin1 = Math.sin(a1);
    const cos2 = Math.cos(a2);
    const sin2 = Math.sin(a2);
    const [c1x, c1y] = map(cos1 - t * sin1, sin1 + t * cos1);
    const [c2x, c2y] = map(cos2 + t * sin2, sin2 - t * cos2);
    const [ex, ey] = i === count - 1 ? [x2, y2] : map(cos2, sin2);
    out.push([c1x, c1y, c2x, c2y, ex, ey]);
  }
  return out;
}

/** Parses SVG path data (`d`) into contours of cubic bezier vertices. Never throws. */
export function parsePathData(d: string): ParsedPathData {
  const contours: Contour[] = [];
  const num = numberPattern();
  let i = 0;
  let error = false;

  let current: Contour | null = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  // Last control point of the previous cubic / quadratic, for S and T reflection.
  let lastCubic: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  let needStart = false;

  const skipWs = (): void => {
    while (i < d.length && /\s/.test(d[i] ?? "")) i++;
  };
  const skipSep = (): void => {
    skipWs();
    if (d[i] === ",") {
      i++;
      skipWs();
    }
  };
  const readNumber = (): number | undefined => {
    num.lastIndex = i;
    const m = num.exec(d);
    if (m === null) return undefined;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) return undefined;
    i = num.lastIndex;
    return n;
  };
  const readFlag = (): boolean | undefined => {
    const c = d[i];
    if (c !== "0" && c !== "1") return undefined;
    i++;
    return c === "1";
  };
  const finish = (): void => {
    if (current !== null) contours.push(current);
    current = null;
  };
  const begin = (x: number, y: number): Contour => {
    finish();
    const c: Contour = { closed: false, vertices: [vertex(x, y)] };
    current = c;
    needStart = false;
    return c;
  };
  const active = (): Contour => (needStart || current === null ? begin(cx, cy) : current);
  const lineTo = (x: number, y: number): void => {
    active().vertices.push(vertex(x, y));
    cx = x;
    cy = y;
  };
  const cubicTo = (
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void => {
    const c = active();
    const last = c.vertices[c.vertices.length - 1];
    if (last === undefined) return;
    last.outTangent = [c1x - last.point[0], c1y - last.point[1]];
    const v = vertex(x, y);
    v.inTangent = [c2x - x, c2y - y];
    c.vertices.push(v);
    cx = x;
    cy = y;
  };

  let cmd = "";
  let first = true;
  while (true) {
    skipWs();
    if (i >= d.length) break;
    const ch = d[i] ?? "";
    if (/[A-Za-z]/.test(ch)) {
      if (!(ch.toLowerCase() in ARGS)) {
        error = true;
        break;
      }
      cmd = ch;
      i++;
    } else if (cmd !== "" && cmd.toLowerCase() !== "z" && /[-+.\d]/.test(ch)) {
      if (cmd === "M") cmd = "L";
      else if (cmd === "m") cmd = "l";
    } else {
      error = true;
      break;
    }
    if (first && cmd.toLowerCase() !== "m") {
      error = true;
      break;
    }
    first = false;
    const rel = cmd === cmd.toLowerCase();
    const lower = cmd.toLowerCase();
    const n = ARGS[lower] ?? 0;
    const args: number[] = [];
    let flags: [boolean, boolean] = [false, false];
    let ok = true;
    if (lower === "a") {
      // rx ry rotation flag flag x y: flags are single characters and need no separator.
      for (let k = 0; k < 7 && ok; k++) {
        skipSep();
        if (k === 3 || k === 4) {
          const f = readFlag();
          if (f === undefined) ok = false;
          else if (k === 3) flags = [f, flags[1]];
          else flags = [flags[0], f];
          args.push(f ? 1 : 0);
        } else {
          const v = readNumber();
          if (v === undefined) ok = false;
          else args.push(v);
        }
      }
    } else {
      for (let k = 0; k < n && ok; k++) {
        skipSep();
        const v = readNumber();
        if (v === undefined) ok = false;
        else args.push(v);
      }
    }
    if (!ok) {
      error = true;
      break;
    }
    // Separator after the final argument is consumed by the next loop iteration's skipWs; a comma
    // between repeats is allowed.
    skipSep();

    const a = (k: number): number => args[k] ?? 0;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    let nextCubic: [number, number] | null = null;
    let nextQuad: [number, number] | null = null;
    switch (lower) {
      case "m": {
        const x = a(0) + ox;
        const y = a(1) + oy;
        begin(x, y);
        cx = sx = x;
        cy = sy = y;
        break;
      }
      case "l":
        lineTo(a(0) + ox, a(1) + oy);
        break;
      case "h":
        lineTo(a(0) + ox, cy);
        break;
      case "v":
        lineTo(cx, a(0) + oy);
        break;
      case "c": {
        const c2: [number, number] = [a(2) + ox, a(3) + oy];
        cubicTo(a(0) + ox, a(1) + oy, c2[0], c2[1], a(4) + ox, a(5) + oy);
        nextCubic = c2;
        break;
      }
      case "s": {
        const c1: [number, number] = lastCubic
          ? [2 * cx - lastCubic[0], 2 * cy - lastCubic[1]]
          : [cx, cy];
        const c2: [number, number] = [a(0) + ox, a(1) + oy];
        cubicTo(c1[0], c1[1], c2[0], c2[1], a(2) + ox, a(3) + oy);
        nextCubic = c2;
        break;
      }
      case "q":
      case "t": {
        let q: [number, number];
        let x: number;
        let y: number;
        if (lower === "q") {
          q = [a(0) + ox, a(1) + oy];
          x = a(2) + ox;
          y = a(3) + oy;
        } else {
          q = lastQuad ? [2 * cx - lastQuad[0], 2 * cy - lastQuad[1]] : [cx, cy];
          x = a(0) + ox;
          y = a(1) + oy;
        }
        const p0x = cx;
        const p0y = cy;
        cubicTo(
          p0x + (2 / 3) * (q[0] - p0x),
          p0y + (2 / 3) * (q[1] - p0y),
          x + (2 / 3) * (q[0] - x),
          y + (2 / 3) * (q[1] - y),
          x,
          y,
        );
        nextQuad = q;
        break;
      }
      case "a": {
        const x = a(5) + ox;
        const y = a(6) + oy;
        if (x === cx && y === cy) break;
        const segs = arcToCubics(cx, cy, a(0), a(1), a(2), flags[0], flags[1], x, y);
        if (segs === null) lineTo(x, y);
        else for (const s of segs) cubicTo(s[0], s[1], s[2], s[3], s[4], s[5]);
        break;
      }
      case "z": {
        const c = current as Contour | null;
        if (c !== null && !needStart) {
          const firstV = c.vertices[0];
          const lastV = c.vertices[c.vertices.length - 1];
          if (
            c.vertices.length >= 2 &&
            firstV !== undefined &&
            lastV !== undefined &&
            Math.abs(firstV.point[0] - lastV.point[0]) < EPS &&
            Math.abs(firstV.point[1] - lastV.point[1]) < EPS
          ) {
            firstV.inTangent = lastV.inTangent;
            c.vertices.pop();
          }
          c.closed = true;
          finish();
        }
        cx = sx;
        cy = sy;
        needStart = true;
        break;
      }
    }
    lastCubic = nextCubic;
    lastQuad = nextQuad;
  }
  finish();
  return { contours, error };
}
