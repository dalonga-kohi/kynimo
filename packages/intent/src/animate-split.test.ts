import type { Interpolation, PositionTrack, TransformProperty } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { expandTransformTrack, sample, type Value } from "./animate.js";
import { applied, doc, keyed, kf, layerOf, type Obj, solid } from "./fixtures.test-util.js";

const fps = { num: 30, den: 1 };
const linear: Interpolation = { type: "linear" };

const bez = (frame: number, value: unknown, x1: number, y1: number, x2: number, y2: number) => ({
  frame,
  value,
  interpolation: { type: "bezier", x1, y1, x2, y2 },
});

const withSpatial = (key: Obj, inTangent: number[], outTangent: number[]): Obj => ({
  ...key,
  spatial: { inTangent, outTangent },
});

/**
 * Runs the window over `trackSpec` with both ends taken from the old track, and returns samplers
 * for the track before and after.
 */
function run(
  property: TransformProperty,
  trackSpec: unknown,
  s: number,
  e: number,
  easing: Interpolation = linear,
  to: { value?: Value } = {},
) {
  const d = doc([solid("a", { transform: { [property]: trackSpec } })]);
  const layer = layerOf(d, "a");
  const op = expandTransformTrack(layer, property, {}, to, {
    start: s,
    frames: e - s,
    easing,
    fps,
    path: ["layers"],
    equalPath: ["to"],
  });
  const after = layerOf(applied(d, [op]), "a");
  const read = (l: typeof layer) =>
    (l as unknown as { transform: Record<string, PositionTrack> }).transform[
      property
    ] as PositionTrack;
  return {
    op,
    before: (f: number) => sample(property, read(layer), f, fps),
    after: (f: number) => sample(property, read(after), f, fps),
  };
}

const distance = (a: Value, b: Value): number =>
  typeof a === "number"
    ? Math.abs(a - (b as number))
    : Math.hypot(a[0] - (b as number[])[0]!, a[1] - (b as number[])[1]!);

/** Largest sampled difference between old and new on [from, to] (inclusive, every frame). */
function maxDrift(r: ReturnType<typeof run>, from: number, to: number): number {
  let worst = 0;
  for (let f = from; f <= to; f++) worst = Math.max(worst, distance(r.before(f), r.after(f)));
  return worst;
}

