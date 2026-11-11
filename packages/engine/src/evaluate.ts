import type {
  Animatable,
  Asset,
  BezierPath,
  Composition,
  FrameRate,
  Layer,
  Mask,
  Project,
  ShapeItem,
} from "@kynimo/scene";
import { MAX_COMPOSITION_SIZE } from "@kynimo/scene";
import { type Affine, multiply } from "./affine.js";
import { createBehaviorResolver } from "./behavior-resolve.js";
import { parseColor } from "./color.js";
import { resolveEffects } from "./effect.js";
import { resolveTransform, sampleNonNegative, sampleSize, sampleUnit } from "./properties.js";
import type {
  ResolvedAudio,
  ResolvedComposition,
  ResolvedLayer,
  ResolvedMask,
  ResolvedTransform,
} from "./resolved.js";
import { resolveShapeItems, samplePath } from "./shape.js";
import { resolveTextAnimators } from "./text-animator.js";
import { sampleColor, sampleNumber } from "./track.js";

type VisualLayer = Exclude<Layer, { type: "audio" }>;
type DrawnLayer = Exclude<VisualLayer, { type: "null" }>;

const vertexCount = (path: Animatable<BezierPath>): number =>
  ("value" in path ? path.value : path.keyframes[0]?.value)?.vertices.length ?? 0;

/**
 * Most work one `evaluateFrame` call may do inside precomps, in units: 1 per layer, plus 1 per
 * shape item, effect, mask, path or mask vertex and gradient stop, summed over every distinct (composition, local frame)
 * a precomp evaluates. The root composition is not charged: its work is linear in the document, except
 * that link behaviors with delays (ADR-0039) can make a chain of N links touch N² (layer, frame) pairs
 * (see {@link MAX_FRAME_LINK_STEPS}, which caps it). Other behaviors are not charged: each costs
 * O(log K) per (layer, property, evaluation) over a track's K keyframes (K is capped by the schema),
 * since the keyframe groups they read are built once per track.
 * The memo only collapses precomps that land on the same local frame, so precomps placed at many
 * different offsets multiply: N placements of N placements of N layers is N³ work from 3N layers
 * of JSON. For scale: a 1000-layer composition evaluated at 1000 different offsets costs 1,000,000.
 */
export const MAX_EVALUATION_UNITS = 1_000_000;

/**
 * Most link steps one evaluateFrame call may take, across every composition it evaluates. A step is one
 * (layer, property, composition frame) value that a link behavior (ADR-0039) asks for and the call's memo
 * does not hold yet. Each delay reads another frame, so a chain of N delayed links touches about N²/2
 * values per frame; undelayed chains hit the memo and cost N. Calibration: about 100,000 steps took
 * about 0.2 s (190 to 240 ms over five runs of a 447-layer delayed chain) on the maintainer's machine, so a frame that hits the cap is rejected in about that time.
 */
export const MAX_FRAME_LINK_STEPS = 100_000;

/** Units one evaluation of `comp` costs (see {@link MAX_EVALUATION_UNITS}). Iterative over shape groups. */
function compositionCost(comp: Composition): number {
  let units = 0;
  for (const layer of comp.layers) {
    units += 1;
    if (layer.type === "audio" || layer.type === "null") continue;
    units += layer.effects.length;
    for (const mask of layer.masks) units += 1 + vertexCount(mask.path);
    if (layer.type !== "shape") continue;
    const stack: ShapeItem[] = [...layer.contents];
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      units += 1;
      switch (item.type) {
        case "group":
          stack.push(...item.items);
          break;
        case "path":
          units += vertexCount(item.path);
          break;
        case "fill":
        case "stroke": {
          const paint = item.paint;
          if (paint.type !== "solid")
            units +=
              ("value" in paint.stops ? paint.stops.value : paint.stops.keyframes[0]?.value)
                ?.length ?? 0;
          break;
        }
        default:
          break;
      }
    }
  }
  return units;
}

/**
 * Maps a precomp layer's content time (parent frames) to the nested composition's frame.
 * Exact integer math, floored, so the nested composition is always sampled on its own frames
 * (After Effects "preserve frame rate"). BigInt because num/den are unbounded integers.
 */
