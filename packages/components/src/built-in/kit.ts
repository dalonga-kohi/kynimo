import type { DurationToken, EasingToken, SpringToken } from "@kynimo/guidelines";
import {
  type Animatable,
  AssetIdSchema,
  type BezierPath,
  type BlendMode,
  type Color,
  type Effect,
  EffectIdSchema,
  type Generator,
  type Interpolation,
  type Keyframe,
  type Layer,
  LayerIdSchema,
  type Mask,
  MaskIdSchema,
  type RangeSelector,
  type ShapeItem,
  ShapeItemIdSchema,
  springSettleFrames,
  type TextAnimator,
  type Transform,
  type Vec2,
} from "@kynimo/scene";
import type { ComponentEvalContext } from "../define.js";
import type { PropDescriptor } from "../props.js";

/**
 * The shared kit of the built-in components: builders that return fully specified scene layers
 * (every required field set, effects and behaviors explicit) and the timing helpers that make every
 * component enter at the start of its instance and exit at the end of it. Pure and deterministic.
 */

/** Rounds to 3 decimals, the precision positions and sizes are written with. */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
export const vec = (x: number, y: number): Vec2 => [round3(x), round3(y)];

/** A constant property. */
export const still = <T>(value: T): { value: T } => ({ value });

const isTrack = (v: unknown): v is Animatable<unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** A plain value as a constant property, or a property as it is. */
export const track = <T>(v: T | Animatable<T>): Animatable<T> =>
  isTrack(v) ? (v as Animatable<T>) : still(v as T);

/** Maps every value of a property (a constant or each keyframe), keeping the timing. */
export function mapTrack<T, U>(t: Animatable<T>, f: (v: T) => U): Animatable<U> {
  if ("value" in t) return still(f(t.value));
  return {
    keyframes: t.keyframes.map((k) => ({
      frame: k.frame,
      value: f(k.value),
      interpolation: k.interpolation,
    })),
  };
}

/** A layer position from x and y (one of them may move on its own): a point, or separate tracks. */
export function position(
  x: number | Animatable<number>,
  y: number | Animatable<number>,
): Transform["position"] {
  if (typeof x === "number" && typeof y === "number") return still(vec(x, y));
  return { separate: { x: track(x), y: track(y) } };
}

export const HOLD: Interpolation = { type: "hold" };
export const LINEAR: Interpolation = { type: "linear" };

export const key = <T>(
  frame: number,
  value: T,
  interpolation: Interpolation = LINEAR,
): Keyframe<T> => ({ frame, value, interpolation });

/**
 * A keyframe track. A keyframe on the same frame as the one before replaces it (so windows that
 * touch don't collide); frames must not go backwards. One keyframe is a constant.
 */
export function keys<T>(...keyframes: Keyframe<T>[]): Animatable<T> {
  const out: Keyframe<T>[] = [];
  for (const k of keyframes) {
    const prev = out[out.length - 1];
    if (prev !== undefined && k.frame < prev.frame)
      throw new RangeError(
        `keyframes must not go backwards (frame ${k.frame} after ${prev.frame})`,
      );
    if (prev !== undefined && k.frame === prev.frame) out[out.length - 1] = k;
    else out.push(k);
  }
  const only = out[0];
  if (out.length === 1 && only !== undefined) return still(only.value);
  return { keyframes: out };
}

export function transform(over: Partial<Transform> = {}): Transform {
  return {
    anchorPoint: still<Vec2>([0, 0]),
    position: still<Vec2>([0, 0]),
    positionZ: still(0),
    scale: still<Vec2>([1, 1]),
    rotation: still(0),
    rotationX: still(0),
    rotationY: still(0),
    skew: still(0),
    opacity: still(1),
    ...over,
  };
}

/** Options every layer builder takes: an id (unique within the output), the span and a transform. */
export interface LayerOptions {
  id: string;
  /** Frames the layer lasts from frame 0: `max(1, ctx.durationFrames)`. */
  span: number;
  transform?: Partial<Transform>;
  masks?: Mask[];
  effects?: Effect[];
  blendMode?: BlendMode;
  name?: string;
}

function base(o: LayerOptions) {
  return {
    id: LayerIdSchema.parse(o.id),
    name: o.name ?? o.id,
    inFrame: 0,
    outFrame: o.span,
    startFrame: 0,
    hidden: false,
    solo: false,
    editor: { locked: false, shy: false, label: null },
    markers: [],
    parent: null,
    threeD: false,
    transform: transform(o.transform),
    behaviors: [],
    blendMode: o.blendMode ?? ("normal" as const),
    matte: null,
    masks: o.masks ?? [],
    effects: o.effects ?? [],
    motionBlur: null,
    transition: null,
  };
}

