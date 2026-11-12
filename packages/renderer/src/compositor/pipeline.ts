import { type BlendMode, MAX_COMPOSITION_SIZE, type TrackMatte } from "@kynimo/scene";
import type { FramePlan, PlannedFrameLayer, PlannedLayer, PlannedMotionSample } from "../raster.js";

/**
 * Pipeline pieces shared by the reference and WebGL2 compositors, so both read the plan the same
 * way (ADR-0021). Only plain math here: this module also runs in the browser.
 */

/** `[a, b, c, d, e, f]`: (x, y) → (a·x + c·y + e, b·x + d·y + f), as in `@kynimo/engine`. */
export type Affine = readonly [number, number, number, number, number, number];

/**
 * A plane-to-plane projective map, row-major, applied to column vectors: `X = m0·x + m1·y + m2`,
 * `Y = m3·x + m4·y + m5`, `W = m6·x + m7·y + m8`, the point being `(X/W, Y/W)`. The same layout as
 * `Projective` in `@kynimo/engine` (this module does not import it at runtime). `W` is the camera
 * depth in composition pixels; matrices are never normalized.
 */
export type Projective = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Composition pixels in front of the camera at which 3D layers are clipped (`W <= NEAR` is not drawn). */
export const NEAR = 1;

export function invert([a, b, c, d, e, f]: Affine): Affine | null {
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Layer raster → composition: whole-pixel offset for vector layers, the layer matrix otherwise. */
export function placement(layer: PlannedLayer, padding: [number, number] = [0, 0]): Affine {
  const [x, y] = placementPadding(layer, padding);
  if (layer.space === "composition") return [1, 0, 0, 1, layer.x - x, layer.y - y];
  const [a, b, c, d, e, f] = layer.matrix;
  return [a, b, c, d, e - a * x - c * y, f - b * x - d * y];
}

/** A warped raster starts at its solved origin in the layer's original raster space. */
function placementPadding(layer: PlannedLayer, padding: [number, number]): [number, number] {
  const warp = layer.space === "layer" ? layer.deform : undefined;
  return warp === undefined ? padding : [padding[0] - warp.origin[0], padding[1] - warp.origin[1]];
}

/** The placement of a motion-blurred layer at one shutter sample: the sample's `delta` after `placement`. */
export function samplePlacement(
  layer: PlannedLayer,
  sample: PlannedMotionSample,
  padding: [number, number] = [0, 0],
): Affine {
  const [a, b, c, d, e, f] = sample.delta;
  const [a2, b2, c2, d2, e2, f2] = placement(layer, padding);
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

/** The map from the layer's raster pixels to composition pixels when it is a 3D layer, else `null`. */
export const layerProjection = (layer: PlannedLayer): Projective | null =>
  layer.space === "layer" ? (layer.projection ?? null) : null;

/**
 * Raster (before effect `padding`) → composition for a 3D layer: its projection, or `sample`'s when
 * it is a motion sample (that one is the full placement, not a delta), after the padding shift.
 * A layer without a projection falls back to its affine placement.
 */
export function projectivePlacement(
  layer: PlannedLayer,
  padding: [number, number] = [0, 0],
  sample?: PlannedMotionSample | null,
): Projective {
  const m = sample?.projection ?? layerProjection(layer);
  if (m === null) {
    const [a, b, c, d, e, f] = placement(layer, padding);
    return [a, c, e, b, d, f, 0, 0, 1];
  }
  const [x, y] = placementPadding(layer, padding);
  // m · translate(-x, -y): the third column absorbs the shift.
  return [
    m[0],
    m[1],
    m[2] - m[0] * x - m[1] * y,
    m[3],
    m[4],
    m[5] - m[3] * x - m[4] * y,
    m[6],
    m[7],
    m[8] - m[6] * x - m[7] * y,
  ];
}

/** The largest finite float32; the GPU receives the inverse as float32, so anything beyond overflows to Infinity. */
export const MAX_GPU_FLOAT = 3.4028234e38;

/** The true inverse (adjugate over determinant, not normalized); `null` when singular, not finite, or beyond float32 range. */
export function projectiveInvert(m: Projective): Projective | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0 || !Number.isFinite(det)) return null;
  const out = [
    A / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    C / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  return out.every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_GPU_FLOAT)
    ? (out as unknown as Projective)
    : null;
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

/** The deepest mip level a projective placement may sample: one texture per level, 14 in all. */
export const MAX_PROJECTIVE_LEVEL = Math.log2(MAX_COMPOSITION_SIZE);

/** Where a composition pixel lands in the source, and how minified it is there. */
export interface ProjectiveSample {
  /** Source position in texels of level 0. */
  qx: number;
  qy: number;
  /** Level of detail, clamped to `[0, min(maxLevel(width, height), MAX_PROJECTIVE_LEVEL)]`. */
  lod: number;
}

/**
 * The source position and level of detail of composition pixel `(x, y)` under the placement whose
 * true inverse is `inv`, or `null` when the pixel is not in front of the near plane (`W = 1 / h.z`
 * must exceed {@link NEAR}). The level comes from the projective Jacobian, so it varies per pixel;
 * for an affine placement it equals {@link levelOfDetail}. Both compositors implement exactly this.
 */
export function projectiveSample(
  inv: Projective,
  x: number,
  y: number,
  width: number,
  height: number,
): ProjectiveSample | null {
  const px = x + 0.5;
  const py = y + 0.5;
  const hx = inv[0] * px + inv[1] * py + inv[2];
  const hy = inv[3] * px + inv[4] * py + inv[5];
  const hz = inv[6] * px + inv[7] * py + inv[8];
  if (!(hz > 0 && hz * NEAR < 1)) return null;
  const qx = hx / hz;
  const qy = hy / hz;
  const rho = Math.max(
    Math.hypot((inv[0] - qx * inv[6]) / hz, (inv[3] - qy * inv[6]) / hz),
    Math.hypot((inv[1] - qx * inv[7]) / hz, (inv[4] - qy * inv[7]) / hz),
  );
  const lod = rho > 1 ? Math.min(Math.log2(rho), maxLevel(width, height), MAX_PROJECTIVE_LEVEL) : 0;
  return { qx, qy, lod };
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

/** Ids of the BLEND shader variants (`blendShader` in shaders.ts); the GPU tests check every mode. */
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
