import { describe, expect, it } from "vitest";
import {
  animateText,
  assignUnits,
  hardLineStarts,
  type ResolvedRangeSelector,
  type ResolvedTextAnimator,
  rangeWeights,
  textClusters,
  unitSlots,
} from "./text-animator.js";

const selector = (over: Partial<ResolvedRangeSelector> = {}): ResolvedRangeSelector => ({
  unit: "characters",
  start: 0,
  end: 1,
  offset: 0,
  shape: "square",
  easeHigh: 0,
  easeLow: 0,
  order: "forward",
  seed: 0,
  amount: 1,
  ...over,
});

const animator = (
  over: Partial<ResolvedTextAnimator> = {},
  sel: Partial<ResolvedRangeSelector> = {},
): ResolvedTextAnimator => ({
  name: "a",
  selector: selector(sel),
  position: null,
  scale: null,
  rotation: null,
  opacity: null,
  fill: null,
  blur: null,
  tracking: null,
  ...over,
});

const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const close = (got: number[], want: number[]) => {
  expect(got).toHaveLength(want.length);
  for (const [i, g] of got.entries()) expect(g).toBeCloseTo(want[i] ?? 0, 9);
};

describe("textClusters", () => {
  it("splits into code points and drops line breaks", () => {
    expect(textClusters("a\nb").map((c) => [c.start, c.end])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(textClusters("a\r\nb")).toHaveLength(2);
  });

  it("keeps combining marks, ZWJ sequences, skin tones and flags together", () => {
    expect(textClusters("éx")).toHaveLength(2);
    expect(textClusters("\u{1F468}‍\u{1F469}‍\u{1F467}")).toHaveLength(1);
    expect(textClusters("\u{1F44D}\u{1F3FD}")).toHaveLength(1);
    // Two flags are four regional indicators: pairs, not one run.
    expect(textClusters("\u{1F1F5}\u{1F1F1}\u{1F1E9}\u{1F1EA}")).toHaveLength(2);
  });
});

describe("assignUnits", () => {
  const text = "ab cd\nef";
  const clusters = textClusters(text);
  it("counts characters, spaces included", () => {
    expect(assignUnits(text, clusters, "characters", hardLineStarts(text)).count).toBe(7);
  });
  it("groups words with the space after them; a line break also ends a word", () => {
    const { count, unitOf } = assignUnits(text, clusters, "words", hardLineStarts(text));
    expect(count).toBe(3);
    expect(unitOf).toEqual([0, 0, 0, 1, 1, 2, 2]);
  });
  it("joins leading spaces to the first word", () => {
    const t = "  ab  cd";
    const r = assignUnits(t, textClusters(t), "words", hardLineStarts(t));
    expect(r).toEqual({ count: 2, unitOf: [0, 0, 0, 0, 0, 0, 1, 1] });
  });
  it("groups lines from the given line starts", () => {
    const { count, unitOf } = assignUnits(text, clusters, "lines", [0, 6]);
    expect(count).toBe(2);
    expect(unitOf).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });
  it("renumbers lines so an empty line leaves no gap", () => {
    const t = "a\n\nb";
    const r = assignUnits(t, textClusters(t), "lines", hardLineStarts(t));
    expect(r).toEqual({ count: 2, unitOf: [0, 1] });
  });
  it("has no units for empty text", () => {
    expect(assignUnits("", [], "words", [0])).toEqual({ count: 0, unitOf: [] });
  });
});

describe("unitSlots", () => {
  it("orders forward, reverse, center-out and edges-in", () => {
    expect(unitSlots("forward", 4, 0)).toEqual([0, 1, 2, 3]);
    expect(unitSlots("reverse", 4, 0)).toEqual([3, 2, 1, 0]);
    // Distance from 1.5: units 1 and 2 tie (earlier first), then 0 and 3.
    expect(unitSlots("center-out", 4, 0)).toEqual([2, 0, 1, 3]);
    expect(unitSlots("edges-in", 4, 0)).toEqual([1, 3, 2, 0]);
    expect(unitSlots("center-out", 5, 0)).toEqual([3, 1, 0, 2, 4]);
  });
  it("shuffles by seed: a permutation, repeatable, different per seed", () => {
    const a = unitSlots("random", 50, 7);
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(unitSlots("random", 50, 7)).toEqual(a);
    expect(unitSlots("random", 50, 8)).not.toEqual(a);
  });
  it("pins the shuffle (a change here changes every random-order animator)", () => {
    expect(unitSlots("random", 8, 1)).toMatchInlineSnapshot(`
      [
        2,
        1,
        6,
        7,
        4,
        3,
        0,
        5,
      ]
    `);
  });
});

describe("rangeWeights", () => {
  it("selects everything by default and nothing for an empty window", () => {
    close(rangeWeights(selector(), 4), [1, 1, 1, 1]);
    close(rangeWeights(selector({ start: 0.5, end: 0.5 }), 4), [0, 0, 0, 0]);
  });

  it("square: whole units inside the window, none outside", () => {
    close(rangeWeights(selector({ start: 0.25, end: 0.75 }), 4), [0, 1, 1, 0]);
  });

  it("square: a window edge inside a unit selects it by the covered fraction", () => {
    // Window 0..0.5 over 5 units: unit 2 (0.4..0.6) is half covered.
    close(rangeWeights(selector({ end: 0.5 }), 5), [1, 1, 0.5, 0, 0]);
    // Sweeping the end one unit's width adds exactly one unit: a typewriter.
    close(rangeWeights(selector({ end: 0.2 }), 5), [1, 0, 0, 0, 0]);
    close(rangeWeights(selector({ end: 0.3 }), 5), [1, 0.5, 0, 0, 0]);
  });

  it("start and end may be given in either order", () => {
    close(rangeWeights(selector({ start: 0.75, end: 0.25 }), 4), [0, 1, 1, 0]);
  });

  it("offset shifts the window without wrapping", () => {
    close(rangeWeights(selector({ start: 0, end: 0.5, offset: 0.25 }), 4), [0, 1, 1, 0]);
    close(rangeWeights(selector({ start: 0, end: 0.5, offset: 0.75 }), 4), [0, 0, 0, 1]);
    close(rangeWeights(selector({ start: 0, end: 0.5, offset: -0.25 }), 4), [1, 0, 0, 0]);
  });

  it("ramp-up and ramp-down average the ramp over each unit", () => {
    // Ramp 0..1 over 4 units: unit i covers [i/4,(i+1)/4]; mean of x = (2i+1)/8.
    close(rangeWeights(selector({ shape: "ramp-up" }), 4), [1 / 8, 3 / 8, 5 / 8, 7 / 8]);
    close(rangeWeights(selector({ shape: "ramp-down" }), 4), [7 / 8, 5 / 8, 3 / 8, 1 / 8]);
  });

  it("triangle peaks in the middle of the window", () => {
    // Four units: means of 2x on [0,.25] and [.25,.5] are .25 and .75; mirrored after.
    close(rangeWeights(selector({ shape: "triangle" }), 4), [0.25, 0.75, 0.75, 0.25]);
  });

  it("smooth is a smoothstep average and round a semicircle average", () => {
    // ∫0..1 (3x²−2x³) = 1/2 and ∫0..1 sqrt(1−(2x−1)²) = π/8·2 = π/4.
    expect(rangeWeights(selector({ shape: "smooth" }), 1)[0]).toBeCloseTo(0.5, 12);
    expect(rangeWeights(selector({ shape: "round" }), 1)[0]).toBeCloseTo(Math.PI / 4, 12);
    // Smooth over two units is symmetric around one half.
    const [a = 0, b = 0] = rangeWeights(selector({ shape: "smooth" }), 2);
    expect(a + b).toBeCloseTo(1, 12);

    expect(a).toBeLessThan(0.5);
  });

  it("order moves which units the window reaches first", () => {
    close(rangeWeights(selector({ end: 0.5, order: "reverse" }), 4), [0, 0, 1, 1]);
    // Center-out slots for 4 units are [2,0,1,3]: the first half of the window takes units 1 and 2.
    close(rangeWeights(selector({ end: 0.5, order: "center-out" }), 4), [0, 1, 1, 0]);
  });

  it("ease flattens the ends of the curve and keeps 0 and 1 fixed", () => {
    const linear = rangeWeights(selector({ shape: "ramp-up" }), 8);
    const eased = rangeWeights(selector({ shape: "ramp-up", easeLow: 1, easeHigh: 1 }), 8);
    // Low end lower, high end higher than linear for a full ease-in-out; symmetric around the middle.
    expect(eased[0]).toBeLessThan(linear[0] ?? 0);
    expect(eased[7]).toBeGreaterThan(linear[7] ?? 0);
    expect((eased[1] ?? 0) + (eased[6] ?? 0)).toBeCloseTo(1, 6);
    close(rangeWeights(selector({ easeHigh: 1, easeLow: 1 }), 3), [1, 1, 1]);
  });

  it("amount scales every weight and may be negative", () => {
    close(rangeWeights(selector({ amount: 0.5 }), 2), [0.5, 0.5]);
    close(rangeWeights(selector({ amount: -1 }), 2), [-1, -1]);
  });

  it("is identical on every call", () => {
    const s = selector({ shape: "round", order: "random", seed: 3, easeHigh: 0.4, end: 0.63 });
    expect(rangeWeights(s, 37)).toEqual(rangeWeights(s, 37));
  });
});

describe("animateText", () => {
  it("is inactive with no animators, zero weights or no property", () => {
    expect(animateText("abc", [], [0], WHITE).active).toBe(false);
    expect(
      animateText("abc", [animator({ position: [0, 9] }, { end: 0 })], [0], WHITE).active,
    ).toBe(false);
    expect(animateText("abc", [animator()], [0], WHITE).active).toBe(false);
  });

  it("treats blur alone as inactive, since it is not drawn", () => {
    const r = animateText("ab", [animator({ blur: 6 })], [0], WHITE);
    expect(r.active).toBe(false);
    expect(r.effects[0]?.blur).toBe(6);
  });

  it("snaps weights that full coverage leaves a rounding error short of 1", () => {
    for (const n of [3, 5, 6, 7, 9, 11, 13])
      for (const w of rangeWeights(selector(), n)) expect(w).toBe(1);
  });

  it("applies weight × value to position, rotation, tracking and blur", () => {
    const r = animateText(
      "ab",
      [animator({ position: [10, -20], rotation: 90, tracking: 100, blur: 8 }, { end: 0.5 })],
      [0],
      WHITE,
    );
    expect(r.active).toBe(true);
    expect(r.effects[0]).toMatchObject({ dx: 10, dy: -20, rotation: 90, tracking: 100, blur: 8 });
    expect(r.effects[1]).toMatchObject({ dx: 0, dy: 0, rotation: 0, tracking: 0, blur: 0 });
  });

  it("moves scale and opacity from 1 toward the value by the weight", () => {
    const r = animateText(
      "abcd",
      [animator({ scale: [0, 2], opacity: 0 }, { shape: "ramp-up" })],
      [0],
      WHITE,
    );
    // Weights 1/8, 3/8, 5/8, 7/8.
    expect(r.effects[0]?.scaleX).toBeCloseTo(1 - 1 / 8, 12);
    expect(r.effects[0]?.scaleY).toBeCloseTo(1 + 1 / 8, 12);
    expect(r.effects[3]?.opacity).toBeCloseTo(1 / 8, 12);
  });

  it("multiplies scale and opacity across animators, and adds position", () => {
    const a = animator({ scale: [2, 2], opacity: 0.5, position: [1, 0] });
    const r = animateText("a", [a, a], [0], WHITE);
    expect(r.effects[0]).toMatchObject({ scaleX: 4, scaleY: 4, opacity: 0.25, dx: 2 });
  });

  it("blends fill toward the color by the weight", () => {
    const red = { r: 1, g: 0, b: 0, a: 1 };
    const r = animateText("ab", [animator({ fill: red }, { end: 0.5 })], [0], WHITE);
    expect(r.effects[0]?.fill).toEqual(red);
    expect(r.effects[1]?.fill).toEqual(WHITE);
  });

  it("negative weights extrapolate additive properties, and never leave 0..1 opacity", () => {
    const r = animateText(
      "a",
      [animator({ position: [10, 0], opacity: 0.5 }, { amount: -1 })],
      [0],
      WHITE,
    );
    expect(r.effects[0]).toMatchObject({ dx: -10, opacity: 1 });
  });

  it("selects words and lines through the line starts", () => {
    const r = animateText(
      "aa bb\ncc",
      [animator({ position: [0, 5] }, { unit: "words", end: 1 / 3 })],
      hardLineStarts("aa bb\ncc"),
      WHITE,
    );
    expect(r.effects.map((e) => e.dy)).toEqual([5, 5, 5, 0, 0, 0, 0]);
    const lines = animateText(
      "aa bb\ncc",
      [animator({ position: [0, 5] }, { unit: "lines", start: 0.5, end: 1 })],
      [0, 6],
      WHITE,
    );
    expect(lines.effects.map((e) => e.dy)).toEqual([0, 0, 0, 0, 0, 5, 5]);
  });
});
