import type { Composition, FrameRate, Layer, Project } from "@kynimo/scene";
import { type Affine, multiply } from "./affine.js";
import { parseColor } from "./color.js";
import { resolveTransform, sampleNonNegative } from "./properties.js";
import type {
  ResolvedAudio,
  ResolvedComposition,
  ResolvedLayer,
  ResolvedTransform,
} from "./resolved.js";
import { resolveShapeItems } from "./shape.js";
import { sampleColor, sampleNumber } from "./track.js";

type VisualLayer = Exclude<Layer, { type: "audio" }>;

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
  /** `compositionId@frame` → result. Shared precomp instances are evaluated once per call. */
  memo: Map<string, ResolvedComposition>;
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

  const fps = comp.fps;
  const byId = new Map(comp.layers.map((l) => [l.id as string, l]));
  const local = new Map<string, { transform: ResolvedTransform; matrix: Affine }>();
  const world = new Map<string, Affine>();

  const localOf = (layer: VisualLayer) => {
    let entry = local.get(layer.id);
    if (entry === undefined) {
      entry = resolveTransform(layer.transform, frame - layer.startFrame, fps);
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
  const active = (l: Layer) =>
    !l.hidden && (!anySolo || l.solo) && l.inFrame <= frame && frame < l.outFrame;

  const layers: ResolvedLayer[] = [];
  const audio: ResolvedAudio[] = [];
  for (const layer of comp.layers) {
    if (!active(layer)) continue;
    const layerFrame = frame - layer.startFrame;
    if (layer.type === "audio") {
      audio.push({
        id: layer.id,
        assetId: layer.assetId,
        layerFrame,
        volume: sampleNonNegative(layer.volume, layerFrame, fps),
      });
      continue;
    }
    if (layer.type === "null") continue;
    const resolved = resolveLayer(ctx, layer, layerFrame, fps, {
      id: layer.id,
      name: layer.name,
      layerFrame,
      transform: localOf(layer).transform,
      matrix: worldOf(layer),
    });
    layers.push(resolved);
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

type Base = Pick<ResolvedLayer, "id" | "name" | "layerFrame" | "transform" | "matrix">;

function resolveLayer(
  ctx: Context,
  layer: Exclude<VisualLayer, { type: "null" }>,
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
      };
    }
    case "image":
      return { ...base, type: "image", assetId: layer.assetId };
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
            ? evaluateComposition(ctx, nested, local, false)
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
  return evaluateComposition({ compositions, memo: new Map() }, comp, frame, true);
}
