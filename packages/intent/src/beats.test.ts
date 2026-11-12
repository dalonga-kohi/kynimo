import { keynote } from "@kynimo/guidelines";
import { MAX_MARKERS, type Project, ProjectSchema, springSettleFrames } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { markBeats, SyncToBeatsInput, syncToBeats } from "./beats.js";
import { IntentError } from "./errors.js";
import { applied, doc, keyed, kf, layerOf, lid, type Obj, solid } from "./fixtures.test-util.js";

const asset = (beats?: number[], over: Obj = {}): Obj => ({
  id: "song",
  type: "audio",
  name: "Song",
  uri: "assets/song.mp3",
  sha256: "0".repeat(64),
  durationMs: 600_000,
  ...(beats === undefined ? {} : { beats: { bpm: 120, confidence: 0.9, timesMs: beats } }),
  ...over,
});

const audio = (over: Obj = {}, markers: number[] = []): Obj => ({
  id: "song",
  name: "song",
  type: "audio",
  assetId: "song",
  inFrame: 0,
  outFrame: 300,
  startFrame: 0,
  hidden: false,
  solo: false,
  editor: { locked: false, shy: false, label: null },
  volume: { value: 1 },
  markers: markers.map((frame, i) => ({
    id: `m${i + 1}`,
    frame,
    durationFrames: 0,
    name: `beat ${i + 1}`,
  })),
  ...over,
});

const markersOf = (project: Project, id: string) =>
  (layerOf(project, id) as unknown as { markers: { frame: number; name: string }[] }).markers.map(
    (m) => [m.frame, m.name],
  );

const fail = (fn: () => unknown): IntentError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(IntentError);
    return e as IntentError;
  }
  throw new Error("expected an IntentError");
};

const FPS_2997 = { num: 30_000, den: 1001 };

