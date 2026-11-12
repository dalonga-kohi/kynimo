import { type ResolvedGenerator, resolveGenerator } from "@kynimo/engine";
import { brutalist, keynote, playfulSaas } from "@kynimo/guidelines";
import type { Effect, Generator } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import type { Obj } from "../fixtures.test-util.js";
import { createComponentStyle } from "../style.js";
import { background } from "./background.js";
import { framesOf, layerById, run } from "./run.test-util.js";

const ID = "background";
const KINDS = (background.props.kind as { values: string[] }).values;
const PATTERNS = ["stripes", "grid", "dots", "checker"];
const FPS = { num: 30, den: 1 };
const COLORS = { colorA: "#101010", colorB: "#ff8800", colorC: "#0088ff", colorD: "#88ff00" };

/** The output of the definition itself (with literal colors), so tracks can be read before sampling. */
function raw(
  props: Obj,
  { duration = 150, width = 1920, height = 1080, random = 0.25 } = {},
): { effects: Effect[]; generators: Generator[] } {
  const defaults = Object.fromEntries(
    Object.entries(background.props).map(([k, d]) => [k, d.default]),
  );
  const ctx = {
    width,
    height,
    fps: FPS,
    durationFrames: duration,
    frame: 0,
    seed: 1,
    depth: 0,
    random: () => random,
    style: createComponentStyle(keynote, { width, height }, FPS),
    assetSize: () => null,
  };
  const out = background.evaluate({ ...defaults, ...COLORS, ...props } as never, ctx as never);
  return {
    effects: (out.layers[0] as { effects: Effect[] }).effects,
    generators: out.layers.map((l) => (l.type === "generator" ? l.generator : (null as never))),
  };
}
/** Generator `index` (top first) resolved at a frame of a `duration`-frame instance. */
const resolved = (props: Obj, frame: number, o: { duration?: number; index?: number } = {}) => {
  const { generators } = raw(props, { duration: o.duration ?? 150 });
  return resolveGenerator(generators[o.index ?? 0] as Generator, frame, FPS, 1920, 1080);
};
const generator = (props: Obj, o = {}) => {
  const l = layerById(run(ID, props, { frame: 10, ...o }), "background");
  if (l?.type !== "generator") throw new Error("no generator layer");
  return l.generator;
};
const angleOf = (a: readonly [number, number], b: readonly [number, number]) =>
  ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 720) % 360;
const close = (a: number, b: number, mod = 360) => {
  const d = (((a - b) % mod) + mod) % mod;
  return Math.min(d, mod - d);
};

