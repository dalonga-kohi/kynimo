import type { Point, ResolvedDeform } from "@kynimo/engine";
import { describe, expect, it, vi } from "vitest";
import { FrameDeformWork, planDeform } from "./deform.js";
import type { PlannedDeform, RasterImage } from "./raster.js";

const raster = (
  width: number,
  height: number,
  alpha: (x: number, y: number) => number,
): RasterImage => {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) pixels[(y * width + x) * 4 + 3] = alpha(x, y);
  return { width, height, pixels };
};

const pin = (id: string, rest: Point, position: Point) => ({ id, rest, position });
const source = { width: 32, height: 24, mask: null };
const first = pin("first", [0, 0], [5, 3]);
const deform = (
  pins: ResolvedDeform["pins"] = [first],
  density = 4,
  iterations = 10,
): ResolvedDeform => ({
  pins,
  density,
  iterations,
});
const plan = (
  settings = deform(),
  input: Parameters<typeof planDeform>[2] = source,
  work = new FrameDeformWork(),
) => planDeform("puppet", settings, input, [1, 0, 0], [0, 0], work);

function verticesOf({ origin, vertices }: PlannedDeform): Map<string, Point> {
  const map = new Map<string, Point>();
  for (let i = 0; i < vertices.length; i += 4)
    map.set(`${vertices[i + 2]},${vertices[i + 3]}`, [
      (vertices[i] as number) + origin[0],
      (vertices[i + 1] as number) + origin[1],
    ]);
  return map;
}

describe("deformation mesh", () => {
  it("uses the rectangle's aspect ratio and row-major NW-SE triangles", () => {
    const { warp } = plan();
    if (warp === null) throw new Error("expected a mesh");
    // Longer side is 4 cells, shorter side is ceil(24/32 × 4) = 3.
    expect(warp.vertices.length).toBe(24 * 12);
    expect(warp.vertices.filter((_, i) => i % 4 >= 2).slice(0, 12)).toEqual([
      0, 0, 8, 0, 8, 8, 0, 0, 8, 8, 0, 8,
    ]);
    expect(verticesOf(warp).get("0,0")).toEqual([5, 3]);
  });

  it("uses positive source and mask coverage with one ring of cells", () => {
    const width = 80;
    const height = 40;
    const image = raster(width, height, (x, y) => ((x === 24 || x === 75) && y === 15 ? 1 : 0));
    const coverage = new Uint8Array(width * height).fill(1);
    coverage[15 * width + 75] = 0;
    const mask = { width, height, coverage };
    const settings = deform([pin("edge", [10, 0], [14, 2])], 8);
    const { warp } = plan(settings, { width, height, raster: image, mask });
    if (warp === null) throw new Error("expected a mesh");
    expect(warp.vertices.length).toBe(18 * 12);
    const rest = [...verticesOf(warp).keys()];
    expect(rest[0]).toBe("10,0");
    expect(rest).toContain("40,30");
    expect(rest).not.toContain("0,0");
    expect(rest).not.toContain("50,30");
    expect(rest).not.toContain("70,20");
    // The same mask has no effect on topology for a full-rectangle source.
    expect(plan(settings, { width, height, mask }).warp?.vertices.length).toBe(64 * 12);
  });

  it("counts all cells overlapping a subpixel grid and treats transparent alpha as empty", () => {
    const input = { width: 1, height: 1, mask: null };
    const opaque = plan(deform(), { ...input, raster: raster(1, 1, () => 1) });
    expect(opaque.warp?.vertices.length).toBe(32 * 12);
    expect(plan(deform(), { ...input, raster: raster(1, 1, () => 0) })).toEqual({
      warp: null,
      warning: null,
    });
    expect(plan(deform([]))).toEqual({ warp: null, warning: null });
  });

  it("leaves every vertex of an unpinned island at rest", () => {
    const width = 128;
    const height = 16;
    const { warp } = plan(deform([pin("left", [0, 0], [3, 5])], 16), {
      width,
      height,
      raster: raster(width, height, (x, y) => (y === 4 && (x === 3 || x === 121) ? 255 : 0)),
      mask: null,
    });
    if (warp === null) throw new Error("expected a mesh");
    const right = [...verticesOf(warp)].filter(([, p]) => p[0] > 100);
    expect(right.length).toBeGreaterThan(0);
    for (const [rest, position] of right) expect(position.join(",")).toBe(rest);
  });
});

