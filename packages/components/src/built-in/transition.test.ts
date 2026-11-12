import {
  applyToPoint,
  invert,
  type ResolvedComposition,
  type ResolvedLayer,
  type ResolvedMask,
} from "@kynimo/engine";
import { brutalist, keynote } from "@kynimo/guidelines";
import { describe, expect, it } from "vitest";
import type { Obj } from "../fixtures.test-util.js";
import { layerById, run } from "./run.test-util.js";
import { transition } from "./transition.js";

const ID = "transition";
const KINDS = (transition.props.kind as { values: string[] }).values;
const DIRECTIONS = ["right", "left", "up", "down"];
const SIZES = [
  [1920, 1080],
  [1080, 1920],
] as const;
/** Sizes up to the largest composition: only evaluated, since sampling every pixel there is slow. */
const LARGE = [
  [7680, 4320],
  [8192, 8192],
] as const;

/** Is `p` inside the circle a four-vertex mask path describes? */
function inCircle(m: ResolvedMask, [x, y]: [number, number]): boolean {
  const pts = m.path.vertices.map((v) => v.point);
  const cx = pts.reduce((a, q) => a + q[0], 0) / pts.length;
  const cy = pts.reduce((a, q) => a + q[1], 0) / pts.length;
  const r = Math.hypot((pts[0] as [number, number])[0] - cx, (pts[0] as [number, number])[1] - cy);
  return r > 0 && Math.hypot(x - cx, y - cy) <= r;
}

/** Is the point (composition pixels) fully painted by this layer: solids and ellipse shapes, with circle masks. */
function covers(l: ResolvedLayer, p: [number, number]): boolean {
  if (l.transform.opacity < 1) return false;
  const inv = invert(l.matrix);
  if (inv === null) return false;
  const [x, y] = applyToPoint(inv, p);
  let inside = false;
  if (l.type === "solid")
    inside = x >= -1e-6 && y >= -1e-6 && x <= l.width + 1e-6 && y <= l.height + 1e-6;
  else if (l.type === "shape") {
    const r = l.contents.find((i) => i.type === "rect");
    const e = l.contents.find((i) => i.type === "ellipse");
    if (r?.type === "rect")
      inside =
        Math.abs(x - r.position[0]) <= r.size[0] / 2 + 1e-6 &&
        Math.abs(y - r.position[1]) <= r.size[1] / 2 + 1e-6;
    else if (e?.type === "ellipse") {
      const [ex, ey] = [
        (x - e.position[0]) / (e.size[0] / 2),
        (y - e.position[1]) / (e.size[1] / 2),
      ];
      inside = ex * ex + ey * ey <= 1;
    } else return false;
  }
  if (!inside) return false;
  if (l.masks.length === 0) return true;
  let acc = ["add", "lighten", "difference"].includes((l.masks[0] as ResolvedMask).mode) ? 0 : 1;
  for (const m of l.masks) {
    const c = (inCircle(m, [x, y]) ? 1 : 0) * m.opacity;
    acc = m.mode === "add" ? acc + c - acc * c : m.mode === "subtract" ? acc * (1 - c) : acc * c;
  }
  return acc >= 1;
}

/** Sample points over the frame, corners included. */
function samples(w: number, h: number, step = 17): [number, number][] {
  const out: [number, number][] = [
    [0.5, 0.5],
    [w - 0.5, 0.5],
    [0.5, h - 0.5],
    [w - 0.5, h - 0.5],
  ];
  for (let y = 0.5; y < h; y += step) for (let x = 0.5; x < w; x += step) out.push([x, y]);
  return out;
}

/** How many sample points no layer paints. */
function gaps(comp: ResolvedComposition): number {
  return samples(comp.width, comp.height).filter((p) => !comp.layers.some((l) => covers(l, p)))
    .length;
}
/** How many sample points some layer paints. */
function painted(comp: ResolvedComposition): number {
  return samples(comp.width, comp.height).filter((p) => comp.layers.some((l) => covers(l, p)))
    .length;
}

