import { brutalist, keynote, playfulSaas } from "@kynimo/guidelines";
import { describe, expect, it } from "vitest";
import { kineticType } from "./kinetic-type.js";
import { framesOf, run, textById, weightsOf } from "./run.test-util.js";

const ID = "kinetic-type";
const VARIANTS = Object.keys(
  Object.fromEntries((kineticType.props.variant as { values: string[] }).values.map((v) => [v, 1])),
);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const title = (props = {}, o = {}) => textById(run(ID, props, o), "title");

describe("kinetic-type", () => {
  it("has the eight documented variants", () => {
    expect(VARIANTS).toEqual([
      "rise",
      "pop",
      "slam",
      "typewriter",
      "blur",
      "cascade",
      "scatter",
      "wave",
    ]);
  });

  for (const variant of VARIANTS)
    for (const duration of [1, 10, 150])
      for (const [width, height] of [
        [1920, 1080],
        [1080, 1920],
      ] as const)
        it(`evaluates '${variant}' over ${duration} frames at ${width}x${height}`, () => {
          for (const frame of framesOf(duration)) {
            const comp = run(
              ID,
              { variant, text: "Make it\nmove" },
              { frame, duration, width, height },
            );
            expect(comp.width).toBe(width);
            expect(comp.layers).toHaveLength(1);
          }
        });

  it("works with no props", () => {
    const layer = title();
    expect(layer.content).toBe("Make it move");
    expect(layer.align).toBe("center");
  });

  it("is deterministic", () => {
    for (const variant of VARIANTS) {
      const a = run(ID, { variant }, { frame: 7 });
      expect(run(ID, { variant }, { frame: 7 })).toEqual(a);
    }
  });

  it("seeds a random order from the instance id", () => {
    const seed = (id: string) =>
      title({ variant: "scatter" }, { id }).animators[0]?.selector.seed as number;
    expect(title({ variant: "scatter" }).animators[0]?.selector.order).toBe("random");
    expect(seed("a")).toBe(seed("a"));
    expect(seed("a")).not.toBe(seed("b"));
    const typed = title({ variant: "typewriter", order: "random" }, { id: "a" });
    expect(typed.animators[0]?.selector.seed).toBe(seed("a"));
    expect(title({ variant: "rise" }).animators[0]?.selector.seed).toBe(0);
  });

  it("restyles with the pinned pack", () => {
    const a = title({}, { pack: keynote });
    const b = title({}, { pack: playfulSaas });
    expect(a.font.size).toBe(keynote.type.display.size);
    expect(b.font.size).toBe(playfulSaas.type.display.size);
    expect(a.font.weight).not.toBe(b.font.weight);
    expect(a.fill).not.toEqual(b.fill);
    const accented = title({ useHighlight: true }, { pack: playfulSaas });
    expect(accented.animators[0]?.fill).not.toBeNull();
  });

  describe("timing", () => {
    for (const variant of VARIANTS)
      it(`'${variant}' starts fully hidden and settles fully shown`, () => {
        const text = "Make it\nmove now";
        const first = title({ variant, text }, { frame: 0 });
        const entering = first.animators[0];
        expect(entering).toBeDefined();
        const w0 = weightsOf(first, entering as never);
        expect(w0.length).toBeGreaterThan(0);
        expect(w0.every((w) => w === 1)).toBe(true);
        expect(entering?.opacity).toBe(0);

        const mid = title({ variant, text }, { frame: 8 });
        const wm = weightsOf(mid, mid.animators[0] as never);
        expect(sum(wm)).toBeGreaterThan(0);
        expect(sum(wm)).toBeLessThan(wm.length);

        const hold = title({ variant, text }, { frame: 75 });
        expect(weightsOf(hold, hold.animators[0] as never).every((w) => w === 0)).toBe(true);
        expect(hold.transform.opacity).toBe(1);

        const last = title({ variant, text, exit: false }, { frame: 149 });
        expect(weightsOf(last, last.animators[0] as never).every((w) => w === 0)).toBe(true);
        expect(last.transform.opacity).toBe(1);
      });

    it("fades out and sinks over the exit window", () => {
      const at = (frame: number, props = {}) => title(props, { frame });
      expect(at(139).transform.opacity).toBe(1);
      expect(at(149).transform.opacity).toBe(0);
      const mid = at(144);
      expect(mid.transform.opacity).toBeGreaterThan(0);
      expect(mid.transform.opacity).toBeLessThan(1);
      expect(at(149).transform.position[1] - at(100).transform.position[1]).toBeCloseTo(
        keynote.motion.distance.small,
        1,
      );
      expect(at(149, { exit: false }).transform.position).toEqual(at(100).transform.position);
    });

    it("shows a one-frame instance in its end state", () => {
      const layer = title({}, { duration: 1 });
      expect(layer.animators).toEqual([]);
      expect(layer.transform.opacity).toBe(1);
    });

    it("speed changes the length of the enter", () => {
      const weights = (speed: string) => {
        const l = title({ speed }, { frame: 12 });
        return sum(weightsOf(l, l.animators[0] as never));
      };
      expect(weights("fast")).toBeLessThan(weights("slow"));
    });

    it("loops a bob after the enter only in 'wave'", () => {
      const bob = (frame: number) => {
        const l = title({ variant: "wave", text: "Wave" }, { frame });
        return l.animators[1];
      };
      const during = bob(5);
      expect(during?.selector.shape).toBe("round");
      expect(during?.position?.[1]).toBeLessThan(0);
      expect(
        weightsOf(title({ variant: "wave", text: "Wave" }, { frame: 5 }), during as never),
      ).toEqual([0, 0, 0, 0]);
      const lit = [30, 40, 50, 60, 70, 80, 90].map((f) => {
        const l = title({ variant: "wave", text: "Wave" }, { frame: f });
        return sum(weightsOf(l, l.animators[1] as never));
      });
      expect(lit.some((w) => w > 0)).toBe(true);
      expect(title({ variant: "rise" }).animators).toHaveLength(1);
      // The offset runs out of the text and starts over (two passes in 150 frames), then rests.
      const offsets = Array.from({ length: 150 }, (_, i) => bobOffset(i));
      expect(offsets.filter((o, i) => i > 0 && o < (offsets[i - 1] as number))).toHaveLength(1);
      expect(Math.max(...offsets)).toBe(1);
      expect(offsets[offsets.length - 1]).toBe(1);
    });
  });

  describe("layout and options", () => {
    it("moves the baseline up for each extra line", () => {
      const one = title({ text: "A" }).transform.position[1];
      const three = title({ text: "A\nB\nC" }).transform.position[1];
      const { size, leading } = keynote.type.display;
      expect(one).toBeCloseTo(540 + 0.35 * size, 2);
      expect(one - three).toBeCloseTo(leading * size, 2);
    });

    it("anchors at the center or a safe margin, plus the position offset", () => {
      const x = (props = {}) => title(props).transform.position[0];
      expect(x()).toBe(960);
      expect(x({ align: "left" })).toBe(keynote.layout.spacing.xl);
      expect(x({ align: "right" })).toBe(1920 - keynote.layout.spacing.xl);
      expect(x({ position: [40, 0] })).toBe(1000);
      expect(title({ align: "right" }).align).toBe("right");
    });

    it("scales the type size", () => {
      expect(title({ scale: 2 }).font.size).toBe(keynote.type.display.size * 2);
      expect(title({ role: "title" }).font.size).toBe(keynote.type.title.size);
    });

    it("lets unit and order override the variant's", () => {
      const sel = (props = {}) => title(props).animators[0]?.selector;
      expect(sel({ variant: "rise" })?.unit).toBe("words");
      expect(sel({ variant: "rise", unit: "lines" })?.unit).toBe("lines");
      expect(sel({ variant: "typewriter" })?.unit).toBe("characters");
      expect(sel({ variant: "blur" })?.order).toBe("center-out");
      expect(sel({ variant: "blur", order: "reverse" })?.order).toBe("reverse");
      expect(sel({ order: "edges-in" })?.order).toBe("edges-in");
    });

    it("takes the case of the type role unless overridden", () => {
      expect(title({}, { pack: brutalist }).textCase).toBe("upper");
      expect(title({}, { pack: keynote }).textCase).toBe("none");
      expect(title({ textCase: "lower" }, { pack: brutalist }).textCase).toBe("lower");
      expect(title({ textCase: "none" }, { pack: brutalist }).textCase).toBe("none");
    });

    it("blurs in the enter by the composition scale", () => {
      const big = title({ variant: "blur" }, { height: 2160, width: 3840 }).animators[0]?.blur;
      const normal = title({ variant: "blur" }).animators[0]?.blur;
      expect(normal).toBe(24);
      expect(big).toBe(48);
    });

    it("keeps a 500-character text valid", () => {
      expect(title({ text: "word ".repeat(100), variant: "typewriter" }).content.length).toBe(500);
    });

    it("rejects hostile props", () => {
      expect(() => run(ID, { scale: 9 })).toThrow(/props\.scale must be a number from 0\.25 to 4/);
      expect(() => run(ID, { variant: "explode" })).toThrow(/props\.variant must be one of: rise,/);
      expect(() => run(ID, { text: "x".repeat(501) })).toThrow(
        /props\.text must be a string of at most 500 characters \(got 501\)/,
      );
    });
  });
});

/** The `offset` of the bob animator at a frame (wave, "Wave"). */
function bobOffset(frame: number): number {
  return title({ variant: "wave", text: "Wave" }, { frame }).animators[1]?.selector
    .offset as number;
}