describe("deformation solve", () => {
  it("snaps ties row-major and applies displacement from the authored rest point", () => {
    const neutral = pin("neutral", [4, 4], [4, 4]);
    expect(plan(deform([neutral])).warp).toBeNull();
    const settings = deform([pin("tie", [4, 4], [8, 10]), pin("far", [32, 24], [32, 24])]);
    const { warp } = plan(settings);
    if (warp === null) throw new Error("expected a mesh");
    const vertices = verticesOf(warp);
    expect(vertices.get("0,0")).toEqual([4, 6]);
    expect(vertices.get("32,24")).toEqual([32, 24]);
    expect(vertices.get("16,8")).not.toEqual([16, 8]);
    expect(plan(settings).warp).toEqual(warp);
    expect(plan({ ...settings, iterations: 1 }).warp).not.toEqual(warp);
  });

  it("keeps the first pin at a shared vertex and bounds the warning", () => {
    const later = Array.from({ length: 12 }, (_, i) => pin(`later-${i}`, [1, 1], [12, 12]));
    const { warp, warning } = plan(deform([first, ...later]));
    expect(warp).toEqual(plan(deform([first])).warp);
    expect(warning).toMatchObject({ id: "puppet", kind: "deform-pin-collision", codepoints: [] });
    expect(warning?.message).toContain("12 deform pin(s)");
    expect(warning?.message).toContain("later-4");
    expect(warning?.message).not.toContain("later-5");
  });

  it("rejects overflowing, nonfinite and out-of-bound pin input even when pins collide", () => {
    for (const hostile of [
      pin("overflow", [1e308, 0], [-1e308, 0]),
      pin("nan", [0, 0], [Number.NaN, 0]),
      pin("huge", [0, 0], [2 ** 21, 0]),
    ])
      expect(() => plan(deform([first, hostile]))).toThrow(/puppet.*finite.*limit/);
  });

  it("rejects invalid source dimensions, array lengths, and settings before mesh work", () => {
    expect(() => plan(deform(), { ...source, width: 8193 })).toThrow(/puppet.*8192-pixel/);
    expect(() => plan(deform(), { ...source, raster: raster(1, 1, () => 255) })).toThrow(
      /puppet.*raster/,
    );
    expect(() => plan(deform([first], 65))).toThrow(/puppet.*density.*4\.\.64/);
    expect(() => plan(deform([first], 4, 31))).toThrow(/puppet.*iterations.*1\.\.30/);
    expect(() => plan(deform(Array.from({ length: 33 }, () => first)))).toThrow(/puppet.*32 pins/);
  });

  it("bounds the target including effects and shares the work budget", () => {
    const stretch = deform([pin("fixed", [0, 0], [0, 0]), pin("stretch", [32, 24], [9000, 0])]);
    expect(() => plan(stretch)).toThrow(/puppet.*8192-pixel target size/);
    expect(() =>
      planDeform("padded", deform(), source, [1, 0, 0], [4096, 0], new FrameDeformWork()),
    ).toThrow(/padded.*effect padding.*8192/);
    const meter = new FrameDeformWork();
    const charge = vi.spyOn(meter, "charge");
    plan(deform(), source, meter);
    const units = charge.mock.calls.reduce((sum, [, cost]) => sum + cost, 0);
    const shared = new FrameDeformWork(units);
    expect(plan(deform(), source, shared).warp).not.toBeNull();
    expect(() => plan(deform(), source, shared)).toThrow(/puppet.*frame budget/);
  });
});
