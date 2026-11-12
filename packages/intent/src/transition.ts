import { hashWords } from "@kynimo/engine";
import {
  type Animatable,
  type Interpolation,
  type Keyframe,
  LayerSelectorSchema,
  MAX_BLINDS,
  MAX_CLOCK_FEATHER,
  MAX_NOISE_DISSOLVE_SCALE,
  MAX_PIXELATE_CELL,
  MAX_TRANSITION_ANGLE,
  MAX_TRANSITION_FEATHER,
  MIN_NOISE_DISSOLVE_SCALE,
  MIN_PIXELATE_CELL,
  matchLayers,
  type Op,
  type Project,
  TRANSITION_KINDS,
  type Transition,
  TransitionSchema,
} from "@kynimo/scene";
import { z } from "zod";
import { windowFrames } from "./animate.js";
import { IntentError } from "./errors.js";
import { DurationInput, EasingInput, interpolation, resolveStyle } from "./style.js";

export const AddTransitionInputSchema = z.strictObject({
  layer: LayerSelectorSchema,
  kind: z.enum(TRANSITION_KINDS),
  edge: z.enum(["in", "out"]).optional(),
  duration: DurationInput.optional(),
  easing: EasingInput.optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
type AddTransitionInput = z.infer<typeof AddTransitionInputSchema>;

export interface AddTransitionResolved {
  layer: string;
  kind: Transition["kind"];
  edge: "in" | "out";
  from_frame: number;
  to_frame: number;
  duration_frames: number;
  easing: Interpolation;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Wraps an angle into the schema's ±3600 degree range without changing its direction. */
function normaliseAngle(degrees: number): number {
  if (degrees > MAX_TRANSITION_ANGLE)
    return degrees - 360 * Math.ceil((degrees - MAX_TRANSITION_ANGLE) / 360);
  if (degrees < -MAX_TRANSITION_ANGLE)
    return degrees + 360 * Math.ceil((-MAX_TRANSITION_ANGLE - degrees) / 360);
  return degrees;
}

/** A deterministic uint32 from the layer id: the engine's hash over its UTF-16 code units. */
function seedFor(layerId: string): number {
  const words: number[] = [];
  for (let i = 0; i < layerId.length; i++) words.push(layerId.charCodeAt(i));
  return hashWords(0, words);
}

const constant = (value: unknown) => ({ value });

/** The fields of a new transition of `kind` (without `progress`), sized to the composition. */
function defaultFields(
  kind: Transition["kind"],
  width: number,
  height: number,
  layerId: string,
): Record<string, unknown> {
  const center = constant([width / 2, height / 2]);
  const feather = constant(
    clamp(Math.round(0.04 * Math.max(width, height)), 0, MAX_TRANSITION_FEATHER),
  );
  switch (kind) {
    case "dissolve":
      return {};
    case "noise-dissolve":
      return {
        seed: seedFor(layerId),
        scale: constant(
          clamp(
            Math.round(Math.min(width, height) / 24),
            MIN_NOISE_DISSOLVE_SCALE,
            MAX_NOISE_DISSOLVE_SCALE,
          ),
        ),
        feather: constant(0.25),
      };
    case "wipe":
      return { angle: constant(0), feather };
    case "clock":
      return {
        startAngle: constant(0),
        clockwise: true,
        center,
        feather: constant(clamp(12, 0, MAX_CLOCK_FEATHER)),
      };
    case "iris":
      return { shape: "circle", center, feather };
    case "blinds":
      return { count: clamp(8, 2, MAX_BLINDS), angle: constant(0), feather: constant(0.25) };
    case "pixelate":
      return {
        cell: constant(
          clamp(Math.round(Math.min(width, height) / 12), MIN_PIXELATE_CELL, MAX_PIXELATE_CELL),
        ),
      };
    case "push":
      return { angle: constant(0) };
    case "zoom":
      return { center, strength: constant(1) };
    case "glitch":
      return { seed: seedFor(layerId), bands: 24, amount: constant(0.5) };
  }
}

/** Adds 180 degrees to an angle track (a value or every keyframe). */
function turnAround(track: unknown): unknown {
  if (typeof track !== "object" || track === null) return track;
  const t = track as { value?: unknown; keyframes?: unknown };
  if (typeof t.value === "number") return { value: normaliseAngle(t.value + 180) };
  if (Array.isArray(t.keyframes))
    return {
      keyframes: t.keyframes.map((k) =>
        typeof k === "object" && k !== null && typeof (k as { value?: unknown }).value === "number"
          ? { ...k, value: normaliseAngle((k as { value: number }).value + 180) }
          : k,
      ),
    };
  return track;
}

/** The new transition's fields for the out edge, so `angle` keeps meaning the on-screen travel direction. */
function mirrorForOut(kind: Transition["kind"], fields: Record<string, unknown>) {
  if (kind === "wipe" || kind === "push" || kind === "blinds")
    return { ...fields, angle: turnAround(fields.angle) };
  if (kind === "clock") return { ...fields, clockwise: fields.clockwise !== true };
  return fields;
}

/**
 * Expands "reveal this layer with a shader transition" into one `updateLayer` that sets the
 * layer's `transition`: the progress runs 0 to 1 over the first frames of the layer (edge in), or
 * 1 to 0 over its last frames (edge out). A layer holds one transition; calling again with the same
 * kind and no params adds the other edge to it.
 */
export function addTransition(
  doc: Project,
  input: AddTransitionInput,
): { ops: Op[]; resolved: AddTransitionResolved } {
  const matches = matchLayers(doc, input.layer);
  const match = matches[0];
  if (match === undefined || matches.length !== 1)
    throw new IntentError(
      ["layer"],
      `selector matched ${matches.length} layers; supply the id of one layer`,
    );
  const { layer, composition } = match;
  if (layer.type === "adjustment" || !("transition" in layer))
    throw new IntentError(
      ["layer"],
      `'${layer.id}' is ${/^[aeiou]/.test(layer.type) ? "an" : "a"} ${layer.type} layer; transitions go on drawn layers other than adjustment layers`,
    );

  const edge = input.edge ?? "in";
  const existing = layer.transition;
  if (existing !== null && existing.kind !== input.kind)
    throw new IntentError(["kind"], alreadyHas(layer.id, existing.kind));
  if (existing !== null && input.params !== undefined)
    throw new IntentError(["params"], alreadyHas(layer.id, existing.kind));

  const { pack } = resolveStyle(doc);
  const easing = interpolation(input.easing ?? "move", pack);
  const requested = windowFrames(easing, input.duration, "base", pack, composition.fps, [
    "duration",
  ]);
  const room = layer.outFrame - 1 - layer.inFrame;
  if (room < 1)
    throw new IntentError(
      ["layer"],
      `layer '${layer.id}' is one frame long; a transition needs at least two frames`,
    );
  const frames = Math.min(requested, room);
  const from = edge === "in" ? layer.inFrame : layer.outFrame - 1 - frames;
  const to = from + frames;

  const keyframes: Keyframe<number>[] = [
    {
      frame: from - layer.startFrame,
      value: edge === "in" ? 0 : 1,
      interpolation: easing,
    },
    { frame: to - layer.startFrame, value: edge === "in" ? 1 : 0, interpolation: { type: "hold" } },
  ];

  let transition: Transition;
  if (existing === null) {
    const params = input.params ?? {};
    for (const key of ["kind", "progress"])
      if (key in params)
        throw new IntentError(
          ["params", key],
          `'${key}' is set by add_transition; drop it from params`,
        );
    const base = {
      kind: input.kind,
      progress: { keyframes },
      ...defaultFields(input.kind, composition.width, composition.height, layer.id),
      ...params,
    } as Record<string, unknown>;
    // Validate before mirroring: mirroring only ever sees in-range numbers.
    const first = parseTransition(base);
    transition =
      edge === "out"
        ? parseTransition(mirrorForOut(input.kind, first as unknown as Record<string, unknown>))
        : first;
  } else {
    const progress = existing.progress as Animatable<number>;
    const lo = from - layer.startFrame;
    const hi = to - layer.startFrame;
    if ("keyframes" in progress) {
      const other = otherEdgeFrames(progress.keyframes, edge);
      if (other !== undefined) {
        const [c, d] = [other[0] + layer.startFrame, other[1] + layer.startFrame];
        if (from <= d && to >= c) {
          const fit = edge === "out" ? layer.outFrame - 2 - d : c - 1 - layer.inFrame;
          const otherName = edge === "out" ? "in" : "out";
          throw new IntentError(
            ["duration"],
            `the ${edge} edge (frames ${from}–${to}) would overlap the ${otherName} edge (frames ${c}–${d}) on '${layer.id}'; ${
              fit >= 1
                ? `use a shorter duration (at most ${fit} frames)`
                : "the layer is too short for both edges"
            }`,
          );
        }
      }
    }
    const kept =
      "keyframes" in progress ? progress.keyframes.filter((k) => k.frame < lo || k.frame > hi) : [];
    const merged = [...kept, ...keyframes].sort((a, b) => a.frame - b.frame);
    transition = { ...existing, progress: { keyframes: merged } } as Transition;
  }

  return {
    ops: [{ op: "updateLayer", layer: layer.id, set: { transition } }],
    resolved: {
      layer: layer.id,
      kind: input.kind,
      edge,
      from_frame: from,
      to_frame: to,
      duration_frames: frames,
      easing,
    },
  };
}

function parseTransition(fields: Record<string, unknown>): Transition {
  const parsed = TransitionSchema.safeParse(fields);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new IntentError(
      ["params", ...(issue?.path ?? []).map((p) => (typeof p === "symbol" ? String(p) : p))],
      issue?.message ?? "invalid transition parameters",
    );
  }
  return parsed.data;
}

/** The layer-local frames [first, last] of the edge opposite to `edge`, if the progress track has one. */
function otherEdgeFrames(
  keyframes: Keyframe<number>[],
  edge: "in" | "out",
): [number, number] | undefined {
  const n = keyframes.length;
  if (n < 2) return undefined;
  if (edge === "in") {
    const a = keyframes[n - 2] as Keyframe<number>;
    const b = keyframes[n - 1] as Keyframe<number>;
    return a.value === 1 && b.value === 0 ? [a.frame, b.frame] : undefined;
  }
  const a = keyframes[0] as Keyframe<number>;
  const b = keyframes[1] as Keyframe<number>;
  return a.value === 0 && b.value === 1 ? [a.frame, b.frame] : undefined;
}

const alreadyHas = (id: string, kind: string) =>
  `'${id}' already has a ${kind} transition and a layer holds one; call add_transition with the same kind and no params to add the other edge, or clear it with update_layer { transition: null } first`;