export function nestedFrame(layerFrame: number, parent: FrameRate, nested: FrameRate): number {
  if (parent.num === nested.num && parent.den === nested.den) return layerFrame;
  const n = BigInt(layerFrame) * BigInt(nested.num) * BigInt(parent.den);
  const d = BigInt(nested.den) * BigInt(parent.num);
  const q = n / d; // truncates toward zero
  return Number(n < 0n && q * d !== n ? q - 1n : q);
}

interface Context {
  compositions: Map<string, Composition>;
  /** Video assets by id, for mapping layer time to source frames. */
  videos: Map<string, Extract<Asset, { type: "video" }>>;
  /** `compositionId@frame` → result. Shared precomp instances are evaluated once per call. */
  memo: Map<string, ResolvedComposition>;
  /** Units left in this call's {@link MAX_EVALUATION_UNITS} budget. */
  budget: number;
  /** Link steps left in this call's {@link MAX_FRAME_LINK_STEPS} budget. */
  linkSteps: number;
  /** Per-composition cost, computed once per call so counting is not multiplied too. */
  costs: Map<string, number>;
  /** Precomp layer ids from the root down to the composition being evaluated, for error messages. */
  chain: string[];
}

function evaluateComposition(
  ctx: Context,
  comp: Composition,
  frame: number,
  root: boolean,
): ResolvedComposition {
  const key = `${comp.id}@${frame}`;
  const cached = root ? undefined : ctx.memo.get(key);
  if (cached !== undefined) return cached;

  if (!root) charge(ctx, comp);

  const fps = comp.fps;
  const byId = new Map(comp.layers.map((l) => [l.id as string, l]));
  const local = new Map<string, { transform: ResolvedTransform; matrix: Affine }>();
  const world = new Map<string, Affine>();

  // Layers without behaviors take the plain sampling path below, untouched.
  const behaviors = createBehaviorResolver(byId, fps, (layerId, property) => {
    if (--ctx.linkSteps < 0)
      throw new RangeError(
        `evaluating this frame needs more than ${MAX_FRAME_LINK_STEPS} link steps (link behaviors that read other layers, each delay a separate frame); it ran out at layer '${layerId}' property '${property}'. Shorten link chains, or use fewer delayed links`,
      );
  });

  const localOf = (layer: VisualLayer) => {
    let entry = local.get(layer.id);
    if (entry === undefined) {
      entry =
        layer.behaviors.length === 0
          ? resolveTransform(layer.transform, frame - layer.startFrame, fps)
          : behaviors.transform(layer, frame);
      local.set(layer.id, entry);
    }
    return entry;
  };

  /**
   * Layer → composition space. Parents drive children whether or not they are visible on this
   * frame, each sampled at its own layer time. Iterative: chains can be MAX_LAYERS long, and the
   * schema rules out cycles.
   */
  const worldOf = (layer: VisualLayer): Affine => {
    const chain: VisualLayer[] = [];
    let current: VisualLayer | undefined = layer;
    while (current !== undefined && !world.has(current.id)) {
      chain.push(current);
      const parent: Layer | undefined =
        current.parent === null ? undefined : byId.get(current.parent);
      current = parent?.type === "audio" ? undefined : parent;
    }
    let above = current === undefined ? null : (world.get(current.id) as Affine);
    for (let i = chain.length - 1; i >= 0; i--) {
      const link = chain[i] as VisualLayer;
      const m = above === null ? localOf(link).matrix : multiply(above, localOf(link).matrix);
      world.set(link.id, m);
      above = m;
    }
    return world.get(layer.id) as Affine;
  };

  // Solo is per composition and covers audio too: once any layer is soloed, only soloed layers render or play.
  const anySolo = comp.layers.some((l) => l.solo);
  const inRange = (l: Layer) => l.inFrame <= frame && frame < l.outFrame;
  const active = (l: Layer) => !l.hidden && (!anySolo || l.solo) && inRange(l);

  const resolvedById = new Map<string, ResolvedLayer>();
  const resolve = (layer: DrawnLayer): ResolvedLayer => {
    let resolved = resolvedById.get(layer.id);
    if (resolved === undefined) {
      const layerFrame = frame - layer.startFrame;
      resolved = resolveLayer(ctx, layer, layerFrame, fps, {
        id: layer.id,
        name: layer.name,
        layerFrame,
        transform: localOf(layer).transform,
        matrix: worldOf(layer),
        blendMode: layer.blendMode,
        masks: resolveMasks(layer.masks, layerFrame, fps),
        effects: resolveEffects(layer.effects, layerFrame, fps),
        matte: null,
      });
      resolvedById.set(layer.id, resolved);
    }
    return resolved;
  };

  const layers: ResolvedLayer[] = [];
  const audio: ResolvedAudio[] = [];
  for (const layer of comp.layers) {
    if (!active(layer)) continue;
    if (layer.type === "audio") {
      const layerFrame = frame - layer.startFrame;
      audio.push({
        id: layer.id,
        assetId: layer.assetId,
        layerFrame,
        volume: sampleNonNegative(layer.volume, layerFrame, fps),
      });
      continue;
    }
    if (layer.type === "null") continue;
    layers.push(resolve(layer));
  }

  // Track mattes, linked in a second pass so chains need no recursion. A matte source is resolved
  // whatever its hidden and solo switches say, but only inside its in/out range. The schema rules
  // out cycles and guarantees every source is a drawing layer of this composition.
  const pending = [...layers];
  for (let target = pending.pop(); target !== undefined; target = pending.pop()) {
    const matte = (byId.get(target.id) as DrawnLayer).matte;
    if (matte === null) continue;
    const source = byId.get(matte.layerId) as DrawnLayer;
    let resolved: ResolvedLayer | null = null;
    if (inRange(source)) {
      const known = resolvedById.has(source.id);
      resolved = resolve(source);
      if (!known) pending.push(resolved);
    }
    target.matte = { layerId: source.id, mode: matte.mode, source: resolved };
  }

  const result: ResolvedComposition = {
    id: comp.id,
    width: comp.width,
    height: comp.height,
    fps: { num: fps.num, den: fps.den },
    frame,
    background: root && comp.background !== null ? parseColor(comp.background) : null,
    layers,
    audio,
  };
  if (!root) ctx.memo.set(key, result);
  return result;
}

