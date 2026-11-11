import { parseColor } from "./color.js";
import { parseNumber } from "./numbers.js";
import type { XNode } from "./xml.js";

/** Properties that inherit from ancestors (and from a `<use>` into its referenced content). */
export const INHERITED = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "color",
  "visibility",
] as const;

/** Presentation attributes read from elements; `style` declarations override them. */
const PRESENTATION = new Set<string>([
  ...INHERITED,
  "opacity",
  "display",
  "vector-effect",
  "stop-color",
  "stop-opacity",
  "filter",
  "clip-path",
  "mask",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

export type Inherited = Partial<Record<string, string>>;

/** Splits a `style` attribute into declarations, ignoring `;` inside parentheses and quotes. */
export function parseStyleAttribute(style: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  const flush = (end: number): void => {
    const decl = style.slice(start, end);
    const colon = decl.indexOf(":");
    if (colon > 0) {
      const name = decl.slice(0, colon).trim().toLowerCase();
      const value = decl
        .slice(colon + 1)
        .replace(/!\s*important\s*$/i, "")
        .trim();
      if (name !== "" && value !== "") out.push([name, value]);
    }
    start = end + 1;
  };
  for (let i = 0; i < style.length; i++) {
    const c = style[i];
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) flush(i);
  }
  flush(style.length);
  return out;
}

const cache = new WeakMap<XNode, Record<string, string>>();

/** Declared values of an element: presentation attributes, overridden by its `style` attribute. */
export function declared(node: XNode): Record<string, string> {
  const hit = cache.get(node);
  if (hit !== undefined) return hit;
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of Object.entries(node.attrs)) {
    if (PRESENTATION.has(k)) out[k] = v.trim();
  }
  const style = node.attrs.style;
  if (style !== undefined) for (const [k, v] of parseStyleAttribute(style)) out[k] = v;
  cache.set(node, out);
  return out;
}

/** Inherited properties for `node`, given its parent's. `inherit` and absent values take the parent's. */
export function computeInherited(node: XNode, parent: Inherited): Inherited {
  const own = declared(node);
  const out: Inherited = {};
  for (const p of INHERITED) {
    const v = own[p];
    out[p] = v === undefined || v === "" || v === "inherit" ? parent[p] : v;
  }
  return out;
}

/** The element's `currentColor`: its inherited `color`, default black. */
export function currentColorOf(inh: Inherited): string {
  const c = inh.color;
  if (c === undefined) return "#000000";
  const parsed = parseColor(c);
  return parsed === undefined || parsed === "none" ? "#000000" : parsed;
}

/** A number or percentage as a 0..1 opacity; `undefined` when invalid. */
export function parseOpacity(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const s = value.trim();
  const n = s.endsWith("%") ? parseNumber(s.slice(0, -1)) : parseNumber(s);
  if (n === undefined) return undefined;
  return Math.max(0, Math.min(1, s.endsWith("%") ? n / 100 : n));
}

/** Properties the converter reads or reports itself (`filter`, `clip-path`, ...): never "unsupported". */
const CARRIED = new Set<string>([...PRESENTATION]);

/** Properties that only matter for text (reported as dropped) or rendering hints with no shape output. */
const HARMLESS = new Set<string>([
  "letter-spacing",
  "word-spacing",
  "line-height",
  "white-space",
  "direction",
  "unicode-bidi",
  "writing-mode",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "kerning",
  "color-interpolation",
  "color-interpolation-filters",
  "color-rendering",
  "shape-rendering",
  "image-rendering",
  "pointer-events",
  "cursor",
  "overflow",
  "enable-background",
  "flood-color",
  "flood-opacity",
  "lighting-color",
  "clip-rule",
  "user-select",
  "touch-action",
]);

/** Presentation attributes (not only style declarations) whose effect is not carried. */
const UNSUPPORTED_ATTRIBUTES = [
  "paint-order",
  "mix-blend-mode",
  "isolation",
  "transform-origin",
  "transform-box",
] as const;

const isHarmlessName = (name: string): boolean =>
  HARMLESS.has(name) ||
  name.startsWith("font") ||
  name.startsWith("text-") ||
  name.startsWith("glyph-orientation") ||
  // Vendor-prefixed (`-inkscape-font-specification`, `-webkit-...`) and custom (`--x`) properties.
  name.startsWith("-");

/** Declarations whose value equals the property's initial value. */
function isDefaultValue(name: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  switch (name) {
    case "isolation":
      return v === "auto";
    case "mix-blend-mode":
      return v === "normal";
    case "paint-order":
      return v === "normal" || v === "fill";
    default:
      return false;
  }
}

const unsupportedCache = new WeakMap<XNode, string[]>();

/**
 * Names of the style declarations and presentation attributes on `node` that the importer does not
 * apply and that are not harmless, e.g. `paint-order: stroke`, `mix-blend-mode: multiply`, a CSS
 * `transform` in `style`. Each name once, in source order.
 */
export function unsupportedProperties(node: XNode): string[] {
  const hit = unsupportedCache.get(node);
  if (hit !== undefined) return hit;
  const out: string[] = [];
  const consider = (name: string, value: string): void => {
    if (CARRIED.has(name) || isHarmlessName(name) || isDefaultValue(name, value)) return;
    if (!out.includes(name)) out.push(name);
  };
  for (const name of UNSUPPORTED_ATTRIBUTES) {
    const v = node.attrs[name];
    if (v !== undefined) consider(name, v);
  }
  const style = node.attrs.style;
  if (style !== undefined) for (const [k, v] of parseStyleAttribute(style)) consider(k, v);
  // A root that explicitly shows its overflow is not clipped by browsers' viewport rules the way
  // the importer assumes.
  if (node.parent === null) {
    const overflow = (
      parseStyleAttribute(style ?? "").find(([k]) => k === "overflow")?.[1] ?? node.attrs.overflow
    )
      ?.trim()
      .toLowerCase();
    if (overflow === "visible" && !out.includes("overflow")) out.push("overflow");
  }
  unsupportedCache.set(node, out);
  return out;
}
