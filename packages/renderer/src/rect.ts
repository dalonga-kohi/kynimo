import type { Affine } from "@kynimo/engine";

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
 * clipped to the `width × height` composition; `null` when nothing is left.
 */
export function cropToComposition(
  bounds: Rect,
  width: number,
  height: number,
  [padX, padY] = [0, 0],
): Rect | null {
  const x0 = Math.max(-padX, Math.floor(bounds[0] - AA_PAD));
  const y0 = Math.max(-padY, Math.floor(bounds[1] - AA_PAD));
  const x1 = Math.min(width + padX, Math.ceil(bounds[2] + AA_PAD));
  const y1 = Math.min(height + padY, Math.ceil(bounds[3] + AA_PAD));
  return x1 <= x0 || y1 <= y0 ? null : [x0, y0, x1, y1];
}
