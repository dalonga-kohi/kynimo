import { type Layer, LayerSelectorSchema, MAX_MARKERS, type Op, type Project } from "@kynimo/scene";
import { z } from "zod";
import { IntentError, scoped } from "./errors.js";
import { TargetsInput } from "./style.js";
import { resolveTargets, type Target } from "./targets.js";
import { checkMovedTracks, diffLayerOps, listKeyframeTracks, mapLayerKeyframes } from "./walk.js";

export const MarkBeatsInput = z.strictObject({
  layer: LayerSelectorSchema,
  grid: z
    .strictObject({
      bpm: z.number().min(20).max(400),
      first_beat_frame: z.number().int(),
      count: z.number().int().positive().max(1000).optional(),
    })
    .optional(),
  replace: z.boolean().optional(),
});
export type MarkBeatsInput = z.infer<typeof MarkBeatsInput>;

export interface MarkBeatsResolved {
  layer_id: string;
  source: "asset" | "grid";
  bpm: number;
  beat_count: number;
  first_frame: number | null;
  last_frame: number | null;
  removed: number;
}

type AudioLayer = Extract<Layer, { type: "audio" }>;

/** The one audio layer a selector names. */
function resolveAudio(doc: Project, selector: MarkBeatsInput["layer"], tool: string, path: string) {
  const found = resolveTargets(doc, selector, [path]);
  if (found.length > 1)
    throw new IntentError([path], `select one audio layer (matched ${found.length})`);
  const target = found[0] as Target;
  if (target.layer.type !== "audio")
    throw new IntentError(
      [path],
      `${tool} needs an audio layer; '${target.layer.id}' is a ${target.layer.type} layer`,
    );
  return { composition: target.composition, layer: target.layer as AudioLayer };
}

/**
 * Puts beat markers on an audio layer: from the beats detected in its asset, or from a bpm grid.
 * Markers are zero-length, named `beat <n>`, in layer time, and only cover the layer's in/out range.
 */
export function markBeats(
  doc: Project,
  input: MarkBeatsInput,
): { ops: Op[]; resolved: MarkBeatsResolved } {
  const { composition, layer } = resolveAudio(doc, input.layer, "mark_beats", "layer");
  const { fps } = composition;
  if (layer.markers.length > 0 && input.replace !== true)
    throw new IntentError(
      ["replace"],
      `layer '${layer.id}' already has ${layer.markers.length} markers; set replace: true to remove them first`,
    );

  /** Beats as layer-time frames with their 1-based number, ascending. */
  const beats: { frame: number; n: number }[] = [];
  let bpm: number;
  if (input.grid === undefined) {
    const asset = doc.assets.find((a) => a.id === layer.assetId);
    if (asset?.type !== "audio" || asset.beats === undefined)
      throw new IntentError(
        ["grid"],
        `asset '${layer.assetId}' has no detected beats (uploaded before beat detection, or no steady beat found); pass grid: { bpm, first_beat_frame }`,
      );
    bpm = asset.beats.bpm;
    asset.beats.timesMs.forEach((t, i) => {
      const frame = Math.floor((t * fps.num) / (1000 * fps.den) + 0.5);
      const comp = layer.startFrame + frame;
      if (comp < layer.inFrame || comp >= layer.outFrame) return;
      if (beats[beats.length - 1]?.frame === frame) return;
      beats.push({ frame, n: i + 1 });
    });
  } else {
    const { first_beat_frame: first, count } = input.grid;
    bpm = input.grid.bpm;
    const period = (60 * fps.num) / (fps.den * bpm);
    if (period < 1)
      throw new IntentError(
        ["grid", "bpm"],
        `at ${bpm} bpm a beat is shorter than one frame at ${fps.num / fps.den} fps`,
      );
    if (first >= layer.outFrame)
      throw new IntentError(
        ["grid", "first_beat_frame"],
        `first_beat_frame ${first} is not before the layer's out frame ${layer.outFrame}`,
      );
    // Jump over the beats before the in frame instead of walking them (they still count in the name).
    let k = Math.max(0, Math.floor((layer.inFrame - first) / period) - 2);
    for (; count === undefined || k < count; k++) {
      const comp = Math.floor(first + k * period + 0.5);
      if (comp >= layer.outFrame || beats.length > MAX_MARKERS) break;
      if (comp < layer.inFrame) continue;
      beats.push({ frame: comp - layer.startFrame, n: k + 1 });
    }
  }
  if (beats.length === 0)
    throw new IntentError(["layer"], "no beat falls inside the layer's in/out range");
  if (beats.length > MAX_MARKERS)
    throw new IntentError(
      ["layer"],
      `a layer holds at most ${MAX_MARKERS} markers; this would make ${beats.length}`,
    );

  const ops: Op[] = [];
  if (input.replace === true)
    for (const m of layer.markers) ops.push({ op: "removeMarker", marker: m.id });
  for (const b of beats)
    ops.push({
      op: "addMarker",
      target: { layer: layer.id },
      marker: { frame: b.frame, durationFrames: 0, name: `beat ${b.n}` },
    });
  const first = beats[0] as { frame: number };
  const last = beats[beats.length - 1] as { frame: number };
  return {
    ops,
    resolved: {
      layer_id: layer.id,
      source: input.grid === undefined ? "asset" : "grid",
      bpm,
      beat_count: beats.length,
      first_frame: layer.startFrame + first.frame,
      last_frame: layer.startFrame + last.frame,
      removed: input.replace === true ? layer.markers.length : 0,
    },
  };
}

