import type { Point } from "@kynimo/engine";
import { type Contour, KAPPA, type Segment } from "./geometry.js";

/**
 * Path operators on plain contours (ADR-0034): trim paths and round corners. Everything is
 * computed in JavaScript with a fixed amount of work per segment, so the same contour always
 * gives the same output, bit for bit (ADR-0016).
 */

/** A segment with its start point and arc length. */
interface Piece {
  from: Point;
  segment: Segment;
  length: number;
  /** Cubics: cumulative arc length at `t = k / STEPS`, `k = 0..STEPS`. */
  table: number[] | null;
}

/** Steps per cubic in the arc-length table; each step is integrated with 3-point Gauss–Legendre. */
const STEPS = 32;
const GAUSS: readonly (readonly [number, number])[] = [
  [0.5 - Math.sqrt(15) / 10, 5 / 18],
  [0.5, 8 / 18],
  [0.5 + Math.sqrt(15) / 10, 5 / 18],
];

const distance = (p: Point, q: Point): number => {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  // Not Math.hypot: its result may differ between engines, sqrt is correctly rounded everywhere.
  return Math.sqrt(dx * dx + dy * dy);
};

const same = (p: Point, q: Point): boolean => p[0] === q[0] && p[1] === q[1];

const lerpPoint = (p: Point, q: Point, t: number): Point => [
  p[0] + (q[0] - p[0]) * t,
  p[1] + (q[1] - p[1]) * t,
];

function arcTable(p0: Point, c1: Point, c2: Point, p3: Point): number[] {
  // B'(t) / 3 = (1-t)²(c1-p0) + 2(1-t)t(c2-c1) + t²(p3-c2); the factor 3 is applied at the end.
  const ax = c1[0] - p0[0];
  const ay = c1[1] - p0[1];
  const bx = c2[0] - c1[0];
  const by = c2[1] - c1[1];
  const cx = p3[0] - c2[0];
  const cy = p3[1] - c2[1];
  const speed = (t: number): number => {
    const u = 1 - t;
    const x = u * u * ax + 2 * u * t * bx + t * t * cx;
    const y = u * u * ay + 2 * u * t * by + t * t * cy;
    return 3 * Math.sqrt(x * x + y * y);
  };
  const table = [0];
  let total = 0;
  for (let k = 0; k < STEPS; k++) {
    let step = 0;
    for (const [x, w] of GAUSS) step += w * speed((k + x) / STEPS);
    total += step / STEPS;
    table.push(total);
  }
  return table;
}

function measure(from: Point, segment: Segment): Piece {
  if (segment.kind === "line")
    return { from, segment, length: distance(from, segment.to), table: null };
  const table = arcTable(from, segment.c1, segment.c2, segment.to);
  return { from, segment, length: table[STEPS] as number, table };
}

/** A contour's segments, with the closing line of a closed contour written out. */
function pieces(contour: Contour): Piece[] {
  const out: Piece[] = [];
  let from = contour.start;
  for (const segment of contour.segments) {
    out.push(measure(from, segment));
    from = segment.to;
  }
  if (contour.closed && !same(from, contour.start))
    out.push(measure(from, { kind: "line", to: contour.start }));
  return out;
}

/** The curve parameter at arc length `l` along a cubic, interpolated within one table step. */
function paramAt(table: readonly number[], l: number): number {
  let lo = 0;
  let hi = STEPS;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((table[mid] as number) <= l) lo = mid;
    else hi = mid;
  }
  const a = table[lo] as number;
  const b = table[hi] as number;
  const within = b > a ? Math.min(1, Math.max(0, (l - a) / (b - a))) : 0;
  return (lo + within) / STEPS;
}

type Cubic = [Point, Point, Point, Point];

/** De Casteljau at `t`: the left and right halves. */
function split([p0, p1, p2, p3]: Cubic, t: number): [Cubic, Cubic] {
  const p01 = lerpPoint(p0, p1, t);
  const p12 = lerpPoint(p1, p2, t);
  const p23 = lerpPoint(p2, p3, t);
  const p012 = lerpPoint(p01, p12, t);
  const p123 = lerpPoint(p12, p23, t);
  const mid = lerpPoint(p012, p123, t);
  return [
    [p0, p01, p012, mid],
    [mid, p123, p23, p3],
  ];
}

