import type { ResolvedLayer } from "@kynimo/engine";
import { keynote, playfulSaas } from "@kynimo/guidelines";
import { describe, expect, it } from "vitest";
import { lowerThird } from "./lower-third.js";
import { framesOf, layerById, run, textById } from "./run.test-util.js";

const ID = "lower-third";
const VARIANTS = (lowerThird.props.variant as { values: string[] }).values;
const CORNERS = ["bottom-left", "bottom-right", "top-left", "top-right"];

/** Not visible yet: transparent, scaled to nothing on an axis, or a trim that has drawn nothing. */
const hidden = (l: ResolvedLayer) =>
  l.transform.opacity === 0 ||
  l.transform.scale.some((s) => s === 0) ||
  (l.type === "shape" && l.contents.some((i) => i.type === "trim" && i.end === 0));

const shown = (l: ResolvedLayer) =>
  l.transform.opacity === 1 &&
  l.transform.scale[0] === 1 &&
  l.transform.scale[1] === 1 &&
  (l.type !== "shape" || l.contents.every((i) => i.type !== "trim" || i.end === 1));

describe("lower-third", () => {
  it("has the six documented variants", () => {
    expect(VARIANTS).toEqual(["bar", "plate", "underline", "split", "minimal", "outline"]);
  });

  for (const variant of VARIANTS)
    for (const corner of CORNERS)
      for (const duration of [1, 10, 150])
        for (const [width, height] of [
          [1920, 1080],
          [1080, 1920],
        ] as const)
          it(`evaluates '${variant}' in ${corner} over ${duration} frames at ${width}x${height}`, () => {
            for (const frame of framesOf(duration)) {
              const comp = run(ID, { variant, corner }, { frame, duration, width, height });
              expect(comp.layers.length).toBeGreaterThanOrEqual(3);
            }
          });

  it("works with no props", () => {
    const comp = run(ID, {});
    expect(textById(comp, "title").content).toBe("Alex Rivera");
    expect(textById(comp, "subtitle").content).toBe("Director of Motion");
  });

  it("is deterministic", () => {
    for (const variant of VARIANTS) {
      const a = run(ID, { variant }, { frame: 9 });
      expect(run(ID, { variant }, { frame: 9 })).toEqual(a);
    }
  });

  it("restyles with the pinned pack", () => {
    const a = run(ID, {}, { pack: keynote, frame: 75 });
    const b = run(ID, {}, { pack: playfulSaas, frame: 75 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(textById(a, "title").fill).not.toEqual(textById(b, "title").fill);
    expect(textById(a, "title").font.weight).not.toBe(textById(b, "title").font.weight);
    expect(textById(a, "title").font.size).toBe(keynote.type.title.size);
    expect(textById(b, "subtitle").font.size).toBe(playfulSaas.type.body.size);
  });

  describe("timing", () => {
    for (const variant of VARIANTS)
      it(`'${variant}' starts hidden, holds fully shown and leaves again`, () => {
        const first = run(ID, { variant }, { frame: 0 });
        expect(first.layers.every(hidden)).toBe(true);

        const hold = run(ID, { variant }, { frame: 75 });
        expect(hold.layers.every(shown)).toBe(true);

        const lastKept = run(ID, { variant, exit: false }, { frame: 149 });
        expect(lastKept.layers.every(shown)).toBe(true);
        for (const l of lastKept.layers) {
          const rest = layerById(hold, l.id) as ResolvedLayer;
          expect(l.transform.position).toEqual(rest.transform.position);
        }

        const last = run(ID, { variant }, { frame: 149 });
        expect(last.layers.every((l) => l.transform.opacity === 0)).toBe(true);
      });

    it("slides back toward its own side on the exit", () => {
      for (const [corner, sign] of [
        ["bottom-left", -1],
        ["top-right", 1],
      ] as const) {
        const hold = textById(run(ID, { variant: "plate", corner }, { frame: 75 }), "title");
        const gone = textById(run(ID, { variant: "plate", corner }, { frame: 149 }), "title");
        expect(gone.transform.position[0] - hold.transform.position[0]).toBeCloseTo(
          sign * keynote.motion.distance.small,
          2,
        );
      }
    });

    it("staggers the subtitle behind the title", () => {
      const comp = run(ID, { variant: "plate" }, { frame: 12 });
      const t = textById(comp, "title").transform.opacity;
      const s = textById(comp, "subtitle").transform.opacity;
      expect(t).toBeGreaterThan(s);
    });

    it("draws the underline and outline on with a trim", () => {
      const end = (variant: string, id: string, frame: number) => {
        const l = layerById(run(ID, { variant }, { frame }), id);
        const trim = l?.type === "shape" ? l.contents.find((i) => i.type === "trim") : undefined;
        return trim?.type === "trim" ? trim.end : undefined;
      };
      expect(end("underline", "line", 0)).toBe(0);
      expect(end("underline", "line", 14)).toBeGreaterThan(0);
      expect(end("underline", "line", 14)).toBeLessThan(1);
      expect(end("underline", "line", 75)).toBe(1);
      expect(end("outline", "outline", 0)).toBe(0);
      expect(end("outline", "outline", 75)).toBe(1);
    });

    it("grows the bar from its bottom", () => {
      const bar = (frame: number) => layerById(run(ID, { variant: "bar" }, { frame }), "bar");
      expect(bar(0)?.transform.scale).toEqual([1, 0]);
      expect(bar(75)?.transform.scale).toEqual([1, 1]);
    });

    it("cuts the bar's text with a mask that keeps its place on screen", () => {
      const clip = (corner: string, frame: number) => {
        const m = textById(run(ID, { variant: "bar", corner }, { frame }), "title").masks[0];
        return m?.path.vertices.map((v) => v.point[0]) as number[];
      };
      const pad = keynote.layout.spacing.m;
      expect(clip("bottom-left", 75)[0]).toBe(-pad);
      // Early on the text sits closer to the bar, so the cut moves farther into the text.
      expect(clip("bottom-left", 0)[0]).toBeCloseTo(-pad + keynote.motion.distance.base, 2);
      expect(
        (clip("bottom-right", 0)[1] as number) - (clip("bottom-right", 75)[1] as number),
      ).toBeCloseTo(-keynote.motion.distance.base, 2);
      expect(textById(run(ID, { variant: "plate" }), "title").masks).toEqual([]);
    });
  });

  describe("layout and options", () => {
    it("right-aligns text in right corners and left-aligns it in left corners", () => {
      for (const corner of CORNERS) {
        const title = textById(run(ID, { corner, variant: "plate" }, { frame: 75 }), "title");
        expect(title.align).toBe(corner.endsWith("right") ? "right" : "left");
      }
      const left = textById(run(ID, { corner: "bottom-left" }, { frame: 75 }), "title");
      const right = textById(run(ID, { corner: "bottom-right" }, { frame: 75 }), "title");
      expect(left.transform.position[0]).toBeLessThan(960);
      expect(right.transform.position[0]).toBeGreaterThan(960);
    });

    it("keeps the block inside the margin at every corner", () => {
      const margin = keynote.layout.spacing.xl;
      for (const corner of CORNERS) {
        const comp = run(ID, { corner, variant: "plate" }, { frame: 75 });
        for (const id of ["title", "subtitle"]) {
          const t = textById(comp, id);
          if (t.box.mode !== "box") throw new Error("expected box text");
          const [x, y] = t.transform.position;
          expect(x).toBeGreaterThanOrEqual(margin - 1e-6);
          expect(x + t.box.width).toBeLessThanOrEqual(1920 - margin + 1e-6);
          expect(y).toBeGreaterThanOrEqual(margin - 1e-6);
          expect(y + t.box.height).toBeLessThanOrEqual(1080 - margin + 1e-6);
        }
      }
    });

    it("puts bottom corners below top corners", () => {
      const y = (corner: string) =>
        textById(run(ID, { corner }, { frame: 75 }), "title").transform.position[1];
      expect(y("bottom-left")).toBeGreaterThan(y("top-left"));
      expect(y("bottom-left")).toBe(y("bottom-right"));
    });

    it("drops the subtitle layer when it is empty", () => {
      for (const variant of VARIANTS) {
        const comp = run(ID, { variant, subtitle: "" }, { frame: 75 });
        expect(layerById(comp, "subtitle")).toBeUndefined();
        expect(layerById(comp, "title")).toBeDefined();
        expect(comp.layers.every(shown)).toBe(true);
      }
      expect(layerById(run(ID, { variant: "split", subtitle: "" }), "plate-b")).toBeUndefined();
    });

    it("sizes the text box from the width fraction, single-line, auto-fit", () => {
      const title = textById(run(ID, { variant: "plate", width: 0.5 }), "title");
      const pad = keynote.layout.spacing.m;
      expect(title.box).toEqual({
        mode: "box",
        width: 0.5 * 1920 - 2 * pad,
        height:
          Math.round((keynote.type.title.leading * keynote.type.title.size + 2) * 1000) / 1000,
        autoFit: true,
      });
      const narrow = textById(run(ID, { variant: "plate", width: 0.15 }), "title");
      expect(narrow.box.mode === "box" && narrow.box.width).toBeCloseTo(0.15 * 1920 - 2 * pad, 3);
    });

    it("scales with the composition", () => {
      const small = textById(run(ID, { variant: "plate" }, { width: 960, height: 540 }), "title");
      expect(small.font.size).toBe(keynote.type.title.size / 2);
    });

    it("accepts roles and colors", () => {
      const comp = run(
        ID,
        { titleRole: "headline", subtitleRole: "label", titleColor: "#ff0000", variant: "plate" },
        { frame: 75 },
      );
      expect(textById(comp, "title").font.size).toBe(keynote.type.headline.size);
      expect(textById(comp, "subtitle").font.size).toBe(keynote.type.label.size);
      expect(textById(comp, "subtitle").textCase).toBe("upper");
      expect(textById(comp, "title").fill).toMatchObject({ r: 1, g: 0, b: 0 });
    });

    it("uses the background color for the split title", () => {
      const title = textById(run(ID, { variant: "split", titleColor: "#ff0000" }), "title");
      expect(title.fill).not.toMatchObject({ r: 1, g: 0, b: 0 });
    });

    it("validates the longest title and subtitle", () => {
      for (const variant of VARIANTS) {
        const comp = run(
          ID,
          { variant, title: "W".repeat(120), subtitle: "s".repeat(160) },
          { frame: 75 },
        );
        expect(textById(comp, "title").content).toHaveLength(120);
      }
    });

    it("rejects hostile props", () => {
      expect(() => run(ID, { width: 2 })).toThrow(
        /props\.width must be a number from 0\.15 to 0\.9/,
      );
      expect(() => run(ID, { corner: "middle" })).toThrow(
        /props\.corner must be one of: bottom-left,/,
      );
      expect(() => run(ID, { title: "x".repeat(121) })).toThrow(
        /props\.title must be a string of at most 120 characters \(got 121\)/,
      );
    });
  });
});