type TextLayer = Extract<Layer, { type: "text" }>;

const size = (n: number): number => Math.max(1, Math.round(n));

export function solidLayer(
  o: LayerOptions & { width: number; height: number; color: Color },
): Layer {
  return {
    ...base(o),
    type: "solid",
    deform: null,
    width: size(o.width),
    height: size(o.height),
    color: o.color,
  };
}

export function generatorLayer(
  o: LayerOptions & { width: number; height: number; generator: Generator },
): Layer {
  return {
    ...base(o),
    type: "generator",
    deform: null,
    width: size(o.width),
    height: size(o.height),
    generator: o.generator,
  };
}

/** A full-frame adjustment layer: its effects apply to everything composited below it. */
export function adjustmentLayer(o: LayerOptions): Layer {
  return { ...base(o), type: "adjustment" };
}

export function imageLayer(o: LayerOptions & { assetId: string }): Layer {
  return { ...base(o), type: "image", deform: null, assetId: AssetIdSchema.parse(o.assetId) };
}

export function shapeLayer(o: LayerOptions & { contents: ShapeItem[] }): Layer {
  return { ...base(o), type: "shape", deform: null, contents: o.contents };
}

export function textLayer(
  o: LayerOptions & {
    content: string;
    box: { mode: "point" } | { mode: "box"; width: number; height: number; autoFit: boolean };
    font: { family: string; weight: number; size: number | Animatable<number> };
    tracking: number;
    leading: number;
    align: "left" | "center" | "right";
    textCase: "none" | "upper" | "lower";
    fill: Color | Animatable<Color>;
    animators?: TextAnimator[];
  },
): Layer {
  return {
    ...base(o),
    type: "text",
    deform: null,
    content: still(o.content),
    box:
      o.box.mode === "point"
        ? { mode: "point" }
        : {
            mode: "box",
            width: still(round3(o.box.width)),
            height: still(round3(o.box.height)),
            autoFit: o.box.autoFit,
          },
    font: {
      family: o.font.family,
      weight: o.font.weight as TextLayer["font"]["weight"],
      size: track(o.font.size),
    },
    tracking: still(o.tracking),
    leading: still(o.leading),
    align: o.align,
    textCase: o.textCase,
    fill: track(o.fill),
    animators: o.animators ?? [],
  };
}

/** A text animator selector over the whole text; override what differs (see ADR-0038). */
export function selector(
  unit: RangeSelector["unit"],
  over: Partial<RangeSelector> = {},
): RangeSelector {
  return {
    unit,
    start: still(0),
    end: still(1),
    offset: still(0),
    shape: "square",
    easeHigh: still(0),
    easeLow: still(0),
    order: "forward",
    seed: 0,
    amount: still(1),
    ...over,
  };
}

// --- shape items -----------------------------------------------------------------------------

const itemId = (id: string) => ShapeItemIdSchema.parse(id);

/** A rectangle centered on `position`. */
export function rectItem(
  id: string,
  o: { position: Vec2 | Animatable<Vec2>; size: Vec2 | Animatable<Vec2>; cornerRadius?: number },
): ShapeItem {
  return {
    type: "rect",
    id: itemId(id),
    name: id,
    position: track(o.position),
    size: track(o.size),
    cornerRadius: still(Math.max(0, round3(o.cornerRadius ?? 0))),
  };
}

export function ellipseItem(
  id: string,
  o: { position: Vec2 | Animatable<Vec2>; size: Vec2 | Animatable<Vec2> },
): ShapeItem {
  return {
    type: "ellipse",
    id: itemId(id),
    name: id,
    position: track(o.position),
    size: track(o.size),
  };
}

export function pathItem(id: string, path: BezierPath): ShapeItem {
  return { type: "path", id: itemId(id), name: id, path: still(path) };
}

/** An open straight path from `from` to `to`. */
export function linePath(from: Vec2, to: Vec2): BezierPath {
  return {
    closed: false,
    vertices: [
      { point: from, inTangent: [0, 0], outTangent: [0, 0] },
      { point: to, inTangent: [0, 0], outTangent: [0, 0] },
    ],
  };
}

/** A closed rectangle path from its left, top, right and bottom edges. */
export function rectPath(left: number, top: number, right: number, bottom: number): BezierPath {
  const v = (x: number, y: number) => ({
    point: vec(x, y),
    inTangent: [0, 0] as Vec2,
    outTangent: [0, 0] as Vec2,
  });
  return {
    closed: true,
    vertices: [v(left, top), v(right, top), v(right, bottom), v(left, bottom)],
  };
}

