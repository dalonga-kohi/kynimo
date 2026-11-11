import { keynote } from "@kynimo/guidelines";
import { springSettleFrames } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { IntentError } from "./errors.js";
import { applied, doc, keyed, kf, layerOf, lid, solid, text } from "./fixtures.test-util.js";
import { retime } from "./retime.js";

const opacityFrames = (project: ReturnType<typeof doc>, id: string) =>
  (
    layerOf(project, id) as unknown as {
      transform: { opacity: { keyframes: { frame: number }[] } };
    }
  ).transform.opacity.keyframes.map((k) => k.frame);

const fade = (...frames: number[]) => ({
  transform: { opacity: keyed(...frames.map((f, i) => kf(f, i % 2))) },
});

describe("retime", () => {
  it("scales around the earliest keyframe by default", () => {
    const d = doc([solid("a", fade(10, 20, 40))]);
    const { ops, resolved } = retime(d, { layers: lid("a"), scale: 2 });
    expect(resolved).toEqual({ pivot: 10, scale: 2, shift: 0, layer_ids: ["a"] });
    expect(opacityFrames(applied(d, ops), "a")).toEqual([10, 30, 70]);
  });

  it("shifts, and rounds half up", () => {
    const d = doc([solid("a", fade(0, 3))]);
    expect(opacityFrames(applied(d, retime(d, { layers: lid("a"), shift: 5 }).ops), "a")).toEqual([
      5, 8,
    ]);
    // 3 * 0.5 = 1.5 -> 2
    expect(opacityFrames(applied(d, retime(d, { layers: lid("a"), scale: 0.5 }).ops), "a")).toEqual(
      [0, 2],
    );
  });

  it("uses an explicit pivot in composition frames, across layers with different start frames", () => {
    const d = doc([
      solid("a", { ...fade(0, 10), startFrame: 20, inFrame: 20 }),
      solid("b", fade(0, 10)),
    ]);
    const { ops } = retime(d, { layers: [lid("a"), lid("b")], scale: 2, pivot: 0 });
    const out = applied(d, ops);
    // a: composition frames 20, 30 -> 40, 60 -> layer time 20, 40
    expect(opacityFrames(out, "a")).toEqual([20, 40]);
    expect(opacityFrames(out, "b")).toEqual([0, 20]);
  });

  it("moves only keyframes inside the window", () => {
    const d = doc([solid("a", fade(0, 10, 20, 100))]);
    const { ops, resolved } = retime(d, {
      layers: lid("a"),
      scale: 2,
      window: { from: 10, to: 20 },
    });
    expect(resolved.pivot).toBe(10);
    expect(opacityFrames(applied(d, ops), "a")).toEqual([0, 10, 30, 100]);
  });

  it("refuses a no-op and bad windows", () => {
    const d = doc([solid("a", fade(0, 10))]);
    expect(() => retime(d, { layers: lid("a") })).toThrow(IntentError);
    expect(() => retime(d, { layers: lid("a"), scale: 2, window: { from: 5, to: 1 } })).toThrow(
      expect.objectContaining({ path: ["window"] }),
    );
    expect(() => retime(d, { layers: lid("a"), scale: 2, window: { from: 50, to: 60 } })).toThrow(
      "no keyframe",
    );
    expect(() => retime(doc([solid("p")]), { layers: lid("p"), scale: 2 })).toThrow("no keyframes");
  });

  it("refuses collisions naming the layer and field", () => {
    const d = doc([solid("a", fade(0, 1, 2))]);
    expect(() => retime(d, { layers: lid("a"), scale: 0.1 })).toThrow(
      expect.objectContaining({
        path: ["layers"],
        message: expect.stringMatching(/^a\.transform\.opacity: .*same frame/),
      }),
    );
    // A window shift that jumps over a fixed keyframe changes order.
    const w = doc([solid("a", fade(0, 10, 20))]);
    expect(() => retime(w, { layers: lid("a"), shift: 15, window: { from: 10, to: 10 } })).toThrow(
      "change order",
    );
  });

  it("refuses squeezing a spring segment and says how much to scale", () => {
    const spring = {
      frame: 0,
      value: 0,
      interpolation: { type: "spring", damping: 1, response: 0.7 },
    };
    const settle = springSettleFrames(keynote.motion.springs.gentle, { num: 30, den: 1 });
    const d = doc([solid("a", { transform: { opacity: keyed(spring, kf(settle + 10, 1)) } })]);
    const needed = Math.ceil((settle / (settle + 10)) * 100) / 100;
    const attempt = () => retime(d, { layers: lid("a"), scale: 0.5 });
    expect(attempt).toThrow(
      `a.transform.opacity: the spring at frame 0 needs ${settle} frames to settle but the next keyframe is ${Math.floor((settle + 10) * 0.5 + 0.5)} frames later; use a scale of at least ${needed}, or switch that segment to a bezier easing`,
    );
    // Stretching is fine.
    applied(d, retime(d, { layers: lid("a"), scale: 2 }).ops);
  });

  it("refuses layers with keyframes it can't write back, at the layer's path", () => {
    const d = doc([
      text("t", { font: { family: "Inter", weight: 400, size: keyed(kf(0, 40), kf(9, 60)) } }),
    ]);
    expect(() => retime(d, { layers: lid("t"), scale: 2 })).toThrow(
      expect.objectContaining({ path: ["layers"] }),
    );
  });
});
