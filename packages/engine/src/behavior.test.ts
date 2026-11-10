import type { FrameRate, InertiaBehavior, Interpolation, LoopBehavior } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import {
  easingSlope,
  evaluateGroup,
  hashLattice,
  incomingVelocity,
  loopMap,
  noise1d,
  outgoingVelocity,
  type PropertyTrack,
  trackGroups,
  waveform,
  wiggleNoise,
  wiggleOffset,
} from "./behavior.js";
import { cubicPath } from "./path.js";

const fps: FrameRate = { num: 30, den: 1 };
const linear: Interpolation = { type: "linear" };
const kf = (frame: number, value: unknown, interpolation: Interpolation = linear) => ({
  frame,
  value,
  interpolation,
});
const numberTrack = (...kfs: ReturnType<typeof kf>[]) =>
  ({ keyframes: kfs }) as unknown as PropertyTrack;
const group = (track: PropertyTrack, vector = false) => {
  const g = trackGroups(track, vector)[0];
  if (g === undefined) throw new Error("no group");
  return g;
};
const loop = (
  direction: LoopBehavior["direction"],
  mode: LoopBehavior["mode"],
  span = 0,
): LoopBehavior => ({
  id: "l" as LoopBehavior["id"],
  name: "Loop",
  enabled: true,
  property: "rotation",
  type: "loop",
  direction,
  mode,
  span,
});
const inertia = (amplitude: number, frequency: number, decay: number): InertiaBehavior => ({
  id: "i" as InertiaBehavior["id"],
  name: "Inertia",
  enabled: true,
  property: "rotation",
  type: "inertia",
  amplitude,
  frequency,
  decay,
});