export const SyncToBeatsInput = z.strictObject({
  layers: TargetsInput,
  audio_layer: LayerSelectorSchema,
  snap: z
    .array(z.enum(["keyframes", "cuts"]))
    .min(1)
    .max(2)
    .refine((s) => new Set(s).size === s.length, "snap entries must be unique")
    .optional(),
  every: z.number().int().min(1).max(64).optional(),
  phase: z.number().int().min(0).max(63).optional(),
  max_distance: z.number().int().min(0).optional(),
  window: z.strictObject({ from: z.number().int(), to: z.number().int() }).optional(),
});
export type SyncToBeatsInput = z.infer<typeof SyncToBeatsInput>;

export interface SyncToBeatsResolved {
  audio_layer_id: string;
  beat_count: number;
  max_distance: number;
  keyframes_moved: number;
  keyframes_skipped: number;
  cuts_moved: number;
  layer_ids: string[];
}

/**
 * Snaps keyframes and/or cuts of the selected layers to the beat markers of an audio layer. A cut
 * slides the whole layer (in, out and start together) so its content keeps its timing relative to
 * the cut; keyframes then move to the nearest beat (the earlier one on a tie) when it is within
 * `max_distance`. `window` is judged on the frames before this call (a cut by its original in point, a keyframe before any slide). Refuses moves that make keyframes collide or squeeze a spring.
 */