/** The part of a piece between arc lengths `l0 < l1`; the ends are exact when not cut. */
function subPiece(piece: Piece, l0: number, l1: number): { from: Point; segment: Segment } {
  const { from, segment, length } = piece;
  if (l0 <= 0 && l1 >= length) return { from, segment };
  if (segment.kind === "line") {
    const start = l0 <= 0 ? from : lerpPoint(from, segment.to, l0 / length);
    const end = l1 >= length ? segment.to : lerpPoint(from, segment.to, l1 / length);
    return { from: start, segment: { kind: "line", to: end } };
  }
  const table = piece.table as number[];
  const t0 = l0 <= 0 ? 0 : paramAt(table, l0);
  const t1 = l1 >= length ? 1 : paramAt(table, l1);
  if (t0 >= t1) {
    // Nothing between the cuts: a point, which callers drop, not a near-zero cubic.
    const at = split([from, segment.c1, segment.c2, segment.to], t0)[0][3];
    return { from: at, segment: { kind: "line", to: at } };
  }
  let curve: Cubic = [from, segment.c1, segment.c2, segment.to];
  if (t1 < 1) curve = split(curve, t1)[0];
  if (t0 > 0) curve = split(curve, t1 > 0 ? t0 / t1 : 0)[1];
  const [p0, c1, c2, p3] = curve;
  return { from: p0, segment: { kind: "cubic", c1, c2, to: l1 >= length ? segment.to : p3 } };
}

/** The open contour between arc lengths `a < b`, measured from the contour's start. */
function extract(list: readonly Piece[], a: number, b: number): Contour | null {
  let start: Point | null = null;
  const segments: Segment[] = [];
  let offset = 0;
  for (const piece of list) {
    const end = offset + piece.length;
    const lo = Math.max(a, offset);
    const hi = Math.min(b, end);
    if (hi > lo && piece.length > 0) {
      const part = subPiece(piece, lo - offset, hi - offset);
      if (start === null) start = part.from;
      segments.push(part.segment);
    }
    offset = end;
  }
  return start === null ? null : { start, segments, closed: false };
}

/** Arc-length ranges `[lo, hi]` within one contour, ascending and non-overlapping. */
type Ranges = [number, number][];

/**
 * Cuts `ranges` out of a contour of length `length`. A closed contour cut across its start
 * comes out as one contour that runs through the start; a range covering all of it keeps the
 * contour as it was, closed.
 */
function cut(contour: Contour, list: readonly Piece[], length: number, ranges: Ranges): Contour[] {
  const kept = ranges.filter(([lo, hi]) => hi > lo);
  const [first] = kept;
  if (first === undefined) return [];
  if (kept.length === 1 && first[0] <= 0 && first[1] >= length) return [contour];
  const last = kept[kept.length - 1] as [number, number];
  if (contour.closed && kept.length > 1 && first[0] <= 0 && last[1] >= length) {
    const head = extract(list, last[0], length);
    const tail = extract(list, 0, first[1]);
    const middle = kept.slice(1, -1).map(([lo, hi]) => extract(list, lo, hi));
    const joined =
      head && tail ? { ...head, segments: [...head.segments, ...tail.segments] } : (head ?? tail);
    return [joined, ...middle].filter((c): c is Contour => c !== null);
  }
  return kept.map(([lo, hi]) => extract(list, lo, hi)).filter((c): c is Contour => c !== null);
}

export interface TrimSettings {
  start: number;
  end: number;
  /** Degrees. */
  offset: number;
  mode: "simultaneous" | "individual";
}

/**
 * Trim paths with After Effects semantics. The kept window runs from the smaller of `start` and
 * `end` to the larger, shifted by `offset / 360` of a length and wrapping around. `simultaneous`
 * trims each contour by the same fractions; `individual` treats the contours, in order, as one
 * path. Returns the result per input contour: none, one or (an open contour cut across its end)
 * two contours. A window of the whole length returns every contour unchanged.
 */