describe("markBeats", () => {
  it("marks the beats of the asset, rounded to frames at 30 fps", () => {
    const d = doc([audio()], { assets: [asset([500, 1000, 1500, 2000])] });
    const { ops, resolved } = markBeats(d, { layer: lid("song") });
    expect(resolved).toEqual({
      layer_id: "song",
      source: "asset",
      bpm: 120,
      beat_count: 4,
      first_frame: 15,
      last_frame: 60,
      removed: 0,
    });
    expect(ops.every((o) => o.op === "addMarker")).toBe(true);
    expect(markersOf(applied(d, ops), "song")).toEqual([
      [15, "beat 1"],
      [30, "beat 2"],
      [45, "beat 3"],
      [60, "beat 4"],
    ]);
  });

  it("rounds at 29.97 fps with the composition's rational rate", () => {
    const d = doc([audio()], { assets: [asset([500, 1001, 1500, 2002])] }, { fps: FPS_2997 });
    const { ops } = markBeats(d, { layer: lid("song") });
    expect(markersOf(applied(d, ops), "song").map((m) => m[0])).toEqual([15, 30, 45, 60]);
  });

  it("keeps only beats inside the layer's in/out range, in layer time", () => {
    const d = doc([audio({ inFrame: 20, outFrame: 50, startFrame: 10 })], {
      assets: [asset([100, 500, 1000, 1500, 2000])],
    });
    const { ops, resolved } = markBeats(d, { layer: lid("song") });
    expect(resolved.first_frame).toBe(25);
    expect(resolved.last_frame).toBe(40);
    expect(markersOf(applied(d, ops), "song")).toEqual([
      [15, "beat 2"],
      [30, "beat 3"],
    ]);
  });

  it("keeps the first of two beats that round to the same frame", () => {
    const d = doc([audio()], { assets: [asset([500, 510, 1000, 1500])] });
    const { ops, resolved } = markBeats(d, { layer: lid("song") });
    expect(resolved.beat_count).toBe(3);
    expect(markersOf(applied(d, ops), "song").map((m) => m[1])).toEqual([
      "beat 1",
      "beat 3",
      "beat 4",
    ]);
  });

  it("lays a bpm grid with a count", () => {
    const d = doc([audio()], { assets: [asset()] });
    const { ops, resolved } = markBeats(d, {
      layer: lid("song"),
      grid: { bpm: 120, first_beat_frame: 0, count: 4 },
    });
    expect(resolved).toMatchObject({ source: "grid", bpm: 120, beat_count: 4, last_frame: 45 });
    expect(markersOf(applied(d, ops), "song").map((m) => m[0])).toEqual([0, 15, 30, 45]);
  });

  it("runs a grid to the out frame and numbers beats before the in frame", () => {
    const d = doc([audio({ inFrame: 20, outFrame: 100 })], { assets: [asset()] });
    const { ops } = markBeats(d, {
      layer: lid("song"),
      grid: { bpm: 120, first_beat_frame: 0 },
    });
    expect(markersOf(applied(d, ops), "song")).toEqual([
      [30, "beat 3"],
      [45, "beat 4"],
      [60, "beat 5"],
      [75, "beat 6"],
      [90, "beat 7"],
    ]);
  });

  it("rounds a fractional grid period", () => {
    const d = doc([audio()], { assets: [asset()] });
    const { ops } = markBeats(d, {
      layer: lid("song"),
      grid: { bpm: 70, first_beat_frame: 5, count: 3 },
    });
    // period 25.714...: 5, 30.7 -> 31, 56.4 -> 56
    expect(markersOf(applied(d, ops), "song").map((m) => m[0])).toEqual([5, 31, 56]);
  });

  it("refuses a beat shorter than one frame", () => {
    const d = doc([audio()], { assets: [asset()] }, { fps: { num: 1, den: 1 } });
    const e = fail(() =>
      markBeats(d, { layer: lid("song"), grid: { bpm: 400, first_beat_frame: 0 } }),
    );
    expect(e.path).toEqual(["grid", "bpm"]);
    expect(e.message).toBe("at 400 bpm a beat is shorter than one frame at 1 fps");
  });

  it("refuses a grid that starts at or after the out frame", () => {
    const d = doc([audio()], { assets: [asset()] });
    const e = fail(() =>
      markBeats(d, { layer: lid("song"), grid: { bpm: 120, first_beat_frame: 300 } }),
    );
    expect(e.path).toEqual(["grid", "first_beat_frame"]);
  });

  it("refuses a layer that is not audio", () => {
    const d = doc([solid("a")]);
    const e = fail(() => markBeats(d, { layer: lid("a") }));
    expect(e.path).toEqual(["layer"]);
    expect(e.message).toBe("mark_beats needs an audio layer; 'a' is a solid layer");
  });

  it("refuses a selector that matches two layers", () => {
    const d = doc([audio({ id: "s1", name: "s1" }), audio({ id: "s2", name: "s2" })], {
      assets: [asset([500, 1000, 1500, 2000])],
    });
    const e = fail(() => markBeats(d, { layer: { type: "audio" } }));
    expect(e.path).toEqual(["layer"]);
    expect(e.message).toBe("select one audio layer (matched 2)");
  });

  it("refuses existing markers unless replace is set, then removes them first", () => {
    const d = doc([audio({}, [3, 6])], { assets: [asset([500, 1000, 1500, 2000])] });
    const e = fail(() => markBeats(d, { layer: lid("song") }));
    expect(e.path).toEqual(["replace"]);
    expect(e.message).toBe(
      "layer 'song' already has 2 markers; set replace: true to remove them first",
    );
    const { ops, resolved } = markBeats(d, { layer: lid("song"), replace: true });
    expect(resolved.removed).toBe(2);
    expect(ops.slice(0, 2)).toEqual([
      { op: "removeMarker", marker: "m1" },
      { op: "removeMarker", marker: "m2" },
    ]);
    expect(markersOf(applied(d, ops), "song").map((m) => m[0])).toEqual([15, 30, 45, 60]);
  });

  it("points at the grid when the asset has no beats", () => {
    const d = doc([audio()], { assets: [asset()] });
    const e = fail(() => markBeats(d, { layer: lid("song") }));
    expect(e.path).toEqual(["grid"]);
    expect(e.message).toBe(
      "asset 'song' has no detected beats (uploaded before beat detection, or no steady beat found); pass grid: { bpm, first_beat_frame }",
    );
  });

  it("refuses when no beat falls inside the layer", () => {
    const d = doc([audio({ inFrame: 200, outFrame: 250 })], { assets: [asset([500, 1000, 1500])] });
    const e = fail(() => markBeats(d, { layer: lid("song") }));
    expect(e.message).toBe("no beat falls inside the layer's in/out range");
  });

  it("refuses more markers than a layer holds", () => {
    const d = doc([audio({ outFrame: 10_000 })], { assets: [asset()] }, { durationFrames: 10_000 });
    const e = fail(() =>
      markBeats(d, { layer: lid("song"), grid: { bpm: 400, first_beat_frame: 0 } }),
    );
    expect(e.message).toContain(String(MAX_MARKERS));
  });
});