export function fillItem(id: string, color: Color | Animatable<Color>, opacity = 1): ShapeItem {
  return {
    type: "fill",
    id: itemId(id),
    name: id,
    paint: { type: "solid", color: track(color) },
    opacity: still(opacity),
    rule: "nonzero",
  };
}

export function strokeItem(
  id: string,
  color: Color | Animatable<Color>,
  width: number,
  o: { cap?: "butt" | "round" | "square"; join?: "miter" | "round" | "bevel" } = {},
): ShapeItem {
  return {
    type: "stroke",
    id: itemId(id),
    name: id,
    paint: { type: "solid", color: track(color) },
    opacity: still(1),
    width: still(Math.max(0, round3(width))),
    cap: o.cap ?? "butt",
    join: o.join ?? "miter",
    miterLimit: 4,
    dashes: [],
    dashOffset: still(0),
  };
}

export function trimItem(
  id: string,
  o: { start?: Animatable<number>; end: Animatable<number> },
): ShapeItem {
  return {
    type: "trim",
    id: itemId(id),
    name: id,
    start: o.start ?? still(0),
    end: o.end,
    offset: still(0),
    mode: "simultaneous",
  };
}

/** A closed ellipse path centered on (`cx`, `cy`) with four vertices, so its radii can be animated. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): BezierPath {
  const k = 0.5522847498307936;
  const v = (x: number, y: number, tx: number, ty: number) => ({
    point: vec(cx + x, cy + y),
    inTangent: vec(-tx, -ty),
    outTangent: vec(tx, ty),
  });
  return {
    closed: true,
    vertices: [
      v(0, -ry, k * rx, 0),
      v(rx, 0, 0, k * ry),
      v(0, ry, -k * rx, 0),
      v(-rx, 0, 0, -k * ry),
    ],
  };
}

/** A rectangular mask (add mode) whose path may be animated. */
export function rectMask(id: string, path: Animatable<BezierPath>): Mask {
  return pathMask(id, path, "add");
}

/** A mask of any mode whose path may be animated (all keyframes need the same vertex count). */
export function pathMask(id: string, path: Animatable<BezierPath>, mode: Mask["mode"]): Mask {
  return {
    id: MaskIdSchema.parse(id),
    name: id,
    mode,
    inverted: false,
    path,
    feather: still<[number, number]>([0, 0]),
    opacity: still(1),
    expansion: still(0),
  };
}

// --- effects ---------------------------------------------------------------------------------

const effectId = (id: string) => EffectIdSchema.parse(id);

export function blurEffect(id: string, radius: number | Animatable<number>): Effect {
  return { id: effectId(id), type: "gaussian-blur", radius: track(radius) };
}

export function glowEffect(
  id: string,
  o: { radius: number; color: Color; intensity: number },
): Effect {
  return {
    id: effectId(id),
    type: "glow",
    radius: still(round3(o.radius)),
    color: still(o.color),
    intensity: still(o.intensity),
  };
}

export function aberrationEffect(id: string, amount: number | Animatable<number>): Effect {
  return { id: effectId(id), type: "chromatic-aberration", amount: track(amount) };
}

export function vignetteEffect(
  id: string,
  o: { amount: number; radius: number; feather: number; color: Color },
): Effect {
  return {
    id: effectId(id),
    type: "vignette",
    amount: still(o.amount),
    radius: still(o.radius),
    feather: still(o.feather),
    color: still(o.color),
  };
}

export function grainEffect(
  id: string,
  o: { amount: number; size: number; seed: number; animated: boolean; monochrome: boolean },
): Effect {
  return {
    id: effectId(id),
    type: "grain",
    amount: still(o.amount),
    size: o.size,
    seed: o.seed,
    animated: o.animated,
    monochrome: o.monochrome,
  };
}

export function scanlinesEffect(
  id: string,
  o: { amount: number; spacing: number; thickness: number; color: Color },
): Effect {
  return {
    id: effectId(id),
    type: "scanlines",
    amount: still(o.amount),
    spacing: still(o.spacing),
    thickness: still(o.thickness),
    offset: still(0),
    color: still(o.color),
  };
}

// --- text layout -----------------------------------------------------------------------------

/**
 * The baseline of a block of `lines` lines of text of `fontSize` px whose middle is at `middleY`.
 * There are no font metrics here, so this is an estimate: the first baseline sits 0.35 em below the
 * middle of a single line, moved up by half the extra lines.
 */
export function textBaseline(
  middleY: number,
  fontSize: number,
  lines: number,
  leading: number,
): number {
  return middleY + 0.35 * fontSize - ((lines - 1) * leading * fontSize) / 2;
}