export function trimContours(contours: readonly Contour[], settings: TrimSettings): Contour[][] {
  const lo = Math.min(settings.start, settings.end);
  const span = Math.max(settings.start, settings.end) - lo;
  if (span >= 1) return contours.map((c) => [c]);
  if (span <= 0) return contours.map(() => []);
  const shifted = lo + settings.offset / 360;
  const a = shifted - Math.floor(shifted);
  const b = a + span;
  // The window as fractions of a length, ascending: one range, or two when it wraps.
  const window: Ranges =
    b <= 1
      ? [[a, b]]
      : [
          [0, b - 1],
          [a, 1],
        ];
  const measured = contours.map((contour) => {
    const list = pieces(contour);
    return { contour, list, length: list.reduce((sum, p) => sum + p.length, 0) };
  });
  if (settings.mode === "simultaneous")
    return measured.map(({ contour, list, length }) =>
      length > 0
        ? cut(
            contour,
            list,
            length,
            window.map(([x, y]) => [x * length, y >= 1 ? length : y * length]),
          )
        : [],
    );
  const total = measured.reduce((sum, m) => sum + m.length, 0);
  if (!(total > 0)) return contours.map(() => []);
  const global = window.map(([x, y]) => [x * total, y >= 1 ? total : y * total] as const);
  let offset = 0;
  return measured.map(({ contour, list, length }) => {
    const begin = offset;
    const end = offset + length;
    offset = end;
    if (length <= 0) return [];
    const local: Ranges = [];
    for (const [x, y] of global) {
      if (y <= begin || x >= end) continue;
      // Exact 0 and `length` where the window covers an end, so whole contours stay whole.
      local.push([x <= begin ? 0 : x - begin, y >= end ? length : y - begin]);
    }
    return cut(contour, list, length, local);
  });
}

/** A vertex is a corner when neither side has a tangent handle there. */
const sharpEnd = (p: Piece): boolean =>
  p.segment.kind === "line" || same(p.segment.c2, p.segment.to);
const sharpStart = (p: Piece): boolean => p.segment.kind === "line" || same(p.segment.c1, p.from);

/**
 * Round corners with After Effects semantics: every sharp vertex (no tangent handles on either
 * side; the ends of an open contour excluded) is replaced by an arc that leaves each side at
 * `radius` from the corner, or at half that side's length when it is shorter. The arc is a cubic
 * whose handles point at the corner (κ of the way), a circular quarter for a right angle. Vertices
 * with handles, like an ellipse's, are left alone.
 */
export function roundCorners(contour: Contour, radius: number): Contour {
  if (!(radius > 0)) return contour;
  // Zero-length sides (a closed path that repeats its first vertex, common in imports) have no
  // direction; drop them so the corners on either side are seen and rounded.
  const list = pieces(contour).filter((p) => p.length > 0);
  const n = list.length;
  if (n < 2) return contour;
  // cutStart[k] / cutEnd[k]: arc length removed at the start / end of piece k.
  const cutStart = new Array<number>(n).fill(0);
  const cutEnd = new Array<number>(n).fill(0);
  const rounded = new Array<boolean>(n).fill(false); // vertex k sits between piece k-1 and k
  for (let k = contour.closed ? 0 : 1; k < n; k++) {
    const before = list[(k - 1 + n) % n] as Piece;
    const after = list[k] as Piece;
    if (!(before.length > 0 && after.length > 0) || !sharpEnd(before) || !sharpStart(after))
      continue;
    rounded[k] = true;
    cutEnd[(k - 1 + n) % n] = Math.min(radius, before.length / 2);
    cutStart[k] = Math.min(radius, after.length / 2);
  }
  if (!rounded.includes(true)) return contour;
  const trimmed = list.map((piece, k) =>
    subPiece(piece, cutStart[k] as number, piece.length - (cutEnd[k] as number)),
  );
  const endOf = (k: number): Point => (trimmed[k] as { segment: Segment }).segment.to;
  const segments: Segment[] = [];
  for (let k = 0; k < n; k++) {
    const part = trimmed[k] as { from: Point; segment: Segment };
    if (rounded[k]) {
      const corner = (list[k] as Piece).from;
      const a = endOf((k - 1 + n) % n);
      const b = part.from;
      segments.push({
        kind: "cubic",
        c1: lerpPoint(a, corner, KAPPA),
        c2: lerpPoint(b, corner, KAPPA),
        to: b,
      });
    }
    // A side eaten whole by its two arcs leaves nothing between them.
    if (!same(part.from, part.segment.to)) segments.push(part.segment);
  }
  // A rounded first vertex moves the start back to where its arc begins, on the closing side.
  const start = contour.closed && rounded[0] ? endOf(n - 1) : contour.start;
  return { start, segments, closed: contour.closed };
}

/** Arc length of a contour, closing side included. For tests and reports. */
export const contourLength = (contour: Contour): number =>
  pieces(contour).reduce((sum, p) => sum + p.length, 0);
