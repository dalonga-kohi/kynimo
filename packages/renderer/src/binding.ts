import type { ResolvedShapeItem } from "@kynimo/engine";
import { type Affine, IDENTITY, transformMatrix } from "@kynimo/engine";
import { type Contour, isGeometry, itemContour, transformContour } from "./geometry.js";

export type PaintItem = Extract<ResolvedShapeItem, { type: "fill" | "stroke" }>;

/** One fill or stroke and the geometry it paints. */
export interface PaintOp {
  paint: PaintItem;
  /** Paint space (the group that holds the fill or stroke) → layer space. */
  matrix: Affine;
  /** In paint space. Painted as one compound path, so fill rules act across contours. */
  contours: Contour[];
}

/**
 * Binds fills and strokes to geometry with After Effects semantics. Items are listed top-first.
 * A fill or stroke paints every path listed above it in its own group, including the paths inside
 * groups listed above it. Items lower in the list draw underneath, and a group's own paints draw
 * at the group's place in that order. Returns the ops bottom-first, ready to draw in order.
 *
 * Gradients and stroke widths live in the paint's own group space, so a group's transform scales
 * the strokes it holds but not the strokes of an enclosing group that paint its paths.
 */
export function bindPaints(items: readonly ResolvedShapeItem[]): PaintOp[] {
  const ops: PaintOp[] = [];
  walk(items, IDENTITY, ops);
  return ops.reverse();
}

/** Pushes ops top-first; returns this group's geometry (in its own space) for enclosing paints. */
function walk(items: readonly ResolvedShapeItem[], matrix: Affine, ops: PaintOp[]): Contour[] {
  const above: Contour[] = [];
  for (const item of items) {
    if (isGeometry(item)) above.push(itemContour(item));
    else if (item.type === "group") {
      const local = transformMatrix(item.transform);
      for (const contour of walk(item.items, item.matrix, ops))
        above.push(transformContour(local, contour));
    } else if (above.length > 0) ops.push({ paint: item, matrix, contours: [...above] });
  }
  return above;
}
