import type { Point } from "@kynimo/engine";
import { describe, expect, it } from "vitest";
import { type Contour, ellipseContour, KAPPA, rectContour } from "./geometry.js";
import { contourLength, roundCorners, type TrimSettings, trimContours } from "./operators.js";

const line = (from: Point, to: Point): Contour => ({
  start: from,
  segments: [{ kind: "line", to }],
  closed: false,
});

const trim = (start: number, end: number, more: Partial<TrimSettings> = {}): TrimSettings => ({
  start,
  end,
  offset: 0,
  mode: "simultaneous",
  ...more,
});

/** The first output contour of the first input. */
const firstPiece = (result: Contour[][]): Contour => result[0]?.[0] as Contour;

const ends = (c: Contour) => [c.start, ...c.segments.map((s) => s.to)];
const last = (c: Contour) => c.segments[c.segments.length - 1]?.to ?? c.start;

const expectPoint = (actual: Point, expected: Point, digits = 9) => {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
};

describe("contourLength", () => {
  it("measures lines exactly, the closing side included", () => {
    expect(contourLength(rectContour([0, 0], [20, 10], 0))).toBe(60);
    expect(contourLength(line([0, 0], [3, 4]))).toBe(5);
  });

  it("measures cubics to well under a thousandth", () => {
    // The four-cubic circle is 0.027% wider than a true circle at its widest.
    const length = contourLength(ellipseContour([0, 0], [200, 200]));
    expect(Math.abs(length - 200 * Math.PI) / (200 * Math.PI)).toBeLessThan(2e-4);
  });
});

