import type { ResolvedShapeItem } from "@kynimo/engine";
import { type Affine, IDENTITY, invert, multiply, transformMatrix } from "@kynimo/engine";
import { RenderError } from "./errors.js";
import {
  type Contour,
  type GeometryItem,
  isGeometry,
  itemContour,
  transformContour,
} from "./geometry.js";
import { roundCorners, trimContours } from "./operators.js";

export type PaintItem = Extract<ResolvedShapeItem, { type: "fill" | "stroke" }>;
type OperatorItem = Extract<ResolvedShapeItem, { type: "trim" | "round-corners" }>;
type RepeaterItem = Extract<ResolvedShapeItem, { type: "repeater" }>;

/** One fill or stroke and the geometry it paints. */
export interface PaintOp {
  paint: PaintItem;
  /** Paint space (the group that holds the fill or stroke) → layer space. */
  matrix: Affine;
  /** In paint space. Painted as one compound path, so fill rules act across contours. */
  contours: Contour[];
  /**
   * Product of the opacities of the groups that hold the paint (as in After Effects and Lottie).
   * The opacity of a group whose paths an enclosing paint reaches into does not apply.
   */
  opacity: number;
}

/**
 * Path work one shape layer may take per frame, in units: one per item visited (every copy of
 * every item a repeater copies), and one per segment plus one per contour each time a path is
 * built, changed by an operator, or handed to a paint. Repeaters multiply items, paints and
 * operators below a repeater act on every copy, and wrapping trims split contours, so a small
 * document could otherwise ask for minutes of CPU or more memory than the process has. Charged
 * before the work is done, so a refused layer allocates nothing large.
 */
export const MAX_SHAPE_LAYER_WORK = 500_000;

/**
 * The shape tree as the binder walks it: repeaters are already expanded into one group per copy,
 * and groups carry only their local matrix, so a copy can share the items it repeats.
 */
type Node =
  | { kind: "geometry"; item: GeometryItem }
  | { kind: "paint"; item: PaintItem }
  | { kind: "operator"; item: OperatorItem }
  | { kind: "group"; local: Affine; opacity: number; items: readonly Node[] };

/**
 * Binds fills and strokes to geometry with After Effects semantics. Items are listed top-first.
 * A fill or stroke paints every path listed above it in its own group, including the paths inside
 * groups listed above it. Items lower in the list draw underneath, and a group's own paints draw
 * at the group's place in that order. Returns the ops bottom-first, ready to draw in order.
 *
 * Gradients and stroke widths live in the paint's own group space, so a group's transform scales
 * the strokes it holds but not the strokes of an enclosing group that paint its paths.
 *
 * Path operators (ADR-0034) change the paths listed above them, in the operator's own group
 * space, nested groups included; inner groups' operators apply first. Every paint draws its paths
 * as all operators leave them, wherever it sits relative to them. A repeater copies everything
 * above it, as one group per copy.
 */
export function bindPaints(items: readonly ResolvedShapeItem[]): PaintOp[] {
  const pending: Pending[] = [];
  const budget = new Budget();
  walk(toNodes(items), null, 1, pending, budget);
  return pending.reverse().map(({ refs, ...op }) => {
    budget.charge(refs.reduce((sum, ref) => sum + cost(ref.slot.contours), 0));
    return { ...op, contours: refs.flatMap(resolve) };
  });
}

/** Counts path work against {@link MAX_SHAPE_LAYER_WORK}. */
class Budget {
  private left = MAX_SHAPE_LAYER_WORK;
  charge(units: number): void {
    this.left -= units;
    if (this.left < 0)
      throw new RenderError(
        `a shape layer needs more than ${MAX_SHAPE_LAYER_WORK} units of path work for one frame (items times repeater copies, plus path segments for every paint and operator that reads them); lower the repeater copy counts, the number of paints or operators below a repeater, or the paths' vertex counts`,
      );
  }
}

/** Work units for building, changing or painting these contours. */
const cost = (contours: readonly Contour[]): number =>
  contours.reduce((sum, c) => sum + c.segments.length + 1, 0);

function toNodes(items: readonly ResolvedShapeItem[]): Node[] {
  let out: Node[] = [];
  for (const item of items) {
    if (isGeometry(item)) out.push({ kind: "geometry", item });
    else if (item.type === "fill" || item.type === "stroke") out.push({ kind: "paint", item });
    else if (item.type === "trim" || item.type === "round-corners")
      out.push({ kind: "operator", item });
    else if (item.type === "repeater") out = repeat(out, item);
    else
      out.push({
        kind: "group",
        local: transformMatrix(item.transform),
        opacity: item.transform.opacity,
        items: toNodes(item.items),
      });
  }
  return out;
}

/** `sign(x)·|x|^f`, so a fraction of a flipping scale stays real. */
const signedPow = (x: number, f: number): number =>
  f === 1 ? x : f === 0 ? 1 : Math.sign(x) * Math.abs(x) ** f;

/** `n`-th power of `m` by squaring; negative powers use the inverse, if there is one. */
function power(m: Affine, n: number): Affine | null {
  let base: Affine | null = n < 0 ? invert(m) : m;
  if (base === null) return null;
  let e = Math.abs(n);
  let out: Affine = IDENTITY;
  while (e > 0) {
    if (e % 2 === 1) out = multiply(out, base);
    e = Math.floor(e / 2);
    if (e > 0) base = multiply(base, base);
  }
  return out;
}

const finite = (m: Affine): boolean => m.every(Number.isFinite);

/**
 * The repeater's copies of `above`, listed top-first. Copy `i` is transformed `offset + i` times:
 * `M^n · step(f)` with `n + f = offset + i`, where `M` is one step and `step(f)` the step with
 * position and rotation times `f` and scale to the power `f`. Its opacity runs linearly from
 * `startOpacity` (first copy) to `endOpacity` (copy `copies - 1`); a fractional count draws its
 * last copy at that fraction of its opacity, so an animated count fades copies in.
 */
