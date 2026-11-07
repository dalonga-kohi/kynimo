import { describe, expect, it } from "vitest";
import {
  bezierContour,
  type Contour,
  ellipseContour,
  itemContour,
  KAPPA,
  rectContour,
  transformContour,
} from "./geometry.js";

const ends = (c: Contour) => [c.start, ...c.segments.map((s) => s.to)];

/** Shoelace area over the on-curve points; positive is clockwise on screen (+y down). */
const signedArea = (c: Contour) => {
  const pts = ends(c);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i] as [number, number];
    const [x1, y1] = pts[(i + 1) % pts.length] as [number, number];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
};

describe("rectContour", () => {
  it("is centered on position, starts top-right and runs clockwise", () => {
    const c = rectContour([50, 40], [20, 10], 0);
    expect(c.start).toEqual([60, 35]);
    expect(ends(c)).toEqual([
      [60, 35],
      [60, 45],
      [40, 45],
      [40, 35],
    ]);
    expect(c.closed).toBe(true);
    expect(signedArea(c)).toBeGreaterThan(0);
  });

  it("rounds corners with quarter-circle cubics, starting below the top-right corner", () => {
    const c = rectContour([0, 0], [20, 10], 2);
    expect(c.start).toEqual([10, -3]);
    const corner = c.segments[1];
    expect(corner).toEqual({
      kind: "cubic",
      c1: [10, 5 - 2 * (1 - KAPPA)],
      c2: [10 - 2 * (1 - KAPPA), 5],
      to: [8, 5],
    });
  });

  it("clamps the radius to half the shorter side and drops zero-length edges", () => {
    const c = rectContour([0, 0], [20, 10], 50);
    expect(c.start).toEqual([10, 0]);
    // The short sides vanish: two straight edges and four corners remain.
    expect(c.segments.map((s) => s.kind)).toEqual([
      "cubic",
      "line",
      "cubic",
      "cubic",
      "line",
      "cubic",
    ]);
  });
});

describe("ellipseContour", () => {
  it("starts at the top and passes right, bottom, left (clockwise)", () => {
    const c = ellipseContour([10, 10], [20, 8]);
    expect(ends(c)).toEqual([
      [10, 6],
      [20, 10],
      [10, 14],
      [0, 10],
      [10, 6],
    ]);
  });
});

describe("polygon and star", () => {
  const base = { id: "p", name: "p", position: [0, 0] as const };

  it("puts the first polygon vertex straight up and turns clockwise", () => {
    const c = itemContour({ ...base, type: "polygon", points: 4, radius: 10, rotation: 0 });
    const pts = ends(c);
    expect(pts).toHaveLength(4);
    expect(pts[0]?.[0]).toBeCloseTo(0);
    expect(pts[0]?.[1]).toBeCloseTo(-10);
    expect(pts[1]?.[0]).toBeCloseTo(10);
    expect(pts[1]?.[1]).toBeCloseTo(0);
  });

  it("alternates outer and inner radii, outer first", () => {
    const c = itemContour({
      ...base,
      type: "star",
      points: 5,
      outerRadius: 10,
      innerRadius: 4,
      rotation: 0,
    });
    const radii = ends(c).map(([x, y]) => Math.hypot(x, y));
    expect(radii).toHaveLength(10);
    radii.forEach((r, i) => {
      expect(r).toBeCloseTo(i % 2 === 0 ? 10 : 4);
    });
  });

  it("applies rotation in degrees, clockwise", () => {
    const c = itemContour({ ...base, type: "polygon", points: 3, radius: 10, rotation: 90 });
    expect(c.start[0]).toBeCloseTo(10);
    expect(c.start[1]).toBeCloseTo(0);
  });
});

describe("bezierContour", () => {
  it("uses lines for handle-free segments and absolute control points for curves", () => {
    const c = bezierContour({
      closed: true,
      vertices: [
        { point: [0, 0], inTangent: [0, 0], outTangent: [5, 0] },
        { point: [10, 10], inTangent: [0, -5], outTangent: [0, 0] },
        { point: [0, 10], inTangent: [0, 0], outTangent: [0, 0] },
      ],
    });
    expect(c.segments).toEqual([
      { kind: "cubic", c1: [5, 0], c2: [10, 5], to: [10, 10] },
      { kind: "line", to: [0, 10] },
      { kind: "line", to: [0, 0] },
    ]);
  });

  it("leaves open paths open", () => {
    const c = bezierContour({
      closed: false,
      vertices: [
        { point: [0, 0], inTangent: [0, 0], outTangent: [0, 0] },
        { point: [10, 0], inTangent: [0, 0], outTangent: [0, 0] },
      ],
    });
    expect(c.closed).toBe(false);
    expect(c.segments).toHaveLength(1);
  });
});

describe("transformContour", () => {
  it("maps every point, control points included", () => {
    const c = transformContour([2, 0, 0, 2, 1, 1], ellipseContour([0, 0], [2, 2]));
    expect(c.start).toEqual([1, -1]);
    expect(c.segments[0]).toEqual({
      kind: "cubic",
      c1: [1 + 2 * KAPPA, -1],
      c2: [3, 1 - 2 * KAPPA],
      to: [3, 1],
    });
  });
});
