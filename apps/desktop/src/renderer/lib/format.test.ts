import { describe, expect, it } from "vitest";
import type { AnimationSummary } from "../../shared/api.js";
import {
  formatClock,
  formatDuration,
  formatTimecode,
  formatTotal,
  lengthLabel,
  metaLine,
  packColor,
  prettyPack,
  relativeTime,
  renderingLabel,
  sceneCount,
  sizeLabel,
  sortAnimations,
} from "./format.js";

describe("formatTimecode", () => {
  it("is MM:SS:FF at the animation's frame rate", () => {
    expect(formatTimecode(4.4, 30)).toBe("00:04:12");
    expect(formatTimecode(12, 30)).toBe("00:12:00");
    expect(formatTimecode(0, 30)).toBe("00:00:00");
    expect(formatTimecode(61.5, 24)).toBe("01:01:12");
    expect(formatTimecode(10, 24)).toBe("00:10:00");
  });

  it("rounds down to the frame, also at 29.97", () => {
    expect(formatTimecode(1 / 30 - 0.001, 30)).toBe("00:00:00");
    expect(formatTimecode(1.0, 29.97)).toBe("00:00:29");
    expect(formatTimecode(1.002, 29.97)).toBe("00:01:00");
    expect(formatTimecode(2.5, 29.97)).toBe("00:02:14");
  });

  it("clamps what cannot be a time", () => {
    expect(formatTimecode(-3, 30)).toBe("00:00:00");
    expect(formatTimecode(1, 0)).toBe("00:01:00");
  });
});

describe("relativeTime", () => {
  const now = new Date(2026, 10, 13, 12, 0, 0).getTime();
  const ago = (ms: number) => relativeTime(now - ms, now);
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [60_000, "1 min ago"],
    [59 * MIN, "59 min ago"],
    [HOUR, "1 hour ago"],
    [2 * HOUR + 5 * MIN, "2 hours ago"],
    [23 * HOUR + 59 * MIN, "23 hours ago"],
    [24 * HOUR, "yesterday"],
    [47 * HOUR, "yesterday"],
    [48 * HOUR, "Nov 11"],
  ])("%d ms ago reads %s", (ms, text) => {
    expect(ago(ms)).toBe(text);
  });

  it("uses fixed English month names", () => {
    const at = new Date(2026, 0, 5, 9).getTime();
    expect(relativeTime(at, new Date(2026, 5, 1).getTime())).toBe("Jan 5");
    expect(relativeTime(new Date(2025, 11, 31, 9).getTime(), new Date(2026, 5, 1).getTime())).toBe(
      "Dec 31",
    );
  });

  it("treats the future as just now and an unknown time as nothing", () => {
    expect(relativeTime(now + 5000, now)).toBe("just now");
    expect(relativeTime(undefined, now)).toBeUndefined();
  });
});

describe("metaLine", () => {
  const now = Date.UTC(2026, 10, 13, 12);
  it("joins the creator and the time, leaving out what is unknown", () => {
    expect(metaLine("Codex", now - 2 * 3_600_000, now)).toBe("Codex · 2 hours ago");
    expect(metaLine(undefined, now - 2 * 3_600_000, now)).toBe("2 hours ago");
    expect(metaLine("Codex", undefined, now)).toBe("Codex");
    expect(metaLine(undefined, undefined, now)).toBe("");
  });
});

const animation = (over: Partial<AnimationSummary>): AnimationSummary => ({
  id: "a",
  name: "A",
  version: 1,
  durationSec: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  layerCount: 1,
  ...over,
});

describe("totals", () => {
  it("formats durations as MM:SS and totals as 1m 04s or 12s", () => {
    expect(formatDuration(12)).toBe("00:12");
    expect(formatDuration(75.4)).toBe("01:15");
    expect(formatTotal(64)).toBe("1m 04s");
    expect(formatTotal(12)).toBe("12s");
    expect(formatTotal(60)).toBe("1m 00s");
    expect(formatTotal(0)).toBe("0s");
  });

  it("counts scenes, singular for one", () => {
    expect(
      sceneCount([animation({ durationSec: 30 }), animation({ id: "b", durationSec: 34 })]),
    ).toBe("2 scenes · 1m 04s");
    expect(sceneCount([animation({ durationSec: 8 })])).toBe("1 scene · 8s");
  });

  it("formats the elapsed clock", () => {
    expect(formatClock(14_999)).toBe("00:00:14");
    expect(formatClock(3_725_000)).toBe("01:02:05");
    expect(formatClock(-5)).toBe("00:00:00");
  });
});

describe("sortAnimations", () => {
  const list = [
    animation({ id: "1", name: "bravo", updatedAt: 200 }),
    animation({ id: "2", name: "Alpha", updatedAt: 300 }),
    animation({ id: "3", name: "charlie" }),
    animation({ id: "4", name: "Delta", updatedAt: 100 }),
  ];
  const ids = (order: Parameters<typeof sortAnimations>[1]) =>
    sortAnimations(list, order).map((a) => a.id);

  it("puts the latest first, and unknown times last", () => {
    expect(ids("latest")).toEqual(["2", "1", "4", "3"]);
  });
  it("puts the oldest first, and unknown times last", () => {
    expect(ids("oldest")).toEqual(["4", "1", "2", "3"]);
  });
  it("sorts by name without regard to case", () => {
    expect(ids("name")).toEqual(["2", "1", "3", "4"]);
  });
  it("does not change the list it is given", () => {
    const before = list.map((a) => a.id);
    sortAnimations(list, "name");
    expect(list.map((a) => a.id)).toEqual(before);
  });
});

describe("style packs", () => {
  it("gives a pack the same color every time, from the design's palette", () => {
    expect(packColor("keynote")).toBe(packColor("keynote"));
    expect(["#2997ff", "#6c47ff", "#b3261e", "#ff2a00"]).toContain(packColor("editorial"));
    const colors = new Set(["keynote", "editorial", "brutalist", "neon"].map(packColor));
    expect(colors.size).toBe(4);
  });

  it("uses the faint text color for no style", () => {
    expect(packColor(undefined)).toBe("var(--color-text-faint)");
    expect(packColor("")).toBe("var(--color-text-faint)");
  });

  it("prettifies pack ids", () => {
    expect(prettyPack("keynote")).toBe("Keynote");
    expect(prettyPack("editorial-dark")).toBe("Editorial Dark");
    expect(prettyPack("data_viz-pack")).toBe("Data Viz Pack");
    expect(prettyPack(undefined)).toBe("None");
    expect(prettyPack("")).toBe("None");
  });
});

describe("labels", () => {
  it("shows the length with one decimal only when it is not whole", () => {
    expect(lengthLabel(12)).toBe("12 s");
    expect(lengthLabel(7.5)).toBe("7.5 s");
    expect(lengthLabel(7.04)).toBe("7 s");
  });
  it("shows size and rate", () => {
    expect(sizeLabel(1920, 1080, 30)).toBe("1920×1080 · 30 fps");
    expect(sizeLabel(1080, 1920, 29.97)).toBe("1080×1920 · 29.97 fps");
  });
  it("shows the render progress as a whole percent", () => {
    expect(renderingLabel(0.62)).toBe("Rendering frames · 62%");
    expect(renderingLabel(1.4)).toBe("Rendering frames · 100%");
  });
});
