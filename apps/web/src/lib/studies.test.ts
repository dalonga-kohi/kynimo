import { describe, expect, it } from "vitest";
import { progress, STUDY, seeded } from "./studies";

describe("seeded", () => {
  it("repeats the same sequence for the same seed", () => {
    const a = seeded(7);
    const b = seeded(7);
    const runA = Array.from({ length: 20 }, () => a());
    const runB = Array.from({ length: 20 }, () => b());
    expect(runA).toEqual(runB);
    for (const v of runA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("gives different sequences for different seeds", () => {
    expect(seeded(1)()).not.toBe(seeded(2)());
  });
});

describe("progress", () => {
  it("runs 0 to 1 over its window and clamps outside it", () => {
    expect(progress(0, 10, 20)).toBe(0);
    expect(progress(20, 10, 20)).toBe(0.5);
    expect(progress(40, 10, 20)).toBe(1);
  });
});

describe("STUDY", () => {
  it("is ten seconds at 30 fps", () => {
    expect(STUDY.frames / STUDY.fps).toBe(10);
  });
});
