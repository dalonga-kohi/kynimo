import { keynote } from "@kynimo/guidelines";
import { applyOps, springSettleFrames } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { animate } from "./animate.js";
import { IntentError } from "./errors.js";
import { applied, doc, keyed, kf, layerOf, lid, prop, solid } from "./fixtures.test-util.js";

const fps = { num: 30, den: 1 };
const move = keynote.motion.easings.move;

const track = (project: ReturnType<typeof doc>, id: string, property: string) =>
  (layerOf(project, id) as unknown as { transform: Record<string, unknown> }).transform[property];

describe("animate", () => {
  it("animates a constant track with the default window, duration and easing", () => {
    const d = doc([solid("a", { inFrame: 10, startFrame: 10 })]);
    const { ops, resolved } = animate(d, { layers: lid("a"), property: "opacity", from: 0 });
    expect(resolved).toMatchObject({
      start_frames: [10],
      duration_frames: 18,
      easing: move,
      style: { packId: "keynote", pinned: false },
    });
    expect(track(applied(d, ops), "a", "opacity")).toEqual({
      keyframes: [
        { frame: 0, value: 0, interpolation: move },
        { frame: 18, value: 1, interpolation: { type: "hold" } },
      ],
    });
  });

  it("takes start in composition frames and converts to layer time", () => {
    const d = doc([solid("a", { startFrame: 20, inFrame: 20, outFrame: 90 })]);
    const { ops, resolved } = animate(d, {
      layers: lid("a"),
      property: "rotation",
      from: 0,
      to: 90,
      start: 40,
      duration: 500,
      easing: "enter",
    });
    expect(resolved.start_frames).toEqual([40]);
    expect(resolved.duration_frames).toBe(15);
    expect(track(applied(d, ops), "a", "rotation")).toMatchObject({
      keyframes: [
        { frame: 20, value: 0, interpolation: keynote.motion.easings.enter },
        { frame: 35, value: 90 },
      ],
    });
  });

  it("keeps keyframes outside the window and replaces the ones inside", () => {
    const d = doc([
      solid("a", {
        transform: {
          opacity: keyed(kf(0, 0), kf(10, 0.2), kf(20, 0.5), kf(50, 1), kf(60, 0)),
        },
      }),
    ]);
    const { ops } = animate(d, {
      layers: lid("a"),
      property: "opacity",
      to: 0.9,
      start: 15,
      duration: 500,
    });
    const frames = (
      track(applied(d, ops), "a", "opacity") as { keyframes: { frame: number; value: number }[] }
    ).keyframes;
    expect(frames.map((k) => k.frame)).toEqual([0, 10, 15, 30, 50, 60]);
    // From is the old animated value at the window start (halfway through 0.2 -> 0.5 hold-less linear: frame 10..20).
    expect(frames[2]?.value).toBeCloseTo(0.35, 5);
    expect(frames[3]?.value).toBe(0.9);
  });

  it("gives the end key the outgoing interpolation of the old track when keys follow", () => {
    const d = doc([
      solid("a", {
        transform: { opacity: keyed(kf(0, 0, "hold"), kf(10, 0.4, "hold"), kf(80, 1)) },
      }),
    ]);
    const { ops } = animate(d, {
      layers: lid("a"),
      property: "opacity",
      from: 0.1,
      to: 0.6,
      start: 20,
      duration: 300,
    });
    const keys = (
      track(applied(d, ops), "a", "opacity") as {
        keyframes: { frame: number; interpolation: unknown }[];
      }
    ).keyframes;
    expect(keys.find((k) => k.frame === 29)?.interpolation).toEqual({ type: "hold" });
  });

  it("samples missing ends from the old track and adds by-deltas to them", () => {
    const d = doc([
      solid("a", { transform: { position: keyed(kf(0, [0, 0]), kf(60, [600, 300])) } }),
    ]);
    const { ops } = animate(d, {
      layers: lid("a"),
      property: "position",
      from: { by: [0, 10] },
      to: { by: [100, 0] },
      start: 0,
      duration: 1000,
    });
    // window 0..30 inside old keys 0..60; sample at 0 = [0,0], at 30 is eased-linear halfway.
    const keys = (
      track(applied(d, ops), "a", "position") as { keyframes: { frame: number; value: number[] }[] }
    ).keyframes;
    expect(keys[0]?.value).toEqual([0, 10]);
    expect(keys[1]?.value).toEqual([400, 150]);
    expect(keys.map((k) => k.frame)).toEqual([0, 30, 60]);
  });

  it("takes a number for scale as uniform and refuses the wrong value kind", () => {
    const d = doc([solid("a")]);
    const { ops } = animate(d, { layers: lid("a"), property: "scale", from: 0.5 });
    expect(track(applied(d, ops), "a", "scale")).toMatchObject({
      keyframes: [{ value: [0.5, 0.5] }, { value: [1, 1] }],
    });
    expect(() => animate(d, { layers: lid("a"), property: "rotation", from: [1, 2] })).toThrow(
      expect.objectContaining({ path: ["from"] }),
    );
    expect(() => animate(d, { layers: lid("a"), property: "position", to: 4 })).toThrow(
      expect.objectContaining({ path: ["to"] }),
    );
    expect(() => animate(d, { layers: lid("a"), property: "opacity", to: { by: [1, 1] } })).toThrow(
      expect.objectContaining({ path: ["to", "by"] }),
    );
  });

  it("needs from or to, and refuses equal ends", () => {
    const d = doc([solid("a")]);
    expect(() => animate(d, { layers: lid("a"), property: "opacity" })).toThrow("at least one");
    expect(() => animate(d, { layers: lid("a"), property: "opacity", from: 1 })).toThrow(
      "from and to are equal; nothing would move",
    );
  });

  it("lets a spring set the duration and refuses an explicit one", () => {
    const d = doc([solid("a")]);
    const { ops, resolved } = animate(d, {
      layers: lid("a"),
      property: "scale",
      from: 0,
      easing: "gentle",
    });
    const settle = springSettleFrames(keynote.motion.springs.gentle, fps);
    expect(resolved.duration_frames).toBe(settle);
    expect(resolved.easing).toMatchObject({ type: "spring" });
    applied(d, ops);
    expect(() =>
      animate(d, {
        layers: lid("a"),
        property: "scale",
        from: 0,
        easing: "gentle",
        duration: "base",
      }),
    ).toThrow(
      expect.objectContaining({ path: ["duration"], message: expect.stringContaining("settle") }),
    );
  });

  it("lets batch validation report a kept spring keyframe squeezed by the new one", () => {
    const spring = {
      frame: 0,
      value: 0,
      interpolation: { type: "spring", damping: 1, response: 0.7 },
    };
    const d = doc([solid("a", { transform: { opacity: keyed(spring, kf(200, 1)) } })]);
    const { ops } = animate(d, {
      layers: lid("a"),
      property: "opacity",
      from: 0.5,
      to: 0.8,
      start: 5,
    });
    const result = applyOps(d, ops);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain("settle");
  });

  it("refuses separate position tracks and layers without a transform", () => {
    const sep = doc([
      solid("a", { transform: { position: { separate: { x: prop(1), y: prop(2) } } } }),
    ]);
    expect(() => animate(sep, { layers: lid("a"), property: "position", to: [0, 0] })).toThrow(
      "position has separate X/Y tracks; set it with set_keyframes",
    );
    expect(() => animate(sep, { layers: lid("a"), property: "position", to: [0, 0] })).toThrow(
      IntentError,
    );
  });

  it("animates several layers, each from its own in frame", () => {
    const d = doc([solid("a", { inFrame: 0 }), solid("b", { inFrame: 12 })]);
    const { ops, resolved } = animate(d, {
      layers: [lid("a"), lid("b")],
      property: "opacity",
      from: 0,
    });
    expect(resolved.start_frames).toEqual([0, 12]);
    expect(ops).toHaveLength(2);
    applied(d, ops);
  });

  it("uses the pinned pack's tokens", () => {
    const d = doc([solid("a")], { style: { packId: "brutalist", version: "0.1.0" } });
    const { resolved } = animate(d, {
      layers: lid("a"),
      property: "opacity",
      from: 0,
      duration: "fast",
    });
    expect(resolved.style).toEqual({ packId: "brutalist", version: "0.1.0", pinned: true });
  });
});