/** Beats every 30 frames: 0, 30, 60, 90. */
const beatDoc = (layers: Obj[], markers = [0, 30, 60, 90], comp: Obj = {}): Project =>
  doc([...layers, audio({}, markers)], { assets: [asset()] }, comp);

const opacity = (...frames: number[]) => ({
  transform: { opacity: keyed(...frames.map((f, i) => kf(f, i % 2))) },
});

const opacityFrames = (project: Project, id: string) =>
  (
    layerOf(project, id) as unknown as {
      transform: { opacity: { keyframes: { frame: number }[] } };
    }
  ).transform.opacity.keyframes.map((k) => k.frame);

describe("syncToBeats", () => {
  it("snaps keyframes to the nearest beat", () => {
    const d = beatDoc([solid("a", opacity(28, 62, 95))]);
    const { ops, resolved } = syncToBeats(d, { layers: lid("a"), audio_layer: lid("song") });
    expect(resolved).toEqual({
      audio_layer_id: "song",
      beat_count: 4,
      max_distance: 15,
      keyframes_moved: 3,
      keyframes_skipped: 0,
      cuts_moved: 0,
      layer_ids: ["a"],
    });
    expect(opacityFrames(applied(d, ops), "a")).toEqual([30, 60, 90]);
  });

  it("snaps a tie to the earlier beat", () => {
    const d = beatDoc([solid("a", opacity(45))]);
    const { ops } = syncToBeats(d, { layers: lid("a"), audio_layer: lid("song") });
    expect(opacityFrames(applied(d, ops), "a")).toEqual([30]);
  });

  it("uses layer time: a layer starting later is snapped in composition frames", () => {
    const d = beatDoc([solid("a", { ...opacity(8, 40), startFrame: 20 })]);
    const { ops } = syncToBeats(d, { layers: lid("a"), audio_layer: lid("song") });
    // comp 28 -> 30 (layer 10), comp 60 stays (layer 40).
    expect(opacityFrames(applied(d, ops), "a")).toEqual([10, 40]);
  });

  it("honours every and phase", () => {
    const d = beatDoc([solid("a", opacity(20, 100))]);
    const { ops, resolved } = syncToBeats(d, {
      layers: lid("a"),
      audio_layer: lid("song"),
      every: 2,
      phase: 1,
    });
    expect(resolved.beat_count).toBe(2);
    expect(resolved.max_distance).toBe(30);
    expect(opacityFrames(applied(d, ops), "a")).toEqual([30, 90]);
  });

  it("skips keyframes farther than max_distance and counts them", () => {
    const d = beatDoc([solid("a", opacity(28, 50, 95))]);
    const { ops, resolved } = syncToBeats(d, {
      layers: lid("a"),
      audio_layer: lid("song"),
      max_distance: 5,
    });
    expect(resolved).toMatchObject({ max_distance: 5, keyframes_moved: 2, keyframes_skipped: 1 });
    expect(opacityFrames(applied(d, ops), "a")).toEqual([30, 50, 90]);
  });

  it("derives the default max_distance from the median gap", () => {
    const d = beatDoc([solid("a", opacity(8))], [0, 10, 40]);
    const { resolved } = syncToBeats(d, { layers: lid("a"), audio_layer: lid("song") });
    expect(resolved.max_distance).toBe(10);
  });

  it("leaves keyframes outside the window alone and uncounted", () => {
    const d = beatDoc([solid("a", opacity(28, 62, 95))]);
    const { ops, resolved } = syncToBeats(d, {
      layers: lid("a"),
      audio_layer: lid("song"),
      window: { from: 50, to: 100 },
    });
    expect(resolved.keyframes_moved).toBe(2);
    expect(opacityFrames(applied(d, ops), "a")).toEqual([28, 60, 90]);
  });

  it("slides a cut with its content, then snaps keyframes on the slid layer", () => {
    const d = beatDoc([
      solid("b", { ...opacity(10, 40), inFrame: 25, outFrame: 80, startFrame: 20 }),
    ]);
    const { ops, resolved } = syncToBeats(d, {
      layers: lid("b"),
      audio_layer: lid("song"),
      snap: ["cuts", "keyframes"],
    });
    expect(resolved).toMatchObject({ cuts_moved: 1, keyframes_moved: 2 });
    const out = applied(d, ops);
    const layer = layerOf(out, "b");
    expect([layer.inFrame, layer.outFrame, layer.startFrame]).toEqual([30, 85, 25]);
    // after the slide the keys sit at comp 35 and 65; they snap to 30 and 60.
    expect(opacityFrames(out, "b")).toEqual([5, 35]);
  });

  it("judges window on the frames before the call: a keyframe in the window snaps after a slide moves it out", () => {
    const d = beatDoc([solid("b", { ...opacity(50), inFrame: 25, outFrame: 80, startFrame: 20 })]);
    const { ops, resolved } = syncToBeats(d, {
      layers: lid("b"),
      audio_layer: lid("song"),
      snap: ["cuts", "keyframes"],
      window: { from: 0, to: 72 },
    });
    expect(resolved).toMatchObject({ cuts_moved: 1, keyframes_moved: 1 });
    const out = applied(d, ops);
    const layer = layerOf(out, "b");
    expect(layer.inFrame).toBe(30);
    // comp 70 slid to 75, a tie between 60 and 90: the earlier one, composition frame 60.
    expect(layer.startFrame + (opacityFrames(out, "b")[0] as number)).toBe(60);
  });

  it("leaves a keyframe outside the window alone even when the slide moves it inside", () => {
    const d = beatDoc([solid("b", { ...opacity(44), inFrame: 33, outFrame: 80, startFrame: 30 })]);
    const { ops, resolved } = syncToBeats(d, {
      layers: lid("b"),
      audio_layer: lid("song"),
      snap: ["cuts", "keyframes"],
      window: { from: 0, to: 72 },
    });
    // comp 74 is outside the window; the cut slides by -3 so it would sit at 71.
    expect(resolved).toMatchObject({ cuts_moved: 1, keyframes_moved: 0, keyframes_skipped: 0 });
    const out = applied(d, ops);
    expect(layerOf(out, "b").inFrame).toBe(30);
    expect(opacityFrames(out, "b")).toEqual([44]);
  });

  it("says when a refused collision is on frames after the cut slide", () => {
    const d = beatDoc([
      solid("b", { ...opacity(28, 32), inFrame: 28, outFrame: 80, startFrame: 0 }),
    ]);
    expect(
      fail(() =>
        syncToBeats(d, { layers: lid("b"), audio_layer: lid("song"), snap: ["cuts", "keyframes"] }),
      ).message,
    ).toContain("keyframes at frames 30 and 34 (after the cut slide) would land on the same frame");
  });

  it("snaps cuts only and leaves keyframes in layer time", () => {
    const d = beatDoc([
      solid("b", { ...opacity(10, 40), inFrame: 25, outFrame: 80, startFrame: 20 }),
    ]);
    const { ops, resolved } = syncToBeats(d, {
      layers: lid("b"),
      audio_layer: lid("song"),
      snap: ["cuts"],
    });
    expect(resolved).toMatchObject({ cuts_moved: 1, keyframes_moved: 0 });
    const out = applied(d, ops);
    expect(opacityFrames(out, "b")).toEqual([10, 40]);
    expect(layerOf(out, "b").inFrame).toBe(30);
  });

  it("refuses keyframes that would land on the same beat", () => {
    const d = beatDoc([solid("a", opacity(28, 32))]);
    const e = fail(() => syncToBeats(d, { layers: lid("a"), audio_layer: lid("song") }));
    expect(e.path).toEqual(["layers"]);
    expect(e.message).toBe(
      "a.transform.opacity: keyframes at frames 28 and 32 would land on the same frame; use every, max_distance or a window so they snap to different beats",
    );
  });

  it("refuses a snap that squeezes a spring below its settle time", () => {
    const spring = {
      frame: 36,
      value: 0,
      interpolation: { type: "spring", damping: 1, response: 0.7 },
    };
    const settle = springSettleFrames(keynote.motion.springs.gentle, { num: 30, den: 1 });
    const d = beatDoc(
      [solid("a", { transform: { opacity: keyed(spring, kf(36 + settle, 1)) } })],
      [40, 38 + settle],
    );
    const e = fail(() => syncToBeats(d, { layers: lid("a"), audio_layer: lid("song") }));
    expect(e.message).toBe(
      `a.transform.opacity: the spring at frame 40 needs ${settle} frames to settle but the next keyframe is ${settle - 2} frames later; use a larger every or switch that segment to a bezier easing`,
    );
  });

  it("refuses an audio layer in another composition", () => {
    const base = beatDoc([solid("a", opacity(28))]);
    const main = base.compositions[0] as (typeof base.compositions)[number];
    const split = ProjectSchema.parse({
      ...base,
      compositions: [
        { ...main, layers: main.layers.filter((l) => l.id === "a") },
        { ...main, id: "other", name: "other", layers: main.layers.filter((l) => l.id === "song") },
      ],
    });
    const e = fail(() => syncToBeats(split, { layers: lid("a"), audio_layer: lid("song") }));
    expect(e.path).toEqual(["audio_layer"]);
    expect(e.message).toBe("the audio layer must be in the same composition as the layers");
  });

  it("refuses to sync the audio layer to itself", () => {
    const d = beatDoc([solid("a", opacity(28))]);
    const e = fail(() =>
      syncToBeats(d, { layers: [lid("a"), lid("song")], audio_layer: lid("song") }),
    );
    expect(e.path).toEqual(["layers"]);
    expect(e.message).toBe("the audio layer can't be synced to its own beats");
  });

  it("refuses an audio layer without markers", () => {
    const d = beatDoc([solid("a", opacity(28))], []);
    const e = fail(() => syncToBeats(d, { layers: lid("a"), audio_layer: lid("song") }));
    expect(e.path).toEqual(["audio_layer"]);
    expect(e.message).toBe("audio layer 'song' has no beat markers; add them with mark_beats");
  });

  it("refuses when nothing would move", () => {
    const d = beatDoc([solid("a", opacity(30, 60))]);
    const e = fail(() => syncToBeats(d, { layers: lid("a"), audio_layer: lid("song") }));
    expect(e.path).toEqual(["layers"]);
    expect(e.message).toBe(
      "everything selected is already on the beats or farther than max_distance from one",
    );
  });

  it("refuses a phase that is not below every", () => {
    const d = beatDoc([solid("a", opacity(28))]);
    const e = fail(() =>
      syncToBeats(d, { layers: lid("a"), audio_layer: lid("song"), every: 2, phase: 2 }),
    );
    expect(e.path).toEqual(["phase"]);
  });

  it("needs max_distance when only one beat is left", () => {
    const d = beatDoc([solid("a", opacity(28))], [30]);
    const e = fail(() => syncToBeats(d, { layers: lid("a"), audio_layer: lid("song") }));
    expect(e.path).toEqual(["max_distance"]);
    const { ops } = syncToBeats(d, {
      layers: lid("a"),
      audio_layer: lid("song"),
      max_distance: 5,
    });
    expect(opacityFrames(applied(d, ops), "a")).toEqual([30]);
  });

  it("rejects duplicate snap entries and an empty list", () => {
    const base = { layers: "a", audio_layer: "song" };
    expect(SyncToBeatsInput.safeParse({ ...base, snap: ["cuts", "cuts"] }).success).toBe(false);
    expect(SyncToBeatsInput.safeParse({ ...base, snap: [] }).success).toBe(false);
    expect(SyncToBeatsInput.safeParse({ ...base, snap: ["cuts", "keyframes"] }).success).toBe(true);
  });
});
