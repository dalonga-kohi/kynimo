import { sampleNumber, textClusters } from "@kynimo/engine";
import type { DurationToken, GuidelinePack } from "@kynimo/guidelines";
import {
  type Composition,
  type FrameRate,
  type Interpolation,
  type Layer,
  type LayerType,
  MAX_MASKS,
  MAX_SHAPE_ITEMS,
  MAX_TEXT_ANIMATORS,
  type Op,
  type Project,
  type ShapeItem,
  type TextAnimator,
  type Vec2,
} from "@kynimo/scene";
import { z } from "zod";
import { type Endpoints, expandTransformTrack, windowFrames } from "./animate.js";
import { type InputPath, IntentError, scoped } from "./errors.js";
import { StaggerTiming, staggerDelays } from "./stagger.js";
import {
  DistanceInput,
  DurationInput,
  distancePx,
  EasingInput,
  interpolation,
  resolveStyle,
  TargetsInput,
} from "./style.js";
import { resolveTargets } from "./targets.js";

export const PRESET_KINDS = ["enter", "exit"] as const;

/** Layers that draw: every layer type with a transform except nulls. */
export const VISUAL_LAYER_TYPES = [
  "shape",
  "text",
  "image",
  "video",
  "solid",
  "precomp",
  "adjustment",
  "component",
] as const satisfies readonly LayerType[];

export interface PresetContext {
  doc: Project;
  pack: GuidelinePack;
  composition: Composition;
  fps: FrameRate;
}

/** The resolved window of one layer's preset: composition frame it opens at, its length and easing. */
export interface PresetTiming {
  start: number;
  frames: number;
  easing: Interpolation;
}

type Params = Record<string, unknown>;

export interface Preset {
  id: string;
  title: string;
  /** One line. */
  description: string;
  kind: (typeof PRESET_KINDS)[number];
  layerTypes: readonly LayerType[] | "any-visual";
  /** Strict; includes the common `start`, `duration` and `easing`. */
  params: z.ZodObject;
  defaults: {
    /** A token, or a function of the layer and params giving whole milliseconds (or a token). */
    duration: DurationToken | ((layer: Layer, params: Params) => DurationInput);
    easing: EasingInput;
  };
  expand(ctx: PresetContext, layer: Layer, params: Params, timing: PresetTiming): Op[];
}

const common = {
  start: z
    .number()
    .int()
    .optional()
    .describe("Composition frame the animation starts at; default per preset kind."),
  duration: DurationInput.optional().describe("Token or milliseconds."),
  easing: EasingInput.optional().describe("Easing or spring token, or an interpolation."),
};

const DIRECTIONS = ["up", "down", "left", "right"] as const;
type Direction = (typeof DIRECTIONS)[number];
const Direction = z.enum(DIRECTIONS);
/** Unit vector of travel on screen (y grows downward). */
const TRAVEL: Record<Direction, Vec2> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

const distance = (def: "small" | "base" | "large") =>
  DistanceInput.optional().describe(`Token or pixels; default '${def}'.`);

const Box = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
type Box = z.infer<typeof Box>;

/**
 * A preset animates each property of a layer at most once: two `setTransformTrack` ops for the
 * same layer and property would overwrite each other. A preset that does is a programming error.
 */
export function assertDistinctTracks(presetId: string, ops: readonly Op[]): void {
  const seen = new Set<string>();
  for (const op of ops) {
    if (op.op !== "setTransformTrack") continue;
    const key = `${JSON.stringify(op.layer)}:${op.property}`;
    if (seen.has(key))
      throw new Error(
        `preset '${presetId}' sets the ${op.property} track of ${JSON.stringify(op.layer)} twice; a preset must animate each property once`,
      );
    seen.add(key);
  }
}

/** One transform part of a preset, resolved against its layer. */
function transformPart(
  ctx: PresetContext,
  layer: Layer,
  timing: PresetTiming,
  property: Parameters<typeof expandTransformTrack>[1],
  from: Endpoints,
  to: Endpoints,
): Op {
  return expandTransformTrack(layer, property, from, to, {
    ...timing,
    fps: ctx.fps,
    path: [],
    equalPath: [],
  });
}

/** `[0, 1]`-style layer-time keyframes: `from` at the window start, `to` held at its end. */
const sweep = <T>(layer: Layer, timing: PresetTiming, from: T, to: T) => {
  const s = timing.start - layer.startFrame;
  return {
    keyframes: [
      { frame: s, value: from, interpolation: timing.easing },
      { frame: s + timing.frames, value: to, interpolation: { type: "hold" as const } },
    ],
  };
};

