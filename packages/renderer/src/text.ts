import {
  animateText,
  type GlyphEffect,
  multiply,
  type ResolvedTextLayer,
  transformMatrix,
} from "@kynimo/engine";
import { FALLBACK_FONT_FAMILY } from "@kynimo/scene";
import type { CanvasKit, LineMetrics, Paragraph } from "canvaskit-wasm";
import { effectPadding } from "./compositor/effects.js";
import { RenderError } from "./errors.js";
import type { FontLibrary, LoadedFont } from "./fonts.js";
import type { RasterImage, RenderWarning } from "./raster.js";
import { cropToComposition, type Rect, transformRect, union } from "./rect.js";
import { type Own, rasterize, scoped, toSkColor, toSkMatrix } from "./skia.js";

/** Point text lays out without a width limit, so lines break only at newlines. */
const UNBOUNDED = Number.POSITIVE_INFINITY;
/** Auto-fit never shrinks text below this fraction of its size, then clips like a plain box. */
export const MIN_FIT_SCALE = 1 / 64;
/** Bisection steps for auto-fit: a fixed count, so the chosen size is deterministic (1/4096 precision). */
const FIT_STEPS = 12;
/** Slack for float comparisons against the box, in layer units. */
const EPS = 1e-6;
/** At most this many codepoints are listed per warning, so reports stay compact. */
const MAX_LISTED = 32;

interface Fonts {
  primary: LoadedFont;
  /** `null` when the primary font is the fallback itself. */
  fallback: LoadedFont | null;
}

/** Applies the layer's case. `toUpperCase` is locale-independent, unlike `toLocaleUpperCase`. */
export function applyCase(text: string, textCase: ResolvedTextLayer["textCase"]): string {
  if (textCase === "upper") return text.toUpperCase();
  if (textCase === "lower") return text.toLowerCase();
  return text;
}

function resolveFonts(fonts: FontLibrary, layer: ResolvedTextLayer): Fonts {
  const { family, weight } = layer.font;
  const primary = fonts.match(family, weight);
  if (primary === undefined)
    throw new RenderError(
      `layer '${layer.id}' uses font family '${family}', which was not loaded into the FontLibrary`,
    );
  if (family === FALLBACK_FONT_FAMILY) return { primary, fallback: null };
  const fallback = fonts.match(FALLBACK_FONT_FAMILY, weight);
  if (fallback === undefined)
    throw new RenderError(
      `the fallback font '${FALLBACK_FONT_FAMILY}' was not loaded into the FontLibrary; every frame with text needs it`,
    );
  return { primary, fallback };
}

const clamp = (v: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, v));

function buildParagraph(
  ck: CanvasKit,
  library: FontLibrary,
  fonts: Fonts,
  layer: ResolvedTextLayer,
  text: string,
  size: number,
  maxLines: number | undefined,
  own: Own,
): Paragraph {
  const { primary, fallback } = fonts;
  const weight = layer.font.weight;
  const families = fallback === null ? [primary.alias] : [primary.alias, fallback.alias];
  const align = layer.box.mode === "point" && layer.align === "justify" ? "left" : layer.align;
  const style = new ck.ParagraphStyle({
    textStyle: {
      color: toSkColor(ck, layer.fill),
      fontFamilies: families,
      fontSize: size,
      fontStyle: { weight: { value: clamp(weight, primary.weight) } },
      // Fonts without an axis ignore it. `opsz` follows the size, as CSS `font-optical-sizing: auto`.
      fontVariations: [
        { axis: "wght", value: clamp(weight, primary.weight) },
        { axis: "opsz", value: size },
      ],
      letterSpacing: (layer.tracking / 1000) * size,
    },
    // A forced strut makes every line exactly `leading × size` tall, baseline to baseline,
    // whatever fonts the line uses (fallback glyphs included).
    strutStyle: {
      strutEnabled: true,
      forceStrutHeight: true,
      fontFamilies: [primary.alias],
      fontSize: size,
      heightMultiplier: Math.max(layer.leading, 1e-3),
      halfLeading: true,
    },
    textAlign: {
      left: ck.TextAlign.Left,
      center: ck.TextAlign.Center,
      right: ck.TextAlign.Right,
      justify: ck.TextAlign.Justify,
    }[align],
    textDirection: ck.TextDirection.LTR,
    replaceTabCharacters: true,
    applyRoundingHack: false,
    ...(maxLines === undefined ? {} : { maxLines }),
  });
  const builder = own(ck.ParagraphBuilder.MakeFromFontProvider(style, library.provider));
  builder.addText(text);
  return own(builder.build());
}

