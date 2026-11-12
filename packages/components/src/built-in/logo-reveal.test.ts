import type { ResolvedLayer, ResolvedMask } from "@kynimo/engine";
import { brutalist, keynote, playfulSaas } from "@kynimo/guidelines";
import { describe, expect, it } from "vitest";
import { imageAsset, kf, type Obj } from "../fixtures.test-util.js";
import { createComponentStyle } from "../style.js";
import { logoReveal } from "./logo-reveal.js";
import { framesOf, layerById, run, textById } from "./run.test-util.js";

const ID = "logo-reveal";
const VARIANTS = (logoReveal.props.variant as { values: string[] }).values;
const asset = (width: number, height: number): Obj => ({ ...imageAsset("logo"), width, height });

const bbox = (m: ResolvedMask) => {
  const xs = m.path.vertices.map((v) => v.point[0]);
  const ys = m.path.vertices.map((v) => v.point[1]);
  return {
    l: Math.min(...xs),
    r: Math.max(...xs),
    t: Math.min(...ys),
    b: Math.max(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
};
const mark = (props: Obj = {}, o = {}) => {
  const l = layerById(run(ID, props, o), "mark");
  if (l === undefined) throw new Error("no mark layer");
  return l;
};
const effect = (l: ResolvedLayer, type: string) => l.effects.find((e) => e.type === type);

/** Not visible yet: transparent, or (wipe, iris) masked down to nothing. */
const hiddenMark = (l: ResolvedLayer) =>
  l.transform.opacity === 0 ||
  l.transform.scale.some((s) => s === 0) ||
  l.masks.some((m) => bbox(m).w === 0 || bbox(m).h === 0);

describe("logo-reveal", () => {
  it("has the eight documented variants", () => {
    expect(VARIANTS).toEqual(["scale", "wipe", "blur", "iris", "rise", "flip", "glitch", "stamp"]);
  });

  for (const variant of VARIANTS)
    for (const duration of [1, 10, 150])
      for (const [width, height] of [
        [1920, 1080],
        [1080, 1920],
      ] as const)
        it(`evaluates '${variant}' over ${duration} frames at ${width}x${height}`, () => {
          for (const frame of framesOf(duration)) {
            const text = run(
              ID,
              { variant, tagline: "Motion for everyone", glow: true, exit: true },
              { frame, duration, width, height },
            );
            expect(text.width).toBe(width);
            expect(layerById(text, "mark")).toBeDefined();
            const image = run(
              ID,
              { variant, logo: "logo", tagline: "x", exit: true },
              { frame, duration, width, height, assets: [asset(300, 120)] },
            );
            expect(layerById(image, "mark")?.type).toBe("image");
          }
        });

  it("works with no props: the wordmark, centered, held to the end", () => {
    const comp = run(ID, {}, { frame: 149 });
    const t = textById(comp, "mark");
    expect(t.content).toBe("Kynimo");
    expect(t.align).toBe("center");
    expect(t.transform.opacity).toBe(1);
    expect(t.transform.scale).toEqual([1, 1]);
    expect(layerById(comp, "tagline")).toBeUndefined();
    expect(comp.background).toBeNull();
    // The anchor is the middle of the line, so the layer's position is the frame center.
    expect(t.transform.position).toEqual([960, 540]);
    expect(t.font.size).toBeCloseTo(0.28 * 1080 * 0.7, 3);
  });

  it("is deterministic", () => {
    for (const variant of VARIANTS) {
      const a = run(ID, { variant, tagline: "t" }, { frame: 9 });
      expect(run(ID, { variant, tagline: "t" }, { frame: 9 })).toEqual(a);
    }
  });

  it("seeds the glitch jitter from the instance id", () => {
    const x = (id: string) => mark({ variant: "glitch" }, { id, frame: 4 }).transform.position[0];
    expect(x("a")).toBe(x("a"));
    const xs = new Set(["a", "b", "c", "d"].map(x));
    expect(xs.size).toBeGreaterThan(1);
  });

  it("restyles with the pinned pack", () => {
    const a = run(ID, { tagline: "hi", useBackdrop: true }, { pack: keynote, frame: 100 });
    const b = run(ID, { tagline: "hi", useBackdrop: true }, { pack: playfulSaas, frame: 100 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(textById(a, "mark").fill).not.toEqual(textById(b, "mark").fill);
    expect(textById(a, "mark").font.weight).not.toBe(textById(b, "mark").font.weight);
    expect(textById(a, "tagline").font.size).toBe(keynote.type.body.size);
    expect(layerById(a, "backdrop")?.type === "solid" && layerById(a, "backdrop")).not.toEqual(
      layerById(b, "backdrop"),
    );
    const c = run(ID, { glow: true }, { pack: brutalist, frame: 100 });
    expect(layerById(c, "mark")?.effects[0]).toMatchObject({ type: "glow" });
  });

  describe("timing", () => {
    for (const variant of VARIANTS)
      it(`'${variant}' starts hidden and holds fully shown`, () => {
        const first = run(ID, { variant, tagline: "t" }, { frame: 0 });
        for (const l of first.layers) expect(l.transform.opacity === 0 || hiddenMark(l)).toBe(true);

        const hold = run(ID, { variant, tagline: "t" }, { frame: 75 });
        const m = layerById(hold, "mark") as ResolvedLayer;
        expect(m.transform.opacity).toBe(1);
        expect(m.transform.scale).toEqual([1, 1]);
        expect(m.transform.position).toEqual([960, 540]);
        expect(layerById(hold, "tagline")?.transform.opacity).toBe(1);
        for (const mask of m.masks) {
          const box = bbox(mask);
          expect(box.w).toBeGreaterThan(0);
          expect(box.h).toBeGreaterThan(0);
        }

        // Held to the end by default.
        const last = layerById(run(ID, { variant, tagline: "t" }, { frame: 149 }), "mark");
        expect(last?.transform.opacity).toBe(1);
        expect(last?.transform.scale).toEqual([1, 1]);
      });

    for (const variant of VARIANTS)
      it(`'${variant}' fades and shrinks on the exit`, () => {
        const last = run(ID, { variant, tagline: "t", exit: true }, { frame: 149 });
        for (const l of last.layers) {
          expect(l.transform.opacity).toBe(0);
          if (l.id !== "ring") expect(l.transform.scale[0]).toBeCloseTo(0.94, 3);
        }
        const before = run(ID, { variant, tagline: "t", exit: true }, { frame: 75 });
        expect(layerById(before, "mark")?.transform.opacity).toBe(1);
      });

    it("takes longer with a slower speed", () => {
      const op = (speed: string, frame: number) =>
        mark({ variant: "scale", speed }, { frame }).transform.opacity;
      expect(op("fast", 10)).toBeGreaterThan(op("slow", 10));
      expect(op("fast", 75)).toBe(1);
    });

    it("shows the end state for a one-frame instance", () => {
      for (const variant of VARIANTS) {
        const comp = run(ID, { variant, tagline: "t" }, { frame: 0, duration: 1 });
        const m = layerById(comp, "mark") as ResolvedLayer;
        expect(m.transform.opacity).toBe(1);
        expect(m.transform.scale).toEqual([1, 1]);
        expect(layerById(comp, "ring")).toBeUndefined();
      }
    });

    it("brings the tagline in a beat after the mark, rising into place", () => {
      const at = (frame: number) => layerById(run(ID, { tagline: "later" }, { frame }), "tagline");
      expect(at(0)?.transform.opacity).toBe(0);
      const early = at(5);
      const rest = at(75);
      expect(early?.transform.opacity).toBeGreaterThan(0);
      expect(early?.transform.opacity).toBeLessThan(1);
      expect(
        (early?.transform.position[1] as number) - (rest?.transform.position[1] as number),
      ).toBeGreaterThan(0);
      expect(
        (early?.transform.position[1] as number) - (rest?.transform.position[1] as number),
      ).toBeLessThanOrEqual(keynote.motion.distance.small + 1e-6);
      // A beat behind the mark: the stagger delays its start.
      expect(at(3)?.transform.opacity).toBe(0);
      expect(mark({}, { frame: 3 }).transform.opacity).toBeGreaterThan(0);
    });
  });

  describe("variants", () => {
    it("scale: grows from 0.6 with the gentle spring", () => {
      expect(mark({ variant: "scale" }, { frame: 0 }).transform.scale).toEqual([0.6, 0.6]);
      const mid = mark({ variant: "scale" }, { frame: 6 }).transform.scale[0];
      expect(mid).toBeGreaterThan(0.6);
    });

    it("wipe: the mask opens toward the direction", () => {
      const box = (direction: string, frame: number) =>
        bbox(mark({ variant: "wipe", direction }, { frame }).masks[0] as ResolvedMask);
      const full = box("right", 75);
      expect(box("right", 0).w).toBe(0);
      expect(box("right", 0).l).toBeCloseTo(full.l, 3);
      expect(box("left", 0).l).toBeCloseTo(full.r, 3);
      expect(box("down", 0).h).toBe(0);
      expect(box("down", 0).t).toBeCloseTo(full.t, 3);
      expect(box("up", 0).t).toBeCloseTo(full.b, 3);
      const part = box("right", 8);
      expect(part.w).toBeGreaterThan(0);
      expect(part.w).toBeLessThan(full.w);
      // The mask covers the whole estimated wordmark.
      expect(full.l).toBeLessThan(-0.65 * 6 * 0.28 * 1080 * 0.7 * 0.5);
      // Other variants ignore the direction.
      expect(run(ID, { variant: "scale", direction: "up" }, { frame: 5 })).toEqual(
        run(ID, { variant: "scale", direction: "left" }, { frame: 5 }),
      );
    });

    it("blur: starts blurred by 40 scaled px and clears", () => {
      const r = (frame: number) => {
        const e = effect(mark({ variant: "blur" }, { frame }), "gaussian-blur");
        return e?.type === "gaussian-blur" ? e.radius : -1;
      };
      expect(r(0)).toBeCloseTo(40, 3);
      expect(r(10)).toBeLessThan(40);
      expect(r(75)).toBe(0);
      // Scales with the composition, and never passes the scene's blur limit.
      const big = effect(
        mark({ variant: "blur" }, { frame: 0, width: 7680, height: 4320 }),
        "gaussian-blur",
      );
      expect(big?.type === "gaussian-blur" && big.radius).toBe(48);
    });

    it("iris: a circle grows from nothing to cover the mark's diagonal", () => {
      const at = (frame: number) =>
        bbox(mark({ variant: "iris" }, { frame }).masks[0] as ResolvedMask);
      expect(at(0).w).toBe(0);
      const full = at(75);
      expect(full.w).toBeCloseTo(full.h, 2);
      const fs = 0.28 * 1080 * 0.7;
      const half = (6 * 0.65 * fs) / 2;
      expect(full.w / 2).toBeGreaterThan(Math.hypot(half, fs / 2));
      expect(at(8).w).toBeLessThan(full.w);
    });

    it("rise: comes up out of a line that draws first, clipped at it", () => {
      const at = (frame: number) => run(ID, { variant: "rise" }, { frame });
      const line0 = layerById(at(0), "line") as ResolvedLayer;
      expect(line0.transform.scale[0]).toBe(0);
      const line = layerById(at(75), "line") as ResolvedLayer;
      expect(line.transform.scale).toEqual([1, 1]);
      const m75 = layerById(at(75), "mark") as ResolvedLayer;
      const early = layerById(at(7), "mark") as ResolvedLayer;
      // The mark starts low by the large distance and the clip edge keeps its place on screen.
      expect(early.transform.position[1] - m75.transform.position[1]).toBeGreaterThan(0);
      const screenEdge = (l: ResolvedLayer) =>
        l.transform.position[1] +
        (bbox(l.masks[0] as ResolvedMask).b - l.transform.anchorPoint[1]) * l.transform.scale[1];
      expect(screenEdge(early)).toBeCloseTo(screenEdge(m75), 2);
      // The line sits just under the clip edge.
      expect(line.transform.position[1]).toBeGreaterThan(screenEdge(m75) - 1);
      expect(line.transform.position[1]).toBeLessThan(screenEdge(m75) + keynote.layout.spacing.xs);
      expect(layerById(run(ID, { variant: "scale" }), "line")).toBeUndefined();
    });

    it("flip: turns in from nothing on x", () => {
      expect(mark({ variant: "flip" }, { frame: 0 }).transform.scale).toEqual([0, 1]);
      const mid = mark({ variant: "flip" }, { frame: 5 }).transform.scale;
      expect(mid[0]).toBeGreaterThan(0);
      expect(mid[1]).toBe(1);
    });

    it("glitch: aberration settles to nothing while the mark jitters within the small distance", () => {
      const ab = (frame: number) => {
        const e = effect(mark({ variant: "glitch" }, { frame }), "chromatic-aberration");
        return e?.type === "chromatic-aberration" ? e.amount : -1;
      };
      expect(ab(0)).toBeCloseTo(24, 3);
      expect(ab(10)).toBeLessThan(24);
      expect(ab(75)).toBe(0);
      const small = keynote.motion.distance.small;
      const xs = Array.from(
        { length: 20 },
        (_, f) => mark({ variant: "glitch" }, { frame: f }).transform.position[0],
      );
      for (const x of xs.slice(0, 20)) expect(Math.abs(x - 960)).toBeLessThanOrEqual(small + 1e-6);
      expect(mark({ variant: "glitch" }, { frame: 75 }).transform.position[0]).toBe(960);
      // Jumps: it holds for two frames at a time.
      expect(xs[0]).toBe(xs[1]);
      expect(new Set(xs).size).toBeGreaterThan(3);
      // Visible from frame 1.
      expect(mark({ variant: "glitch" }, { frame: 1 }).transform.opacity).toBe(1);
    });

    it("stamp: lands from 1.8 and sends a ring outward", () => {
      expect(mark({ variant: "stamp" }, { frame: 0 }).transform.scale).toEqual([1.8, 1.8]);
      const ring = (frame: number) =>
        layerById(run(ID, { variant: "stamp" }, { frame }), "ring") as ResolvedLayer;
      expect(ring(0).transform.opacity).toBe(0);
      const mid = ring(14);
      expect(mid.transform.opacity).toBeGreaterThan(0);
      expect(mid.transform.scale[0]).toBeGreaterThan(1);
      expect(mid.transform.scale[0]).toBeLessThan(1.6);
      expect(ring(60).transform.opacity).toBe(0);
      const shape = ring(14);
      expect(shape.type === "shape" && shape.contents.some((i) => i.type === "stroke")).toBe(true);
    });

    it("accent colors the ring and the line", () => {
      const ring = layerById(
        run(ID, { variant: "stamp", accent: "#ff0000" }, { frame: 14 }),
        "ring",
      );
      const stroke = ring?.type === "shape" ? ring.contents.find((i) => i.type === "stroke") : null;
      expect(stroke?.type === "stroke" && stroke.paint).toMatchObject({
        type: "solid",
        color: { r: 1, g: 0, b: 0 },
      });
    });

    it("glow adds a glow in the accent color", () => {
      expect(mark({}, { frame: 75 }).effects).toEqual([]);
      const e = effect(mark({ glow: true, accent: "#00ff00" }, { frame: 75 }), "glow");
      expect(e).toMatchObject({ type: "glow", color: { r: 0, g: 1, b: 0 } });
      // The pack's large spacing, capped at the scene's effect limit of 48.
      expect(e?.type === "glow" && e.radius).toBe(48);
      const small = layerById(
        run(ID, { glow: true }, { frame: 75, width: 960, height: 540 }),
        "mark",
      );
      expect(effect(small as ResolvedLayer, "glow")).toMatchObject({
        radius: keynote.layout.spacing.l / 2,
      });
    });
  });

  describe("layout", () => {
    it("fits an image by height, centered on its middle", () => {
      for (const [w, h] of [
        [400, 100],
        [100, 400],
        [250, 250],
      ] as const) {
        const m = mark({ logo: "logo" }, { frame: 75, assets: [asset(w, h)] });
        const f = (0.28 * 1080) / h;
        expect(m.type).toBe("image");
        expect(m.transform.scale[0]).toBeCloseTo(Math.min(f, (0.8 * 1920) / w), 3);
        expect(m.transform.anchorPoint).toEqual([w / 2, h / 2]);
        expect(m.transform.position).toEqual([960, 540]);
        expect(m.transform.scale[0] * h).toBeLessThanOrEqual(0.28 * 1080 + 0.1);
      }
      // 400x100 at height 302.4 is 1209.6 wide: not clamped.
      expect(
        mark({ logo: "logo" }, { frame: 75, assets: [asset(400, 100)] }).transform.scale[0],
      ).toBeCloseTo(3.024, 3);
    });

    it("never lets an image pass 80% of the width", () => {
      const wide = mark({ logo: "logo", size: 0.5 }, { frame: 75, assets: [asset(2000, 100)] });
      expect(wide.transform.scale[0] * 2000).toBeCloseTo(0.8 * 1920, 3);
      const portrait = mark(
        { logo: "logo" },
        { frame: 75, width: 1080, height: 1920, assets: [asset(400, 100)] },
      );
      expect(portrait.transform.scale[0] * 400).toBeLessThanOrEqual(0.8 * 1080 + 1e-3);
      expect(portrait.transform.scale[0] * 400).toBeCloseTo(0.8 * 1080, 3);
    });

    it("sizes the wordmark from the size fraction and keeps a long one inside 80% of the width", () => {
      const fs = (props: Obj, o = {}) =>
        textById(run(ID, props, { frame: 75, ...o }), "mark").font.size;
      expect(fs({ size: 0.5 })).toBeCloseTo(0.5 * 1080 * 0.7, 3);
      expect(fs({ size: 0.9, wordmark: "W".repeat(60) })).toBeLessThan(0.9 * 1080 * 0.7);
      const em = 0.65 + keynote.type.display.tracking / 1000;
      expect(fs({ size: 0.9, wordmark: "W".repeat(60) }) * 60 * em).toBeLessThanOrEqual(
        0.8 * 1920 + 1,
      );
    });

    it("moves with position and animates size and position", () => {
      const m = mark(
        { position: [100, -50], logo: "logo" },
        { frame: 75, assets: [asset(100, 100)] },
      );
      expect(m.transform.position).toEqual([1060, 490]);
      const grow = { keyframes: [kf(0, 0.1), kf(100, 0.5)] };
      const a = mark({ logo: "logo", size: grow }, { frame: 20, assets: [asset(100, 100)] });
      const b = mark({ logo: "logo", size: grow }, { frame: 80, assets: [asset(100, 100)] });
      expect(b.transform.scale[0]).toBeGreaterThan(a.transform.scale[0]);
    });

    it("places the tagline under the mark, inside the frame width", () => {
      const comp = run(ID, { tagline: "Below" }, { frame: 75 });
      const t = textById(comp, "tagline");
      expect(t.box.mode).toBe("box");
      expect(t.align).toBe("center");
      expect(t.transform.position[1]).toBeGreaterThan(540);
      expect(t.font.size).toBe(keynote.type.body.size);
    });

    it("fills the frame with the backdrop only when asked", () => {
      expect(run(ID, {}).background).toBeNull();
      expect(layerById(run(ID, {}), "backdrop")).toBeUndefined();
      const backdrop = layerById(run(ID, { useBackdrop: true, backdrop: "#ff0000" }), "backdrop");
      expect(backdrop).toMatchObject({ type: "solid", width: 1920, height: 1080 });
      expect(backdrop?.type === "solid" && backdrop.color).toMatchObject({ r: 1, g: 0, b: 0 });
      // The bottom of the stack, and it stays while the mark leaves.
      const comp = run(ID, { useBackdrop: true, exit: true }, { frame: 149 });
      expect(comp.layers.at(-1)?.id).toBe("backdrop");
      expect(comp.layers.at(-1)?.transform.opacity).toBe(1);
    });
  });

  describe("errors", () => {
    it("names an asset that has no known size", () => {
      const style = createComponentStyle(
        keynote,
        { width: 1920, height: 1080 },
        { num: 30, den: 1 },
      );
      const ctx = {
        width: 1920,
        height: 1080,
        fps: { num: 30, den: 1 },
        durationFrames: 30,
        frame: 0,
        seed: 1,
        random: () => 0.5,
        style,
        assetSize: () => null,
      };
      const props = Object.fromEntries(
        Object.entries(logoReveal.props).map(([k, d]) => [k, d.default]),
      );
      expect(() => logoReveal.evaluate({ ...props, logo: "missing" }, ctx as never)).toThrow(
        /logo asset 'missing' has no known pixel size/,
      );
    });

    it("rejects an unknown asset and a non-image asset", () => {
      expect(() => run(ID, { logo: "nope" })).toThrow(/props\.logo refers to unknown asset 'nope'/);
    });

    it("rejects hostile props", () => {
      expect(() => run(ID, { size: 2 })).toThrow(/props\.size must be a number from 0\.05 to 0\.9/);
      expect(() => run(ID, { variant: "spin" })).toThrow(/props\.variant must be one of: scale,/);
      expect(() => run(ID, { direction: "diagonal" })).toThrow(/props\.direction must be one of/);
      expect(() => run(ID, { wordmark: "x".repeat(61) })).toThrow(
        /props\.wordmark must be a string of at most 60 characters \(got 61\)/,
      );
      expect(() => run(ID, { tagline: "x".repeat(121) })).toThrow(
        /props\.tagline must be a string of at most 120 characters \(got 121\)/,
      );
    });
  });
});
