import { describe, expect, it } from "vitest";
import {
  type Affine,
  invert,
  levelOfDetail,
  NEAR,
  type Projective,
  projectiveInvert,
  projectivePlacement,
  projectiveSample,
} from "./pipeline.js";
import { cardProjection } from "./projective.test-util.js";

const apply = (m: Projective, x: number, y: number): [number, number, number] => [
  m[0] * x + m[1] * y + m[2],
  m[3] * x + m[4] * y + m[5],
  m[6] * x + m[7] * y + m[8],
];

describe("projectiveInvert", () => {
  it("is the true inverse of a known homography, without normalizing", () => {
    const m: Projective = [2, 0.1, 3, -0.2, 1.5, 5, 0.002, 0.001, 1.25];
    const inv = projectiveInvert(m) as Projective;
    expect(inv).not.toBeNull();
    for (const [x, y] of [
      [0, 0],
      [10, 20],
      [-7, 3.5],
    ] as const) {
      const [X, Y, W] = apply(m, x, y);
      const [hx, hy, hz] = apply(inv, X / W, Y / W);
      // The homogeneous result is a multiple of (x, y, 1), the multiple being 1 / W.
      expect(hx / hz).toBeCloseTo(x, 9);
      expect(hy / hz).toBeCloseTo(y, 9);
      expect(hz).toBeCloseTo(1 / W, 12);
    }
  });

  it("returns null for a singular or non-finite matrix", () => {
    expect(projectiveInvert([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
    expect(projectiveInvert([1, 0, 0, 0, 1, 0, 0, 0, Number.NaN])).toBeNull();
  });
});

describe("projectiveSample", () => {
  it("equals levelOfDetail for an affine placement, at every pixel", () => {
    for (const affine of [
      [0.3, 0.05, -0.05, 0.3, 4, 6],
      [0.11, 0, 0, 0.07, 1, 1],
      [1, 0, 0, 1, 3, 3],
      [2.5, 0, 0, 1.75, -10, -5],
      [0.02, 0.01, -0.01, 0.02, 0, 0],
    ] as const) {
      const inv = invert([...affine]) as Affine;
      // Homogeneous scale 1/2 (W = 2, in front of the near plane): the same affine map.
      const proj: Projective = [inv[0], inv[2], inv[4], inv[1], inv[3], inv[5], 0, 0, 1].map(
        (v) => v / 2,
      ) as unknown as Projective;
      const expected = levelOfDetail(inv, 40, 30);
      for (const [x, y] of [
        [0, 0],
        [13, 7],
        [63, 47],
      ] as const) {
        const at = projectiveSample(proj, x, y, 40, 30);
        expect(at?.lod).toBeCloseTo(expected, 9);
        expect(at?.qx).toBeCloseTo(inv[0] * (x + 0.5) + inv[2] * (y + 0.5) + inv[4], 9);
        expect(at?.qy).toBeCloseTo(inv[1] * (x + 0.5) + inv[3] * (y + 0.5) + inv[5], 9);
      }
    }
  });

  it("varies across a foreshortened layer and is clamped to the mip chain", () => {
    const m = cardProjection({
      comp: [64, 48],
      zoom: 60,
      position: [32, 24, 0],
      anchor: [20, 15],
      rotationY: 70,
    });
    const inv = projectiveInvert(m) as Projective;
    // The far (right) edge is minified more than the near (left) one.
    const left = projectiveSample(inv, 14, 24, 40, 30);
    const right = projectiveSample(inv, 50, 24, 40, 30);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect((right?.lod ?? 0) > (left?.lod ?? 0)).toBe(true);
    // 1x1 source: no level below 0 exists.
    expect(projectiveSample(inv, 50, 24, 1, 1)?.lod).toBe(0);
  });

  it("clips at the near plane: W must exceed NEAR, and never mirrors", () => {
    // Composition x = X / W = x / (0.1 x + 0.5), W = 0.1 x + 0.5: the layer's far end piles up at 10.
    const m: Projective = [1, 0, 0, 0, 1, 0, 0.1, 0, 0.5];
    const inv = projectiveInvert(m) as Projective;
    expect(NEAR).toBe(1);
    const covered = (px: number) => projectiveSample(inv, px, 0, 64, 64) !== null;
    expect(covered(2)).toBe(false); // pixel centre 2.5 is layer x = 1.67, W = 0.67
    expect(covered(4)).toBe(false); // 4.5 -> W = 0.91, still behind the near plane
    expect(covered(5)).toBe(true); // 5.5 -> W = 1.11
    expect(covered(7)).toBe(true);
    expect(covered(12)).toBe(false); // past the horizon the inverse gives W < 0: no mirrored image
    expect(covered(40)).toBe(false);
  });
});

describe("projectivePlacement", () => {
  it("shifts the raster by the effect padding", () => {
    const m: Projective = [2, 0, 10, 0, 3, 20, 0.001, 0, 1];
    const layer = { space: "layer", projection: m, matrix: [1, 0, 0, 1, 0, 0] } as never;
    const p = projectivePlacement(layer, [4, 6]);
    // A raster pixel (x, y) of the padded raster is the unpadded pixel (x - 4, y - 6).
    const padded = apply(p, 10, 12);
    const direct = apply(m, 6, 6);
    for (let i = 0; i < 3; i++) expect(padded[i]).toBeCloseTo(direct[i] as number, 9);
  });

  it("uses a motion sample's full projection, not a delta", () => {
    const m: Projective = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const s: Projective = [2, 0, 5, 0, 2, 5, 0, 0, 1];
    const layer = { space: "layer", projection: m, matrix: [1, 0, 0, 1, 0, 0] } as never;
    expect(
      projectivePlacement(layer, [0, 0], { delta: [1, 0, 0, 1, 0, 0], opacity: 1, projection: s }),
    ).toEqual(s);
  });
});
