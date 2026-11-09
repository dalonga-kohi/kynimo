import { describe, expect, it } from "vitest";
import { BUILT_IN_PACKS, brutalist, keynote } from "./packs/index.js";
import {
  durationFrames,
  interpolationFor,
  listTokens,
  millisecondsToFrames,
  scaleFor,
  staggerFrames,
} from "./resolve.js";

const fps30 = { num: 30, den: 1 };
const ntsc = { num: 30000, den: 1001 };

describe("millisecondsToFrames", () => {
  it("rounds to the nearest frame, half up", () => {
    expect(millisecondsToFrames(1000, fps30)).toBe(30);
    expect(millisecondsToFrames(500, fps30)).toBe(15);
    expect(millisecondsToFrames(50, fps30)).toBe(2); // 1.5 frames
    expect(millisecondsToFrames(49, fps30)).toBe(1);
    expect(millisecondsToFrames(1000, { num: 24, den: 1 })).toBe(24);
    expect(millisecondsToFrames(1001, ntsc)).toBe(30);
  });

  it("never rounds a real duration down to nothing, and keeps zero at zero", () => {
    expect(millisecondsToFrames(1, fps30)).toBe(1);
    expect(millisecondsToFrames(0, fps30)).toBe(0);
  });
});

describe("token resolution", () => {
  it("turns duration and stagger tokens into frames", () => {
    expect(durationFrames(keynote, "base", fps30)).toBe(18);
    expect(durationFrames(keynote, "base", { num: 60, den: 1 })).toBe(36);
    expect(staggerFrames(keynote, "base", fps30)).toBe(3);
    // Brutalist's instant is one frame at 30 fps: a cut.
    expect(durationFrames(brutalist, "instant", fps30)).toBe(1);
  });

  it("turns easing and spring tokens into keyframe interpolations", () => {
    expect(interpolationFor(keynote, "enter")).toEqual({
      type: "bezier",
      x1: 0.05,
      y1: 0.7,
      x2: 0.1,
      y2: 1,
    });
    expect(interpolationFor(keynote, "gentle")).toEqual({
      type: "spring",
      damping: 1,
      response: 0.7,
    });
    expect(interpolationFor(brutalist, "enter")).toEqual({ type: "hold" });
  });

  it("scales reference pixels by the composition's shorter side", () => {
    expect(scaleFor({ width: 1920, height: 1080 })).toBe(1);
    expect(scaleFor({ width: 1080, height: 1920 })).toBe(1);
    expect(scaleFor({ width: 3840, height: 2160 })).toBe(2);
    expect(scaleFor({ width: 640, height: 360 })).toBeCloseTo(1 / 3, 12);
  });
});

describe("listTokens", () => {
  it("lists the same token names, in the same order, for every pack", () => {
    const names = BUILT_IN_PACKS.map((p) => listTokens(p).map((t) => t.name));
    for (const n of names) expect(n).toEqual(names[0]);
    expect(new Set(names[0]).size).toBe(names[0]?.length);
    expect(names[0]).toContain("motion.easings.enter");
    expect(names[0]).toContain("color.accent");
    expect(names[0]).toHaveLength(40);
  });

  it("carries values and units", () => {
    const tokens = listTokens(keynote);
    expect(tokens.find((t) => t.name === "motion.durations.base")).toEqual({
      name: "motion.durations.base",
      group: "motion",
      value: 600,
      unit: "ms",
    });
    expect(tokens.find((t) => t.name === "color.background")?.value).toBe("#000000");
  });
});