const times = (v: Vec2, n: number): Vec2 => [v[0] * n, v[1] * n];

const FADE_IN_PARAMS = z.strictObject(common);

function enterScaleOf(ctx: PresetContext): Vec2 {
  const n = ctx.pack.motion.enterScale;
  return [n, n];
}

const asText = (layer: Layer) => layer as Extract<Layer, { type: "text" }>;
const asShape = (layer: Layer) => layer as Extract<Layer, { type: "shape" }>;

function appendAnimator(layer: Layer, animator: TextAnimator): Op {
  const existing = asText(layer).animators;
  if (existing.length >= MAX_TEXT_ANIMATORS)
    throw new IntentError(
      [],
      `'${layer.id}' already has ${MAX_TEXT_ANIMATORS} text animators, the most a layer can have`,
    );
  return { op: "setTextAnimators", layer: layer.id, animators: [...existing, animator] } as Op;
}

/** A selector that covers the whole text and reveals it by sweeping `start` from 0 to 1. */
function revealSelector(unit: "characters" | "words", layer: Layer, timing: PresetTiming) {
  return {
    unit,
    start: sweep(layer, timing, 0, 1),
    end: { value: 1 },
    offset: { value: 0 },
    shape: "square" as const,
    easeHigh: { value: 0 },
    easeLow: { value: 0 },
    order: "forward" as const,
    seed: 0,
    amount: { value: 1 },
  };
}

/**
 * Units a typewriter types: the clusters the characters selector counts (a ZWJ emoji or a letter
 * with its combining marks is one), leaving out whitespace.
 */
export function typedCharacters(content: string): number {
  return textClusters(content).filter((c) => !/^\s*$/u.test(content.slice(c.start, c.end))).length;
}

function shapeItemIds(items: readonly ShapeItem[], into = new Set<string>()): Set<string> {
  for (const item of items) {
    into.add(item.id);
    if (item.type === "group") shapeItemIds(item.items, into);
  }
  return into;
}

/** The layer-space box a mask reveal sweeps over, from what the layer says about its size. */
function defaultBox(ctx: PresetContext, layer: Layer, timing: PresetTiming): Box {
  const missing = (why: string): never => {
    throw new IntentError(["params", "box"], `${why}; pass params.box {x, y, width, height}`);
  };
  switch (layer.type) {
    case "solid":
      return { x: 0, y: 0, width: layer.width, height: layer.height };
    case "image":
    case "video": {
      const asset = ctx.doc.assets.find((a) => a.id === layer.assetId);
      if (asset === undefined || (asset.type !== "image" && asset.type !== "video"))
        return missing(`'${layer.id}' references no image or video asset`);
      return { x: 0, y: 0, width: asset.width, height: asset.height };
    }
    case "text": {
      if (layer.box.mode === "point")
        return missing(`'${layer.id}' is point text and has no box to reveal`);
      const at = timing.start - layer.startFrame;
      return {
        x: 0,
        y: 0,
        width: sampleNumber(layer.box.width, at, ctx.fps),
        height: sampleNumber(layer.box.height, at, ctx.fps),
      };
    }
    default:
      return missing(`a ${layer.type} layer has no size the engine can read`);
  }
}

const corner = ([x, y]: Vec2) => ({ point: [x, y] as Vec2, inTangent: [0, 0], outTangent: [0, 0] });

/** The box as a closed four-vertex path, clipped to the edge the reveal starts from when `collapsed`. */
function boxPath(box: Box, direction: Direction, collapsed: boolean) {
  let { x, y, width: w, height: h } = box;
  if (collapsed) {
    if (direction === "right") {
      w = 0;
    } else if (direction === "left") {
      x += w;
      w = 0;
    } else if (direction === "down") {
      h = 0;
    } else {
      y += h;
      h = 0;
    }
  }
  return {
    closed: true,
    vertices: [corner([x, y]), corner([x + w, y]), corner([x + w, y + h]), corner([x, y + h])],
  };
}

const slideSign = { in: -1, out: 1 } as const;

function slide(kind: "in" | "out"): Preset["expand"] {
  return (ctx, layer, params, timing) => {
    const dir = TRAVEL[(params.direction as Direction | undefined) ?? "up"];
    const d = distancePx(
      (params.distance as DistanceInput | undefined) ?? "large",
      ctx.pack,
      ctx.composition,
    );
    const by: Vec2 = times(dir, slideSign[kind] * d);
    return kind === "in"
      ? [transformPart(ctx, layer, timing, "position", { by }, {})]
      : [transformPart(ctx, layer, timing, "position", {}, { by })];
  };
}

