import type {
  Animatable,
  Asset,
  BezierPath,
  ComponentLayer,
  Composition,
  FrameRate,
  Layer,
  Mask,
  MotionBlur,
  Project,
  ShapeItem,
} from "@kynimo/scene";
import { MAX_COMPOSITION_SIZE } from "@kynimo/scene";
import { type Affine, multiply, transformMatrix } from "./affine.js";
import { createBehaviorResolver } from "./behavior-resolve.js";
import { parseColor } from "./color.js";
import { COMPONENT_COST_WEIGHT, type ComponentHost, MAX_COMPONENT_DEPTH } from "./component.js";
import { resolveEffects } from "./effect.js";
import { resolveGenerator } from "./generator.js";
import { hashWords } from "./hash.js";
import {
  affineApproximation,
  affineToMat4,
  lookAtRotation,
  type Mat4,
  mat4Invert,
  mat4Multiply,
  mat4RotateX,
  mat4RotateY,
  mat4RotateZ,
  mat4Translate,
  type Projective,
  projectiveDepth,
  projectLayerPlane,
} from "./projective.js";
import { resolveTransform, sampleNonNegative, sampleSize, sampleUnit } from "./properties.js";
import type {
  MotionSample,
  ResolvedAudio,
  ResolvedComposition,
  ResolvedLayer,
  ResolvedMask,
  ResolvedTransform,
} from "./resolved.js";
import { resolveShapeItems, samplePath } from "./shape.js";
import { resolveTextAnimators } from "./text-animator.js";
import { sampleColor, sampleNumber, sampleVector } from "./track.js";

type VisualLayer = Exclude<Layer, { type: "audio" }>;
type DrawnLayer = Exclude<VisualLayer, { type: "null" | "camera" }>;
type CameraLayer = Extract<Layer, { type: "camera" }>;

/** A layer that lives in 3D space: a camera, or a layer with its 3D switch on (ADR-0054). */
const is3D = (layer: VisualLayer): boolean => layer.type === "camera" || layer.threeD;

/** After Effects' default 50 mm lens on a 36 mm film back, in composition pixels. */
const defaultZoom = (width: number) => (width * 50) / 36;

interface Local {
  transform: ResolvedTransform;
  matrix: Affine;
}

/**
 * Everything that depends on one point in time (the composition frame, or a motion blur sample):
 * local and world transforms, the active camera's view and layer projections.
 */
interface Space {
  local(layer: VisualLayer): Local;
  /** The layer's placement: for a 3D layer, its projection and the affine approximation of it. */
  place(layer: DrawnLayer): { matrix: Affine; projection: Projective | null };
}

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

/**
 * Most transform resolutions (each chain link at each sample time, memoized per layer and time)
 * motion blur may do in one evaluateFrame call, nested compositions included. Without it
 * `samples` x chain depth x blurred layers is unbounded in the document size.
 */
export const MAX_FRAME_MOTION_TRANSFORMS = 65_536;

/**
 * The composition frames a motion-blurred layer is sampled at (ADR-0053): `samples` times evenly
 * spread over the shutter interval, which starts `shutterPhase` degrees after `frame` and lasts
 * `shutterAngle` degrees (360 is one frame). Sample i is the middle of the i-th slice.
 */
export function motionSampleTimes(
  frame: number,
  settings: Pick<MotionBlur, "shutterAngle" | "shutterPhase" | "samples">,
): number[] {
  const { shutterAngle, shutterPhase, samples } = settings;
  const times: number[] = [];
  for (let i = 0; i < samples; i++)
    times.push(frame + shutterPhase / 360 + (shutterAngle / 360) * ((i + 0.5) / samples));
  return times;
}