describe("background", () => {
  it("has the ten documented kinds", () => {
    expect(KINDS).toEqual([
      "aurora",
      "gradient",
      "radial",
      "conic",
      "noise",
      "stripes",
      "grid",
      "dots",
      "checker",
      "mesh",
    ]);
  });

  for (const kind of KINDS)
    for (const duration of [1, 10, 150])
      for (const [width, height] of [
        [1920, 1080],
        [1080, 1920],
      ] as const)
        it(`evaluates '${kind}' over ${duration} frames at ${width}x${height}`, () => {
          for (const frame of framesOf(duration)) {
            const comp = run(
              ID,
              { kind, useFourth: true, scanlines: true },
              { frame, duration, width, height },
            );
            expect(comp.layers).toHaveLength(kind === "mesh" ? 2 : 1);
            for (const l of comp.layers) {
              expect(l.type).toBe("generator");
              if (l.type === "generator") expect([l.width, l.height]).toEqual([width, height]);
            }
            expect(comp.background).toBeNull();
          }
        });

  it("draws the generator each kind names", () => {
    const g = (kind: string) => generator({ kind });
    expect(g("aurora").type).toBe("aurora");
    expect(g("gradient")).toMatchObject({ type: "gradient", kind: "linear" });
    expect(g("radial")).toMatchObject({ type: "gradient", kind: "radial" });
    expect(g("conic")).toMatchObject({ type: "gradient", kind: "conic" });
    expect(g("noise")).toMatchObject({ type: "noise", octaves: 4 });
    for (const kind of PATTERNS) expect(g(kind)).toMatchObject({ type: "pattern", kind });
    const comp = run(ID, { kind: "mesh" }, { frame: 10 });
    const [overlay, base] = comp.layers;
    expect(base?.type === "generator" && base.generator.type).toBe("aurora");
    expect(overlay?.type === "generator" && overlay.generator.type).toBe("noise");
    expect(overlay?.blendMode).toBe("overlay");
    expect(overlay?.transform.opacity).toBe(0.4);
    expect(base?.transform.opacity).toBe(1);
  });

  it("works with no props: an aurora in the pack's colors with a vignette and grain", () => {
    const l = layerById(run(ID, {}, { frame: 10 }), "background");
    expect(l?.type === "generator" && l.generator.type).toBe("aurora");
    expect(l?.effects.map((e) => e.type)).toEqual(["vignette", "grain"]);
    const g = l?.type === "generator" ? l.generator : null;
    expect(g?.type === "aurora" && g.colors).toHaveLength(3);
  });

  it("uses a fourth color only when asked, in every multi-color kind", () => {
    const count = (kind: string, useFourth: boolean) => {
      const g = generator({ kind, useFourth });
      return g.type === "aurora" ? g.colors.length : g.type === "gradient" ? g.stops.length : 0;
    };
    expect(count("aurora", false)).toBe(3);
    expect(count("aurora", true)).toBe(4);
    expect(count("gradient", false)).toBe(3);
    expect(count("gradient", true)).toBe(4);
    expect(count("radial", true)).toBe(4);
    // The conic's last stop repeats the first, so its seam is invisible.
    expect(count("conic", false)).toBe(4);
    const stops = (generator({ kind: "conic" }) as Extract<ResolvedGenerator, { type: "gradient" }>)
      .stops;
    expect(stops.at(-1)?.color).toEqual(stops[0]?.color);
    expect(stops.at(-1)?.offset).toBe(1);
    const mesh = run(ID, { kind: "mesh", useFourth: true }, { frame: 10 }).layers[1];
    expect(
      mesh?.type === "generator" && mesh.generator.type === "aurora" && mesh.generator.colors,
    ).toHaveLength(4);
  });

  it("restyles with the pinned pack and scales with the composition", () => {
    const a = run(ID, { kind: "noise" }, { pack: keynote, frame: 10 });
    const b = run(ID, { kind: "noise" }, { pack: playfulSaas, frame: 10 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    const c = run(ID, { kind: "gradient" }, { pack: brutalist, frame: 10 });
    expect(JSON.stringify(c)).not.toBe(
      JSON.stringify(run(ID, { kind: "gradient" }, { pack: keynote, frame: 10 })),
    );
    const noise = (width: number, height: number, detail = "base") =>
      generator({ kind: "noise", detail }, { width, height }) as Extract<
        ResolvedGenerator,
        { type: "noise" }
      >;
    expect(noise(1920, 1080).scale).toBe(192);
    expect(noise(960, 540).scale).toBe(96);
    expect(noise(3840, 2160).scale).toBe(384);
  });

  it("sets the noise and pattern coarseness from detail", () => {
    const noise = (detail: string) =>
      (generator({ kind: "noise", detail }) as Extract<ResolvedGenerator, { type: "noise" }>).scale;
    expect([noise("fine"), noise("base"), noise("coarse")]).toEqual([64, 192, 512]);
    for (const kind of PATTERNS) {
      const size = (detail: string) =>
        (generator({ kind, detail }) as Extract<ResolvedGenerator, { type: "pattern" }>).size;
      expect([size("fine"), size("base"), size("coarse")]).toEqual([24, 48, 96]);
    }
  });

  it("colors patterns with colorB on colorA, thin or half", () => {
    const thick = (kind: string) =>
      (generator({ kind }) as Extract<ResolvedGenerator, { type: "pattern" }>).thickness;
    expect([thick("stripes"), thick("grid"), thick("checker"), thick("dots")]).toEqual([
      0.18, 0.18, 0.5, 0.5,
    ]);
    const g = generator({ kind: "grid", angle: -45 }) as Extract<
      ResolvedGenerator,
      { type: "pattern" }
    >;
    expect(g.rotation[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(g.rotation[1]).toBeCloseTo(-Math.SQRT1_2, 6);
    const hex = raw({ kind: "stripes" }).generators[0];
    expect(hex?.type === "pattern" && hex.foreground).toEqual({ value: "#ff8800" });
    expect(hex?.type === "pattern" && hex.background).toEqual({ value: "#101010" });
  });

  it("is deterministic", () => {
    for (const kind of KINDS) {
      const a = run(ID, { kind }, { frame: 21 });
      expect(run(ID, { kind }, { frame: 21 })).toEqual(a);
    }
  });

  describe("seeds", () => {
    const seedOf = (props: Obj, id: string) => {
      const g = generator({ kind: "noise", ...props }, { id });
      return g.type === "noise" ? g.seed : -1;
    };
    it("differ per instance and stay the same for one", () => {
      expect(seedOf({}, "a")).toBe(seedOf({}, "a"));
      expect(new Set(["a", "b", "c", "d"].map((id) => seedOf({}, id))).size).toBeGreaterThan(1);
    });
    it("move with the seed prop", () => {
      expect(seedOf({ seed: 5 }, "a")).toBe((seedOf({ seed: 0 }, "a") + 5) % 2 ** 31);
      expect(seedOf({ seed: 1_000_000 }, "a")).toBeLessThan(2 ** 31);
    });
    it("give the mesh overlay its own seed and the grain the aurora's", () => {
      const comp = run(ID, { kind: "mesh" }, { frame: 10 });
      const [overlay, base] = comp.layers;
      const seed = (l: typeof base) =>
        l?.type === "generator" && "seed" in l.generator ? l.generator.seed : -1;
      expect(seed(overlay)).not.toBe(seed(base));
      const { effects } = raw({ kind: "aurora" }, { random: 0.5 });
      const grain = effects.find((e) => e.type === "grain");
      expect(grain?.type === "grain" && grain.seed).toBe(2 ** 30);
    });
  });

  describe("looks", () => {
    const effects = (props: Obj) =>
      layerById(run(ID, props, { frame: 10 }), "background")?.effects ?? [];
    it("adds vignette, grain and scanlines on request", () => {
      const all = effects({ vignette: true, grain: true, scanlines: true });
      expect(all.map((e) => e.type)).toEqual(["vignette", "grain", "scanlines"]);
      expect(all[0]).toMatchObject({ amount: 0.35 });
      expect(all[1]).toMatchObject({ amount: 0.06, monochrome: true });
      const grain = raw({ grain: true }).effects.find((e) => e.type === "grain");
      expect(grain).toMatchObject({ animated: true, monochrome: true });
      expect(all[2]).toMatchObject({ amount: 0.12 });
      expect(effects({ vignette: false, grain: false })).toEqual([]);
      expect(
        effects({ vignette: false, grain: false, scanlines: true }).map((e) => e.type),
      ).toEqual(["scanlines"]);
    });
    it("scales grain and scanlines with the composition", () => {
      const at = (width: number, height: number) =>
        layerById(run(ID, { scanlines: true }, { frame: 10, width, height }), "background")
          ?.effects ?? [];
      const big = at(3840, 2160);
      expect(big.find((e) => e.type === "grain")).toMatchObject({ size: 2 });
      expect(big.find((e) => e.type === "scanlines")).toMatchObject({ spacing: 8 });
      expect(at(1920, 1080).find((e) => e.type === "scanlines")).toMatchObject({ spacing: 4 });
    });
    it("puts the looks on the top layer", () => {
      const comp = run(ID, { kind: "mesh" }, { frame: 10 });
      expect(comp.layers[0]?.effects.map((e) => e.type)).toEqual(["vignette", "grain"]);
      expect(comp.layers[1]?.effects).toEqual([]);
    });
  });

  describe("motion", () => {
    const duration = 150;
    it("loops aurora and mesh exactly: a whole number of evolution units", () => {
      for (const loops of [1, 2, 3]) {
        for (const kind of ["aurora", "mesh"]) {
          const props = { kind, loops };
          const a = resolved(props, 0, { index: kind === "mesh" ? 1 : 0 });
          const b = resolved(props, duration, { index: kind === "mesh" ? 1 : 0 });
          if (a.type !== "aurora" || b.type !== "aurora") throw new Error("expected aurora");
          a.points.forEach((p, i) => {
            expect(b.points[i]?.[0]).toBeCloseTo(p[0], 6);
            expect(b.points[i]?.[1]).toBeCloseTo(p[1], 6);
          });
          // And it moves in between.
          const mid = resolved(props, 40, { index: kind === "mesh" ? 1 : 0 });
          expect(mid.type === "aurora" && mid.points[0]).not.toEqual(a.points[0]);
        }
      }
      const evolution = raw({ kind: "aurora", loops: 3 }).generators[0];
      expect(evolution?.type === "aurora" && evolution.evolution).toEqual({
        keyframes: [
          { frame: 0, value: 0, interpolation: { type: "linear" } },
          { frame: duration, value: 3, interpolation: { type: "linear" } },
        ],
      });
    });

    it("loops the mesh's noise overlay in lockstep", () => {
      const overlay = raw({ kind: "mesh", loops: 2 }).generators[0];
      expect(overlay?.type === "noise" && overlay.evolution).toMatchObject({
        keyframes: [
          { frame: 0, value: 0 },
          { frame: duration, value: 2 },
        ],
      });
    });

    it("moves patterns by whole periods per loop, so they land where they began", () => {
      for (const kind of PATTERNS)
        for (const [angle, loops] of [
          [30, 1],
          [-90, 2],
          [200, 3],
          [0, 1],
        ] as const) {
          const a = resolved({ kind, angle, loops }, 0);
          const b = resolved({ kind, angle, loops }, duration);
          if (a.type !== "pattern" || b.type !== "pattern") throw new Error("expected pattern");
          const period = kind === "checker" ? 2 * a.size : a.size;
          const [ox, oy] = b.offset;
          const along = ox * b.rotation[0] + oy * b.rotation[1];
          const across = -ox * b.rotation[1] + oy * b.rotation[0];
          expect(a.offset).toEqual([0, 0]);
          expect(along).toBeCloseTo(loops * period, 2);
          expect(across).toBeCloseTo(0, 2);
        }
    });

    it("turns the gradient once per loop about the center, corner to corner at every angle", () => {
      for (const loops of [1, 2.5]) {
        for (const f of [0, 20, 40, 100, 149]) {
          const g = resolved({ kind: "gradient", loops, angle: 30 }, f);
          if (g.type !== "gradient") throw new Error("expected gradient");
          const expected = 30 + 360 * loops * (f / duration);
          expect(close(angleOf(g.start, g.end), expected)).toBeLessThan(0.5);
          // Centered, and long enough to reach the frame's edge at that angle.
          expect((g.start[0] + g.end[0]) / 2).toBeCloseTo(960, 2);
          expect((g.start[1] + g.end[1]) / 2).toBeCloseTo(540, 2);
          const a = (expected * Math.PI) / 180;
          const length = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]);
          expect(length).toBeCloseTo(
            Math.abs(1920 * Math.cos(a)) + Math.abs(1080 * Math.sin(a)),
            0,
          );
        }
        // Frame `duration` is a whole number of turns from frame 0 (loops 1: exactly the same).
      }
      const a = resolved({ kind: "gradient", loops: 1 }, 0);
      const b = resolved({ kind: "gradient", loops: 1 }, 149);
      if (a.type !== "gradient" || b.type !== "gradient") throw new Error("expected gradient");
      // One frame before the end it is one frame's turn short of the start.
      expect(close(angleOf(b.start, b.end), angleOf(a.start, a.end))).toBeCloseTo(
        360 / duration,
        0,
      );
    });

    it("samples more often when the turn is quick", () => {
      const start = raw({ kind: "gradient", loops: 8 }).generators[0];
      const frames =
        start?.type === "gradient" && "keyframes" in start.start ? start.start.keyframes : [];
      // Sixteen samples a turn, as far as the frames allow (two frames apart at 150 frames).
      expect(frames[1]?.frame).toBe(2);
      expect(frames.at(-1)?.frame).toBe(duration - 1);
      expect(frames.length).toBeLessThanOrEqual(513);
      for (let i = 1; i < frames.length; i++)
        expect(frames[i]?.frame).toBeGreaterThan(frames[i - 1]?.frame as number);
      const slow = raw({ kind: "gradient", loops: 1 }).generators[0];
      const slowFrames =
        slow?.type === "gradient" && "keyframes" in slow.start ? slow.start.keyframes : [];
      expect(slowFrames[1]?.frame).toBe(Math.ceil(duration / 32));
      expect(slowFrames.at(-1)?.frame).toBe(duration - 1);
    });

    it("breathes the radial by 8% once per loop around its origin", () => {
      const r = (f: number, origin = [0, 0]) => {
        const g = resolved({ kind: "radial", origin }, f);
        if (g.type !== "gradient") throw new Error("expected gradient");
        return { start: g.start, radius: Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]) };
      };
      const base = r(0).radius;
      expect(base).toBeCloseTo(Math.hypot(960, 540), 2);
      // 150 / 4 is not a keyframe; the quarter point lies between the keyframes at 35 and 40.
      expect(r(40).radius).toBeGreaterThan(base * 1.06);
      expect(r(40).radius).toBeLessThanOrEqual(base * 1.08 + 1e-6);
      expect(r(115).radius).toBeLessThan(base * 0.94);
      expect(Math.abs(r(149).radius / base - 1)).toBeLessThan(0.01);
      expect(r(0, [300, -200]).start).toEqual([1260, 340]);
      expect(r(0, [300, -200]).radius).toBeCloseTo(Math.hypot(960 + 300, 540 + 200), 2);
    });

    it("turns the conic's start with the same rate and keeps its center on the origin", () => {
      const g = resolved({ kind: "conic", loops: 1, angle: 90, origin: [100, 0] }, 45);
      if (g.type !== "gradient") throw new Error("expected gradient");
      expect(g.start).toEqual([1060, 540]);
      expect(close(angleOf(g.start, g.end), 90 + 360 * (45 / duration))).toBeLessThan(0.5);
    });

    it("holds everything still with zero loops", () => {
      for (const kind of KINDS) {
        const props = { kind, loops: 0 };
        const { generators } = raw(props);
        for (const [index] of generators.entries()) {
          const first = resolved(props, 0, { index });
          for (const f of [37, 75, 149]) expect(resolved(props, f, { index })).toEqual(first);
        }
      }
      const g = raw({ kind: "aurora", loops: 0 }).generators[0];
      expect(g?.type === "aurora" && g.evolution).toEqual({ value: 0 });
      const p = raw({ kind: "dots", loops: 0 }).generators[0];
      expect(p?.type === "pattern" && p.offset).toEqual({ value: [0, 0] });
    });

    it("lets noise drift by `loops` cells over the span", () => {
      const e = (f: number) => {
        const g = resolved({ kind: "noise", loops: 2 }, f);
        return g.type === "noise" ? g.evolution : -1;
      };
      expect(e(0)).toBe(0);
      expect(e(75)).toBeCloseTo(1, 6);
    });

    it("rotates the pattern's offset direction with its angle", () => {
      const o = resolved({ kind: "stripes", angle: 90, loops: 1 }, 75);
      if (o.type !== "pattern") throw new Error("expected pattern");
      expect(o.offset[0]).toBeCloseTo(0, 3);
      expect(o.offset[1]).toBeCloseTo(24, 0);
    });
  });

  describe("size and cost", () => {
    const cost = (comp: ReturnType<typeof run>) =>
      comp.layers.reduce((sum, l) => {
        if (l.type !== "generator") return sum;
        const g = l.generator;
        const perPixel =
          g.type === "aurora" ? g.colors.length : g.type === "noise" ? 8 * g.octaves : 1;
        // Vignette, grain and scanlines are one sample each.
        return sum + l.width * l.height * (perPixel + l.effects.length);
      }, 0);

    it("evaluates every kind at 4K within the frame's sample budget", () => {
      for (const kind of KINDS) {
        const comp = run(
          ID,
          { kind, useFourth: true, scanlines: true },
          { frame: 75, width: 3840, height: 2160 },
        );
        expect(cost(comp), kind).toBeLessThan(500_000_000);
        for (const l of comp.layers)
          expect([l.type === "generator" && l.width, l.type === "generator" && l.height]).toEqual([
            3840, 2160,
          ]);
      }
    });

    it("validates at tiny and huge compositions", () => {
      for (const kind of KINDS)
        for (const [width, height] of [
          [64, 36],
          [16, 16],
          [8192, 8192],
          [8192, 4320],
        ] as const) {
          const comp = run(
            ID,
            { kind, loops: 8, detail: "coarse", scanlines: true },
            { frame: 5, width, height },
          );
          expect(comp.layers.length).toBeGreaterThan(0);
        }
    });

    it("keeps pattern motion inside the scene's offset limit by shortening the slide", () => {
      const big = raw(
        { kind: "checker", loops: 8, detail: "coarse", angle: 0 },
        { width: 8192, height: 8192 },
      ).generators[0];
      if (big?.type !== "pattern" || !("keyframes" in big.offset))
        throw new Error("expected motion");
      const size = big.size as { value: number };
      const [x] = (big.offset.keyframes.at(-1) as { value: [number, number] }).value;
      // 96 px at the reference height, scaled to 8192: a checker period is two cells.
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThanOrEqual(8192);
      const cells = x / (2 * size.value);
      expect(Math.abs(cells - Math.round(cells))).toBeLessThan(1e-3);
      expect(x).toBeLessThan(8 * 2 * size.value);
    });
  });

  describe("errors", () => {
    it("rejects hostile props", () => {
      expect(() => run(ID, { loops: 9 })).toThrow(/props\.loops must be a number from 0 to 8/);
      expect(() => run(ID, { loops: -1 })).toThrow(/props\.loops must be a number from 0 to 8/);
      expect(() => run(ID, { angle: 400 })).toThrow(
        /props\.angle must be a number from -360 to 360/,
      );
      expect(() => run(ID, { seed: 1.5 })).toThrow(
        /props\.seed must be an integer from 0 to 1000000/,
      );
      expect(() => run(ID, { seed: 1_000_001 })).toThrow(
        /props\.seed must be an integer from 0 to 1000000/,
      );
      expect(() => run(ID, { kind: "plasma" })).toThrow(/props\.kind must be one of: aurora,/);
      expect(() => run(ID, { detail: "huge" })).toThrow(
        /props\.detail must be one of: fine, base, coarse/,
      );
      expect(() => run(ID, { origin: "center" })).toThrow(/props\.origin/);
      expect(() => run(ID, { vignette: "yes" })).toThrow(/props\.vignette/);
    });
  });
});
