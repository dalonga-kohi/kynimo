import type { Op, Project } from "@kynimo/scene";
import { z } from "zod";
import { IntentError, scoped } from "./errors.js";
import { TargetsInput } from "./style.js";
import { resolveTargets } from "./targets.js";
import { checkMovedTracks, diffLayerOps, listKeyframeTracks, mapLayerKeyframes } from "./walk.js";

export const RetimeInput = z.strictObject({
  layers: TargetsInput,
  scale: z.number().positive().max(100).optional(),
  shift: z.number().int().optional(),
  pivot: z.number().int().optional(),
  window: z.strictObject({ from: z.number().int(), to: z.number().int() }).optional(),
});
export type RetimeInput = z.infer<typeof RetimeInput>;

export interface RetimeResolved {
  pivot: number;
  scale: number;
  shift: number;
  layer_ids: string[];
}

/**
 * Scales and shifts the keyframe times of the selected layers around a pivot, in composition
 * frames: `floor(pivot + (f − pivot)·scale + 0.5) + shift`. With a window only the keyframes
 * inside it move. Refuses moves that would make two keyframes of a track collide or swap, or
 * that squeeze a spring segment below its settle time.
 */
export function retime(doc: Project, input: RetimeInput): { ops: Op[]; resolved: RetimeResolved } {
  const scale = input.scale ?? 1;
  const shift = input.shift ?? 0;
  if (scale === 1 && shift === 0)
    throw new IntentError(["scale"], "scale 1 and shift 0 change nothing; set a scale or a shift");
  const { window } = input;
  if (window !== undefined && window.from > window.to)
    throw new IntentError(["window"], "window.from must not be after window.to");
  const targets = resolveTargets(doc, input.layers);
  const fps = (targets[0] as (typeof targets)[number]).composition.fps;
  const inWindow = (compositionFrame: number): boolean =>
    window === undefined || (compositionFrame >= window.from && compositionFrame <= window.to);

  const tracksOf = targets.map(({ layer, path }) => scoped(path, () => listKeyframeTracks(layer)));
  let pivot = input.pivot;
  if (pivot === undefined) {
    let earliest: number | undefined;
    targets.forEach(({ layer }, i) => {
      for (const t of tracksOf[i] ?? [])
        for (const k of t.keyframes) {
          const f = layer.startFrame + k.frame;
          if (inWindow(f) && (earliest === undefined || f < earliest)) earliest = f;
        }
    });
    if (earliest === undefined)
      throw new IntentError(
        ["layers"],
        window === undefined
          ? "the selected layers have no keyframes to retime"
          : "no keyframe of the selected layers falls inside the window",
      );
    pivot = earliest;
  }
  const origin = pivot;
  const move = (compositionFrame: number): number =>
    inWindow(compositionFrame)
      ? Math.floor(origin + (compositionFrame - origin) * scale + 0.5) + shift
      : compositionFrame;

  const ops: Op[] = [];
  targets.forEach(({ layer, path }, i) => {
    scoped(path, () => {
      const after = mapLayerKeyframes(layer, (f) => move(layer.startFrame + f) - layer.startFrame);
      checkMovedTracks(layer, tracksOf[i] ?? [], listKeyframeTracks(after), fps, path, {
        collision: "use a window or a different pivot",
        spring: (needed) =>
          window === undefined
            ? `use a scale of at least ${needed}, or switch that segment to a bezier easing`
            : "move the window or the pivot so both keyframes move together, or switch that segment to a bezier easing",
      });
      ops.push(...diffLayerOps(layer, after));
    });
  });
  if (ops.length === 0)
    throw new IntentError(["layers"], "this retime moves no keyframe of the selected layers");
  return {
    ops,
    resolved: { pivot: origin, scale, shift, layer_ids: targets.map((t) => t.layer.id) },
  };
}