/** Lines whose whole line box fits within `height`, counted from the top. */
function linesThatFit(paragraph: Paragraph, height: number): number {
  let bottom = 0;
  let n = 0;
  for (const line of paragraph.getLineMetrics()) {
    bottom += line.height;
    if (bottom > height + EPS) break;
    n++;
  }
  return n;
}

export interface TextLayout {
  paragraph: Paragraph;
  /** The laid-out string: the layer's content after its case. */
  text: string;
  /** Where each line starts in `text` (UTF-16), for every line the layout makes, hidden ones too. */
  lineStarts: number[];
  /** Where the paragraph's top-left corner sits in layer space. */
  origin: [number, number];
  /** The font size laid out: the layer's, or smaller after auto-fit. */
  size: number;
  /** Ink can reach past line boxes (overhangs, accents); bounds are padded by this much. */
  pad: number;
}

/**
 * Lays out a text layer in layer space (ADR-0019). Point text: the origin is on the first line's
 * baseline, at its left edge, center or right edge by alignment. Box text: the origin is the box's
 * top-left corner; lines wrap to its width, and lines that do not fit its height are hidden whole.
 * Auto-fit shrinks the size (tracking and leading are relative, so they follow) until every line
 * fits and no word breaks mid-word. Returns `null` when there is nothing to draw.
 */
export function layoutText(
  ck: CanvasKit,
  library: FontLibrary,
  layer: ResolvedTextLayer,
  own: Own,
): TextLayout | null {
  const text = applyCase(layer.content, layer.textCase);
  const size = layer.font.size;
  if (text.length === 0 || !(size > 0)) return null;
  const fonts = resolveFonts(library, layer);
  const box = layer.box;

  if (box.mode === "point") {
    const paragraph = buildParagraph(ck, library, fonts, layer, text, size, undefined, own);
    paragraph.layout(UNBOUNDED);
    // Lay out again at the widest line, so center and right alignment are relative to the origin.
    const width = Math.ceil(paragraph.getMaxIntrinsicWidth()) + 1;
    paragraph.layout(width);
    const first = paragraph.getLineMetrics()[0];
    if (first === undefined) return null;
    const dx = layer.align === "center" ? -width / 2 : layer.align === "right" ? -width : 0;
    return {
      paragraph,
      text,
      lineStarts: paragraph.getLineMetrics().map((l) => l.startIndex),
      origin: [dx, -first.baseline],
      size,
      pad: size,
    };
  }

  if (!(box.width > 0) || !(box.height > 0)) return null;
  const layoutAt = (s: number, maxLines?: number) => {
    const p = buildParagraph(ck, library, fonts, layer, text, s, maxLines, own);
    p.layout(box.width);
    return p;
  };
  const fits = (p: Paragraph) =>
    p.getHeight() <= box.height + EPS && p.getMinIntrinsicWidth() <= box.width + EPS;

  let fitted = size;
  let paragraph = layoutAt(size);
  if (box.autoFit && !fits(paragraph)) {
    let lo = MIN_FIT_SCALE;
    let hi = 1;
    let best = layoutAt(size * lo);
    if (fits(best))
      for (let i = 0; i < FIT_STEPS; i++) {
        const mid = (lo + hi) / 2;
        const p = layoutAt(size * mid);
        if (fits(p)) {
          lo = mid;
          best = p;
        } else hi = mid;
      }
    fitted = size * lo;
    paragraph = best;
  }
  const visible = linesThatFit(paragraph, box.height);
  if (visible === 0) return null;
  // Units divide the whole text, so lines a box hides still count (taken before they are cut).
  const lineStarts = paragraph.getLineMetrics().map((l) => l.startIndex);
  if (visible < lineStarts.length) paragraph = layoutAt(fitted, visible);
  return { paragraph, text, lineStarts, origin: [0, 0], size: fitted, pad: fitted };
}

/** Layer-space box around every line, padded for ink that overhangs the line boxes. */
function layoutBounds({ paragraph, origin: [dx, dy], pad }: TextLayout): Rect | null {
  let bounds: Rect | null = null;
  for (const line of paragraph.getLineMetrics()) {
    const top = line.baseline - line.ascent;
    const box: Rect = [
      dx + line.left - pad,
      dy + top - pad,
      dx + line.left + line.width + pad,
      dy + line.baseline + line.descent + pad,
    ];
    bounds = bounds === null ? box : union(bounds, box);
  }
  return bounds;
}

