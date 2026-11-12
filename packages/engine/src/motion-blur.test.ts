import { describe, expect, it } from "vitest";
import { applyToPoint } from "./affine.js";
import { evaluateFrame, MAX_FRAME_MOTION_TRANSFORMS, motionSampleTimes } from "./evaluate.js";
import {
  composition,
  layer,
  type Obj,
  project,
  prop,
  solid,
  transform,
} from "./fixtures.test-util.js";
import type { ResolvedLayer } from "./resolved.js";

const blur = (rest: Obj = {}) => ({ shutterAngle: 180, shutterPhase: -90, samples: 2, ...rest });
const linear = { type: "linear" };
const kf = (frame: number, value: unknown) => ({ frame, value, interpolation: linear });
const moving = { position: { keyframes: [kf(0, [0, 0]), kf(10, [100, 0])] } };
const first = (layers: Obj[], frame = 10) =>
  evaluateFrame(project([composition("main", layers)]), frame).layers[0] as ResolvedLayer;

describe("motionSampleTimes", () => {
  it("spreads samples over the shutter interval, each in the middle of its slice", () => {
    expect(motionSampleTimes(10, blur())).toEqual([9.875, 10.125]);
    expect(motionSampleTimes(10, { shutterAngle: 360, shutterPhase: 0, samples: 4 })).toEqual([
      10.125, 10.375, 10.625, 10.875,
    ]);
  });

  it("returns `samples` times for any setting", () => {
    expect(
      motionSampleTimes(0, { shutterAngle: 720, shutterPhase: -360, samples: 64 }),
    ).toHaveLength(64);
  });
});

describe("evaluateFrame: motion blur", () => {
  it("is null when off, at angle 0 and on adjustment layers", () => {
    expect(first([solid("a", { transform: transform(moving) })]).motion).toBeNull();
    expect(
      first([solid("a", { transform: transform(moving), motionBlur: blur({ shutterAngle: 0 }) })])
        .motion,
    ).toBeNull();
    expect(
      first([layer("adj", "adjustment", { transform: transform(moving), motionBlur: null })])
        .motion,
    ).toBeNull();
  });

  it("samples a linearly moving layer at the sub-frame times", () => {
    const l = first([solid("a", { transform: transform(moving), motionBlur: blur() })], 5);
    expect(l.motion).toHaveLength(2);
    const xs = (l.motion ?? []).map((s) => applyToPoint(s.matrix, [0, 0])[0]);
    expect(xs[0]).toBeCloseTo(48.75, 9);
    expect(xs[1]).toBeCloseTo(51.25, 9);
    expect(applyToPoint(l.matrix, [0, 0])[0]).toBeCloseTo(50, 9);
  });

  it("blurs a static child of a moving parent, each link at its own start frame", () => {
    const parent = layer("p", "null", { transform: transform(moving), startFrame: 5 });
    const child = solid("c", { parent: "p", motionBlur: blur() });
    const l = first([child, parent]);
    const xs = (l.motion ?? []).map((s) => applyToPoint(s.matrix, [0, 0])[0]);
    // The parent's content time is frame - 5, so at frame 10 it is halfway.
    expect(xs[0]).toBeCloseTo(48.75, 9);
    expect(xs[1]).toBeCloseTo(51.25, 9);
  });

  it("samples opacity keyframes per sample", () => {
    const l = first([
      solid("a", {
        transform: transform({ opacity: { keyframes: [kf(0, 0), kf(10, 1)] } }),
        motionBlur: blur({ shutterAngle: 360, shutterPhase: -180 }),
      }),
    ]);
    const o = (l.motion ?? []).map((s) => s.opacity);
    expect(o[0]).toBeCloseTo(0.975, 9);
    expect(o[1]).toBeCloseTo(1, 9);
  });

  it("is deterministic with a wiggle behavior sampled at sub-frames", () => {
    const wiggle = {
      id: "w",
      name: "w",
      enabled: true,
      property: "position",
      type: "wiggle",
      frequency: prop(2),
      amplitude: prop([20, 10]),
      octaves: 2,
      seed: 7,
      linked: false,
    };
    const doc = project([
      composition("main", [
        solid("a", { behaviors: [wiggle], motionBlur: blur({ samples: 8, shutterAngle: 360 }) }),
      ]),
    ]);
    const a = evaluateFrame(doc, 12).layers[0] as ResolvedLayer;
    const b = evaluateFrame(doc, 12).layers[0] as ResolvedLayer;
    expect(a.motion).toEqual(b.motion);
    const xs = new Set((a.motion ?? []).map((s) => s.matrix[4]));
    expect(xs.size).toBeGreaterThan(1);
  });

  it("does not change the center-frame values", () => {
    const off = first([solid("a", { transform: transform(moving) })]);
    const on = first([solid("a", { transform: transform(moving), motionBlur: blur() })]);
    expect({ ...on, motion: null }).toEqual(off);
  });

  it("uses the nested composition's own frames inside a precomp", () => {
    const inner = composition(
      "inner",
      [solid("a", { transform: transform(moving), motionBlur: blur() })],
      {
        fps: { num: 15, den: 1 },
      },
    );
    const main = composition("main", [layer("p", "precomp", { compositionId: "inner" })]);
    const p = evaluateFrame(project([main, inner]), 10).layers[0];
    if (p?.type !== "precomp" || p.composition === null) throw new Error("no precomp");
    // Local frame 5 of 15 fps: samples at 4.875 and 5.125.
    const xs = (p.composition.layers[0]?.motion ?? []).map((s) => s.matrix[4]);
    expect(xs[0]).toBeCloseTo(48.75, 9);
    expect(xs[1]).toBeCloseTo(51.25, 9);
  });

  it("refuses a frame over the transform budget, naming the layer and the limit", () => {
    const blurred = Array.from({ length: 600 }, (_, i) =>
      solid(`l${i}`, { motionBlur: blur({ samples: 64 }) }),
    );
    const doc = project([
      composition("main", [
        layer("p1", "precomp", { compositionId: "inner" }),
        layer("p2", "precomp", { compositionId: "inner", startFrame: 1 }),
      ]),
      composition("inner", blurred),
    ]);
    expect(MAX_FRAME_MOTION_TRANSFORMS).toBe(65_536);
    expect(() => evaluateFrame(doc, 10)).toThrow(RangeError);
    expect(() => evaluateFrame(doc, 10)).toThrow(
      /needs more than 65536 motion blur transform samples \(layer 'l\d+'\); use fewer samples or blur fewer layers/,
    );
  });
});
