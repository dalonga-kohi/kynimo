import { brutalist, keynote } from "@kynimo/guidelines";
import { describe, expect, it } from "vitest";
import { IntentError } from "./errors.js";
import { doc, lid, solid } from "./fixtures.test-util.js";
import {
  DistanceInput,
  DurationInput,
  distancePx,
  durationFrames,
  EasingInput,
  interpolation,
  resolveStyle,
  StaggerOffsetInput,
  TargetsInput,
} from "./style.js";
import { resolveTargets } from "./targets.js";

const fps = { num: 30, den: 1 };

describe("resolveStyle", () => {
  it("falls back to Keynote's latest when no style is pinned", () => {
    const s = resolveStyle(doc([]));
    expect(s.pack).toBe(keynote);
    expect(s.pinned).toBe(false);
    expect(s.ref).toEqual({ packId: keynote.id, version: keynote.version });
  });

  it("uses the pinned pack", () => {
    const s = resolveStyle(
      doc([], { style: { packId: brutalist.id, version: brutalist.version } }),
    );
    expect(s.pack).toBe(brutalist);
    expect(s.pinned).toBe(true);
  });

  it("refuses a pinned pack this build doesn't have", () => {
    const d = doc([], { style: { packId: "nope", version: "9.9.9" } });
    expect(() => resolveStyle(d)).toThrow("the pinned style nope@9.9.9 isn't in this build");
    expect(() => resolveStyle(d)).toThrow(IntentError);
  });
});

describe("token resolution", () => {
  it("resolves duration tokens and raw milliseconds to frames", () => {
    expect(durationFrames("base", keynote, fps)).toBe(18);
    expect(durationFrames(600, keynote, fps)).toBe(18);
    expect(durationFrames(1, keynote, fps)).toBe(1);
  });

  it("resolves easings: bezier and spring tokens, and explicit interpolations", () => {
    expect(interpolation("enter", keynote)).toEqual(keynote.motion.easings.enter);
    expect(interpolation("gentle", keynote)).toEqual({
      type: "spring",
      ...keynote.motion.springs.gentle,
    });
    expect(interpolation({ type: "hold" }, keynote)).toEqual({ type: "hold" });
  });

  it("scales distance tokens to the composition and takes numbers as pixels", () => {
    const hd = { width: 1920, height: 1080 };
    const vertical = { width: 1080, height: 1920 };
    const small = { width: 540, height: 540 };
    expect(distancePx("base", keynote, hd)).toBe(40);
    expect(distancePx("base", keynote, vertical)).toBe(40);
    expect(distancePx("base", keynote, small)).toBe(20);
    expect(distancePx(33, keynote, small)).toBe(33);
  });
});

describe("input schemas", () => {
  it("accepts tokens and numbers, and refuses the rest", () => {
    expect(DurationInput.safeParse("base").success).toBe(true);
    expect(DurationInput.safeParse(250).success).toBe(true);
    expect(DurationInput.safeParse(0).success).toBe(false);
    expect(DurationInput.safeParse(1.5).success).toBe(false);
    expect(DurationInput.safeParse("huge").success).toBe(false);
    expect(StaggerOffsetInput.safeParse(0).success).toBe(true);
    expect(StaggerOffsetInput.safeParse("loose").success).toBe(true);
    expect(EasingInput.safeParse("bouncy").success).toBe(true);
    expect(EasingInput.safeParse({ type: "linear" }).success).toBe(true);
    expect(EasingInput.safeParse("slow").success).toBe(false);
    expect(DistanceInput.safeParse("large").success).toBe(true);
    expect(DistanceInput.safeParse(-1).success).toBe(false);
    expect(TargetsInput.safeParse([]).success).toBe(false);
    expect(TargetsInput.safeParse(["a", { type: "text" }]).success).toBe(true);
  });
});

describe("resolveTargets", () => {
  const d = doc([solid("a"), solid("b"), solid("c")]);

  it("dedupes by id in the order given, document order within a selector", () => {
    const t = resolveTargets(d, [{ type: "solid" }, lid("c"), lid("a")]);
    expect(t.map((x) => x.layer.id)).toEqual(["a", "b", "c"]);
    expect(resolveTargets(d, [lid("c"), lid("a")]).map((x) => x.layer.id)).toEqual(["c", "a"]);
  });

  it("points at the selector that matches nothing", () => {
    expect(() => resolveTargets(d, [lid("a"), lid("zzz")])).toThrow(
      expect.objectContaining({ path: ["layers", 1] }),
    );
    expect(() => resolveTargets(d, lid("zzz"))).toThrow(
      expect.objectContaining({ path: ["layers"] }),
    );
  });

  it("refuses layers of different compositions", () => {
    const two = doc([solid("a")], {
      compositions: [
        { ...doc([solid("a")]).compositions[0], id: "main" },
        { ...doc([solid("b")]).compositions[0], id: "other" },
      ],
    });
    expect(() => resolveTargets(two, [lid("a"), lid("b")])).toThrow(
      expect.objectContaining({ path: ["layers", 1] }),
    );
  });

  it("refuses more than 50 layers", () => {
    const many = doc(Array.from({ length: 51 }, (_, i) => solid(`l${i}`)));
    expect(() => resolveTargets(many, { type: "solid" })).toThrow("at most 50");
  });
});