/** Control and invisible format characters never need a glyph: `[first, last]` codepoint ranges. */
const NO_GLYPH_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f], // C0 controls (newline, tab)
  [0x007f, 0x009f], // DEL, C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian variation selectors
  [0x200b, 0x200f], // zero-width space, joiners, direction marks
  [0x202a, 0x202e], // bidi embeddings
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // zero-width no-break space
  [0xe0000, 0xe0fff], // tags, variation selectors supplement
];
const needsNoGlyph = (cp: number) => NO_GLYPH_RANGES.some(([a, b]) => cp >= a && cp <= b);

/**
 * Characters the layer's font lacks: drawn by the fallback font, or by no font (shown as a
 * missing-glyph box). Checked against each file's character map, so it is exact and cheap.
 * Warnings describe the layer's content, not this frame's ink: characters in lines a box hides,
 * or in a transparent layer, are reported too, so a problem shows up before it becomes visible.
 */
export function textWarnings(
  ck: CanvasKit,
  library: FontLibrary,
  layer: ResolvedTextLayer,
): RenderWarning[] {
  const text = applyCase(layer.content, layer.textCase);
  if (text.length === 0) return [];
  const { primary, fallback } = resolveFonts(library, layer);
  return scoped((own) => {
    const codepoints = [...new Set(Array.from(text, (c) => c.codePointAt(0) ?? 0))]
      .filter((cp) => !needsNoGlyph(cp))
      .sort((a, b) => a - b);
    const covered = (font: LoadedFont, cps: number[]) => {
      if (cps.length === 0) return [];
      const ids = own(new ck.Font(font.typeface, 1)).getGlyphIDs(String.fromCodePoint(...cps));
      return cps.map((_, i) => (ids[i] ?? 0) !== 0);
    };
    const inPrimary = covered(primary, codepoints);
    const lacking = codepoints.filter((_, i) => !inPrimary[i]);
    const inFallback = fallback === null ? [] : covered(fallback, lacking);
    const viaFallback = lacking.filter((_, i) => inFallback[i]);
    const missing = lacking.filter((_, i) => !inFallback[i]);
    const list = (cps: number[]) =>
      cps
        .slice(0, MAX_LISTED)
        .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`)
        .join(", ") + (cps.length > MAX_LISTED ? ", …" : "");
    const family = layer.font.family;
    const warnings: RenderWarning[] = [];
    if (viaFallback.length > 0)
      warnings.push({
        id: layer.id,
        kind: "font-fallback",
        codepoints: viaFallback.slice(0, MAX_LISTED),
        message: `'${family}' has no glyphs for ${list(viaFallback)}; they are drawn with '${FALLBACK_FONT_FAMILY}'`,
      });
    if (missing.length > 0)
      warnings.push({
        id: layer.id,
        kind: "missing-glyphs",
        codepoints: missing.slice(0, MAX_LISTED),
        message: `no loaded font has glyphs for ${list(missing)}; they draw as missing-glyph boxes. Use a font asset that covers them`,
      });
    return warnings;
  });
}

/** Glyph clusters one animated text layer may draw per frame: each is shaped and drawn on its own. */
export const MAX_ANIMATED_CLUSTERS = 1_000;
/** The same limit across a frame's text layers, precomps included. */
export const MAX_FRAME_ANIMATED_CLUSTERS = 4_000;

/** Shared across a frame like `FrameShapeWork`: animated glyphs are charged before they are shaped. */
export class FrameTextWork {
  private left: number;
  constructor(readonly limit = MAX_FRAME_ANIMATED_CLUSTERS) {
    this.left = limit;
  }
  charge(units: number): void {
    this.left -= units;
    if (this.left < 0)
      throw new RenderError(
        `the frame animates more than ${this.limit} glyphs across its text layers; animate fewer or shorter text layers`,
      );
  }
}

/** One cluster of an animated layer, placed by the unchanged layout and ready to draw. */
interface PlacedGlyph {
  text: string;
  effect: GlyphEffect;
  /** Layer space: left edge of the cluster, and its width. */
  x: number;
  width: number;
  baseline: number;
  top: number;
  bottom: number;
}

/**
 * Where every visible cluster sits in the layout as it is, plus what tracking animators add:
 * a cluster moves by the tracking of the clusters before it on its line, and a centered or
 * right-aligned line grows around its anchor. Wrapping stays as the base layout chose it.
 */
function placeGlyphs(
  ck: CanvasKit,
  layout: TextLayout,
  animation: ReturnType<typeof animateText>,
  align: ResolvedTextLayer["align"],
): PlacedGlyph[] {
  const { paragraph, origin, size, text } = layout;
  const lines: LineMetrics[] = paragraph.getLineMetrics();
  const found: (PlacedGlyph & { lineNo: number; before: number })[] = [];
  const running = new Map<number, number>();
  animation.clusters.forEach((cluster, i) => {
    const effect = animation.effects[i];
    // `getLineNumberAt` takes UTF-8 byte offsets in canvaskit-wasm, unlike every other call here, so
    // the line is found from the visible lines' own UTF-16 ranges.
    const lineNo = lines.findIndex(
      (l) =>
        cluster.start >= l.startIndex &&
        cluster.start < Math.max(l.endIndex, l.endIncludingNewline),
    );
    const line = lines[lineNo];
    if (effect === undefined || line === undefined) return;
    const rects = paragraph.getRectsForRange(
      cluster.start,
      cluster.end,
      ck.RectHeightStyle.Tight,
      ck.RectWidthStyle.Tight,
    );
    if (rects.length === 0) return;
    const left = Math.min(...rects.map((r) => r.rect[0] ?? 0));
    const right = Math.max(...rects.map((r) => r.rect[2] ?? 0));
    const before = running.get(lineNo) ?? 0;
    running.set(lineNo, before + (effect.tracking / 1000) * size);
    found.push({
      text: text.slice(cluster.start, cluster.end),
      effect,
      x: origin[0] + left,
      width: right - left,
      baseline: origin[1] + line.baseline,
      top: origin[1] + line.baseline - line.ascent,
      bottom: origin[1] + line.baseline + line.descent,
      lineNo,
      before,
    });
  });
  return found.map(({ lineNo, before, ...glyph }) => {
    const total = running.get(lineNo) ?? 0;
    const shift = align === "center" ? -total / 2 : align === "right" ? -total : 0;
    return { ...glyph, x: glyph.x + before + shift };
  });
}

/** Local matrix of one glyph's animator transform about its baseline center, in layer space. */
function glyphMatrix(g: PlacedGlyph) {
  const ax = g.x + g.width / 2;
  return transformMatrix({
    anchorPoint: [ax, g.baseline],
    position: [ax + g.effect.dx, g.baseline + g.effect.dy],
    scale: [g.effect.scaleX, g.effect.scaleY],
    rotation: g.effect.rotation,
    skew: 0,
  });
}

/** Text animators draw each cluster as its own paragraph at the position the whole layout gave it. */
function rasterizeAnimated(
  ck: CanvasKit,
  library: FontLibrary,
  layer: ResolvedTextLayer,
  layout: TextLayout,
  animation: ReturnType<typeof animateText>,
  width: number,
  height: number,
  reserve: (width: number, height: number) => void,
  work: FrameTextWork | undefined,
  own: Own,
): { x: number; y: number; raster: RasterImage } | null {
  const glyphs = placeGlyphs(ck, layout, animation, layer.align).filter(
    (g) => g.effect.opacity * g.effect.fill.a > 0 && g.text.trim() !== "",
  );
  if (glyphs.length > MAX_ANIMATED_CLUSTERS)
    throw new RenderError(
      `text layer '${layer.id}' animates ${glyphs.length} glyphs; at most ${MAX_ANIMATED_CLUSTERS} are drawn per layer. Split the text across layers or animate less of it`,
    );
  work?.charge(glyphs.length);

  const pad = layout.pad;
  let bounds: Rect | null = null;
  for (const g of glyphs) {
    const box = transformRect(multiply(layer.matrix, glyphMatrix(g)), [
      g.x - pad,
      g.top - pad,
      g.x + g.width + pad,
      g.bottom + pad,
    ]);
    if (box !== null) bounds = bounds === null ? box : union(bounds, box);
  }
  if (bounds === null) return null;
  const crop = cropToComposition(bounds, width, height, effectPadding(layer.effects));
  if (crop === null) return null;
  const [x0, y0, x1, y1] = crop;
  reserve(x1 - x0, y1 - y0);

  const fonts = resolveFonts(library, layer);
  // Clusters that repeat in the same color share one shaped paragraph.
  const shaped = new Map<string, { paragraph: Paragraph; baseline: number }>();
  const shape = (text: string, color: ResolvedTextLayer["fill"]) => {
    const key = `${text}|${color.r}|${color.g}|${color.b}|${color.a}`;
    let entry = shaped.get(key);
    if (entry === undefined) {
      // Tracking is zero: the full layout already placed the cluster, and spacing is added after it.
      const single = {
        ...layer,
        fill: color,
        tracking: 0,
        align: "left",
        box: { mode: "point" },
      } as const;
      const paragraph = buildParagraph(
        ck,
        library,
        fonts,
        single,
        text,
        layout.size,
        undefined,
        own,
      );
      paragraph.layout(UNBOUNDED);
      entry = { paragraph, baseline: paragraph.getLineMetrics()[0]?.baseline ?? 0 };
      shaped.set(key, entry);
    }
    return entry;
  };

  const raster = rasterize(ck, x1 - x0, y1 - y0, (canvas) => {
    canvas.translate(-x0, -y0);
    canvas.concat(toSkMatrix(layer.matrix));
    for (const g of glyphs) {
      const { paragraph, baseline } = shape(g.text, {
        ...g.effect.fill,
        a: g.effect.fill.a * g.effect.opacity,
      });
      canvas.save();
      canvas.concat(toSkMatrix(glyphMatrix(g)));
      canvas.drawParagraph(paragraph, g.x, g.baseline - baseline);
      canvas.restore();
    }
  });
  const trimmed = trimTransparent(raster);
  return trimmed === null
    ? null
    : { x: x0 + trimmed.dx, y: y0 + trimmed.dy, raster: trimmed.raster };
}

/**
 * Per-glyph blur is a text animator property. The built-in Gaussian blur applies to a whole layer.
 */
export function textAnimatorWarnings(layer: ResolvedTextLayer): RenderWarning[] {
  const blurred = layer.animators.some((a) => a.blur !== null && a.blur > 0);
  return blurred
    ? [
        {
          id: layer.id,
          kind: "animator-blur",
          codepoints: [],
          message:
            "a text animator sets per-glyph blur, which is not drawn yet; use gaussian-blur to blur the whole text layer",
        },
      ]
    : [];
}

/**
 * Rasterizes a text layer in composition space (ADR-0016), cropped to its ink within the
 * `width × height` composition. Returns `null` when nothing visible lands inside it. With text
 * animators that change something this frame, each cluster is drawn on its own (ADR-0038);
 * otherwise the layer is one paragraph, exactly as before animators existed.
 */
export function rasterizeTextLayer(
  ck: CanvasKit,
  library: FontLibrary,
  layer: ResolvedTextLayer,
  width: number,
  height: number,
  /** Called with the raster size before it is allocated; may throw to refuse it. */
  reserve: (width: number, height: number) => void = () => {},
  /** The frame's shared glyph budget; omitted, only the per-layer limit applies. */
  work?: FrameTextWork,
): { x: number; y: number; raster: RasterImage } | null {
  if (!(layer.fill.a > 0) && layer.animators.length === 0) return null;
  return scoped((own) => {
    const layout = layoutText(ck, library, layer, own);
    if (layout === null) return null;
    if (layer.animators.length > 0) {
      const animation = animateText(layout.text, layer.animators, layout.lineStarts, layer.fill);
      if (animation.active)
        return rasterizeAnimated(
          ck,
          library,
          layer,
          layout,
          animation,
          width,
          height,
          reserve,
          work,
          own,
        );
    }
    if (!(layer.fill.a > 0)) return null;
    const local = layoutBounds(layout);
    const bounds = local === null ? null : transformRect(layer.matrix, local);
    if (bounds === null) return null;
    const crop = cropToComposition(bounds, width, height, effectPadding(layer.effects));
    if (crop === null) return null;
    const [x0, y0, x1, y1] = crop;
    reserve(x1 - x0, y1 - y0);
    const raster = rasterize(ck, x1 - x0, y1 - y0, (canvas) => {
      canvas.translate(-x0, -y0);
      canvas.concat(toSkMatrix(layer.matrix));
      canvas.drawParagraph(layout.paragraph, layout.origin[0], layout.origin[1]);
    });
    const trimmed = trimTransparent(raster);
    return trimmed === null
      ? null
      : { x: x0 + trimmed.dx, y: y0 + trimmed.dy, raster: trimmed.raster };
  });
}

/**
 * Crops fully transparent rows and columns off the edges, so the compositor uploads only ink.
 * `null` when every pixel is transparent (whitespace, glyphs outside the composition).
 */
export function trimTransparent(
  raster: RasterImage,
): { dx: number; dy: number; raster: RasterImage } | null {
  const { width, height, pixels } = raster;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) !== 0) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        bottom = y;
      }
  if (right < 0) return null;
  if (left === 0 && top === 0 && right === width - 1 && bottom === height - 1)
    return { dx: 0, dy: 0, raster };
  const w = right - left + 1;
  const h = bottom - top + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    out.set(
      pixels.subarray(((top + y) * width + left) * 4, ((top + y) * width + right + 1) * 4),
      y * w * 4,
    );
  return { dx: left, dy: top, raster: { width: w, height: h, pixels: out } };
}