describe("animate keeps the motion outside its window", () => {
  const windows: [number, number][] = [
    [25, 35],
    [10, 50],
    [1, 59],
    [0, 20], // starts exactly on a key
    [40, 60], // ends exactly on a key
    [0, 60],
  ];

  it("changes nothing at any frame for a linear track and a linear window", () => {
    const track = keyed(kf(0, 0), kf(60, 100));
    for (const [s, e] of windows) {
      const r = run("rotation", track, s, e);
      expect(maxDrift(r, 0, 70)).toBeLessThan(1e-9);
    }
  });

  it("changes nothing at any frame for a keyed vector track", () => {
    const track = keyed(kf(0, [0, 0]), kf(30, [100, 40]), kf(60, [300, 400]));
    for (const [s, e] of [
      [10, 20],
      [0, 30],
      [35, 55],
      [30, 60],
    ] as [number, number][]) {
      const r = run("scale", track, s, e);
      expect(maxDrift(r, 0, 70)).toBeLessThan(1e-9);
    }
  });

  it.each([
    ["ease-in-out", 0.42, 0, 0.58, 1],
    ["ease-out", 0, 0, 0.58, 1],
    ["overshooting y", 0.3, -0.6, 0.6, 1.5],
    ["anticipation", 0.4, -1.5, 0.6, 1],
  ])(
    "keeps the motion before and after the window of a %s bezier segment",
    (_n, x1, y1, x2, y2) => {
      const track = keyed(bez(0, 0, x1, y1, x2, y2), kf(60, 100));
      for (const [s, e] of windows) {
        const r = run("rotation", track, s, e);
        expect(maxDrift(r, 0, s)).toBeLessThan(1e-6);
        expect(maxDrift(r, e, 70)).toBeLessThan(1e-6);
      }
    },
  );

  it("matches the old bezier everywhere when the window is linear-in-progress over a cut of it", () => {
    // A window whose own easing is the old curve's own cut would be exact; here we only demand the
    // sides, but a single-window identity holds for the sides at every frame including the keys.
    const track = keyed(bez(0, 0, 0.25, 0.1, 0.25, 1), bez(60, 100, 0.42, 0, 0.58, 1), kf(120, 0));
    const r = run("rotation", track, 45, 80);
    expect(maxDrift(r, 0, 45)).toBeLessThan(1e-6);
    expect(maxDrift(r, 80, 130)).toBeLessThan(1e-6);
  });

  it("refuses an edge where the overshoot crosses full progress, which no two curves can split", () => {
    const track = keyed(bez(0, 0, 0.2, 0, 0.7, 1.8), kf(60, 100));
    expect(() => run("rotation", track, 25, 35)).toThrow(
      expect.objectContaining({
        path: ["layers"],
        message: expect.stringContaining("can't be split into two curves"),
      }),
    );
  });

  it("keeps a hold segment held on both sides", () => {
    const track = keyed(kf(0, 0, "hold"), kf(60, 100));
    const ease: Interpolation = { type: "bezier", x1: 0.4, y1: 0, x2: 0.2, y2: 1 };
    const r = run("rotation", track, 25, 35, ease, { value: 50 });
    for (let f = 0; f <= 25; f++) expect(r.after(f)).toBe(0);
    // The end key is the explicit 50 and the cut hold keeps it until the next key.
    for (let f = 35; f <= 59; f++) expect(r.after(f)).toBe(50);
    expect(r.after(60)).toBe(100);
  });

  it("splits several segments when the window spans keys", () => {
    const track = keyed(
      bez(0, 0, 0.3, -0.4, 0.7, 1.4),
      kf(30, 50),
      bez(60, 80, 0.5, 0, 0.5, 1),
      kf(90, 0),
    );
    const r = run("rotation", track, 15, 75);
    expect(maxDrift(r, 0, 15)).toBeLessThan(1e-6);
    expect(maxDrift(r, 75, 100)).toBeLessThan(1e-6);
  });

  it("extends a constant look before the first key and after the last", () => {
    const track = keyed(kf(10, 0), kf(40, 90));
    const r = run("rotation", track, 45, 60, linear, { value: 30 });
    expect(maxDrift(r, 0, 45)).toBeLessThan(1e-9);
    const r2 = run("rotation", track, 0, 5, linear, { value: 20 });
    expect(maxDrift(r2, 10, 70)).toBeLessThan(1e-9);
  });

  describe("spatial position paths", () => {
    const arc = (interp: (f: number, v: number[]) => Obj) =>
      keyed(
        withSpatial(interp(0, [0, 0]), [0, 0], [0, -300]),
        withSpatial(kf(60, [600, 0]), [0, -300], [0, 0]),
      );

    it("reviewer's case: no bump before the window or after it", () => {
      const track = arc((f, v) => kf(f, v));
      const r = run("position", track, 25, 35);
      expect(maxDrift(r, 0, 25)).toBeLessThan(0.5);
      expect(maxDrift(r, 35, 60)).toBeLessThan(0.5);
      // Exactly on the window's own keys the new samples are the old samples.
      expect(distance(r.before(25), r.after(25))).toBeLessThan(1e-9);
      expect(distance(r.before(35), r.after(35))).toBeLessThan(1e-9);
    });

    it("follows the same path through eased bezier segments", () => {
      const track = arc((f, v) => bez(f, v, 0.42, 0, 0.58, 1));
      for (const [s, e] of windows) {
        const r = run("position", track, s, e);
        expect(maxDrift(r, 0, s)).toBeLessThan(0.5);
        expect(maxDrift(r, e, 70)).toBeLessThan(0.5);
      }
    });

    it("keeps a long curved path within a fraction of a pixel", () => {
      const track = keyed(
        withSpatial(bez(0, [0, 0], 0.3, 0.1, 0.2, 1), [0, 0], [800, -600]),
        withSpatial(kf(90, [1500, 200]), [-700, -500], [0, 0]),
      );
      const r = run("position", track, 30, 50);
      expect(maxDrift(r, 0, 30)).toBeLessThan(0.5);
      expect(maxDrift(r, 50, 100)).toBeLessThan(0.5);
    });

    it("splits the path across several keys", () => {
      const track = keyed(
        withSpatial(kf(0, [0, 0]), [0, 0], [0, -200]),
        withSpatial(kf(30, [300, 0]), [0, -200], [100, 100]),
        withSpatial(kf(60, [600, 100]), [-100, 100], [0, 0]),
      );
      const r = run("position", track, 15, 45);
      expect(maxDrift(r, 0, 15)).toBeLessThan(0.5);
      expect(maxDrift(r, 45, 70)).toBeLessThan(0.5);
    });

    it("refuses a cut where the easing overshoots the path", () => {
      const track = arc((f, v) => bez(f, v, 0.2, 0, 0.7, 2.2));
      expect(() => run("position", track, 40, 55)).toThrow(/overshoots the motion path/);
    });

    it("leaves a flat window edge flat: a track after its last key stays still", () => {
      const track = keyed(
        withSpatial(kf(0, [0, 0]), [0, 0], [0, -300]),
        withSpatial(kf(30, [300, 0]), [0, -300], [200, 200]),
      );
      const r = run("position", track, 40, 50, linear, { value: [900, 100] });
      expect(maxDrift(r, 0, 40)).toBeLessThan(1e-9);
    });
  });

  describe("springs", () => {
    const spring = {
      frame: 0,
      value: 0,
      interpolation: { type: "spring", damping: 1, response: 0.7 },
    };

    it("refuses a window that starts or ends before the spring has settled", () => {
      const track = keyed(spring, kf(200, 100));
      expect(() => run("rotation", track, 5, 40)).toThrow(
        expect.objectContaining({
          path: ["layers"],
          message: expect.stringMatching(
            /starts inside a spring segment at frame 0; start at or after its settle frame \d+, or switch it to a bezier/,
          ),
        }),
      );
      expect(() => run("rotation", keyed(spring, kf(200, 100)), -20, 10)).toThrow(
        /ends inside a spring segment/,
      );
    });

    it("accepts a window past the settle frame and leaves the settled motion intact", () => {
      const track = keyed(spring, kf(200, 100));
      const r = run("rotation", track, 100, 120, linear, { value: 40 });
      expect(maxDrift(r, 0, 100)).toBeLessThan(1e-9);
      // The settled value is 100; a cut right part runs from the window's end back to it.
      expect(r.after(200)).toBe(100);
    });
  });
});

describe("animate with explicit ends", () => {
  it("keeps the old shape up to an explicit start value and reaches it", () => {
    const d = doc([solid("a", { transform: { opacity: keyed(kf(0, 0), kf(60, 1)) } })]);
    const layer = layerOf(d, "a");
    const op = expandTransformTrack(
      layer,
      "opacity",
      { value: 0.8 },
      { value: 0.2 },
      { start: 30, frames: 10, easing: linear, fps, path: ["layers"], equalPath: ["to"] },
    );
    const out = layerOf(applied(d, [op]), "a") as unknown as {
      transform: { opacity: { keyframes: { frame: number; value: unknown }[] } };
    };
    const track = out.transform.opacity;
    expect(track.keyframes.map((k) => [k.frame, k.value])).toEqual([
      [0, 0],
      [30, 0.8],
      [40, 0.2],
      [60, 1],
    ]);
  });
});