describe("trimContours", () => {
  it("keeps the window between start and end, in either order", () => {
    for (const settings of [trim(0.25, 0.75), trim(0.75, 0.25)]) {
      const piece = firstPiece(trimContours([line([0, 0], [100, 0])], settings));
      expect(piece).toEqual(line([25, 0], [75, 0]));
    }
  });

  it("returns paths whole at a full window and drops them at an empty one", () => {
    const path = rectContour([0, 0], [20, 10], 0);
    const whole = firstPiece(trimContours([path], trim(0, 1, { offset: 123 })));
    expect(whole).toBe(path);
    expect(trimContours([path], trim(0.4, 0.4))).toEqual([[]]);
  });

  it("runs a wrapped window on a closed path through its start, as one open path", () => {
    // Perimeter 60, starting top-right and running clockwise. Offset 270° shifts the window
    // 0..0.5 to 0.75..1.25: from 45 (halfway along the top side's first 10) round to 15.
    const result = trimContours([rectContour([0, 0], [20, 10], 0)], trim(0, 0.5, { offset: 270 }));
    expect(result[0]).toHaveLength(1);
    const piece = firstPiece(result);
    expect(piece?.closed).toBe(false);
    expect(ends(piece as Contour)).toEqual([
      [-5, -5],
      [10, -5],
      [10, 5],
      [5, 5],
    ]);
  });

  it("splits a wrapped window on an open path into two pieces", () => {
    const [pieces] = trimContours([line([0, 0], [100, 0])], trim(0, 0.5, { offset: 270 }));
    expect(pieces).toEqual([line([0, 0], [25, 0]), line([75, 0], [100, 0])]);
  });

  it("trims paths individually as one path, in order", () => {
    const short = line([0, 0], [100, 0]);
    const long = line([0, 10], [300, 10]);
    const [first, second] = trimContours([short, long], trim(0, 0.5, { mode: "individual" }));
    expect(first).toEqual([short]);
    expect(second).toEqual([line([0, 10], [100, 10])]);
    // Simultaneously, each path loses its own second half.
    const [a, b] = trimContours([short, long], trim(0, 0.5));
    expect(a).toEqual([line([0, 0], [50, 0])]);
    expect(b).toEqual([line([0, 10], [150, 10])]);
  });

  it("splits cubics at arc length", () => {
    // A circle's first quarter is its first cubic, ending at the rightmost point.
    const circle = ellipseContour([0, 0], [100, 100]);
    const quarter = firstPiece(trimContours([circle], trim(0, 0.25)));
    expect(quarter?.start).toEqual([0, -50]);
    expectPoint(last(quarter as Contour), [50, 0], 6);
    // An eighth lands at 45° on the arc (the cubic is symmetric about it).
    const eighth = firstPiece(trimContours([circle], trim(0, 0.125)));
    const end = last(eighth as Contour);
    expect(Math.hypot(end[0], end[1])).toBeCloseTo(50, 1);
    expect(end[0]).toBeCloseTo(-end[1], 6);
    expect(contourLength(eighth as Contour)).toBeCloseTo(contourLength(circle) / 8, 6);
  });

  it("gives the same bits every time", () => {
    const run = () =>
      trimContours(
        [ellipseContour([3, 7], [91, 37]), line([1, 1], [9, 4])],
        trim(0.13, 0.71, { offset: 33.3, mode: "individual" }),
      );
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe("roundCorners", () => {
  it("rounds a sharp rectangle into the rectangle's own rounded corners", () => {
    const rounded = roundCorners(rectContour([0, 0], [20, 10], 0), 2);
    const reference = rectContour([0, 0], [20, 10], 2);
    // Starts where the first corner's arc begins, on the closing (top) side.
    expect(rounded.start).toEqual([8, -5]);
    expect(rounded.closed).toBe(true);
    // Same outline, started one segment later.
    const shift = (c: Contour) => [...c.segments.slice(1), c.segments[0]];
    const actual = shift(rounded);
    const expected = reference.segments.slice(0, actual.length);
    actual.forEach((segment, i) => {
      const want = expected[i];
      expect(segment?.kind).toBe(want?.kind);
      expectPoint(segment?.to as Point, want?.to as Point, 12);
      if (segment?.kind === "cubic" && want?.kind === "cubic") {
        expectPoint(segment.c1, want.c1, 12);
        expectPoint(segment.c2, want.c2, 12);
      }
    });
    expect(contourLength(rounded)).toBeCloseTo(contourLength(reference), 9);
  });

  it("stops at half of each side, so sides can vanish", () => {
    // At radius 3 every side keeps a straight middle; at 50 the arcs meet at every midpoint.
    expect(roundCorners(rectContour([0, 0], [20, 10], 0), 3).segments.map((s) => s.kind)).toEqual([
      "cubic",
      "line",
      "cubic",
      "line",
      "cubic",
      "line",
      "cubic",
      "line",
    ]);
    const rounded = roundCorners(rectContour([0, 0], [20, 10], 0), 50);
    expect(rounded.segments.map((s) => s.kind)).toEqual(["cubic", "cubic", "cubic", "cubic"]);
    // The right side's two arcs meet at its middle.
    expect(rounded.segments[0]?.to).toEqual([10, 0]);
  });

  it("puts the arc's handles κ of the way to the corner", () => {
    const corner: Contour = {
      start: [0, 0],
      segments: [
        { kind: "line", to: [10, 0] },
        { kind: "line", to: [10, 10] },
      ],
      closed: false,
    };
    const rounded = roundCorners(corner, 4);
    expect(rounded.start).toEqual([0, 0]);
    expect(rounded.segments).toEqual([
      { kind: "line", to: [6, 0] },
      { kind: "cubic", c1: [6 + 4 * KAPPA, 0], c2: [10, 4 - 4 * KAPPA], to: [10, 4] },
      { kind: "line", to: [10, 10] },
    ]);
  });

  it("leaves smooth vertices, open ends and a zero radius alone", () => {
    const circle = ellipseContour([0, 0], [10, 10]);
    expect(roundCorners(circle, 3)).toBe(circle);
    const straight = line([0, 0], [10, 0]);
    expect(roundCorners(straight, 3)).toBe(straight);
    const box = rectContour([0, 0], [10, 10], 0);
    expect(roundCorners(box, 0)).toBe(box);
  });

  it("rounds the corners next to a repeated closing vertex", () => {
    // `M0,0 L10,0 L10,10 L0,10 L0,0 Z`: the closing side has no length.
    const square: Contour = {
      start: [0, 0],
      segments: [
        { kind: "line", to: [10, 0] },
        { kind: "line", to: [10, 10] },
        { kind: "line", to: [0, 10] },
        { kind: "line", to: [0, 0] },
      ],
      closed: true,
    };
    const rounded = roundCorners(square, 2);
    expect(rounded.segments.filter((s) => s.kind === "cubic")).toHaveLength(4);
    expect(rounded.start).toEqual([0, 2]);
  });

  it("rounds the corners of a polygon whose closing side is implicit", () => {
    const triangle: Contour = {
      start: [0, -10],
      segments: [
        { kind: "line", to: [10, 10] },
        { kind: "line", to: [-10, 10] },
      ],
      closed: true,
    };
    const rounded = roundCorners(triangle, 2);
    expect(rounded.segments.map((s) => s.kind)).toEqual([
      "cubic",
      "line",
      "cubic",
      "line",
      "cubic",
      "line",
    ]);
    expect(last(rounded)).toEqual(rounded.start);
  });
});
