import type { FrameRate, RangeSelector, TextAnimator } from "@kynimo/scene";
import { mixColor, type Rgba } from "./color.js";
import { cubicBezier } from "./easing.js";
import { clampUnit } from "./mix.js";
import { sampleNonNegative, samplePoint, sampleUnit } from "./properties.js";
import type { Point } from "./resolved.js";
import { sampleColor, sampleNumber } from "./track.js";

/**
 * Text animators (ADR-0038): pure functions from a range selector and a text to a weight per
 * unit, and from weights to per-glyph changes. Nothing here draws or measures: the renderer
 * supplies line starts from its layout and places the glyphs.
 */

/** A selector sampled at one frame. */
export interface ResolvedRangeSelector {
  unit: RangeSelector["unit"];
  start: number;
  end: number;
  offset: number;
  shape: RangeSelector["shape"];
  easeHigh: number;
  easeLow: number;
  order: RangeSelector["order"];
  seed: number;
  amount: number;
}

/** An animator sampled at one frame. `null` properties change nothing. */
export interface ResolvedTextAnimator {
  name: string;
  selector: ResolvedRangeSelector;
  position: Point | null;
  scale: Point | null;
  rotation: number | null;
  opacity: number | null;
  fill: Rgba | null;
  blur: number | null;
  tracking: number | null;
}

/** Samples every animator of a text layer at `frame` (layer time). */
export function resolveTextAnimators(
  animators: readonly TextAnimator[],
  frame: number,
  fps: FrameRate,
): ResolvedTextAnimator[] {
  return animators.map(({ name, selector: s, properties: p }) => ({
    name,
    selector: {
      unit: s.unit,
      start: sampleUnit(s.start, frame, fps),
      end: sampleUnit(s.end, frame, fps),
      offset: sampleNumber(s.offset, frame, fps),
      shape: s.shape,
      easeHigh: sampleUnit(s.easeHigh, frame, fps),
      easeLow: sampleUnit(s.easeLow, frame, fps),
      order: s.order,
      seed: s.seed,
      amount: Math.min(1, Math.max(-1, sampleNumber(s.amount, frame, fps))),
    },
    position: p.position === undefined ? null : samplePoint(p.position, frame, fps),
    scale: p.scale === undefined ? null : samplePoint(p.scale, frame, fps),
    rotation: p.rotation === undefined ? null : sampleNumber(p.rotation, frame, fps),
    opacity: p.opacity === undefined ? null : sampleUnit(p.opacity, frame, fps),
    fill: p.fill === undefined ? null : sampleColor(p.fill, frame, fps),
    blur: p.blur === undefined ? null : sampleNonNegative(p.blur, frame, fps),
    tracking: p.tracking === undefined ? null : sampleNumber(p.tracking, frame, fps),
  }));
}

/** A run of UTF-16 code units drawn as one glyph cluster: a base character plus what attaches to it. */
export interface Cluster {
  start: number;
  end: number;
}

const isNewline = (cp: number) => cp === 0x0a || cp === 0x0d || cp === 0x2028 || cp === 0x2029;
/** Combining marks, variation selectors, skin tones and tag characters stay with the character before them. */
const isExtender = (cp: number) =>
  (cp >= 0x0300 && cp <= 0x036f) ||
  (cp >= 0x1ab0 && cp <= 0x1aff) ||
  (cp >= 0x1dc0 && cp <= 0x1dff) ||
  (cp >= 0x20d0 && cp <= 0x20ff) ||
  (cp >= 0xfe00 && cp <= 0xfe0f) ||
  (cp >= 0xfe20 && cp <= 0xfe2f) ||
  (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
  (cp >= 0xe0020 && cp <= 0xe007f) ||
  (cp >= 0xe0100 && cp <= 0xe01ef) ||
  cp === 0x200c;
const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const ZWJ = 0x200d;

/**
 * Splits text into clusters, leaving out line breaks (they draw nothing). This approximates
 * Unicode grapheme clusters without `Intl.Segmenter`, whose data differs between engines and
 * would make output depend on the host: combining marks, variation selectors, skin tones, zero
 * width joiner sequences and flag pairs stay together. Hangul syllables built from conjoining
 * jamo and Indic conjuncts are not joined.
 */
export function textClusters(text: string): Cluster[] {
  const clusters: Cluster[] = [];
  let open: Cluster | null = null;
  /** The previous code point was a joiner, so this one belongs to the same cluster. */
  let joined = false;
  /** The open cluster is a lone regional indicator, which pairs with the next one. */
  let lonelyFlag = false;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    if (isNewline(cp)) {
      open = null;
      joined = false;
      lonelyFlag = false;
    } else if (
      open !== null &&
      (isExtender(cp) || cp === ZWJ || joined || (lonelyFlag && isRegionalIndicator(cp)))
    ) {
      open.end = i + width;
      lonelyFlag = false;
      joined = cp === ZWJ;
    } else {
      open = { start: i, end: i + width };
      clusters.push(open);
      joined = false;
      lonelyFlag = isRegionalIndicator(cp);
    }
    i += width;
  }
  return clusters;
}

