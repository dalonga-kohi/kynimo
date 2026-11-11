import type { Paint } from "@kynimo/scene";
import {
  apply,
  determinant,
  IDENTITY,
  isSimilarity,
  type Matrix,
  multiply,
  parseTransform,
} from "./affine.js";
import { parseColor, withOpacity } from "./color.js";
import type { Bbox } from "./geometry.js";
import { parseNumber, round6 } from "./numbers.js";
import type { ReportCollector } from "./report.js";
import { declared, parseOpacity } from "./style.js";
import { parseLength, type Viewport } from "./units.js";
import type { XNode } from "./xml.js";

const MAX_STOPS = 64;
const MAX_CHAIN = 32;

export interface GradientEnv {
  ids: Map<string, XNode>;
  viewport: Viewport;
  report: ReportCollector;
  /** The painted element, for report examples. */
  element: XNode;
  currentColor: string;
  /** Bounding box of the element's geometry in its own coordinates. */
  bbox: Bbox | null;
  /** Matrix the element's geometry was baked with; gradient coordinates follow it. */
  bake: Matrix | null;
}

const hrefOf = (node: XNode): string | undefined => node.attrs.href ?? node.attrs["xlink:href"];

/** The gradient plus the gradients it inherits from, nearest first; cycle-safe. */
function gradientChain(start: XNode, ids: Map<string, XNode>): XNode[] {
  const chain: XNode[] = [];
  const seen = new Set<XNode>();
  let node: XNode | undefined = start;
  while (node !== undefined && !seen.has(node) && chain.length < MAX_CHAIN) {
    if (node.tag !== "linearGradient" && node.tag !== "radialGradient") break;
    seen.add(node);
    chain.push(node);
    const href: string | undefined = hrefOf(node)?.trim();
    node = href?.startsWith("#") ? ids.get(href.slice(1)) : undefined;
  }
  return chain;
}

interface Stop {
  offset: number;
  color: string;
}

function readStops(chain: XNode[], env: GradientEnv): Stop[] {
  const owner = chain.find((n) => n.children.some((c) => c.tag === "stop"));
  if (owner === undefined) return [];
  const stops: Stop[] = [];
  let last = 0;
  for (const child of owner.children) {
    if (child.tag !== "stop") continue;
    const own = declared(child);
    const rawOffset = (child.attrs.offset ?? "0").trim();
    let offset = rawOffset.endsWith("%")
      ? (parseNumber(rawOffset.slice(0, -1)) ?? 0) / 100
      : (parseNumber(rawOffset) ?? 0);
    offset = Math.max(last, Math.max(0, Math.min(1, offset)));
    last = offset;
    const stopColor = own["stop-color"] ?? "black";
    const ownCurrent = own.color === undefined ? undefined : parseColor(own.color);
    const current =
      ownCurrent === undefined || ownCurrent === "none" ? env.currentColor : ownCurrent;
    let parsed = parseColor(stopColor, current);
    if (parsed === undefined) {
      env.report.add(
        "dropped",
        "invalid-color",
        child,
        `The gradient stop color "${stopColor}" is not a color Kynimo understands, so black was used; use #rrggbb, rgb(), hsl() or a CSS color name.`,
      );
      parsed = "#000000";
    } else if (parsed === "none") parsed = "#00000000";
    const opacity = parseOpacity(own["stop-opacity"]) ?? 1;
    stops.push({ offset: round6(offset), color: withOpacity(parsed, opacity) });
  }
  return stops;
}

const solid = (color: string): Paint => ({ type: "solid", color: { value: color } });

/**
 * Converts a `linearGradient` / `radialGradient` to a gradient paint in the element's output
 * coordinates. `null` when the gradient paints nothing (no stops, or a degenerate bounding box).
 */