/** Charges one evaluation of a nested composition against the budget. Only reached through a precomp, so `chain` is never empty. */
function charge(ctx: Context, comp: Composition): void {
  let cost = ctx.costs.get(comp.id);
  if (cost === undefined) {
    cost = compositionCost(comp);
    ctx.costs.set(comp.id, cost);
  }
  ctx.budget -= cost;
  if (ctx.budget < 0)
    throw new RangeError(
      `evaluating this frame needs more than ${MAX_EVALUATION_UNITS} units of work (layers, shape items, effects, masks, path and mask vertices, gradient stops); it ran out in composition '${comp.id}' via precomp layers ${ctx.chain.join(" > ")}. Precomps placed at many different start frames multiply: place fewer copies, or give copies the same startFrame`,
    );
}

function withChain<T>(ctx: Context, layerId: string, run: () => T): T {
  ctx.chain.push(layerId);
  try {
    return run();
  } finally {
    ctx.chain.pop();
  }
}

type Base = Pick<
  ResolvedLayer,
  | "id"
  | "name"
  | "layerFrame"
  | "transform"
  | "matrix"
  | "blendMode"
  | "masks"
  | "effects"
  | "matte"
>;

/** Keeps eased overshoot inside the schema's range, so the renderer never strokes absurd widths. */
const clampExpansion = (e: number) =>
  Math.min(MAX_COMPOSITION_SIZE, Math.max(-MAX_COMPOSITION_SIZE, e));

function resolveMasks(masks: readonly Mask[], frame: number, fps: FrameRate): ResolvedMask[] {
  const resolved: ResolvedMask[] = [];
  for (const mask of masks) {
    if (mask.mode === "none") continue;
    resolved.push({
      id: mask.id,
      mode: mask.mode,
      inverted: mask.inverted,
      path: samplePath(mask.path, frame, fps),
      feather: sampleSize(mask.feather, frame, fps),
      opacity: sampleUnit(mask.opacity, frame, fps),
      expansion: clampExpansion(sampleNumber(mask.expansion, frame, fps)),
    });
  }
  return resolved;
}

