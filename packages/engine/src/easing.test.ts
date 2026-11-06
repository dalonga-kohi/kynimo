import { SPRING_SETTLE_THRESHOLD, springSettleFrames } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { cubicBezier, segmentProgress, springProgress } from "./easing.js";

const fps30 = { num: 30, den: 1 };
const fpsNtsc = { num: 30000, den: 1001 };

describe("cubicBezier", () => {
  it("is the identity for the linear curve", () => {
    const ease = cubicBezier(0, 0, 1, 1);
    for (const x of [0.1, 0.25, 0.5, 0.9]) expect(ease(x)).toBeCloseTo(x, 9);
  });

  it("matches CSS `ease` at known points", () => {
    const ease = cubicBezier(0.25, 0.1, 0.25, 1);
    // Reference values from a 200-step bisection of the same curve.
    expect(ease(0.5)).toBeCloseTo(0.8024033876, 8);
    expect(ease(0.25)).toBeCloseTo(0.4085105914, 8);
  });

  it("returns exact endpoints and clamps time outside 0..1", () => {
    const ease = cubicBezier(0.42, 0, 0.58, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-0.5)).toBe(0);
    expect(ease(2)).toBe(1);
  });

  it("can overshoot when y handles leave 0..1", () => {
    const back = cubicBezier(0.34, 1.56, 0.64, 1);
    const samples = Array.from({ length: 99 }, (_, i) => back((i + 1) / 100));
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });

  it("solves flat-start curves where the slope at t=0 is zero", () => {
    const ease = cubicBezier(0, 0, 0, 1);
    for (const x of [0.001, 0.01, 0.3, 0.999]) {
      const y = ease(x);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
    expect(ease(0.5)).toBeGreaterThan(ease(0.25));
  });
});

describe("springProgress", () => {
  const springs = [
    { damping: 0.3, response: 0.5 },
    { damping: 0.7, response: 0.4 },
    { damping: 1, response: 0.6 },
    { damping: 2.5, response: 0.3 },
  ];

  it("starts at 0 and is exactly 1 from the settle frame on", () => {
    for (const spring of springs) {
      const settle = springSettleFrames(spring, fps30);
      expect(springProgress(spring, 0, fps30)).toBe(0);
      expect(springProgress(spring, settle, fps30)).toBe(1);
      expect(springProgress(spring, settle + 10, fps30)).toBe(1);
    }
  });

  it("snaps to the target by at most the settle threshold", () => {
    for (const spring of springs) {
      for (const fps of [fps30, fpsNtsc]) {
        const settle = springSettleFrames(spring, fps);
        // Just before the snap the real motion is already inside the threshold (settle is a decay bound).
        const before = springProgress(spring, settle - 1e-9, fps);
        expect(Math.abs(1 - before)).toBeLessThanOrEqual(SPRING_SETTLE_THRESHOLD * 1.0001);
      }
    }
  });

  it("overshoots when underdamped and never does when critically or over-damped", () => {
    const peak = (spring: { damping: number; response: number }) => {
      const settle = springSettleFrames(spring, fps30);
      let max = 0;
      for (let f = 0; f <= settle; f++) max = Math.max(max, springProgress(spring, f, fps30));
      return max;
    };
    expect(peak({ damping: 0.3, response: 0.5 })).toBeGreaterThan(1.2);
    expect(peak({ damping: 1, response: 0.5 })).toBe(1);
    expect(peak({ damping: 2, response: 0.5 })).toBe(1);
  });

  it("is deterministic", () => {
    const spring = { damping: 0.5, response: 0.45 };
    const a = Array.from({ length: 30 }, (_, f) => springProgress(spring, f, fps30));
    const b = Array.from({ length: 30 }, (_, f) => springProgress(spring, f, fps30));
    expect(a).toEqual(b);
  });
});

describe("segmentProgress", () => {
  it("holds at 0, runs linearly, and eases with bezier", () => {
    expect(segmentProgress({ type: "hold" }, 5, 10, fps30)).toBe(0);
    expect(segmentProgress({ type: "linear" }, 5, 10, fps30)).toBe(0.5);
    expect(segmentProgress({ type: "linear" }, 10, 10, fps30)).toBe(1);
    const easeIn = { type: "bezier", x1: 0.42, y1: 0, x2: 1, y2: 1 } as const;
    expect(segmentProgress(easeIn, 5, 10, fps30)).toBeLessThan(0.5);
  });

  it("delegates springs to springProgress", () => {
    const spring = { type: "spring", damping: 0.8, response: 0.5 } as const;
    expect(segmentProgress(spring, 4, 40, fps30)).toBe(springProgress(spring, 4, fps30));
  });
});