const TOKEN_DISTANCE = (params: Params, def: "small" | "base" | "large", ctx: PresetContext) =>
  distancePx((params.distance as DistanceInput | undefined) ?? def, ctx.pack, ctx.composition);

export const PRESETS: readonly Preset[] = [
  {
    id: "fade-in",
    title: "Fade in",
    description: "Opacity rises from 0 to its current value.",
    kind: "enter",
    layerTypes: "any-visual",
    params: FADE_IN_PARAMS,
    defaults: { duration: "base", easing: "enter" },
    expand: (ctx, layer, _p, timing) => [
      transformPart(ctx, layer, timing, "opacity", { value: 0 }, {}),
    ],
  },
  {
    id: "fade-up",
    title: "Fade up",
    description: "Fades in while rising from below into place.",
    kind: "enter",
    layerTypes: "any-visual",
    params: z.strictObject({ ...common, distance: distance("base") }),
    defaults: { duration: "base", easing: "enter" },
    expand(ctx, layer, params, timing) {
      const d = TOKEN_DISTANCE(params, "base", ctx);
      return [
        transformPart(ctx, layer, timing, "opacity", { value: 0 }, {}),
        transformPart(ctx, layer, timing, "position", { by: [0, d] }, {}),
      ];
    },
  },
  {
    id: "scale-in",
    title: "Scale in",
    description: "Grows from the style's enter scale to its current size while fading in.",
    kind: "enter",
    layerTypes: "any-visual",
    params: z.strictObject(common),
    defaults: { duration: "base", easing: "enter" },
    expand: (ctx, layer, _p, timing) => [
      transformPart(ctx, layer, timing, "scale", { times: enterScaleOf(ctx) }, {}),
      transformPart(ctx, layer, timing, "opacity", { value: 0 }, {}),
    ],
  },
  {
    id: "slide-in",
    title: "Slide in",
    description: "Travels in the given direction from off to its current position.",
    kind: "enter",
    layerTypes: "any-visual",
    params: z.strictObject({
      ...common,
      direction: Direction.optional().describe("Direction of travel; default 'up'."),
      distance: distance("large"),
    }),
    defaults: { duration: "base", easing: "enter" },
    expand: slide("in"),
  },
  {
    id: "pop",
    title: "Pop",
    description: "Springs from zero scale to its current size.",
    kind: "enter",
    layerTypes: "any-visual",
    params: z.strictObject(common),
    defaults: { duration: "base", easing: "bouncy" },
    expand: (ctx, layer, _p, timing) => [
      transformPart(ctx, layer, timing, "scale", { value: [0, 0] }, {}),
    ],
  },
  {
    id: "mask-reveal",
    title: "Mask reveal",
    description: "Wipes the layer in with a rectangular mask that grows from one edge.",
    kind: "enter",
    layerTypes: "any-visual",
    params: z.strictObject({
      ...common,
      direction: Direction.optional().describe("Direction the wipe travels; default 'right'."),
      box: Box.optional().describe(
        "Layer-space rectangle to reveal. Default: the layer's own size (solid, image, video, text box); required for shape, point text and others.",
      ),
    }),
    defaults: { duration: "base", easing: "enter" },
    expand(ctx, layer, params, timing) {
      const direction = (params.direction as Direction | undefined) ?? "right";
      if (!("masks" in layer)) throw new IntentError([], `a ${layer.type} layer has no masks`);
      if (layer.masks.length >= MAX_MASKS)
        throw new IntentError(
          [],
          `'${layer.id}' already has ${MAX_MASKS} masks, the most a layer can have`,
        );
      const box = (params.box as Box | undefined) ?? defaultBox(ctx, layer, timing);
      return [
        {
          op: "addMask",
          layer: layer.id,
          mask: {
            name: "Reveal",
            mode: "add",
            inverted: false,
            path: sweep(
              layer,
              timing,
              boxPath(box, direction, true),
              boxPath(box, direction, false),
            ),
            feather: { value: [0, 0] },
            opacity: { value: 1 },
            expansion: { value: 0 },
          },
        } as Op,
      ];
    },
  },
  {
    id: "typewriter",
    title: "Typewriter",
    description: "Types the text out character by character at a steady speed.",
    kind: "enter",
    layerTypes: ["text"],
    params: z.strictObject({
      ...common,
      cps: z
        .number()
        .min(1)
        .max(1000)
        .optional()
        .describe(
          "Characters per second, whitespace not counted; default 20. 'duration' overrides.",
        ),
    }),
    defaults: {
      duration: (layer, params) => {
        const cps = (params.cps as number | undefined) ?? 20;
        const chars = typedCharacters(asText(layer).content.value);
        return Math.max(1, Math.round((chars / cps) * 1000));
      },
      easing: { type: "linear" },
    },
    expand: (_ctx, layer, _p, timing) => [
      appendAnimator(layer, {
        name: "Typewriter",
        selector: revealSelector("characters", layer, timing),
        properties: { opacity: { value: 0 } },
      }),
    ],
  },
  {
    id: "word-by-word",
    title: "Word by word",
    description: "Words fade in and rise into place one after another.",
    kind: "enter",
    layerTypes: ["text"],
    params: z.strictObject({ ...common, distance: distance("small") }),
    defaults: { duration: "slow", easing: "enter" },
    expand: (ctx, layer, params, timing) => [
      appendAnimator(layer, {
        name: "Word by word",
        selector: revealSelector("words", layer, timing),
        properties: {
          opacity: { value: 0 },
          position: { value: [0, TOKEN_DISTANCE(params, "small", ctx)] },
        },
      }),
    ],
  },
  {
    id: "draw-on",
    title: "Draw on",
    description: "Draws the layer's paths from start to end with a trim.",
    kind: "enter",
    layerTypes: ["shape"],
    params: z.strictObject(common),
    defaults: { duration: "slow", easing: "move" },
    expand(_ctx, layer, _p, timing) {
      const contents = asShape(layer).contents;
      if (contents.length >= MAX_SHAPE_ITEMS)
        throw new IntentError(
          [],
          `'${layer.id}' already has ${MAX_SHAPE_ITEMS} top-level shape items`,
        );
      const taken = shapeItemIds(contents);
      let id = "draw-on";
      for (let n = 2; taken.has(id); n++) id = `draw-on-${n}`;
      const trim = {
        type: "trim",
        id,
        name: "Draw on",
        start: { value: 0 },
        end: sweep(layer, timing, 0, 1),
        offset: { value: 0 },
        mode: "simultaneous",
      } as ShapeItem;
      return [{ op: "setShapeContents", layer: layer.id, contents: [...contents, trim] } as Op];
    },
  },
  {
    id: "fade-out",
    title: "Fade out",
    description: "Opacity falls from its current value to 0.",
    kind: "exit",
    layerTypes: "any-visual",
    params: z.strictObject(common),
    defaults: { duration: "base", easing: "exit" },
    expand: (ctx, layer, _p, timing) => [
      transformPart(ctx, layer, timing, "opacity", {}, { value: 0 }),
    ],
  },
  {
    id: "fade-down",
    title: "Fade down",
    description: "Fades out while sinking down from its current position.",
    kind: "exit",
    layerTypes: "any-visual",
    params: z.strictObject({ ...common, distance: distance("base") }),
    defaults: { duration: "base", easing: "exit" },
    expand(ctx, layer, params, timing) {
      const d = TOKEN_DISTANCE(params, "base", ctx);
      return [
        transformPart(ctx, layer, timing, "opacity", {}, { value: 0 }),
        transformPart(ctx, layer, timing, "position", {}, { by: [0, d] }),
      ];
    },
  },
  {
    id: "scale-out",
    title: "Scale out",
    description: "Shrinks to the style's enter scale while fading out.",
    kind: "exit",
    layerTypes: "any-visual",
    params: z.strictObject(common),
    defaults: { duration: "base", easing: "exit" },
    expand: (ctx, layer, _p, timing) => [
      transformPart(ctx, layer, timing, "scale", {}, { times: enterScaleOf(ctx) }),
      transformPart(ctx, layer, timing, "opacity", {}, { value: 0 }),
    ],
  },
  {
    id: "slide-out",
    title: "Slide out",
    description: "Travels in the given direction away from its current position.",
    kind: "exit",
    layerTypes: "any-visual",
    params: z.strictObject({
      ...common,
      direction: Direction.optional().describe("Direction of travel; default 'down'."),
      distance: distance("large"),
    }),
    defaults: { duration: "base", easing: "exit" },
    expand: slide("out"),
  },
];