/** Units one evaluation of `comp` costs (see {@link MAX_EVALUATION_UNITS}). Iterative over shape groups. */
function compositionCost(comp: Composition): number {
  let units = 0;
  for (const layer of comp.layers) {
    units += 1;
    if (layer.type === "audio" || layer.type === "null" || layer.type === "camera") continue;
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
  /** Transform resolutions left in this call's {@link MAX_FRAME_MOTION_TRANSFORMS} budget. */
  motionTransforms: number;
  /** Per-composition cost, computed once per call so counting is not multiplied too. */
  costs: Map<string, number>;
  /** Precomp layer ids from the root down to the composition being evaluated, for error messages. */
  chain: string[];
  /** Evaluates component instances; without one they pass through unevaluated. */
  components: ComponentHost | undefined;
  /** Component instances currently being evaluated inside one another. */
  componentDepth: number;
  /** Seed of the component instance being evaluated; 0 in a document composition. */
  componentSeed: number;
}

/**
 * What an evaluation is for. Only the root is drawn on its background; a precomp is memoized and
 * charged by composition id; a component output is neither (it is charged by its caller).
 */
type EvaluationKind = "root" | "precomp" | "component";

function evaluateComposition(
  ctx: Context,
  comp: Composition,
  frame: number,
  kind: EvaluationKind,
): ResolvedComposition {
  const key = `${comp.id}@${frame}`;
  const cached = kind === "precomp" ? ctx.memo.get(key) : undefined;
  if (cached !== undefined) return cached;

  if (kind === "precomp") charge(ctx, comp);

  const fps = comp.fps;
  const byId = new Map(comp.layers.map((l) => [l.id as string, l]));

  // Layers without behaviors take the plain sampling path below, untouched.
  const behaviors = createBehaviorResolver(byId, fps, (layerId, property) => {
    if (--ctx.linkSteps < 0)
      throw new RangeError(
        `evaluating this frame needs more than ${MAX_FRAME_LINK_STEPS} link steps (link behaviors that read other layers, each delay a separate frame); it ran out at layer '${layerId}' property '${property}'. Shorten link chains, or use fewer delayed links`,
      );
  });

  // Solo is per composition and covers audio too: once any layer is soloed, only soloed layers render or play.
  const anySolo = comp.layers.some((l) => l.solo);
  const inRange = (l: Layer) => l.inFrame <= frame && frame < l.outFrame;
  const active = (l: Layer) => !l.hidden && (!anySolo || l.solo) && inRange(l);

  // The active camera: the topmost one that is not hidden and is in range. Solo does not apply.
  const camera = comp.layers.find(
    (l): l is CameraLayer => l.type === "camera" && !l.hidden && inRange(l),
  );

  /**
   * Builds the space at `time` (composition frames). The center frame's space is free; every other
   * transform a motion blur sample resolves is charged against MAX_FRAME_MOTION_TRANSFORMS, camera
   * chain links included, and `owner` is the blurred layer the charge names.
   */
  const createSpace = (time: number, charged: boolean): Space => {
    let owner = "";
    const localMemo = new Map<string, Local>();
    const worldMemo = new Map<string, Affine>();
    const local3Memo = new Map<string, Mat4>();
    const world3Memo = new Map<string, Mat4>();

    const local = (link: VisualLayer): Local => {
      let entry = localMemo.get(link.id);
      if (entry === undefined) {
        if (charged && --ctx.motionTransforms < 0)
          throw new RangeError(
            `evaluating this frame needs more than ${MAX_FRAME_MOTION_TRANSFORMS} motion blur transform samples (layer '${owner}'); use fewer samples or blur fewer layers`,
          );
        entry =
          link.behaviors.length === 0
            ? resolveTransform(link.transform, time - link.startFrame, fps)
            : behaviors.transform(link, time);
        localMemo.set(link.id, entry);
      }
      return entry;
    };

    /** Walks up the parent chain to the first layer `memo` already knows, then folds back down. */
    const fold = <M>(
      layer: VisualLayer,
      memo: Map<string, M>,
      localMatrix: (link: VisualLayer) => M,
      times: (above: M, own: M) => M,
    ): M => {
      const chain: VisualLayer[] = [];
      let current: VisualLayer | undefined = layer;
      while (current !== undefined && !memo.has(current.id)) {
        chain.push(current);
        const parent: Layer | undefined =
          current.parent === null ? undefined : byId.get(current.parent);
        current = parent?.type === "audio" ? undefined : parent;
      }
      let above = current === undefined ? null : (memo.get(current.id) as M);
      for (let i = chain.length - 1; i >= 0; i--) {
        const link = chain[i] as VisualLayer;
        const m = above === null ? localMatrix(link) : times(above, localMatrix(link));
        memo.set(link.id, m);
        above = m;
      }
      return memo.get(layer.id) as M;
    };

    /**
     * Layer → composition space, including every parent's transform. Parents drive children
     * whether or not they are visible on this frame, each sampled at its own layer time.
     * Iterative: chains can be MAX_LAYERS long, and the schema rules out cycles.
     */
    const world = (layer: VisualLayer): Affine =>
      fold(layer, worldMemo, (link) => local(link).matrix, multiply);

    /** A 3D layer's or camera's local matrix. */
    const local3 = (link: VisualLayer): Mat4 => {
      let m = local3Memo.get(link.id);
      if (m === undefined) {
        const t = local(link).transform;
        const [px, py] = t.position;
        if (link.type === "camera") {
          const poi =
            link.pointOfInterest === null
              ? null
              : sampleVector(link.pointOfInterest, time - link.startFrame, fps);
          const look =
            poi === null
              ? lookAtRotation(0, 0, 0)
              : lookAtRotation(poi[0] - px, poi[1] - py, poi[2] - t.positionZ);
          m = mat4Multiply(
            mat4Multiply(mat4Translate(px, py, t.positionZ), look),
            mat4Multiply(
              mat4RotateX(t.rotationX),
              mat4Multiply(mat4RotateY(t.rotationY), mat4RotateZ(t.rotation)),
            ),
          );
        } else {
          // translate · rotateX · rotateY · (rotateZ · skew · scale · translate(-anchor))
          const flat = transformMatrix({ ...t, position: [0, 0] });
          m = mat4Multiply(
            mat4Multiply(mat4Translate(px, py, t.positionZ), mat4RotateX(t.rotationX)),
            mat4Multiply(mat4RotateY(t.rotationY), affineToMat4(flat)),
          );
        }
        local3Memo.set(link.id, m);
      }
      return m;
    };

    /** Layer → composition space in 3D: 3D links contribute their full local, 2D links their 2D one. */
    const world3 = (layer: VisualLayer): Mat4 =>
      fold(
        layer,
        world3Memo,
        (link) => (is3D(link) ? local3(link) : affineToMat4(local(link).matrix)),
        mat4Multiply,
      );

    let cameraState: { view: Mat4; zoom: number } | undefined;
    const activeCamera = () => {
      if (cameraState === undefined) {
        if (camera === undefined) {
          const zoom = defaultZoom(comp.width);
          cameraState = {
            view: mat4Translate(-comp.width / 2, -comp.height / 2, zoom),
            zoom,
          };
        } else {
          const view = mat4Invert(world3(camera));
          const zoom = sampleNumber(camera.zoom, time - camera.startFrame, fps);
          if (view === null || !Number.isFinite(zoom))
            throw new RangeError(
              `the 3D transform of layer '${camera.id}' is not finite; check positionZ, rotations and the camera zoom`,
            );
          cameraState = { view, zoom: Math.min(100_000, Math.max(1, zoom)) };
        }
      }
      return cameraState;
    };

    return {
      local(layer) {
        owner = layer.id;
        return local(layer);
      },
      place(layer) {
        owner = layer.id;
        if (!layer.threeD) return { matrix: world(layer), projection: null };
        const { view, zoom } = activeCamera();
        const projection = projectLayerPlane(
          mat4Multiply(view, world3(layer)),
          zoom,
          comp.width,
          comp.height,
        );
        if (!projection.every(Number.isFinite))
          throw new RangeError(
            `the 3D transform of layer '${layer.id}' is not finite; check positionZ, rotations and the camera zoom`,
          );
        const anchor = local(layer).transform.anchorPoint;
        return {
          matrix: affineApproximation(projection, anchor) ?? world(layer),
          projection,
        };
      },
    };
  };

  const center = createSpace(frame, false);

  // Motion blur (ADR-0053): the layer's placement and own opacity at each sub-frame time, in
  // spaces of their own so the center frame's stays untouched. A 3D layer samples the camera too.
  const sampled = new Map<number, Space>();
  const motionOf = (layer: DrawnLayer): readonly MotionSample[] | null => {
    const settings = layer.motionBlur;
    if (settings === null || settings.shutterAngle === 0 || layer.type === "adjustment")
      return null;
    return motionSampleTimes(frame, settings).map((t) => {
      let space = sampled.get(t);
      if (space === undefined) {
        space = createSpace(t, true);
        sampled.set(t, space);
      }
      const { matrix, projection } = space.place(layer);
      return { matrix, projection, opacity: space.local(layer).transform.opacity };
    });
  };

  const resolvedById = new Map<string, ResolvedLayer>();
  const resolve = (layer: DrawnLayer): ResolvedLayer => {
    let resolved = resolvedById.get(layer.id);
    if (resolved === undefined) {
      const layerFrame = frame - layer.startFrame;
      resolved = resolveLayer(ctx, comp, layer, layerFrame, {
        id: layer.id,
        name: layer.name,
        layerFrame,
        transform: center.local(layer).transform,
        ...center.place(layer),
        blendMode: layer.blendMode,
        masks: resolveMasks(layer.masks, layerFrame, fps),
        effects: resolveEffects(layer.effects, layerFrame, fps),
        matte: null,
        motion: motionOf(layer),
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
    if (layer.type === "null" || layer.type === "camera") continue;
    layers.push(resolve(layer));
  }
  sortDepthRuns(layers);

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
    background: kind === "root" && comp.background !== null ? parseColor(comp.background) : null,
    layers,
    audio,
  };
  if (kind === "precomp") ctx.memo.set(key, result);
  return result;
}

/**
 * Depth sorting (ADR-0054, After Effects without collapse): every maximal run of consecutive 3D
 * layers is stably sorted by the camera-space depth of its anchor point, nearest first. A 2D layer
 * or an adjustment layer ends a run, so layers never sort across them.
 */
function sortDepthRuns(layers: ResolvedLayer[]): void {
  const depth = (l: ResolvedLayer) =>
    projectiveDepth(l.projection as Projective, l.transform.anchorPoint);
  let i = 0;
  while (i < layers.length) {
    if ((layers[i] as ResolvedLayer).projection === null) {
      i++;
      continue;
    }
    let j = i;
    while (j < layers.length && (layers[j] as ResolvedLayer).projection !== null) j++;
    if (j - i > 1) {
      const run = layers
        .slice(i, j)
        .map((layer, order) => ({ layer, order, depth: depth(layer) }))
        .sort((a, b) => a.depth - b.depth || a.order - b.order);
      run.forEach((entry, k) => {
        layers[i + k] = entry.layer;
      });
    }
    i = j;
  }
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
  | "projection"
  | "blendMode"
  | "masks"
  | "effects"
  | "matte"
  | "motion"
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
  parent: Composition,
  layer: DrawnLayer,
  frame: number,
  base: Base,
): ResolvedLayer {
  const fps = parent.fps;
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
    case "generator":
      return {
        ...base,
        type: "generator",
        width: layer.width,
        height: layer.height,
        generator: resolveGenerator(layer.generator, frame, fps, layer.width, layer.height),
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
            ? withChain(ctx, layer.id, () => evaluateComposition(ctx, nested, local, "precomp"))
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
        composition: resolveComponent(ctx, parent, layer, frame),
      };
  }
}

/**
 * Seed for a component instance: a hash of the layer id's UTF-16 code units, chained from the
 * enclosing instance's seed (0 in a document composition), so it is stable in the document and
 * differs between same-named layers inside different instances.
 */
function deriveComponentSeed(parentSeed: number, layerId: string): number {
  const words: number[] = [];
  for (let i = 0; i < layerId.length; i++) words.push(layerId.charCodeAt(i));
  return hashWords(parentSeed, words);
}

/**
 * Asks the host for an instance's subtree and evaluates it like a precomp at the instance's local
 * frame. Never memoized: the output depends on the instance, not on a shared composition id.
 */
function resolveComponent(
  ctx: Context,
  parent: Composition,
  layer: ComponentLayer,
  layerFrame: number,
): ResolvedComposition | null {
  if (ctx.components === undefined || layerFrame < 0) return null;
  const depth = ctx.componentDepth + 1;
  if (depth > MAX_COMPONENT_DEPTH)
    throw new RangeError(
      `component layer '${layer.id}' nests components deeper than ${MAX_COMPONENT_DEPTH} levels (via ${[...ctx.chain, layer.id].join(" > ")})`,
    );
  const host = ctx.components;
  const seed = deriveComponentSeed(ctx.componentSeed, layer.id);
  return withChain(ctx, layer.id, () => {
    const out = host.evaluate(layer, {
      frame: layerFrame,
      fps: { num: parent.fps.num, den: parent.fps.den },
      durationFrames: layer.outFrame - layer.startFrame,
      width: parent.width,
      height: parent.height,
      seed,
      depth,
    });
    if (out.fps.num !== parent.fps.num || out.fps.den !== parent.fps.den)
      throw new RangeError(
        `component layer '${layer.id}' ('${layer.componentId}@${layer.componentVersion}') returned a subtree at ${out.fps.num}/${out.fps.den} fps; it must match the containing composition's ${parent.fps.num}/${parent.fps.den}`,
      );
    if (layerFrame >= out.durationFrames)
      throw new RangeError(
        `component layer '${layer.id}' ('${layer.componentId}@${layer.componentVersion}') returned a subtree of ${out.durationFrames} frames, too short for its local frame ${layerFrame}`,
      );
    // Each output layer also cost the host a schema validation, so it is charged COMPONENT_COST_WEIGHT times.
    ctx.budget -= compositionCost(out) * COMPONENT_COST_WEIGHT;
    if (ctx.budget < 0)
      throw new RangeError(
        `evaluating this frame needs more than ${MAX_EVALUATION_UNITS} units of work (layers, shape items, effects, masks, path and mask vertices, gradient stops; a component's output counts ${COMPONENT_COST_WEIGHT} times because the host validates it); it ran out in component layer '${layer.id}' via layers ${ctx.chain.join(" > ")}. Components placed many times multiply: place fewer instances, or use components with fewer layers`,
      );
    const parentSeed = ctx.componentSeed;
    ctx.componentDepth = depth;
    ctx.componentSeed = seed;
    try {
      return evaluateComposition(ctx, out, layerFrame, "component");
    } finally {
      ctx.componentDepth = depth - 1;
      ctx.componentSeed = parentSeed;
    }
  });
}

export interface EvaluateOptions {
  /** Evaluates component instances into nested compositions. Without it they pass through unevaluated. */
  components?: ComponentHost;
}

/**
 * Evaluates a composition (the main one by default) at an integer `frame` into a resolved layer
 * tree: every track sampled and clamped to its domain, parenting folded into matrices, precomps
 * nested at their local frame, component instances evaluated by `options.components`. Pure and deterministic; the document is never modified.
 * The project must already have passed `ProjectSchema`.
 */
export function evaluateFrame(
  project: Project,
  frame: number,
  compositionId: string = project.mainCompositionId,
  options: EvaluateOptions = {},
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
    motionTransforms: MAX_FRAME_MOTION_TRANSFORMS,
    costs: new Map(),
    chain: [],
    components: options.components,
    componentDepth: 0,
    componentSeed: 0,
  };
  return evaluateComposition(ctx, comp, frame, "root");
}
