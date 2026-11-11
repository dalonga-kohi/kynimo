import type { BlendMode, TrackMatte } from "@kynimo/scene";
import type { FramePlan, PlannedFrameLayer, PlannedLayer } from "../raster.js";

/**
 * Pipeline pieces shared by the reference and WebGL2 compositors, so both read the plan the same
 * way (ADR-0021). Only plain math here: this module also runs in the browser.
 */

/** `[a, b, c, d, e, f]`: (x, y) → (a·x + c·y + e, b·x + d·y + f), as in `@kynimo/engine`. */
export type Affine = readonly [number, number, number, number, number, number];

export function invert([a, b, c, d, e, f]: Affine): Affine | null {
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Layer raster → composition: whole-pixel offset for vector layers, the layer matrix otherwise. */
export function placement(layer: PlannedLayer, [x, y] = [0, 0]): Affine {
  if (layer.space === "composition") return [1, 0, 0, 1, layer.x - x, layer.y - y];
  const [a, b, c, d, e, f] = layer.matrix;
  return [a, b, c, d, e - a * x - c * y, f - b * x - d * y];
}

const matteTarget = (layer: PlannedFrameLayer): PlannedLayer | null =>
  layer.type === "adjustment" ? (layer.matte?.source ?? null) : layer;

/** Mip levels of a `width × height` source: level n is ⌈size / 2ⁿ⌉, down to 1×1. */
export const maxLevel = (width: number, height: number) =>
  Math.floor(Math.log2(Math.max(width, height, 1)));

/**
 * The level of detail for a placement, from composition-to-texel scale: log₂ of the longer of the
 * two texel-space steps per composition pixel, clamped to the mip chain. 0 when magnifying or at
 * 1:1, which is plain bilinear. Constant per layer, because placements are affine.
 */
export function levelOfDetail(inverse: Affine, width: number, height: number): number {
  const rho = Math.max(Math.hypot(inverse[0], inverse[1]), Math.hypot(inverse[2], inverse[3]));
  const lod = Math.log2(rho);
  return lod > 0 ? Math.min(lod, maxLevel(width, height)) : 0;
}

export const MATTE_MODES: Readonly<Record<TrackMatte["mode"], number>> = {
  alpha: 1,
  "alpha-inverted": 2,
  luma: 3,
  "luma-inverted": 4,
};

/** Rec. 709 luma of premultiplied sRGB-encoded values: a luma matte's coverage (ADR-0021). */
export const LUMA = [0.2126, 0.7152, 0.0722] as const;

/**
 * The matte chain of `layer`, top first: `layer`, its matte source, that source's source, and so
 * on. The schema rules out cycles. `end` says how the last layer is matted: not at all, or by an
 * empty matte (its source is out of range or draws nothing).
 */
export function matteChain(layer: PlannedLayer): { chain: PlannedLayer[]; end: "none" | "empty" } {
  const chain = [layer];
  let last = layer;
  while (last.matte?.source != null) {
    last = last.matte.source;
    chain.push(last);
  }
  return { chain, end: last.matte === null ? "none" : "empty" };
}

/** Ids the BLEND shader switches on; they must match its `case` labels (the GPU tests check every mode). */
export const BLEND_MODE_IDS: Readonly<Record<BlendMode, number>> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  "color-dodge": 6,
  "color-burn": 7,
  "hard-light": 8,
  "soft-light": 9,
  difference: 10,
  exclusion: 11,
  hue: 12,
  saturation: 13,
  color: 14,
  luminosity: 15,
  add: 16,
  subtract: 17,
  divide: 18,
  "linear-burn": 19,
  "linear-light": 20,
  "vivid-light": 21,
  "pin-light": 22,
  "hard-mix": 23,
};

/**
 * How many times compositing `plan` reads each nested precomp frame: once per precomp layer
 * along every drawn layer's matte chain, in every distinct plan (each is composited once). Lets a
 * compositor free a nested result after its last use instead of holding all of them.
 */
export function precompUses(plan: FramePlan): Map<FramePlan, number> {
  const uses = new Map<FramePlan, number>();
  const stack = [plan];
  for (let p = stack.pop(); p !== undefined; p = stack.pop())
    for (const layer of p.layers) {
      const source = matteTarget(layer);
      if (source === null) continue;
      for (const el of matteChain(source).chain) {
        if (el.type !== "precomp") continue;
        const seen = uses.get(el.frame);
        uses.set(el.frame, (seen ?? 0) + 1);
        if (seen === undefined) stack.push(el.frame);
      }
    }
  return uses;
}