export function syncToBeats(
  doc: Project,
  input: SyncToBeatsInput,
): { ops: Op[]; resolved: SyncToBeatsResolved } {
  const snap = input.snap ?? ["keyframes"];
  const snapKeyframes = snap.includes("keyframes");
  const snapCuts = snap.includes("cuts");
  const every = input.every ?? 1;
  const phase = input.phase ?? 0;
  const { window } = input;
  if (window !== undefined && window.from > window.to)
    throw new IntentError(["window"], "window.from must not be after window.to");
  if (phase >= every)
    throw new IntentError(["phase"], `phase ${phase} must be less than every (${every})`);

  const audio = resolveAudio(doc, input.audio_layer, "sync_to_beats", "audio_layer");
  const targets = resolveTargets(doc, input.layers);
  const compositionOf = (targets[0] as Target).composition;
  if (audio.composition.id !== compositionOf.id)
    throw new IntentError(
      ["audio_layer"],
      "the audio layer must be in the same composition as the layers",
    );
  if (targets.some((t) => t.layer.id === audio.layer.id))
    throw new IntentError(["layers"], "the audio layer can't be synced to its own beats");
  const { fps } = compositionOf;

  const all = [...new Set(audio.layer.markers.map((m) => audio.layer.startFrame + m.frame))].sort(
    (a, b) => a - b,
  );
  const beats = all.filter((_, k) => k % every === phase);
  if (beats.length === 0)
    throw new IntentError(
      ["audio_layer"],
      all.length === 0
        ? `audio layer '${audio.layer.id}' has no beat markers; add them with mark_beats`
        : `every ${every} with phase ${phase} leaves no beat of the ${all.length} markers on audio layer '${audio.layer.id}'`,
    );
  let maxDistance = input.max_distance;
  if (maxDistance === undefined) {
    if (beats.length < 2)
      throw new IntentError(["max_distance"], "only one beat is left; set max_distance");
    const gaps = beats.slice(1).map((b, i) => b - (beats[i] as number));
    gaps.sort((a, b) => a - b);
    const mid = gaps.length >> 1;
    const median =
      gaps.length % 2 === 1
        ? (gaps[mid] as number)
        : ((gaps[mid - 1] as number) + (gaps[mid] as number)) / 2;
    maxDistance = Math.floor(median / 2);
  }
  const limit = maxDistance;

  /** The nearest kept beat and its distance; the earlier beat on a tie. */
  const nearest = (frame: number): { beat: number; distance: number } => {
    // First beat at or after the frame (binary search); its predecessor wins a tie.
    let lo = 0;
    let hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((beats[mid] as number) < frame) lo = mid + 1;
      else hi = mid;
    }
    const after = beats[lo];
    const before = beats[lo - 1];
    const best =
      after === undefined
        ? (before as number)
        : before !== undefined && frame - before <= after - frame
          ? before
          : after;
    return { beat: best, distance: Math.abs(best - frame) };
  };
  const inWindow = (frame: number): boolean =>
    window === undefined || (frame >= window.from && frame <= window.to);

  const ops: Op[] = [];
  let keyframesMoved = 0;
  let keyframesSkipped = 0;
  let cutsMoved = 0;
  for (const { layer, path } of targets) {
    scoped(path, () => {
      // `window` is judged on the positions the caller read (this layer before the call): cuts by
      // the original inFrame, keyframes by their frame before any cut slide of this call.
      let current = layer;
      if (snapCuts && inWindow(layer.inFrame)) {
        const { beat, distance } = nearest(layer.inFrame);
        const delta = beat - layer.inFrame;
        if (distance <= limit && delta !== 0) {
          const set = {
            inFrame: layer.inFrame + delta,
            outFrame: layer.outFrame + delta,
            startFrame: layer.startFrame + delta,
          };
          ops.push({ op: "updateLayer", layer: layer.id, set });
          current = { ...layer, ...set };
          cutsMoved++;
        }
      }
      if (!snapKeyframes) return;
      const slid = current;
      const slideDelta = slid.startFrame - layer.startFrame;
      const before = listKeyframeTracks(slid);
      const after = mapLayerKeyframes(slid, (f) => {
        if (!inWindow(layer.startFrame + f)) return f;
        const comp = slid.startFrame + f;
        const { beat, distance } = nearest(comp);
        if (distance === 0) return f;
        if (distance > limit) {
          keyframesSkipped++;
          return f;
        }
        keyframesMoved++;
        return beat - slid.startFrame;
      });
      checkMovedTracks(slid, before, listKeyframeTracks(after), fps, path, {
        collision: "use every, max_distance or a window so they snap to different beats",
        spring: "use a larger every or switch that segment to a bezier easing",
        ...(slideDelta !== 0 ? { frameNote: " (after the cut slide)" } : {}),
      });
      ops.push(...diffLayerOps(slid, after));
    });
  }
  if (ops.length === 0)
    throw new IntentError(
      ["layers"],
      "everything selected is already on the beats or farther than max_distance from one",
    );
  return {
    ops,
    resolved: {
      audio_layer_id: audio.layer.id,
      beat_count: beats.length,
      max_distance: limit,
      keyframes_moved: keyframesMoved,
      keyframes_skipped: keyframesSkipped,
      cuts_moved: cutsMoved,
      layer_ids: targets.map((t) => t.layer.id),
    },
  };
}