export function buildGradient(gradient: XNode, env: GradientEnv): Paint | null {
  const chain = gradientChain(gradient, env.ids);
  const attr = (name: string, sameType: boolean): string | undefined => {
    for (const n of chain) {
      if (sameType && n.tag !== gradient.tag) continue;
      const v = n.attrs[name];
      if (v !== undefined) return v.trim();
    }
    return undefined;
  };

  let stops = readStops(chain, env);
  if (stops.length === 0) return null;
  if (stops.length > MAX_STOPS) {
    env.report.add(
      "approximated",
      "gradient-stops",
      env.element,
      `A gradient has ${stops.length} stops; only the first ${MAX_STOPS} were kept. Simplify the gradient to ${MAX_STOPS} stops or fewer.`,
    );
    stops = stops.slice(0, MAX_STOPS);
  }
  const lastStop = stops[stops.length - 1];
  if (lastStop === undefined) return null;
  if (stops.length === 1) return solid(lastStop.color);

  const spread = attr("spreadMethod", false);
  if (spread === "reflect" || spread === "repeat") {
    env.report.add(
      "approximated",
      "spread-method",
      env.element,
      `A gradient uses spreadMethod="${spread}", which becomes "pad" (the end colors extend); add stops to imitate the repeat.`,
    );
  }

  const userSpace = attr("gradientUnits", false) === "userSpaceOnUse";
  let unitMatrix: Matrix = IDENTITY;
  if (!userSpace) {
    const b = env.bbox;
    if (b === null || !(b.width > 0) || !(b.height > 0)) {
      env.report.add(
        "dropped",
        "gradient-bbox",
        env.element,
        "A gradient paints a shape with zero width or height, where SVG draws nothing; give the shape an area or use gradientUnits=userSpaceOnUse.",
      );
      return null;
    }
    unitMatrix = [b.width, 0, 0, b.height, b.x, b.y];
  }
  const gtRaw = attr("gradientTransform", false);
  let gt: Matrix = IDENTITY;
  if (gtRaw !== undefined) {
    const parsed = parseTransform(gtRaw);
    if (parsed === undefined) {
      env.report.add(
        "dropped",
        "transform-error",
        env.element,
        "A gradientTransform could not be parsed and was ignored.",
      );
    } else gt = parsed;
  }
  const full: Matrix = multiply(env.bake ?? IDENTITY, multiply(unitMatrix, gt));

  const coord = (
    name: string,
    fallback: string,
    axis: "x" | "y" | "r",
    sameType = true,
  ): number => {
    const raw = attr(name, sameType) ?? fallback;
    return resolveCoord(raw, axis) ?? (resolveCoord(fallback, axis) as number);
  };
  const resolveCoord = (raw: string, axis: "x" | "y" | "r"): number | undefined => {
    if (!userSpace) {
      if (raw.endsWith("%")) {
        const n = parseNumber(raw.slice(0, -1));
        return n === undefined ? undefined : n / 100;
      }
      return parseLength(raw, axis, env.viewport)?.value;
    }
    return parseLength(raw, axis, env.viewport)?.value;
  };

  const outStops = stops.map((s) => ({ offset: s.offset, color: s.color }));
  if (gradient.tag === "linearGradient") {
    const x1 = coord("x1", "0%", "x");
    const y1 = coord("y1", "0%", "y");
    const x2 = coord("x2", "100%", "x");
    const y2 = coord("y2", "0%", "y");
    if (x1 === x2 && y1 === y2) return solid(lastStop.color);
    const start = apply(full, [x1, y1]);
    const end = apply(full, [x2, y2]);
    return {
      type: "linear-gradient",
      start: { value: [round6(start[0]), round6(start[1])] },
      end: { value: [round6(end[0]), round6(end[1])] },
      stops: { value: outStops },
    };
  }
  const cx = coord("cx", "50%", "x");
  const cy = coord("cy", "50%", "y");
  const r = coord("r", "50%", "r");
  const fxAttr = attr("fx", true);
  const fyAttr = attr("fy", true);
  const fx = fxAttr === undefined ? cx : (resolveCoord(fxAttr, "x") ?? cx);
  const fy = fyAttr === undefined ? cy : (resolveCoord(fyAttr, "y") ?? cy);
  if (Math.abs(fx - cx) > 1e-9 || Math.abs(fy - cy) > 1e-9) {
    env.report.add(
      "approximated",
      "gradient-focal",
      env.element,
      "A radial gradient has a focal point (fx, fy) away from its center, which Kynimo ignores; the gradient is centered instead.",
    );
  }
  if (!(r > 0)) return solid(lastStop.color);
  const scale = Math.sqrt(Math.abs(determinant(full)));
  if (!isSimilarity(full)) {
    env.report.add(
      "approximated",
      "gradient-transform",
      env.element,
      "A radial gradient is stretched or skewed (by its transform or the shape's bounding box); Kynimo's radial gradients are circular, so a mean radius was used.",
    );
  }
  const radius = round6(r * scale);
  if (!(radius > 0)) return solid(lastStop.color);
  const center = apply(full, [cx, cy]);
  return {
    type: "radial-gradient",
    center: { value: [round6(center[0]), round6(center[1])] },
    radius: { value: radius },
    stops: { value: outStops },
  };
}
