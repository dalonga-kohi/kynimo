import { InterpolationSchema, ProjectSchema, springSettleFrames } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./color.js";
import {
  DURATION_TOKENS,
  EASING_TOKENS,
  type GuidelinePack,
  GuidelinePackSchema,
  SPRING_TOKENS,
} from "./pack.js";
import { BUILT_IN_PACKS, findPack, keynote, latestPacks } from "./packs/index.js";
import { interpolationFor } from "./resolve.js";

const issuesOf = (pack: unknown) => {
  const result = GuidelinePackSchema.safeParse(pack);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};
const edit = (change: (pack: GuidelinePack) => void): GuidelinePack => {
  const copy = JSON.parse(JSON.stringify(keynote));
  change(copy);
  return copy;
};

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    // #767676 is the lightest grey that passes 4.5:1 on white.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });
});

describe("built-in packs", () => {
  it("has the four styles, each with a unique id and version", () => {
    expect(latestPacks().map((p) => p.id)).toEqual([
      "keynote",
      "playful-saas",
      "editorial",
      "brutalist",
    ]);
    const keys = BUILT_IN_PACKS.map((p) => `${p.id}@${p.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(BUILT_IN_PACKS.map((p) => [p.id, p] as const))("%s passes its own rules", (_id, pack) => {
    expect(issuesOf(pack)).toEqual([]);
  });

  it.each(BUILT_IN_PACKS.map((p) => [p.id, p] as const))(
    "%s is plain JSON: it survives a round trip unchanged",
    (_id, pack) => {
      expect(JSON.parse(JSON.stringify(pack))).toEqual(pack);
    },
  );

  it.each(BUILT_IN_PACKS.map((p) => [p.id, p] as const))(
    "%s: every easing and spring token is a valid keyframe interpolation",
    (_id, pack) => {
      for (const token of [...EASING_TOKENS, ...SPRING_TOKENS]) {
        expect(InterpolationSchema.safeParse(interpolationFor(pack, token)).success).toBe(true);
      }
    },
  );

  it.each(BUILT_IN_PACKS.map((p) => [p.id, p] as const))(
    "%s: springs settle within three seconds at 30 fps",
    (_id, pack) => {
      for (const token of SPRING_TOKENS) {
        const frames = springSettleFrames(pack.motion.springs[token], { num: 30, den: 1 });
        expect(frames).toBeGreaterThan(0);
        expect(frames).toBeLessThanOrEqual(90);
      }
    },
  );

  it("packs differ in every motion token group, so a restyle is visible", () => {
    const groups = (p: GuidelinePack) => [
      JSON.stringify(p.motion.durations),
      JSON.stringify(p.motion.easings),
      JSON.stringify(p.motion.springs),
      JSON.stringify(p.color),
    ];
    const all = latestPacks().map(groups);
    for (let g = 0; g < 4; g++) {
      expect(new Set(all.map((x) => x[g])).size).toBe(all.length);
    }
  });

  it("is found by a document's pinned style reference", () => {
    const style = { packId: keynote.id, version: keynote.version };
    expect(findPack(style)).toBe(keynote);
    expect(findPack({ packId: "keynote", version: "9.9.9" })).toBeUndefined();
    expect(findPack({ packId: "nope", version: keynote.version })).toBeUndefined();
    // The reference has the shape the scene format stores.
    expect(ProjectSchema.shape.style.safeParse(style).success).toBe(true);
  });
});

describe("GuidelinePackSchema", () => {
  it("rejects text that fails the pack's own contrast threshold", () => {
    const issues = issuesOf(
      edit((p) => {
        p.color.textMuted = "#444444";
      }),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^color\.textMuted: contrast on background is 2\.\d\d, below/);
  });

  it("rejects durations that are not ascending", () => {
    expect(
      issuesOf(
        edit((p) => {
          p.motion.durations.fast = p.motion.durations.base;
        }),
      ),
    ).toEqual(["motion.durations.base: must be greater than fast"]);
  });

  it("rejects a type size under the pack's minimum", () => {
    expect(
      issuesOf(
        edit((p) => {
          p.type.caption.size = 20;
        }),
      ),
    ).toEqual(["type.caption.size: below this pack's min-text-size of 24"]);
  });

  it("rejects a rule citing a source the pack doesn't list", () => {
    expect(
      issuesOf(
        edit((p) => {
          p.rules["flash-rate"].sources = ["made-up"];
        }),
      ),
    ).toEqual(["rules.flash-rate.sources.0: unknown source 'made-up'"]);
  });

  it("rejects a base duration outside the entrance range", () => {
    expect(
      issuesOf(
        edit((p) => {
          p.rules["entrance-duration"].maxMs = 500;
        }),
      ),
    ).toEqual(["motion.durations.base: must lie inside this pack's entrance-duration range"]);
  });

  it("rejects a font that isn't bundled, a spring out of range and unknown keys", () => {
    expect(
      issuesOf(
        edit((p) => {
          (p.type.body as { family: string }).family = "Comic Sans MS";
        }),
      ),
    ).toContain("type.body.family: must be a bundled font family");
    expect(
      issuesOf(
        edit((p) => {
          p.motion.springs.bouncy.damping = 0;
        }),
      ),
    ).toHaveLength(1);
    expect(issuesOf({ ...keynote, extra: true })).toHaveLength(1);
  });

  it("requires every token name", () => {
    for (const token of DURATION_TOKENS) {
      const copy = JSON.parse(JSON.stringify(keynote)) as {
        motion: { durations: Record<string, number> };
      };
      delete copy.motion.durations[token];
      expect(issuesOf(copy).length).toBeGreaterThan(0);
    }
  });
});