function resolveLayer(
  ctx: Context,
  layer: DrawnLayer,
  frame: number,
  fps: FrameRate,
  base: Base,
): ResolvedLayer {
  switch (layer.type) {
    case "shape":
      return { ...base, type: "shape", contents: resolveShapeItems(layer.contents, frame, fps) };
    case "text": {
      const box = layer.box;
      return {
        ...base,
        type: "text",
        content: layer.content.value,
        box:
          box.mode === "point"
            ? { mode: "point" }
            : {
                mode: "box",
                width: sampleNonNegative(box.width, frame, fps),
                height: sampleNonNegative(box.height, frame, fps),
                autoFit: box.autoFit,
              },
        font: {
          family: layer.font.family,
          weight: layer.font.weight,
          size: sampleNonNegative(layer.font.size, frame, fps),
        },
        tracking: sampleNumber(layer.tracking, frame, fps),
        leading: sampleNonNegative(layer.leading, frame, fps),
        align: layer.align,
        textCase: layer.textCase,
        fill: sampleColor(layer.fill, frame, fps),
        animators: resolveTextAnimators(layer.animators, frame, fps),
      };
    }
    case "image":
      return { ...base, type: "image", assetId: layer.assetId };
    case "video": {
      const video = ctx.videos.get(layer.assetId);
      if (video === undefined)
        throw new RangeError(
          `layer '${layer.id}' references unknown video asset '${layer.assetId}'`,
        );
      // Same exact mapping as a precomp: source frames at the clip's own rate, floored.
      const source = nestedFrame(frame, fps, video.fps);
      return {
        ...base,
        type: "video",
        assetId: video.id,
        sourceFrame: source >= 0 && source < video.frameCount ? source : null,
      };
    }
    case "solid":
      return {
        ...base,
        type: "solid",
        width: layer.width,
        height: layer.height,
        color: parseColor(layer.color),
      };
    case "precomp": {
      const nested = ctx.compositions.get(layer.compositionId);
      if (nested === undefined)
        throw new RangeError(
          `layer '${layer.id}' references unknown composition '${layer.compositionId}'`,
        );
      const local = nestedFrame(frame, fps, nested.fps);
      return {
        ...base,
        type: "precomp",
        compositionId: nested.id,
        composition:
          local >= 0 && local < nested.durationFrames
            ? withChain(ctx, layer.id, () => evaluateComposition(ctx, nested, local, false))
            : null,
      };
    }
    case "adjustment":
      return { ...base, type: "adjustment" };
    case "component":
      return {
        ...base,
        type: "component",
        componentId: layer.componentId,
        componentVersion: layer.componentVersion,
        props: layer.props,
      };
  }
}

/**
 * Evaluates a composition (the main one by default) at an integer `frame` into a resolved layer
 * tree: every track sampled and clamped to its domain, parenting folded into matrices, precomps
 * nested at their local frame. Pure and deterministic; the document is never modified.
 * The project must already have passed `ProjectSchema`.
 */
export function evaluateFrame(
  project: Project,
  frame: number,
  compositionId: string = project.mainCompositionId,
): ResolvedComposition {
  const compositions = new Map(project.compositions.map((c) => [c.id as string, c]));
  const comp = compositions.get(compositionId);
  if (comp === undefined)
    throw new RangeError(
      `unknown composition '${compositionId}'; use one of: ${[...compositions.keys()].join(", ")}`,
    );
  if (!Number.isInteger(frame) || frame < 0 || frame >= comp.durationFrames)
    throw new RangeError(
      `frame must be an integer from 0 to ${comp.durationFrames - 1} for composition '${comp.id}' (got ${frame})`,
    );
  const videos = new Map<string, Extract<Asset, { type: "video" }>>();
  for (const a of project.assets) if (a.type === "video") videos.set(a.id, a);
  const ctx: Context = {
    compositions,
    videos,
    memo: new Map(),
    budget: MAX_EVALUATION_UNITS,
    linkSteps: MAX_FRAME_LINK_STEPS,
    costs: new Map(),
    chain: [],
  };
  return evaluateComposition(ctx, comp, frame, true);
}
