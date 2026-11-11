import { describe, expect, it } from "vitest";
import { arcToCubics, parsePathData } from "./path-data.js";

const pts = (d: string) => parsePathData(d).contours.map((c) => c.vertices.map((v) => v.point));

describe("parsePathData commands", () => {
  it("handles absolute and relative lines", () => {
    expect(pts("M10 10 L20 10 L20 20")).toEqual([
      [
        [10, 10],
        [20, 10],
        [20, 20],
      ],
    ]);
    expect(pts("m10 10 l10 0 l0 10")).toEqual(pts("M10 10 L20 10 L20 20"));
  });

  it("handles H, V and their relative forms", () => {
    expect(pts("M0 0 H10 V5 h-4 v3")).toEqual([
      [
        [0, 0],
        [10, 0],
        [10, 5],
        [6, 5],
        [6, 8],
      ],
    ]);
  });

  it("treats extra pairs after M as lineto (and after m as relative lineto)", () => {
    expect(pts("M0 0 10 0 10 10")).toEqual([
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    ]);
    expect(pts("m1 1 2 0 0 2")).toEqual([
      [
        [1, 1],
        [3, 1],
        [3, 3],
      ],
    ]);
  });

  it("converts C with tangents as offsets from the vertices", () => {
    const [c] = parsePathData("M0 0 C10 0 20 10 20 20").contours;
    expect(c?.vertices[0]?.outTangent).toEqual([10, 0]);
    expect(c?.vertices[1]?.point).toEqual([20, 20]);
    expect(c?.vertices[1]?.inTangent).toEqual([0, -10]);
  });

  it("reflects the control point for S and T", () => {
    const [c] = parsePathData("M0 0 C0 10 10 10 10 0 S20 -10 20 0").contours;
    // reflected c1 = 2*(10,0) - (10,10) = (10,-10): out tangent of vertex 1 = (0,-10)
    expect(c?.vertices[1]?.outTangent).toEqual([0, -10]);
    const [q] = parsePathData("M0 0 Q5 10 10 0 T20 0").contours;
    // reflected quad control (15,-10); cubic c1 = p0 + 2/3 (q - p0) with p0=(10,0)
    const out = q?.vertices[1]?.outTangent ?? [0, 0];
    expect(out[0]).toBeCloseTo((2 / 3) * 5);
    expect(out[1]).toBeCloseTo((2 / 3) * -10);
  });

  it("S and T without a previous curve start at the current point", () => {
    const [c] = parsePathData("M0 0 L10 0 S20 10 20 0").contours;
    expect(c?.vertices[1]?.outTangent).toEqual([0, 0]);
    const [q] = parsePathData("M0 0 L10 0 T20 0").contours;
    expect(q?.vertices[1]?.outTangent).toEqual([0, 0]);
  });

  it("converts quadratics to exact cubics", () => {
    const [c] = parsePathData("M0 0 Q30 60 60 0").contours;
    const a = c?.vertices[0];
    const b = c?.vertices[1];
    expect(a?.outTangent).toEqual([20, 40]);
    expect(b?.inTangent).toEqual([-20, 40]);
    // midpoint of the quadratic is (30, 30); the cubic must agree
    const p0 = [0, 0];
    const p1 = [20, 40];
    const p2 = [60 - 20, 40];
    const p3 = [60, 0];
    const mid = (i: 0 | 1) =>
      0.125 * (p0[i] ?? 0) + 0.375 * (p1[i] ?? 0) + 0.375 * (p2[i] ?? 0) + 0.125 * (p3[i] ?? 0);
    expect(mid(0)).toBeCloseTo(30);
    expect(mid(1)).toBeCloseTo(30);
  });

  it("closes with Z, merging a duplicate end vertex and keeping its in tangent", () => {
    const { contours } = parsePathData("M0 0 L10 0 L10 10 L0 0 Z");
    expect(contours).toHaveLength(1);
    expect(contours[0]?.closed).toBe(true);
    expect(contours[0]?.vertices).toHaveLength(3);
    const curved = parsePathData("M0 0 C10 0 10 10 0 10 C-10 10 -10 0 0 0 Z").contours[0];
    expect(curved?.vertices).toHaveLength(2);
    expect(curved?.vertices[0]?.inTangent).toEqual([-10, 0]);
  });

  it("keeps the vertex when the closing segment is a real line", () => {
    const c = parsePathData("M0 0 L10 0 L10 10 Z").contours[0];
    expect(c?.vertices).toHaveLength(3);
    expect(c?.closed).toBe(true);
  });

  it("starts a subpath after Z at the previous start point", () => {
    expect(pts("M5 5 L10 5 L10 10 Z L20 20")).toEqual([
      [
        [5, 5],
        [10, 5],
        [10, 10],
      ],
      [
        [5, 5],
        [20, 20],
      ],
    ]);
  });

  it("splits subpaths at each M", () => {
    expect(parsePathData("M0 0 L1 1 M5 5 L6 6").contours).toHaveLength(2);
  });
});