const allowedTypes = (preset: Preset): readonly LayerType[] =>
  preset.layerTypes === "any-visual" ? VISUAL_LAYER_TYPES : preset.layerTypes;

export interface PresetDescription {
  id: string;
  title: string;
  description: string;
  kind: Preset["kind"];
  layerTypes: LayerType[];
  /** JSON Schema (draft-7) of the preset's `params`. */
  params: unknown;
}

/** The catalog as JSON-able data, in stable order. */
export function presetCatalog(): PresetDescription[] {
  return PRESETS.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    kind: p.kind,
    layerTypes: [...allowedTypes(p)],
    params: z.toJSONSchema(p.params, { target: "draft-7", io: "input" }),
  }));
}

export const ApplyPresetInput = z.strictObject({
  layers: TargetsInput,
  preset: z.string().describe("A preset id from list_presets."),
  params: z.record(z.string(), z.unknown()).optional().describe("The preset's params."),
  stagger: StaggerTiming.optional().describe("Delay successive layers' starts."),
});
export type ApplyPresetInput = z.infer<typeof ApplyPresetInput>;

export interface ApplyPresetResolved {
  preset: string;
  layer_ids: string[];
  /** Composition frame each layer's animation starts at, per target in order (stagger included). */
  start_frames: number[];
  duration_frames: number[];
  easing: Interpolation;
  style: { packId: string; version: string; pinned: boolean };
}

