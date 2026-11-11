import type { GuidelinePack } from "@kynimo/guidelines";
import { millisecondsToFrames } from "@kynimo/guidelines";
import type { FrameRate, Op, Project } from "@kynimo/scene";
import { z } from "zod";
import { IntentError, scoped } from "./errors.js";
import { mulberry32 } from "./random.js";
import { offsetMilliseconds, resolveStyle, StaggerOffsetInput, TargetsInput } from "./style.js";
import { resolveTargets } from "./targets.js";
import { diffLayerOps, listKeyframeTracks, mapLayerKeyframes } from "./walk.js";

export const STAGGER_ORDERS = ["index", "reverse", "center-out", "random"] as const;
export const STAGGER_RHYTHMS = ["even", "accelerate", "decelerate"] as const;

export const StaggerTiming = z.strictObject({
  offset: StaggerOffsetInput.optional(),
  order: z.enum(STAGGER_ORDERS).optional(),
  rhythm: z.enum(STAGGER_RHYTHMS).optional(),
  seed: z.number().int().min(0).max(0x7fffffff).optional(),
});
export type StaggerTiming = z.infer<typeof StaggerTiming>;

/** The rank of each of `n` targets: the order in which delays are handed out; equal ranks share a delay. */
function ranks(n: number, order: (typeof STAGGER_ORDERS)[number], seed: number): number[] {
  const indices = Array.from({ length: n }, (_, i) => i);
  switch (order) {
    case "index":
      return indices;
    case "reverse":
      return indices.map((i) => n - 1 - i);
    case "center-out":
      return indices.map((i) => Math.abs(i - (n - 1) / 2));
    case "random": {
      const next = mulberry32(seed);
      const shuffled = [...indices];
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor((next() * (i + 1)) / 4294967296);
        [shuffled[i], shuffled[j]] = [shuffled[j] as number, shuffled[i] as number];
      }
      return shuffled;
    }
  }
}

/**
 * Delay in frames for each of `n` targets. With k distinct ranks and gap g (ms), the last rank
 * waits g·(k−1) ms; the rhythm shapes the steps in between. Each delay is converted to frames on
 * its own, so rounding never accumulates.
 */
export function staggerDelays(
  n: number,
  timing: StaggerTiming,
  pack: GuidelinePack,
  fps: FrameRate,
): number[] {
  const gap = offsetMilliseconds(timing.offset ?? "base", pack);
  const rhythm = timing.rhythm ?? "even";
  const rank = ranks(n, timing.order ?? "index", timing.seed ?? 0);
  const distinct = [...new Set(rank)].sort((a, b) => a - b);
  const k = distinct.length;
  return rank.map((r) => {
    const position = distinct.indexOf(r);
    if (k === 1) return 0;
    let ms: number;
    if (rhythm === "even") ms = gap * position;
    else {
      const x = position / (k - 1);
      const f = rhythm === "accelerate" ? 1 - (1 - x) ** 2 : x ** 2;
      ms = gap * (k - 1) * f;
    }
    return millisecondsToFrames(Math.round(ms), fps);
  });
}

export const StaggerInput = StaggerTiming.extend({ layers: TargetsInput });
export type StaggerInput = z.infer<typeof StaggerInput>;

export interface StaggerResolved {
  delays_frames: number[];
  layer_ids: string[];
  style: { packId: string; version: string; pinned: boolean };
}

/** Shifts every keyframe of target i by delay i. The layer's timing and content don't move; repeated calls compound. */
export function stagger(
  doc: Project,
  input: StaggerInput,
): { ops: Op[]; resolved: StaggerResolved } {
  const { pack, ref, pinned } = resolveStyle(doc);
  const targets = resolveTargets(doc, input.layers);
  if (targets.length < 2)
    throw new IntentError(["layers"], "stagger needs at least 2 layers; this selection has 1");
  const fps = (targets[0] as (typeof targets)[number]).composition.fps;
  const delays = staggerDelays(targets.length, input, pack, fps);
  if (delays.every((d) => d === 0))
    throw new IntentError(["offset"], "every delay is 0; nothing would move; use a larger offset");
  const ops: Op[] = [];
  targets.forEach(({ layer, path }, i) => {
    const delay = delays[i] as number;
    scoped(path, () => {
      if (listKeyframeTracks(layer).length === 0)
        throw new IntentError(
          path,
          `'${layer.id}' has nothing animated to stagger; animate it first or use apply_preset with stagger`,
        );
      ops.push(
        ...diffLayerOps(
          layer,
          mapLayerKeyframes(layer, (f) => f + delay),
        ),
      );
    });
  });
  return {
    ops,
    resolved: {
      delays_frames: delays,
      layer_ids: targets.map((t) => t.layer.id),
      style: { ...ref, pinned },
    },
  };
}
