import { describe, expect, it } from "vitest";
import { evaluateFrame } from "./evaluate.js";
import { composition, type Obj, project, prop, solid } from "./fixtures.test-util.js";
import type { ResolvedLayer } from "./resolved.js";

const kf = (frame: number, value: unknown, interpolation: Obj = { type: "linear" }) => ({
  frame,
  value,
  interpolation,
});
const at = (transition: Obj | null, frame: number) =>
  evaluateFrame(project([composition("main", [solid("a", { transition })])]), frame)
    .layers[0] as ResolvedLayer;

describe("evaluateFrame: transition", () => {
  it("is null when the layer has none, including layers written without the field", () => {
    expect(at(null, 0).transition).toBeNull();
    expect(
      (evaluateFrame(project([composition("main", [solid("a")])]), 0).layers[0] as ResolvedLayer)
        .transition,
    ).toBeNull();
  });

  it("samples an animated progress at the layer frame", () => {
    const t = { kind: "dissolve", progress: { keyframes: [kf(0, 0), kf(20, 1)] } };
    expect(at(t, 10).transition).toEqual({ kind: "dissolve", progress: 0.5 });
    expect(at(t, 5).transition).toEqual({ kind: "dissolve", progress: 0.25 });
  });

  it("clamps a bezier overshoot into 0..1", () => {
    const bezier = { type: "bezier", x1: 0.3, y1: 2, x2: 0.7, y2: 2 };
    const t = { kind: "dissolve", progress: { keyframes: [kf(0, 0, bezier), kf(20, 1)] } };
    const values = [2, 4, 6, 8].map((f) => (at(t, f).transition as { progress: number }).progress);
    expect(Math.max(...values)).toBe(1);
    for (const v of values) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("samples an animated point, clamped to the point range", () => {
    const t = {
      kind: "zoom",
      progress: prop(1),
      center: { keyframes: [kf(0, [0, 0]), kf(20, [200, 100])] },
      strength: prop(2),
    };
    expect(at(t, 10).transition).toEqual({
      kind: "zoom",
      progress: 1,
      center: [100, 50],
      strength: 2,
    });
  });

  it("copies constants and samples every animatable of a kind", () => {
    const t = {
      kind: "glitch",
      progress: prop(0.5),
      seed: 42,
      bands: 12,
      amount: prop(0.25),
    };
    expect(at(t, 0).transition).toEqual({
      kind: "glitch",
      progress: 0.5,
      seed: 42,
      bands: 12,
      amount: 0.25,
    });
    const clock = {
      kind: "clock",
      progress: prop(0.5),
      startAngle: prop(90),
      clockwise: false,
      center: prop([10, 20]),
      feather: prop(5),
    };
    expect(at(clock, 0).transition).toEqual({
      kind: "clock",
      progress: 0.5,
      startAngle: 90,
      clockwise: false,
      center: [10, 20],
      feather: 5,
    });
  });
});