function repeat(above: readonly Node[], r: RepeaterItem): Node[] {
  const count = Math.ceil(r.copies);
  if (count <= 0 || above.length === 0) return [];
  const step = (f: number): Affine =>
    transformMatrix({
      anchorPoint: r.anchorPoint,
      position: [r.anchorPoint[0] + r.position[0] * f, r.anchorPoint[1] + r.position[1] * f],
      scale: [signedPow(r.scale[0], f), signedPow(r.scale[1], f)],
      rotation: r.rotation * f,
      skew: 0,
    });
  const one = step(1);
  const whole = Math.floor(r.offset);
  const fraction = r.offset - whole;
  const partial = fraction === 0 ? null : step(fraction);
  const copies: Node[] = [];
  let m = power(one, whole);
  for (let i = 0; i < count; i++) {
    // A collapsing step has no inverse: copies at negative powers don't exist and draw nothing.
    const current = m ?? (whole + i >= 0 ? power(one, whole + i) : null);
    m = current === null ? null : multiply(one, current);
    if (current === null) continue;
    const local = partial === null ? current : multiply(current, partial);
    if (!finite(local)) continue;
    const t = r.copies > 1 ? Math.min(1, i / (r.copies - 1)) : 0;
    let opacity = r.startOpacity + (r.endOpacity - r.startOpacity) * t;
    if (i === count - 1 && r.copies < count) opacity *= r.copies - (count - 1);
    copies.push({ kind: "group", local, opacity, items: above });
  }
  // Top-first: `above` puts each later copy over the one before, so it is listed first.
  return r.composite === "above" ? copies.reverse() : copies;
}

/** One path's current contours, in the space of the group that holds it. Operators replace them. */
interface Slot {
  contours: Contour[];
}

/** A slot seen from an enclosing group: local matrices from the slot's group up, innermost first. */
interface Ref {
  slot: Slot;
  chain: readonly Affine[];
}

interface Pending {
  paint: PaintItem;
  matrix: Affine;
  refs: Ref[];
  opacity: number;
}

// Matrices are applied one level at a time, as before operators existed, so documents without
// operators keep their exact coordinates (and pixels).
const up = (contour: Contour, chain: readonly Affine[]): Contour =>
  chain.reduce((c, m) => transformContour(m, c), contour);

const resolve = (ref: Ref): Contour[] => ref.slot.contours.map((c) => up(c, ref.chain));

/** Maps contours from a ref's view back into its slot's space; `null` if a level collapses. */
function down(contours: Contour[], chain: readonly Affine[]): Contour[] | null {
  let out = contours;
  for (let i = chain.length - 1; i >= 0; i--) {
    const inverse = invert(chain[i] as Affine);
    if (inverse === null) return null;
    out = out.map((c) => transformContour(inverse, c));
  }
  return out;
}

/** Pushes ops top-first; returns refs to this group's paths for enclosing paints and operators. */
function walk(
  nodes: readonly Node[],
  matrix: Affine | null,
  opacity: number,
  pending: Pending[],
  budget: Budget,
): Ref[] {
  const above: Ref[] = [];
  for (const node of nodes) {
    budget.charge(1);
    switch (node.kind) {
      case "geometry": {
        const contours = [itemContour(node.item)];
        budget.charge(cost(contours));
        above.push({ slot: { contours }, chain: [] });
        break;
      }
      case "group": {
        const inner = matrix === null ? node.local : multiply(matrix, node.local);
        for (const ref of walk(node.items, inner, opacity * node.opacity, pending, budget))
          above.push({ slot: ref.slot, chain: [...ref.chain, node.local] });
        break;
      }
      case "paint":
        if (above.length > 0)
          pending.push({ paint: node.item, matrix: matrix ?? IDENTITY, refs: [...above], opacity });
        break;
      case "operator":
        operate(node.item, above, budget);
        break;
    }
  }
  return above;
}

/** Applies one operator, in its own group's space, to every path above it. */
function operate(item: OperatorItem, refs: readonly Ref[], budget: Budget): void {
  // Reading the paths and writing the result both scale with their size; charge both up front
  // for the input, and again for the output before it is mapped back and kept.
  budget.charge(refs.reduce((sum, ref) => sum + cost(ref.slot.contours), 0));
  const views = refs.map(resolve);
  // Per ref, per input contour: what the operator made of it.
  let results: Contour[][][];
  if (item.type === "round-corners")
    results = views.map((contours) => contours.map((c) => [roundCorners(c, item.radius)]));
  else {
    // Individual trims run over every contour in order, so flatten and regroup per slot.
    const flat = trimContours(views.flat(), item);
    let at = 0;
    results = views.map((contours) => {
      const mine = flat.slice(at, at + contours.length);
      at += contours.length;
      return mine;
    });
  }
  budget.charge(results.reduce((sum, r) => sum + cost(r.flat()), 0));
  refs.forEach((ref, i) => {
    const view = views[i] as Contour[];
    const own = ref.slot.contours;
    const next: Contour[] = [];
    (results[i] as Contour[][]).forEach((made, j) => {
      // An untouched contour comes back as the same object: keep the slot's own, exact one.
      if (made.length === 1 && made[0] === view[j]) next.push(own[j] as Contour);
      else if (ref.chain.length === 0) next.push(...made);
      else {
        // A path seen through a collapsing group has no area where it is drawn, and no way back
        // into that group's space: nothing of it remains (ADR-0034).
        const back = down(made, ref.chain);
        if (back !== null) next.push(...back);
      }
    });
    ref.slot.contours = next;
  });
}