/** Start offsets of the lines a text has when only its own line breaks apply (no wrapping). */
export function hardLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++;
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) starts.push(i + 1);
  }
  return starts;
}

/** Whether a line break lies in `text[from, to)`. */
function hasBreak(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (isNewline(text.charCodeAt(i))) return true;
  return false;
}

const isSpace = (s: string) => /^\s+$/u.test(s);

/**
 * Which unit each cluster belongs to, and how many units there are. Words are runs of
 * non-space clusters; the space after a word belongs to it, and leading spaces to the first
 * word. A line break also ends a word. Lines come from `lineStarts` (the renderer's wrapped
 * lines, or {@link hardLineStarts}).
 */
export function assignUnits(
  text: string,
  clusters: readonly Cluster[],
  unit: RangeSelector["unit"],
  lineStarts: readonly number[],
): { count: number; unitOf: number[] } {
  if (clusters.length === 0) return { count: 0, unitOf: [] };
  if (unit === "characters") return { count: clusters.length, unitOf: clusters.map((_, i) => i) };
  if (unit === "lines") {
    let line = 0;
    const unitOf = clusters.map((c) => {
      while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? Infinity) <= c.start) line++;
      return line;
    });
    // Renumber so empty lines (no cluster) leave no gap: the selector divides what exists.
    let renumbered = -1;
    let last = -1;
    const renumberedOf = unitOf.map((u) => {
      if (u !== last) {
        renumbered++;
        last = u;
      }
      return renumbered;
    });
    return { count: renumbered + 1, unitOf: renumberedOf };
  }
  let word = 0;
  let seenWord = false;
  let prevSpace = false;
  let prevEnd = 0;
  const unitOf = clusters.map((c, i) => {
    const space = isSpace(text.slice(c.start, c.end));
    const brokeLine = i > 0 && hasBreak(text, prevEnd, c.start);
    if (!space) {
      if (seenWord && (prevSpace || brokeLine)) word++;
      seenWord = true;
    }
    prevSpace = space;
    prevEnd = c.end;
    return word;
  });
  return { count: word + 1, unitOf };
}

/** Deterministic 32-bit generator (mulberry32): the same seed gives the same sequence everywhere. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) as number) / 4294967296;
  };
}

/** Where each of `n` units sits along the 0..1 axis the window is laid on, as a slot 0..n-1. */
export function unitSlots(order: RangeSelector["order"], n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  switch (order) {
    case "forward":
      return idx;
    case "reverse":
      return idx.map((i) => n - 1 - i);
    case "center-out":
    case "edges-in": {
      // Rank by distance from the middle; ties go to the earlier unit.
      const mid = (n - 1) / 2;
      const ranked = [...idx].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
      const rank = new Array<number>(n);
      ranked.forEach((unit, r) => {
        rank[unit] = r;
      });
      return order === "center-out" ? rank : rank.map((r) => n - 1 - r);
    }
    case "random": {
      const next = mulberry32(seed);
      const slots = [...idx];
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = slots[i] as number;
        slots[i] = slots[j] as number;
        slots[j] = t;
      }
      return slots;
    }
  }
}

/** Antiderivative of each shape's profile on 0..1 (zero outside it), so a unit's weight is an exact average. */
const PROFILE_AREA: Record<RangeSelector["shape"], (x: number) => number> = {
  square: (x) => x,
  "ramp-up": (x) => (x * x) / 2,
  "ramp-down": (x) => x - (x * x) / 2,
  triangle: (x) => (x <= 0.5 ? x * x : 2 * x - x * x - 0.5),
  smooth: (x) => x * x * x - (x * x * x * x) / 2,
  round: (x) => {
    const u = 2 * x - 1;
    return 0.25 * (u * Math.sqrt(Math.max(0, 1 - u * u)) + Math.asin(u)) + Math.PI / 8;
  },
};

/** The soft top and bottom of the weight curve: linear at 0, a full ease at 1. */
function easeCurve(low: number, high: number): ((w: number) => number) | null {
  if (low === 0 && high === 0) return null;
  return cubicBezier(1 / 3 + low / 3, (1 - low) / 3, 2 / 3 - high / 3, 2 / 3 + high / 3);
}

