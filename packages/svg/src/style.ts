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