describe("hash and noise", () => {
  it("pins the integer hash (seed, axis, octave, index), including negative and huge indices", () => {
    expect(hashLattice(0, 0, 0, 0)).toBe(3187378880);
    expect(hashLattice(7, 0, 0, 1)).toBe(1199243789);
    expect(hashLattice(7, 1, 0, 1)).toBe(2757665726);
    expect(hashLattice(7, 0, 2, 1)).toBe(172208487);
    expect(hashLattice(4294967295, 1, 7, -1)).toBe(4064430824);
    expect(hashLattice(123, 0, 0, 0)).toBe(3289430832);
  });

  it("keeps indices that share their low 32 bits apart", () => {
    const hashes = new Set([0, 4294967296, -4294967296].map((i) => hashLattice(123, 0, 0, i)));
    expect(hashes.size).toBe(3);
    expect(hashLattice(123, 0, 0, 4294967296)).toBe(2489672517);
    expect(hashLattice(123, 0, 0, -4294967296)).toBe(105535531);
  });

  it("pins noise and wiggle values", () => {
    expect(noise1d(7, 0, 0, 0.5)).toBe(-0.4835090109807227);
    expect(noise1d(7, 0, 0, -2.25)).toBe(0.25885801589926594);
    expect(noise1d(9, 1, 3, 12.75)).toBe(-0.8698341142186816);
    // One octave at t = 0.5 s, 2 per second: x = 1, so the value is the lattice value at 1.
    expect(wiggleNoise(7, 0, 1, 0.5, 2)).toBe(-0.44155859328842684);
    expect(wiggleNoise(7, 0, 3, 1.3, 2)).toBe(-0.22335185606938174);
    expect(wiggleNoise(7, 1, 3, 1.3, 2)).toBe(0.561770437517227);
  });

  it("is exact at lattice points and stays inside [-1, 1]", () => {
    expect(noise1d(5, 0, 0, 3)).toBe((hashLattice(5, 0, 0, 3) / 4294967295) * 2 - 1);
    for (let i = -500; i < 500; i++) {
      const v = wiggleNoise(11, 0, 8, i * 0.137, 3.3);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });

  it("differs by seed, by axis and by octave count", () => {
    const at = (seed: number, axis: number, octaves: number) =>
      wiggleNoise(seed, axis, octaves, 0.37, 2);
    expect(at(1, 0, 1)).not.toBe(at(2, 0, 1));
    expect(at(1, 0, 1)).not.toBe(at(1, 1, 1));
    expect(at(1, 0, 1)).not.toBe(at(1, 0, 4));
  });

  it("wiggleOffset never exceeds the amplitude, and linked axes share the noise", () => {
    const free = { seed: 3, octaves: 3, linked: false };
    const linked = { ...free, linked: true };
    let sawDifferent = false;
    for (let f = 0; f < 600; f++) {
      const t = f / 30;
      const [x, y] = wiggleOffset(free, [20, 5], t, 2.5) as [number, number];
      expect(Math.abs(x)).toBeLessThanOrEqual(20);
      expect(Math.abs(y)).toBeLessThanOrEqual(5);
      const [lx, ly] = wiggleOffset(linked, [20, 5], t, 2.5) as [number, number];
      expect(ly * 4).toBeCloseTo(lx, 10);
      if (Math.abs(x / 20 - y / 5) > 1e-6) sawDifferent = true;
    }
    expect(sawDifferent).toBe(true);
  });
});

describe("waveform", () => {
  // 1 Hz: quarter periods at t = 0, 0.25, 0.5, 0.75.
  const at = (kind: Parameters<typeof waveform>[0], t: number, phase = 0) =>
    waveform(kind, 1, phase, t);

  it("sine", () => {
    expect(at("sine", 0)).toBe(0);
    expect(at("sine", 0.25)).toBeCloseTo(1, 12);
    expect(at("sine", 0.75)).toBeCloseTo(-1, 12);
    expect(at("sine", 0, 90)).toBeCloseTo(1, 12);
  });

  it("triangle", () => {
    expect(at("triangle", 0)).toBe(0);
    expect(at("triangle", 0.25)).toBeCloseTo(1, 12);
    expect(at("triangle", 0.125)).toBeCloseTo(0.5, 12);
    expect(at("triangle", 0.75)).toBeCloseTo(-1, 12);
    expect(at("triangle", 0, 270)).toBeCloseTo(-1, 12);
  });

  it("square", () => {
    expect(at("square", 0.25)).toBe(1);
    expect(at("square", 0.75)).toBe(-1);
    expect(at("square", 0.1, 180)).toBe(-1);
  });

  it("sawtooth", () => {
    expect(at("sawtooth", 0)).toBe(-1);
    expect(at("sawtooth", 0.25)).toBeCloseTo(-0.5, 12);
    expect(at("sawtooth", 0.5)).toBeCloseTo(0, 12);
    expect(at("sawtooth", 0.75)).toBeCloseTo(0.5, 12);
    expect(at("sawtooth", 0, 90)).toBeCloseTo(-0.5, 12);
    expect(at("sawtooth", -0.25)).toBeCloseTo(0.5, 12);
  });
});

describe("easingSlope", () => {
  const bezier = (x1: number, y1: number, x2: number, y2: number): Interpolation => ({
    type: "bezier",
    x1,
    y1,
    x2,
    y2,
  });
  it("is 1 for linear and 0 for hold and spring", () => {
    expect(easingSlope(linear, true)).toBe(1);
    expect(easingSlope({ type: "hold" }, false)).toBe(0);
    expect(easingSlope({ type: "spring", damping: 0.8, response: 0.5 }, true)).toBe(0);
  });
  it("uses (1 - y2) / (1 - x2) at the end and y1 / x1 at the start", () => {
    expect(easingSlope(bezier(0.25, 0.1, 0.5, 0.5), true)).toBe(1);
    expect(easingSlope(bezier(0.25, 0.5, 0.5, 0.5), false)).toBe(2);
    expect(easingSlope(bezier(0.42, 0, 0.58, 1), true)).toBe(0);
    expect(easingSlope(bezier(0.42, 0, 0.58, 1), false)).toBe(0);
  });
  it("handles a zero denominator: 0 when the numerator is 0, else plus or minus 10", () => {
    expect(easingSlope(bezier(0, 0, 1, 1), true)).toBe(0);
    expect(easingSlope(bezier(0, 0, 1, 1), false)).toBe(0);
    expect(easingSlope(bezier(0.5, 0, 1, 0.5), true)).toBe(10);
    expect(easingSlope(bezier(0.5, 0, 1, 2), true)).toBe(-10);
    expect(easingSlope(bezier(0, 0.5, 0.5, 1), false)).toBe(10);
    expect(easingSlope(bezier(0, -0.5, 0.5, 1), false)).toBe(-10);
  });
  it("clamps to plus or minus 10", () => {
    expect(easingSlope(bezier(0.5, 0, 0.9, -5), true)).toBe(10);
    expect(easingSlope(bezier(0.5, 0, 0.9, 5), true)).toBe(-10);
    expect(easingSlope(bezier(0.01, 5, 0.5, 0), false)).toBe(10);
  });
});

describe("velocity", () => {
  it("is (to - from) / seconds for linear segments, per second", () => {
    const g = group(numberTrack(kf(0, 0), kf(30, 100), kf(75, 100)));
    expect(incomingVelocity(g, 1, fps)).toEqual([100]);
    expect(outgoingVelocity(g, fps)).toEqual([100]);
    expect(incomingVelocity(g, 2, fps)).toEqual([0]);
    // Segment 30 -> 75 is 1.5 s long.
    const rising = group(numberTrack(kf(0, 0), kf(30, 30), kf(75, 120)));
    expect(incomingVelocity(rising, 2, fps)[0]).toBeCloseTo(60, 12);
    expect(incomingVelocity(rising, 2, { num: 24, den: 1 })[0]).toBeCloseTo(48, 12);
  });

  it("applies the easing slope at the end and at the start", () => {
    const ease = (end: Interpolation) => group(numberTrack(kf(0, 0, end), kf(30, 90)));
    expect(
      incomingVelocity(ease({ type: "bezier", x1: 0.25, y1: 0.1, x2: 0.5, y2: 0.5 }), 1, fps),
    ).toEqual([90]);
    expect(
      incomingVelocity(ease({ type: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }), 1, fps),
    ).toEqual([0]);
    expect(
      outgoingVelocity(ease({ type: "bezier", x1: 0.5, y1: 0.25, x2: 0.5, y2: 1 }), fps),
    ).toEqual([45]);
    expect(incomingVelocity(ease({ type: "hold" }), 1, fps)).toEqual([0]);
    expect(incomingVelocity(ease({ type: "spring", damping: 0.8, response: 0.5 }), 1, fps)).toEqual(
      [0],
    );
  });

  it("takes vector velocities per component", () => {
    const g = group(numberTrack(kf(0, [0, 10]), kf(15, [30, 10])), true);
    expect(incomingVelocity(g, 1, fps)).toEqual([60, 0]);
  });

  it("follows a spatial path's end and start tangents scaled by its length", () => {
    const track = {
      keyframes: [
        { ...kf(0, [0, 0]), spatial: { inTangent: [0, 0], outTangent: [0, 50] } },
        { ...kf(30, [100, 0]), spatial: { inTangent: [0, 50], outTangent: [0, 0] } },
      ],
    } as unknown as PropertyTrack;
    const g = group(track, true);
    const path = cubicPath([0, 0], [0, 50], [100, 50], [100, 0]);
    const incoming = incomingVelocity(g, 1, fps);
    expect(incoming[0]).toBeCloseTo(0, 9);
    expect(incoming[1]).toBeCloseTo(-path.length, 9);
    const outgoing = outgoingVelocity(g, fps);
    expect(outgoing[0]).toBeCloseTo(0, 9);
    expect(outgoing[1]).toBeCloseTo(path.length, 9);
  });

  it("gives separate X and Y position tracks their own number velocity", () => {
    const track = {
      separate: {
        x: { keyframes: [kf(0, 0), kf(30, 60)] },
        y: { keyframes: [kf(0, 0), kf(60, 30)] },
      },
    } as unknown as PropertyTrack;
    const [gx, gy] = trackGroups(track, true);
    expect(incomingVelocity(gx as never, 1, fps)).toEqual([60]);
    expect(incomingVelocity(gy as never, 1, fps)).toEqual([15]);
  });
});

describe("loopMap", () => {
  const frames = [0, 10, 20];
  const sampled = (m: ReturnType<typeof loopMap>) => (m.kind === "sample" ? m.frame : null);

  it("leaves frames inside the track alone", () => {
    expect(loopMap(frames, loop("out", "cycle"), 20)).toEqual({ kind: "none" });
    expect(loopMap(frames, loop("out", "cycle"), 3)).toEqual({ kind: "none" });
    expect(loopMap(frames, loop("in", "cycle"), 0)).toEqual({ kind: "none" });
    expect(loopMap(frames, loop("out", "cycle"), -4)).toEqual({ kind: "none" });
    expect(loopMap([5], loop("out", "cycle"), 99)).toEqual({ kind: "none" });
    expect(loopMap([], loop("out", "cycle"), 99)).toEqual({ kind: "none" });
  });

  it("cycles out, with span 0 meaning all segments, and a larger span all of them too", () => {
    expect(sampled(loopMap(frames, loop("out", "cycle"), 21))).toBe(1);
    expect(sampled(loopMap(frames, loop("out", "cycle"), 25))).toBe(5);
    expect(sampled(loopMap(frames, loop("out", "cycle"), 45))).toBe(5);
    expect(sampled(loopMap(frames, loop("out", "cycle", 9), 25))).toBe(5);
  });

  it("cycles only the last `span` segments", () => {
    expect(sampled(loopMap(frames, loop("out", "cycle", 1), 25))).toBe(15);
    expect(sampled(loopMap(frames, loop("out", "cycle", 1), 31))).toBe(11);
    expect(sampled(loopMap(frames, loop("in", "cycle", 1), -3))).toBe(7);
  });

  it("cycles in with a true modulo for negative frames", () => {
    expect(sampled(loopMap(frames, loop("in", "cycle"), -5))).toBe(15);
    expect(sampled(loopMap(frames, loop("in", "cycle"), -25))).toBe(15);
    expect(sampled(loopMap(frames, loop("in", "cycle"), -20))).toBe(0);
  });

  it("ping-pongs within 2P, both ways", () => {
    expect(sampled(loopMap(frames, loop("out", "pingpong"), 25))).toBe(15);
    expect(sampled(loopMap(frames, loop("out", "pingpong"), 40))).toBe(0);
    expect(sampled(loopMap(frames, loop("out", "pingpong"), 45))).toBe(5);
    expect(sampled(loopMap(frames, loop("in", "pingpong"), -3))).toBe(3);
    expect(sampled(loopMap(frames, loop("in", "pingpong"), -25))).toBe(15);
    expect(sampled(loopMap(frames, loop("in", "pingpong", 1), -3))).toBe(3);
    expect(sampled(loopMap(frames, loop("out", "pingpong", 1), 25))).toBe(15);
  });

  it("counts whole cycles in offset mode", () => {
    expect(loopMap(frames, loop("out", "offset"), 25)).toMatchObject({ frame: 5, cycles: 1 });
    expect(loopMap(frames, loop("out", "offset"), 45)).toMatchObject({ frame: 5, cycles: 2 });
    expect(loopMap(frames, loop("in", "offset"), -5)).toMatchObject({ frame: 15, cycles: -1 });
    expect(loopMap(frames, loop("in", "offset"), -25)).toMatchObject({ frame: 15, cycles: -2 });
    expect(loopMap(frames, loop("out", "offset", 1), 25)).toMatchObject({
      frame: 15,
      cycles: 1,
      start: 10,
      end: 20,
    });
  });

  it("continues from the ends", () => {
    expect(loopMap(frames, loop("out", "continue"), 26)).toEqual({
      kind: "continue",
      direction: "out",
      anchor: 20,
      elapsed: 6,
    });
    expect(loopMap(frames, loop("in", "continue"), -4)).toEqual({
      kind: "continue",
      direction: "in",
      anchor: 0,
      elapsed: -4,
    });
  });
});

describe("evaluateGroup", () => {
  const ramp = group(numberTrack(kf(0, 0), kf(30, 100)));
  const value = (loops: LoopBehavior[], frame: number, inertias: InertiaBehavior[] = []) =>
    evaluateGroup(ramp, loops, inertias, frame, fps)[0] as number;

  it("is plain sampling without loops or inertia, and for constant tracks", () => {
    expect(value([], 15)).toBe(50);
    expect(value([], 500)).toBe(100);
    const constant = group({ value: 7 } as unknown as PropertyTrack);
    expect(evaluateGroup(constant, [loop("out", "cycle")], [inertia(1, 1, 1)], 99, fps)).toEqual([
      7,
    ]);
    const single = group(numberTrack(kf(10, 3)));
    expect(evaluateGroup(single, [loop("out", "cycle")], [inertia(1, 1, 1)], 99, fps)).toEqual([3]);
  });

  it("cycles, also far past the end and before the start", () => {
    expect(value([loop("out", "cycle")], 45)).toBe(50);
    expect(value([loop("out", "cycle")], 30 * 1000 + 15)).toBe(50);
    expect(value([loop("in", "cycle")], -15)).toBe(50);
    expect(value([loop("in", "cycle")], -30 * 1000 - 15)).toBe(50);
  });

  it("ping-pongs", () => {
    expect(value([loop("out", "pingpong")], 45)).toBe(50);
    expect(value([loop("out", "pingpong")], 60)).toBe(0);
    expect(value([loop("out", "pingpong")], 75)).toBe(50);
    expect(value([loop("in", "pingpong")], -15)).toBe(50);
  });

  it("adds a whole-cycle delta in offset mode", () => {
    expect(value([loop("out", "offset")], 45)).toBe(150);
    expect(value([loop("out", "offset")], 75)).toBe(250);
    expect(value([loop("in", "offset")], -15)).toBe(-50);
    expect(value([loop("in", "offset")], -45)).toBe(-150);
  });

  it("continues at the end velocity", () => {
    expect(value([loop("out", "continue")], 60)).toBe(200);
    expect(value([loop("out", "continue")], 45)).toBe(150);
    expect(value([loop("in", "continue")], -30)).toBe(-100);
    const eased = group(
      numberTrack(kf(0, 0, { type: "bezier", x1: 0.5, y1: 1, x2: 0.5, y2: 0.5 }), kf(30, 90)),
    );
    // End slope (1 - 0.5) / (1 - 0.5) = 1: 90 units per second.
    expect(evaluateGroup(eased, [loop("out", "continue")], [], 60, fps)[0]).toBe(180);
    // Start slope 1 / 0.5 = 2: 180 units per second, going backwards.
    expect(evaluateGroup(eased, [loop("in", "continue")], [], -15, fps)[0]).toBe(-90);
  });

  it("uses the first loop that acts", () => {
    expect(value([loop("in", "cycle"), loop("out", "pingpong")], 45)).toBe(50);
    expect(value([loop("in", "continue"), loop("out", "cycle")], -30)).toBe(-100);
  });
});

describe("inertia", () => {
  const ramp = group(numberTrack(kf(0, 0), kf(30, 100)));
  const at = (frame: number, g = ramp, i = inertia(0.1, 1.25, 3)) =>
    evaluateGroup(g, [], [i], frame, fps)[0] as number;

  it("is zero before any keyframe after the first is reached", () => {
    expect(at(0)).toBe(0);
    expect(at(15)).toBe(50);
    expect(at(29)).toBeCloseTo(96.666666, 5);
  });

  it("follows v * amplitude * sin(2 pi f t) / exp(decay t) after arrival", () => {
    // 6 frames after the last keyframe is t = 0.2 s: sin(2 pi * 1.25 * 0.2) = sin(pi / 2) = 1.
    expect(at(30)).toBe(100);
    expect(at(36)).toBeCloseTo(100 + (100 * 0.1) / Math.exp(0.6), 10);
    expect(at(36)).toBeGreaterThan(100);
    // Half a period later the sign flips and the envelope has shrunk.
    const late = at(30 + 18); // t = 0.6 s: sin(1.5 pi) = -1
    expect(late).toBeCloseTo(100 - (100 * 0.1) / Math.exp(1.8), 10);
    expect(Math.abs(100 - late)).toBeLessThan(Math.abs(100 - at(36)));
  });

  it("settles to nothing as time passes", () => {
    expect(Math.abs(at(30 + 600) - 100)).toBeLessThan(1e-9);
  });

  it("restarts at each keyframe, with the velocity that segment arrived with", () => {
    const g = group(numberTrack(kf(0, 0), kf(30, 100), kf(60, 130)));
    // Between 30 and 60 the offset comes from keyframe 1 (arrived at 100 units/s).
    expect(at(36, g)).toBeCloseTo(100 + 0.2 * 30 + (100 * 0.1) / Math.exp(0.6), 10);
    // After 60 it comes from keyframe 2 (arrived at 30 units/s).
    expect(at(66, g)).toBeCloseTo(130 + (30 * 0.1) / Math.exp(0.6), 10);
  });

  it("is zero when the track arrives at rest", () => {
    const easeOut = group(
      numberTrack(kf(0, 0, { type: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }), kf(30, 100)),
    );
    expect(at(36, easeOut)).toBe(100);
    const hold = group(numberTrack(kf(0, 0, { type: "hold" }), kf(30, 100)));
    expect(at(36, hold)).toBe(100);
    const spring = group(
      numberTrack(kf(0, 0, { type: "spring", damping: 0.8, response: 0.5 }), kf(30, 100)),
    );
    expect(at(36, spring)).toBe(100);
  });

  it("works on vectors and measures from the looped frame", () => {
    const g = group(numberTrack(kf(0, [0, 0]), kf(30, [90, -30])), true);
    const [x, y] = evaluateGroup(g, [], [inertia(0.1, 1.25, 0)], 36, fps) as number[];
    expect(x).toBeCloseTo(90 + 9, 10);
    expect(y).toBeCloseTo(-30 - 3, 10);
    // Cycling out: frame 45 maps to 15, before keyframe 1, so no inertia yet.
    expect(evaluateGroup(ramp, [loop("out", "cycle")], [inertia(0.1, 1.25, 0)], 45, fps)[0]).toBe(
      50,
    );
    // Frame 66 maps to 6, still before keyframe 1 (it is the only one after the first).
    expect(evaluateGroup(ramp, [loop("out", "cycle")], [inertia(0.1, 1.25, 0)], 66, fps)[0]).toBe(
      20,
    );
  });
});