// --- timing ----------------------------------------------------------------------------------

export interface Envelope {
  /** Frames the instance lasts, at least 1. */
  span: number;
  /** Enter keyframes run from 0 to this frame (0: no enter, the layer is simply shown). */
  enterEnd: number;
  /** Frames of the exit, 0 for none. */
  exitFrames: number;
  /** Exit keyframes run from this frame to `span - 1`. */
  exitStart: number;
}

/**
 * The enter and exit windows of an instance of `ctx.durationFrames` frames. The enter and the exit
 * together fit in `span - 1` frames (so the last frame is the end state of the exit, and with no
 * exit the last frame is fully entered): if they don't, both shrink in proportion (at least one
 * frame each, an exit of 0 stays 0), and an exit that still doesn't fit is dropped. A one-frame
 * instance shows the entered state (no exit).
 */
export function envelope(
  ctx: ComponentEvalContext,
  p: { enter: DurationToken; exit: DurationToken | null },
): Envelope {
  const span = Math.max(1, ctx.durationFrames);
  const budget = span - 1;
  if (budget < 1) return { span, enterEnd: 0, exitFrames: 0, exitStart: span - 1 };
  let enter = Math.max(1, ctx.style.frames(p.enter));
  let exit = p.exit === null ? 0 : Math.max(0, ctx.style.frames(p.exit));
  if (enter + exit > budget) {
    const k = budget / (enter + exit);
    enter = Math.max(1, Math.floor(enter * k));
    exit = exit > 0 ? Math.max(1, Math.floor(exit * k)) : 0;
    if (enter + exit > budget) exit = 0;
  }
  return { span, enterEnd: enter, exitFrames: exit, exitStart: span - 1 - exit };
}

/**
 * The interpolation for an enter over `frames` frames: the pack's token, except a spring that
 * would not settle within the window (the scene format needs the next keyframe after it), which
 * falls back to the pack's enter easing.
 */
export function enterEase(
  ctx: ComponentEvalContext,
  token: EasingToken | SpringToken,
  frames: number,
): Interpolation {
  const ease = ctx.style.easing(token);
  if (ease.type === "spring" && springSettleFrames(ease, ctx.fps) > frames)
    return ctx.style.easing("enter");
  return ease;
}

/**
 * A property that goes from `hidden` to `shown` in `window` (frames within the enter, default all
 * of it), holds, and with an exit goes on to `gone` over the exit window. Without `gone` the exit
 * leaves the property alone.
 */
export function enterExit<T>(
  ctx: ComponentEvalContext,
  env: Envelope,
  p: {
    hidden: T;
    shown: T;
    gone?: T;
    window?: readonly [number, number];
    ease: Interpolation;
  },
): Animatable<T> {
  const [from, to] = p.window ?? [0, env.enterEnd];
  const out: Keyframe<T>[] = [];
  if (to > from) out.push(key(from, p.hidden, p.ease), key(to, p.shown));
  else out.push(key(Math.max(0, to), p.shown));
  if (env.exitFrames > 0 && p.gone !== undefined)
    out.push(key(env.exitStart, p.shown, ctx.style.easing("exit")), key(env.span - 1, p.gone));
  return keys(...out);
}

/** A property that holds `shown` and, with an exit, goes on to `gone` over the exit window. */
export function exitOnly<T>(
  ctx: ComponentEvalContext,
  env: Envelope,
  shown: T,
  gone: T,
): Animatable<T> {
  return enterExit(ctx, env, { hidden: shown, shown, gone, window: [0, 0], ease: LINEAR });
}

// --- shared props ----------------------------------------------------------------------------

export const SPEEDS = ["fast", "base", "slow"] as const;
export type Speed = (typeof SPEEDS)[number];

export const speedProp: Extract<PropDescriptor, { type: "enum" }> = {
  type: "enum",
  description: "How long the enter takes: fast, base or slow (the style's duration tokens).",
  values: [...SPEEDS],
  default: "base",
};

export const exitProp: Extract<PropDescriptor, { type: "boolean" }> = {
  type: "boolean",
  description:
    "Whether the component animates out over its last frames; false holds it to the end.",
  default: true,
};

/** The envelope the shared `speed` and `exit` props describe; the exit lasts the style's fast duration. */
export function propsEnvelope(
  ctx: ComponentEvalContext,
  props: Readonly<Record<string, unknown>>,
): Envelope {
  return envelope(ctx, {
    enter: props.speed as Speed,
    exit: props.exit === false ? null : "fast",
  });
}
