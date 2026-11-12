import { describe, expect, it } from "vitest";
import { durationError, fidelityReport, maxFrames, sizeLimits, toRanges } from "./export.js";

describe("toRanges", () => {
  it("merges consecutive frames", () => {
    expect(toRanges([])).toEqual([]);
    expect(toRanges([4])).toEqual([{ from: 4, to: 4 }]);
    expect(toRanges([3, 4, 5, 9, 11, 12])).toEqual([
      { from: 3, to: 5 },
      { from: 9, to: 9 },
      { from: 11, to: 12 },
    ]);
  });
});

describe("export limits", () => {
  const fps30 = { num: 30, den: 1 };
  it("counts frames exactly", () => {
    expect(maxFrames("export", "mp4", fps30)).toBe(1800);
    expect(maxFrames("export", "gif", fps30)).toBe(450);
    expect(maxFrames("preview", "mp4", fps30)).toBe(300);
    expect(maxFrames("export", "mp4", { num: 30000, den: 1001 })).toBe(1798);
    expect(durationError("export", "mp4", fps30, 0, 1799)).toBeUndefined();
    expect(durationError("export", "mp4", fps30, 0, 1800)).toContain("use to_frame 1799 or less");
    expect(durationError("export", "mp4", fps30, 10, 2000)).toContain("use to_frame 1809 or less");
  });

  it("picks default and maximum sizes", () => {
    const wide = { width: 3000, height: 1000 };
    expect(sizeLimits("export", "mp4", wide)).toEqual({ max: 1920, default: 1920 });
    expect(sizeLimits("export", "gif", wide)).toEqual({ max: 960, default: 480 });
    expect(sizeLimits("preview", "mp4", wide)).toEqual({ max: 480, default: 360 });
    expect(sizeLimits("preview", "mp4", { width: 200, height: 100 }).default).toBe(200);
  });
});

describe("fidelityReport", () => {
  const audio = { playing: [], nested: [], clipped: 0, mixed: [] };
  const comp = { background: "#000000", fps: { num: 25, den: 1 } };

  it("is empty for a plain webm and an opaque mp4", () => {
    expect(fidelityReport({ format: "webm", comp, width: 5, height: 5, audio })).toEqual([]);
    expect(fidelityReport({ format: "mp4", comp, width: 4, height: 4, audio })).toEqual([]);
  });

  it("lists at most five layers per entry", () => {
    const nested = ["a", "b", "c", "d", "e", "f", "g"];
    const [entry] = fidelityReport({
      format: "mp4",
      comp,
      width: 4,
      height: 4,
      audio: { ...audio, nested },
    });
    expect(entry?.layers).toEqual(["a", "b", "c", "d", "e"]);
  });
});