/**
 * The weight of each of `count` units under a selector, in unit order.
 *
 * The selected window spans `min(start, end) + offset` to `max(start, end) + offset` on the 0..1
 * axis (no wrap-around); units occupy equal slices of it in the order's slot sequence. A unit's
 * weight is the average of the shape's profile over its slice, so a window edge that cuts a unit
 * selects it partly. Ease then reshapes 0..1, and `amount` scales the result.
 */
export function rangeWeights(selector: ResolvedRangeSelector, count: number): number[] {
  if (count <= 0) return [];
  const lo = Math.min(selector.start, selector.end) + selector.offset;
  const width = Math.abs(selector.end - selector.start);
  const slots = unitSlots(selector.order, count, selector.seed);
  const area = PROFILE_AREA[selector.shape];
  const ease = easeCurve(clampUnit(selector.easeLow), clampUnit(selector.easeHigh));
  return slots.map((slot) => {
    if (!(width > 1e-9)) return 0;
    const a = clampUnit((slot / count - lo) / width);
    const b = clampUnit(((slot + 1) / count - lo) / width);
    // Both ends clamped: slices outside the window have a == b and no weight.
    const mean = b > a ? (area(b) - area(a)) * count * width : 0;
    const snapped = mean < 1e-9 ? 0 : mean > 1 - 1e-9 ? 1 : mean;
    const w = clampUnit(snapped);
    return (ease === null ? w : ease(w)) * selector.amount;
  });
}

/** What the animators do to one cluster, composed in list order. */
export interface GlyphEffect {
  /** Added to the cluster's position, layer units. */
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  /** Degrees, added. */
  rotation: number;
  /** 0..1, multiplies the fill's alpha. */
  opacity: number;
  /** Replaces the layer fill. */
  fill: Rgba;
  /** Layer units; the renderer reports per-glyph blur as not drawn. */
  blur: number;
  /** Thousandths of an em added after the cluster. */
  tracking: number;
}

export interface TextAnimation {
  clusters: Cluster[];
  effects: GlyphEffect[];
  /** `false` when every cluster is unchanged: the renderer then draws the layer as one paragraph. */
  active: boolean;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
const sameColor = (a: Rgba, b: Rgba) =>
  near(a.r, b.r) && near(a.g, b.g) && near(a.b, b.b) && near(a.a, b.a);

/**
 * Applies the animators to every cluster of `text` (already case-converted, as laid out).
 * Position, rotation, blur and tracking add `weight × value`. Scale and opacity move from 1
 * toward their value by the weight, and multiply across animators. Fill blends toward its color
 * by the weight, in list order.
 */
export function animateText(
  text: string,
  animators: readonly ResolvedTextAnimator[],
  lineStarts: readonly number[],
  baseFill: Rgba,
): TextAnimation {
  const clusters = textClusters(text);
  const effects: GlyphEffect[] = clusters.map(() => ({
    dx: 0,
    dy: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    opacity: 1,
    fill: baseFill,
    blur: 0,
    tracking: 0,
  }));
  for (const animator of animators) {
    const { count, unitOf } = assignUnits(text, clusters, animator.selector.unit, lineStarts);
    const weights = rangeWeights(animator.selector, count);
    effects.forEach((e, i) => {
      const w = weights[unitOf[i] ?? 0] ?? 0;
      if (w === 0) return;
      if (animator.position !== null) {
        e.dx += w * animator.position[0];
        e.dy += w * animator.position[1];
      }
      if (animator.scale !== null) {
        e.scaleX *= 1 + w * (animator.scale[0] - 1);
        e.scaleY *= 1 + w * (animator.scale[1] - 1);
      }
      if (animator.rotation !== null) e.rotation += w * animator.rotation;
      if (animator.opacity !== null) e.opacity *= clampUnit(1 + w * (animator.opacity - 1));
      if (animator.fill !== null) e.fill = mixColor(e.fill, animator.fill, clampUnit(w));
      if (animator.blur !== null) e.blur = Math.max(0, e.blur + w * animator.blur);
      if (animator.tracking !== null) e.tracking += w * animator.tracking;
    });
  }
  const active = effects.some(
    (e) =>
      e.dx !== 0 ||
      e.dy !== 0 ||
      e.scaleX !== 1 ||
      e.scaleY !== 1 ||
      e.rotation !== 0 ||
      e.opacity !== 1 ||
      e.tracking !== 0 ||
      !sameColor(e.fill, baseFill),
  );
  return { clusters, effects, active };
}
