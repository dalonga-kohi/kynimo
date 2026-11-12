import { type Affine, invert } from "@kynimo/engine";
import { MAX_COMPOSITION_SIZE } from "@kynimo/scene";
import type { PlannedMotionSample } from "./raster.js";

/** `[left, top, right, bottom]`. */
export type Rect = [number, number, number, number];

/** Anti-aliasing reaches up to a pixel past the geometry. */
const AA_PAD = 1;

/** Axis-aligned box around the transformed rect; `null` if the result is not finite. */
export function transformRect(m: Affine, [l, t, r, b]: Rect): Rect | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [l, t],
    [r, t],
    [l, b],
    [r, b],
  ] as const) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  const box: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return box.every(Number.isFinite) ? box : null;
}

export const union = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

/**
 * Whole-pixel `[x0, y0, x1, y1]` covering composition-space `bounds` plus anti-aliasing room,
 * clipped to the `width × height` composition (or to `limit` when given, see `motionCropRect`);
 * `null` when nothing is left.
 */
export function cropToComposition(
  bounds: Rect,
  width: number,
  height: number,
  [padX, padY] = [0, 0],
  limit: Rect = [0 - padX, 0 - padY, width + padX, height + padY],
): Rect | null {
  const x0 = Math.max(limit[0], Math.floor(bounds[0] - AA_PAD));
  const y0 = Math.max(limit[1], Math.floor(bounds[1] - AA_PAD));
  const x1 = Math.min(limit[2], Math.ceil(bounds[2] + AA_PAD));
  const y1 = Math.min(limit[3], Math.ceil(bounds[3] + AA_PAD));
  return x1 <= x0 || y1 <= y0 ? null : [x0, y0, x1, y1];
}

/**
 * Chooses the resolution of a layer-space raster (a 3D vector layer, ADR-0054) from its layer-space
 * `bounds`: the scale in raster pixels per layer unit, a power of two; `null` draws nothing.
 */
export type LayerRasterScale = (bounds: Rect) => number | null;

/**
 * Whole-pixel `[x0, y0, x1, y1]` of a layer-space raster at `scale` raster pixels per layer unit,
 * covering `bounds` plus anti-aliasing room. The origin is a multiple of `1 / scale` layer units,
 * so the pixel grid does not depend on the bounds.
 */
export const layerRasterRect = ([l, t, r, b]: Rect, scale: number): Rect => [
  Math.floor(l * scale - AA_PAD),
  Math.floor(t * scale - AA_PAD),
  Math.ceil(r * scale + AA_PAD),
  Math.ceil(b * scale + AA_PAD),
];

/**
 * The region a composition-space raster must cover so a motion-blurred layer still fills the frame
 * at every shutter sample (ADR-0053): the composition rect plus effect `padding`, unioned with that
 * rect carried back by each invertible sample `delta`. Reaches at most one composition width or
 * height past the padded rect on each side; faster content is clipped there. Without motion it is
 * exactly the padded rect, so unblurred layers crop as before. Whole pixels, like the crop it limits.
 */
export function motionCropRect(
  width: number,
  height: number,
  [padX, padY]: [number, number],
  motion: readonly PlannedMotionSample[] | null | undefined,
): Rect {
  const base: Rect = [0 - padX, 0 - padY, width + padX, height + padY];
  if (!motion) return base;
  let reach = base;
  for (const sample of motion) {
    const inverse = invert(sample.delta);
    if (inverse === null) continue;
    const box = transformRect(inverse, base);
    if (box !== null) reach = union(reach, box);
  }
  // The margin is also clamped so the crop never exceeds the texture limit.
  const marginX = Math.max(
    0,
    Math.min(width, Math.floor((MAX_COMPOSITION_SIZE - (width + 2 * padX)) / 2)),
  );
  const marginY = Math.max(
    0,
    Math.min(height, Math.floor((MAX_COMPOSITION_SIZE - (height + 2 * padY)) / 2)),
  );
  return [
    Math.max(Math.floor(reach[0]), base[0] - marginX),
    Math.max(Math.floor(reach[1]), base[1] - marginY),
    Math.min(Math.ceil(reach[2]), base[2] + marginX),
    Math.min(Math.ceil(reach[3]), base[3] + marginY),
  ];
}
