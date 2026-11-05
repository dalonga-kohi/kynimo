import { describe, expect, it } from "vitest";
import { SPRING_SETTLE_THRESHOLD, springSettleFrames } from "./spring.js";

const fps30 = { num: 30, den: 1 };

/** Exact unit-step response of a damped spring, for checking the settle bound against ground truth. */
const deviation = (damping: number, response: number, t: number): number => {
  const w = (2 * Math.PI) / response;
  if (damping < 1) {
    const wd = w * Math.sqrt(1 - damping * damping);
    return Math.abs(
      Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t)),
    );
  }
  if (damping === 1) return (1 + w * t) * Math.exp(-w * t);
  const r = Math.sqrt(damping * damping - 1);
  const slow = w * (damping - r);
  const fast = w * (damping + r);
  return (fast * Math.exp(-slow * t) - slow * Math.exp(-fast * t)) / (fast - slow);
};

describe("springSettleFrames", () => {
  const cases = [
    { damping: 0.1, response: 0.5 },
    { damping: 0.5, response: 0.5 },
    { damping: 0.8, response: 1 },
    { damping: 1, response: 0.4 },
    { damping: 2, response: 0.4 },
    { damping: 10, response: 0.2 },
  ];

  it.each(cases)("never ends before the real motion settles: %o", (spring) => {
    const frames = springSettleFrames(spring, fps30);
    const settleSeconds = frames / 30;
    for (let t = settleSeconds; t < settleSeconds + 5; t += 0.01)
      expect(deviation(spring.damping, spring.response, t)).toBeLessThanOrEqual(
        SPRING_SETTLE_THRESHOLD,
      );
  });

  it("returns a positive integer for every case", () => {
    for (const c of cases) {
      const frames = springSettleFrames(c, fps30);
      expect(Number.isInteger(frames) && frames >= 1).toBe(true);
    }
  });

  it("scales with response and with frame rate, and more damping settles sooner when underdamped", () => {
    expect(springSettleFrames({ damping: 0.5, response: 1 }, fps30)).toBeGreaterThan(
      springSettleFrames({ damping: 0.5, response: 0.5 }, fps30),
    );
    expect(
      springSettleFrames({ damping: 0.5, response: 0.5 }, { num: 60, den: 1 }),
    ).toBeGreaterThan(springSettleFrames({ damping: 0.5, response: 0.5 }, fps30));
    expect(springSettleFrames({ damping: 0.9, response: 0.5 }, fps30)).toBeLessThan(
      springSettleFrames({ damping: 0.3, response: 0.5 }, fps30),
    );
  });

  it("pins golden values, so a formula change cannot silently invalidate stored documents", () => {
    const at = (damping: number, response: number, fps = fps30) =>
      springSettleFrames({ damping, response }, fps);
    expect(at(0.5, 0.5)).toBe(34);
    expect(at(1, 0.5)).toBe(23);
    expect(at(0.1, 10, { num: 240, den: 1 })).toBe(26405);
    expect(at(10, 10, { num: 240, den: 1 })).toBe(52659);
    expect(at(0.6, 0.5, { num: 30000, den: 1001 })).toBe(29);
  });

  it("is continuous around critical damping", () => {
    const at = (damping: number) => springSettleFrames({ damping, response: 0.5 }, fps30);
    expect(at(0.999)).toBe(24);
    expect(at(0.9999999999999999)).toBe(60);
    expect(at(1)).toBe(23);
  });
});
