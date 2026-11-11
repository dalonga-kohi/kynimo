import type { ShapeItem } from "@kynimo/scene";

/** Hard limits that protect the importer from hostile or accidental huge input. */
export const SVG_LIMITS = {
  /** UTF-8 bytes of the input. */
  sourceBytes: 512 * 1024,
  /** Parsed XML elements, before `<use>` expansion. */
  elements: 5000,
  /** Painted elements after `<use>` expansion. */
  expandedElements: 5000,
  /** Nested `<use>` levels. */
  useDepth: 8,
  /** Total path vertices in the output. */
  vertices: 50_000,
  /** Nesting of XML elements; keeps every walk over the tree bounded. */
  xmlDepth: 256,
} as const;

export type FidelityKind = "dropped" | "flattened" | "approximated";

export interface FidelityEntry {
  kind: FidelityKind;
  /** Stable kebab-case key, e.g. `text`, `clip-path`, `baked-transform`. */
  feature: string;
  /** Occurrences. */
  count: number;
  /** Up to 5 examples, as `tag#id` or `tag` with a 1-based index path like `g[2] > path[1]`. */
  elements: string[];
  /** One plain sentence: what happened and what the agent can do instead. */
  detail: string;
}

export interface SvgImportReport {
  /** Aggregated by (kind, feature), sorted by kind, then feature. */
  entries: FidelityEntry[];
  summary: {
    elements: number;
    groups: number;
    paths: number;
    fills: number;
    strokes: number;
    vertices: number;
  };
}

export interface SvgImportResult {
  /** Valid against the contents of a shape layer. Coordinates are in viewBox space. */
  contents: ShapeItem[];
  viewBox: { x: number; y: number; width: number; height: number };
  /** Intrinsic size in px: the width/height attributes, else the viewBox size. */
  size: { width: number; height: number };
  /** Layer transform that places viewBox content at `size`, centred: the viewBox centre. */
  anchorPoint: [number, number];
  /** Layer scale that maps the viewBox onto `size` per `preserveAspectRatio`. */
  scale: [number, number];
  /** Text of the root `<title>`, trimmed, at most 200 characters. */
  title?: string;
  report: SvgImportReport;
}

export type SvgImportErrorCode = "too-large" | "not-svg" | "malformed" | "entities" | "limit";

/** Input the importer refuses. The message names the limit and what to do about it. */
export class SvgImportError extends Error {
  constructor(
    readonly code: SvgImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SvgImportError";
  }
}

/** `7210` as `7 210`, independent of the locale. */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