describe("parsePathData number syntax", () => {
  it("reads compact numbers", () => {
    expect(pts("M1.5.5-1-2")).toEqual([
      [
        [1.5, 0.5],
        [-1, -2],
      ],
    ]);
  });

  it("reads exponents", () => {
    expect(pts("M0 0 L1e-3 1E+2")).toEqual([
      [
        [0, 0],
        [0.001, 100],
      ],
    ]);
  });

  it("accepts commas and odd whitespace", () => {
    expect(pts("M0,0,L10 ,10")).toEqual([
      [
        [0, 0],
        [10, 10],
      ],
    ]);
  });

  it("reads arc flags without separators", () => {
    const compact = parsePathData("M0 0 a1 1 0 011 1").contours[0];
    const spaced = parsePathData("M0 0 a1 1 0 0 1 1 1").contours[0];
    expect(compact).toEqual(spaced);
    expect(compact?.vertices.at(-1)?.point[0]).toBeCloseTo(1);
    expect(compact?.vertices.at(-1)?.point[1]).toBeCloseTo(1);
  });
});

describe("parsePathData errors", () => {
  it("keeps everything before an error", () => {
    const r = parsePathData("M0 0 L10 10 L20 x");
    expect(r.error).toBe(true);
    expect(r.contours[0]?.vertices).toHaveLength(2);
  });

  it("rejects data that does not start with M", () => {
    const r = parsePathData("L10 10");
    expect(r.error).toBe(true);
    expect(r.contours).toHaveLength(0);
  });

  it("drops a command with missing arguments", () => {
    const r = parsePathData("M0 0 L10 10 L20");
    expect(r.error).toBe(true);
    expect(r.contours[0]?.vertices).toHaveLength(2);
  });

  it("rejects unknown commands and numbers after Z", () => {
    expect(parsePathData("M0 0 L1 1 X5").error).toBe(true);
    expect(parsePathData("M0 0 L1 1 Z 5 5").error).toBe(true);
  });

  it("rejects an invalid arc flag", () => {
    expect(parsePathData("M0 0 a1 1 0 2 1 1 1").error).toBe(true);
  });

  it("is clean for empty data", () => {
    expect(parsePathData("")).toEqual({ contours: [], error: false });
  });
});

describe("arcs", () => {
  const evalCubic = (
    p0: [number, number],
    seg: [number, number, number, number, number, number],
    t: number,
  ): [number, number] => {
    const u = 1 - t;
    const f = (a: number, b: number, c: number, d: number) =>
      u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
    return [f(p0[0], seg[0], seg[2], seg[4]), f(p0[1], seg[1], seg[3], seg[5])];
  };

  it("ends exactly at the endpoint and stays on the circle", () => {
    const segs = arcToCubics(10, 0, 10, 10, 0, false, true, 0, 10);
    expect(segs).not.toBeNull();
    const last = segs?.at(-1);
    expect(last?.[4]).toBe(0);
    expect(last?.[5]).toBe(10);
    let p0: [number, number] = [10, 0];
    for (const s of segs ?? []) {
      for (const t of [0.25, 0.5, 0.75]) {
        const [x, y] = evalCubic(p0, s, t);
        expect(Math.hypot(x, y)).toBeCloseTo(10, 1);
      }
      p0 = [s[4], s[5]];
    }
  });

  it("splits into segments of at most 90 degrees", () => {
    // half circle -> 2 segments, three quarters -> 3
    expect(arcToCubics(10, 0, 10, 10, 0, false, true, -10, 0)).toHaveLength(2);
    expect(arcToCubics(10, 0, 10, 10, 0, true, true, 0, -10)).toHaveLength(3);
  });

  it("honours the sweep flag", () => {
    const cw = arcToCubics(10, 0, 10, 10, 0, false, true, 0, 10);
    const ccw = arcToCubics(10, 0, 10, 10, 0, false, false, 0, 10);
    expect(cw?.[0]?.[0]).toBeCloseTo(10); // clockwise about the origin: leaves downward
    expect(cw?.[0]?.[1]).toBeGreaterThan(0);
    expect(ccw?.[0]?.[0]).toBeLessThan(10); // counter-clockwise about (10, 10): leaves leftward
    expect(ccw?.[0]?.[1]).toBeCloseTo(0);
  });

  it("scales up radii that are too small", () => {
    const segs = arcToCubics(0, 0, 1, 1, 0, false, true, 10, 0);
    expect(segs).toHaveLength(2);
    // half circle of radius 5 around (5, 0)
    const mid = segs?.[0];
    expect(mid?.[4]).toBeCloseTo(5);
    expect(Math.abs(mid?.[5] ?? 0)).toBeCloseTo(5);
  });

  it("returns null for a zero radius so the caller draws a line", () => {
    expect(arcToCubics(0, 0, 0, 5, 0, false, true, 10, 10)).toBeNull();
    const c = parsePathData("M0 0 A0 5 0 0 1 10 10").contours[0];
    expect(c?.vertices).toHaveLength(2);
    expect(c?.vertices[1]?.point).toEqual([10, 10]);
  });

  it("skips an arc to the same point", () => {
    expect(parsePathData("M5 5 A3 3 0 0 1 5 5").contours[0]?.vertices).toHaveLength(1);
  });

  it("supports rotated ellipses", () => {
    const segs = arcToCubics(0, 0, 20, 10, 30, false, true, 15, 15);
    expect(segs?.at(-1)?.slice(4)).toEqual([15, 15]);
  });
});