const mid = (span: number) => Math.floor((span - 1) / 2);

describe("transition", () => {
  it("has the ten documented kinds and no speed or exit", () => {
    expect(KINDS).toEqual([
      "wipe",
      "panels",
      "iris",
      "dip",
      "split",
      "diagonal",
      "blinds",
      "shutter",
      "circles",
      "slide",
    ]);
    expect(transition.props.speed).toBeUndefined();
    expect(transition.props.exit).toBeUndefined();
    expect(transition.description).toMatch(/cut your shots at the midpoint/);
  });

  for (const kind of KINDS)
    for (const duration of [1, 2, 10, 150])
      for (const [width, height] of SIZES)
        it(`evaluates '${kind}' over ${duration} frames at ${width}x${height}`, () => {
          for (const frame of new Set([
            0,
            Math.floor(duration * 0.1),
            mid(duration),
            duration - 1,
          ])) {
            const comp = run(ID, { kind }, { frame, duration, width, height });
            expect(comp.width).toBe(width);
            expect(comp.layers.length).toBeGreaterThan(0);
            expect(comp.layers.length).toBeLessThanOrEqual(600);
          }
        });

  for (const kind of KINDS)
    for (const [width, height] of LARGE)
      it(`evaluates '${kind}' at ${width}x${height}`, () => {
        for (const frame of [0, 74, 149]) {
          const comp = run(ID, { kind }, { frame, duration: 150, width, height });
          expect(comp.layers.length).toBeGreaterThan(0);
          expect(comp.layers.length).toBeLessThanOrEqual(600);
        }
      });

  describe("coverage", () => {
    for (const kind of KINDS)
      for (const [width, height] of SIZES)
        for (const duration of [10, 150])
          it(`'${kind}' covers every pixel at the midpoint and none at the ends (${duration} frames, ${width}x${height})`, () => {
            for (const direction of DIRECTIONS) {
              const props = { kind, direction };
              const at = (frame: number) => run(ID, props, { frame, duration, width, height });
              expect(gaps(at(mid(duration))), `${direction} mid`).toBe(0);
              expect(painted(at(0)), `${direction} first`).toBe(0);
              expect(painted(at(duration - 1)), `${direction} last`).toBe(0);
              // Part of the way in it covers some, not all.
              const part = at(Math.max(1, Math.floor(mid(duration) / 8)));
              if (kind !== "dip") expect(gaps(part)).toBeGreaterThan(0);
            }
          });

    it("covers from every origin and with every count", () => {
      for (const origin of [
        [0, 0],
        [900, 500],
        [-900, -500],
        [3000, 0],
      ]) {
        for (const kind of ["iris", "circles"])
          for (const count of [2, 6, 24]) {
            const comp = run(ID, { kind, origin, count }, { frame: 74 });
            expect(gaps(comp), `${kind} ${origin} ${count}`).toBe(0);
          }
      }
      for (const kind of ["panels", "blinds", "shutter", "circles"])
        for (const count of [2, 3, 7, 24])
          for (const [width, height] of SIZES) {
            const comp = run(ID, { kind, count }, { frame: 74, width, height });
            expect(gaps(comp), `${kind} ${count}`).toBe(0);
          }
    });

    it("iris and circles reach the farthest corner", () => {
      const comp = run(ID, { kind: "iris", origin: [500, 300] }, { frame: 74 });
      const m = (comp.layers[0] as ResolvedLayer).masks[0] as ResolvedMask;
      const pts = m.path.vertices.map((v) => v.point);
      const radius =
        Math.abs((pts[1] as [number, number])[0] - (pts[3] as [number, number])[0]) / 2;
      expect(radius).toBeGreaterThanOrEqual(Math.hypot(960 + 500, 540 + 300));
      const cx = ((pts[1] as [number, number])[0] + (pts[3] as [number, number])[0]) / 2;
      expect(cx).toBeCloseTo(960 + 500, 2);

      const circles = run(ID, { kind: "circles", count: 6 }, { frame: 74 });
      const cell = 1920 / 6;
      for (const l of circles.layers) {
        if (l.type !== "shape") throw new Error("expected shapes");
        const e = l.contents.find((i) => i.type === "ellipse");
        expect(
          e?.type === "ellipse" && (e.size[0] / 2) * l.transform.scale[0],
        ).toBeGreaterThanOrEqual(Math.hypot(cell / 2, cell / 2));
      }
    });

    it("keeps the frame covered through the hold and only then lets go", () => {
      const state = (frame: number, hold: number) =>
        gaps(run(ID, { hold }, { frame, duration: 150 }));
      // mid = 74; a hold of 10 covers frames 69 to 79.
      for (const frame of [69, 72, 74, 77, 79]) expect(state(frame, 10)).toBe(0);
      expect(state(60, 10)).toBeGreaterThan(0);
      expect(state(90, 10)).toBeGreaterThan(0);
      expect(state(74, 0)).toBe(0);
      expect(state(69, 0)).toBeGreaterThan(0);
      // Odd holds put the extra frame after the midpoint.
      for (const frame of [72, 74, 77]) expect(state(frame, 5)).toBe(0);
      expect(state(68, 5)).toBeGreaterThan(0);
      expect(state(80, 5)).toBeGreaterThan(0);
    });

    it("keeps a frame for each phase when the hold is too long", () => {
      for (const kind of KINDS) {
        const at = (frame: number) => run(ID, { kind, hold: 120 }, { frame, duration: 10 });
        expect(painted(at(0)), kind).toBe(0);
        expect(painted(at(9)), kind).toBe(0);
        for (const frame of [1, 4, 8]) expect(gaps(at(frame)), `${kind} ${frame}`).toBe(0);
      }
    });

    it("covers from the first frame when the instance is too short for two phases", () => {
      for (const kind of KINDS) {
        expect(gaps(run(ID, { kind }, { frame: 0, duration: 1 })), kind).toBe(0);
        expect(gaps(run(ID, { kind }, { frame: 0, duration: 2 })), kind).toBe(0);
        expect(painted(run(ID, { kind }, { frame: 1, duration: 2 })), kind).toBe(0);
      }
    });
  });

  describe("kinds", () => {
    const layer = (props: Obj, frame: number, id: string, o = {}) =>
      layerById(run(ID, props, { frame, ...o }), id) as ResolvedLayer;

    it("wipe: travels in the direction and leaves through the opposite edge", () => {
      const x = (direction: string, frame: number) =>
        layer({ direction }, frame, "wipe").transform.position[0];
      expect(x("right", 0)).toBe(960 - 1920);
      expect(x("right", 74)).toBe(960);
      expect(x("right", 149)).toBe(960 + 1920);
      expect(x("left", 0)).toBe(960 + 1920);
      expect(x("left", 149)).toBe(960 - 1920);
      const y = layer({ direction: "down" }, 0, "wipe").transform.position[1];
      expect(y).toBe(540 - 1080);
      // Eased: not linear.
      const quarter = x("right", 37);
      expect(quarter).toBeGreaterThan(960 - 1920);
      expect(quarter).toBeLessThan(960);
    });

    it("panels: staggered, alternating colors", () => {
      const panels = run(ID, { kind: "panels", count: 6 }, { frame: 10 }).layers;
      expect(panels).toHaveLength(6);
      const xs = panels.map((l) => l.transform.position[0]);
      // Earlier panels are further along than later ones.
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1] as number);
      const color = (i: number) => {
        const l = panels[i];
        return l?.type === "solid" ? l.color : null;
      };
      expect(color(0)).toEqual(color(2));
      expect(color(0)).not.toEqual(color(1));
      // Together they tile the frame height.
      const heights = panels.map((l) => (l.type === "solid" ? l.height : 0));
      expect(heights.reduce((a, b) => a + b, 0)).toBe(1080);
    });

    it("iris: closes with a growing circle, then a hole opens from the same center", () => {
      const masks = (frame: number) =>
        layer({ kind: "iris", origin: [100, 50] }, frame, "iris").masks;
      expect(masks(0).map((m) => m.mode)).toEqual(["add", "subtract"]);
      expect(inCircle(masks(30)[0] as ResolvedMask, [1060, 590])).toBe(true);
      expect(inCircle(masks(30)[0] as ResolvedMask, [1060 + 2000, 590])).toBe(false);
      // Closing: the hole has no size; opening: it grows.
      expect(inCircle(masks(30)[1] as ResolvedMask, [1060.5, 590])).toBe(false);
      expect(inCircle(masks(120)[1] as ResolvedMask, [1060.5, 590])).toBe(true);
    });

    it("dip: fades to the color and back", () => {
      const o = (frame: number) => layer({ kind: "dip" }, frame, "dip").transform.opacity;
      expect(o(0)).toBe(0);
      expect(o(30)).toBeGreaterThan(0);
      expect(o(30)).toBeLessThan(1);
      expect(o(74)).toBe(1);
      expect(o(149)).toBe(0);
    });

    it("split: halves meet at the center and open back out, along the axis of the direction", () => {
      const h = (direction: string, frame: number, id: string) =>
        layer({ kind: "split", direction }, frame, id).transform.position;
      expect(h("down", 74, "half-a")[1]).toBe(270);
      expect(h("down", 74, "half-b")[1]).toBe(810);
      expect(h("up", 0, "half-a")[1]).toBe(-270);
      expect(h("down", 0, "half-b")[1]).toBe(1350);
      expect(h("right", 74, "half-a")[0]).toBe(480);
      expect(h("right", 149, "half-b")[0]).toBe(1920 + 480);
    });

    it("diagonal: a tilted square larger than the frame's diagonal", () => {
      const l = layer({ kind: "diagonal" }, 74, "diagonal");
      expect(l.transform.rotation).toBe(20);
      const rect = l.type === "shape" ? l.contents.find((i) => i.type === "rect") : undefined;
      if (rect?.type !== "rect") throw new Error("expected a rect");
      expect(rect.size[0]).toBeGreaterThanOrEqual(Math.hypot(1920, 1080) * 1.2 - 1);
      expect(rect.size[0]).toBe(rect.size[1]);
      expect(rect.position).toEqual([0, 0]);
    });

    it("blinds: strips grow from their middle, staggered, and leave in the other order", () => {
      const strips = (frame: number) =>
        run(ID, { kind: "blinds", count: 6, direction: "down" }, { frame }).layers;
      const scaleOf = (frame: number) => strips(frame).map((l) => l.transform.scale);
      expect(scaleOf(0).every(([sx, sy]) => sx === 1 && sy === 0)).toBe(true);
      const early = scaleOf(8).map((s) => s[1]);
      for (let i = 1; i < early.length; i++)
        expect(early[i]).toBeLessThanOrEqual(early[i - 1] as number);
      expect(early[0]).toBeGreaterThan(early.at(-1) as number);
      // Leaving, the last strip goes first.
      const late = scaleOf(80).map((s) => s[1]);
      expect(late.at(-1)).toBeLessThan(late[0] as number);
      // Left and right travel (the default) use vertical slats.
      const vertical = run(ID, { kind: "blinds", direction: "left" }, { frame: 0 }).layers;
      expect(vertical.every((l) => l.transform.scale[0] === 0 && l.transform.scale[1] === 1)).toBe(
        true,
      );
    });

    it("shutter: strips slide in alternately from both edges", () => {
      const xs = run(ID, { kind: "shutter", count: 6 }, { frame: 0 }).layers.map(
        (l) => l.transform.position[0],
      );
      expect(xs[0]).toBeLessThan(0);
      expect(xs[1]).toBeGreaterThan(1920);
      expect(xs[2]).toBeLessThan(0);
      const vertical = run(ID, { kind: "shutter", direction: "down" }, { frame: 0 }).layers.map(
        (l) => l.transform.position[1],
      );
      expect(vertical[0]).toBeLessThan(0);
      expect(vertical[1]).toBeGreaterThan(1080);
    });

    it("circles: a grid that grows from the origin outward and shrinks the same way", () => {
      const cells = (origin: number[], frame: number) =>
        run(ID, { kind: "circles", count: 6, origin }, { frame }).layers;
      expect(cells([0, 0], 0)).toHaveLength(24);
      const away = (l: ResolvedLayer, [ox = 0, oy = 0]: number[]) =>
        Math.hypot(l.matrix[4] - 960 - ox, l.matrix[5] - 540 - oy);
      for (const origin of [
        [0, 0],
        [-800, -400],
        [700, 300],
      ]) {
        const early = cells(origin, 14);
        const sorted = [...early].sort((a, b) => away(a, origin) - away(b, origin));
        const near = sorted[0] as ResolvedLayer;
        const far = sorted.at(-1) as ResolvedLayer;
        expect(near.transform.scale[0]).toBeGreaterThan(far.transform.scale[0]);
      }
      // Bounded: 24 x 24 at most.
      expect(
        run(ID, { kind: "circles", count: 24 }, { width: 1080, height: 1080 }).layers,
      ).toHaveLength(576);
      expect(
        run(ID, { kind: "circles", count: 24 }, { width: 8192, height: 8192 }).layers.length,
      ).toBeLessThanOrEqual(600);
      expect(
        run(ID, { kind: "circles", count: 24 }, { width: 8192, height: 4 }).layers,
      ).toHaveLength(24);
    });

    it("slide: two colors, the second arrives a beat after the first, both leave together", () => {
      const comp = (frame: number) => run(ID, { kind: "slide" }, { frame }).layers;
      expect(comp(0).map((l) => l.id)).toEqual(["slide-main", "slide-second"]);
      const [main, second] = comp(8) as [ResolvedLayer, ResolvedLayer];
      expect(second.transform.position[0]).toBeGreaterThan(main.transform.position[0]);
      const [mainLate, secondLate] = comp(120) as [ResolvedLayer, ResolvedLayer];
      expect(mainLate.transform.position[0]).toBe(secondLate.transform.position[0]);
      const color = (l: ResolvedLayer) => (l.type === "solid" ? l.color : null);
      expect(color(main)).not.toEqual(color(second));
    });
  });

  describe("options", () => {
    it("colors from the props, and restyles with the pack", () => {
      const l = layerById(run(ID, { color: "#ff0000" }, { frame: 74 }), "wipe");
      expect(l?.type === "solid" && l.color).toMatchObject({ r: 1, g: 0, b: 0 });
      const a = run(ID, {}, { pack: keynote, frame: 74 });
      const b = run(ID, {}, { pack: brutalist, frame: 74 });
      expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    });

    it("is deterministic", () => {
      for (const kind of KINDS) {
        const a = run(ID, { kind }, { frame: 31 });
        expect(run(ID, { kind }, { frame: 31 })).toEqual(a);
      }
    });

    it("rejects hostile props", () => {
      expect(() => run(ID, { count: 1 })).toThrow(/props\.count must be an integer from 2 to 24/);
      expect(() => run(ID, { count: 25 })).toThrow(/props\.count must be an integer from 2 to 24/);
      expect(() => run(ID, { count: 2.5 })).toThrow(/props\.count must be an integer from 2 to 24/);
      expect(() => run(ID, { hold: 121 })).toThrow(/props\.hold must be an integer from 0 to 120/);
      expect(() => run(ID, { hold: -1 })).toThrow(/props\.hold must be an integer from 0 to 120/);
      expect(() => run(ID, { kind: "fade" })).toThrow(/props\.kind must be one of: wipe,/);
      expect(() => run(ID, { direction: "diagonal" })).toThrow(/props\.direction must be one of/);
      expect(() => run(ID, { origin: [1, "x"] })).toThrow(/props\.origin/);
    });
  });
});