function validateParams(preset: Preset, raw: unknown): Params {
  const parsed = preset.params.safeParse(raw ?? {});
  if (parsed.success) return parsed.data as Params;
  const issue = parsed.error.issues[0];
  const path: InputPath = ["params", ...((issue?.path ?? []) as InputPath)];
  if (issue?.code === "unrecognized_keys") {
    const allowed = Object.keys(preset.params.shape).join(", ");
    throw new IntentError(
      [...path, ...(issue.keys.length === 1 ? issue.keys : [])],
      `unknown param ${issue.keys.map((k) => `'${k}'`).join(", ")} for '${preset.id}'; it takes ${allowed}`,
    );
  }
  throw new IntentError(path, issue?.message ?? "invalid params");
}

/**
 * Expands a preset on each target layer into operations. Each layer's start is the preset's
 * default (enter: the layer's in frame; exit: so the animation ends on its last visible frame,
 * `outFrame - 1`) or `params.start`, plus its stagger delay (for exits at the default start the
 * delay counts back from the end instead, so the order still says which layer leaves first).
 */
export function applyPreset(
  doc: Project,
  input: ApplyPresetInput,
): { ops: Op[]; resolved: ApplyPresetResolved } {
  const preset = PRESETS.find((p) => p.id === input.preset);
  if (preset === undefined)
    throw new IntentError(
      ["preset"],
      `unknown preset '${input.preset}'; use one of: ${PRESETS.map((p) => p.id).join(", ")}`,
    );
  const params = validateParams(preset, input.params);
  const { pack, ref, pinned } = resolveStyle(doc);
  const targets = resolveTargets(doc, input.layers);
  const first = targets[0] as (typeof targets)[number];
  const { composition } = first;
  const fps = composition.fps;
  const ctx: PresetContext = { doc, pack, composition, fps };
  const allowed = allowedTypes(preset);
  const easing = interpolation(
    (params.easing as EasingInput | undefined) ?? preset.defaults.easing,
    pack,
  );
  const delays =
    input.stagger === undefined
      ? targets.map(() => 0)
      : staggerDelays(targets.length, input.stagger, pack, fps);

  const maxDelay = Math.max(0, ...delays);
  const ops: Op[] = [];
  const starts: number[] = [];
  const durations: number[] = [];
  targets.forEach(({ layer, path }, i) => {
    if (!allowed.includes(layer.type))
      throw new IntentError(
        path,
        `'${preset.id}' works on ${allowed.join(", ")} layers; '${layer.id}' is a ${layer.type} layer`,
      );
    const fallback =
      typeof preset.defaults.duration === "function"
        ? preset.defaults.duration(layer, params)
        : preset.defaults.duration;
    const frames = windowFrames(
      easing,
      params.duration as DurationInput | undefined,
      fallback,
      pack,
      fps,
      ["params", "duration"],
    );
    const delay = delays[i] as number;
    const explicit = params.start as number | undefined;
    // outFrame is exclusive: an exit lands on the last visible frame, outFrame - 1. With the
    // default start a stagger counts back from there, so layer 0 leaves first and every layer
    // still finishes on its own last visible frame.
    const start =
      explicit !== undefined
        ? explicit + delay
        : preset.kind === "enter"
          ? layer.inFrame + delay
          : layer.outFrame - 1 - frames - (maxDelay - delay);
    starts.push(start);
    durations.push(frames);
    const expanded = scoped(path, () =>
      preset.expand(ctx, layer, params, { start, frames, easing }),
    );
    assertDistinctTracks(preset.id, expanded);
    ops.push(...expanded);
  });
  return {
    ops,
    resolved: {
      preset: preset.id,
      layer_ids: targets.map((t) => t.layer.id),
      start_frames: starts,
      duration_frames: durations,
      easing,
      style: { ...ref, pinned },
    },
  };
}
