import { describe, expect, it } from "vitest";
import { KYNIMO_LOOK, OUT_FRAME, PACK_LOOKS, poseAt, springValue, timecode } from "./scene";

describe("springValue", () => {
  it("starts at 0 and settles at 1", () => {
    expect(springValue(0, { damping: 1, response: 0.7 })).toBe(0);
    expect(springValue(-1, { damping: 1, response: 0.7 })).toBe(0);
    expect(springValue(3, { damping: 1, response: 0.7 })).toBeCloseTo(1, 5);
    expect(springValue(3, { damping: 0.5, response: 0.45 })).toBeCloseTo(1, 3);
  });

  it("overshoots only when under-damped", () => {
    const peak = (damping: number) => {
      let max = 0;
      for (let f = 0; f <= 90; f++)
        max = Math.max(max, springValue(f / 30, { damping, response: 0.5 }));
      return max;
    };
    expect(peak(1)).toBeLessThanOrEqual(1);
    expect(peak(0.5)).toBeGreaterThan(1.05);
  });
});

describe("poseAt", () => {
  it("is a pure function of the frame", () => {
    const a = poseAt(20, 6, OUT_FRAME.fixed, KYNIMO_LOOK, "x");
    const b = poseAt(20, 6, OUT_FRAME.fixed, KYNIMO_LOOK, "x");
    expect(a).toEqual(b);
  });

  it("is hidden before its start, at rest once settled, gone after the out frame", () => {
    const before = poseAt(0, 6, OUT_FRAME.fixed, KYNIMO_LOOK, "x");
    expect(before.opacity).toBe(0);
    expect(before.dx).toBe(KYNIMO_LOOK.travel);

    const rest = poseAt(100, 6, OUT_FRAME.fixed, KYNIMO_LOOK, "x");
    expect(rest.opacity).toBe(1);
    expect(Math.abs(rest.dx)).toBeLessThan(0.5);

    const gone = poseAt(OUT_FRAME.fixed + 10, 6, OUT_FRAME.fixed, KYNIMO_LOOK, "x");
    expect(gone.opacity).toBe(0);
  });

  it("cuts instead of easing in the brutalist pack", () => {
    const brutalist = PACK_LOOKS.find((p) => p.id === "brutalist");
    if (!brutalist) throw new Error("brutalist pack missing");
    expect(poseAt(5, 6, 132, brutalist, "x").opacity).toBe(0);
    expect(poseAt(6, 6, 132, brutalist, "x").opacity).toBe(1);
    expect(poseAt(133, 6, 132, brutalist, "x").opacity).toBe(0);
  });
});

describe("timecode", () => {
  it("formats frames at 30 fps", () => {
    expect(timecode(0)).toBe("00:00:00");
    expect(timecode(42)).toBe("00:01:12");
    expect(timecode(149)).toBe("00:04:29");
  });
});
