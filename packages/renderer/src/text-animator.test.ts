import { beforeAll, describe, expect, it } from "vitest";
import type { CanvasKit } from "./canvaskit.js";
import { bundledFonts, canvasKit, freshCanvasKit, sha256 } from "./canvaskit.test-util.js";
import { compositeReference } from "./compositor/reference.js";
import { RenderError } from "./errors.js";
import { frameOf, type Obj, prop, textLayer, transform } from "./fixtures.test-util.js";
import type { FontLibrary } from "./fonts.js";
import { rasterizeFrame } from "./frame.js";
import { ImageLibrary } from "./images.js";
import type { FramePlan, RasterImage } from "./raster.js";
import { MAX_ANIMATED_CLUSTERS } from "./text.js";

let ck: CanvasKit;
let fonts: FontLibrary;
beforeAll(async () => {
  ck = await canvasKit();
  fonts = await bundledFonts(ck);
});

const W = 400;
const H = 300;
const plan = (layers: Obj[], limits: { maxAnimatedGlyphs?: number } = {}): FramePlan =>
  rasterizeFrame(
    ck,
    frameOf(layers, { width: W, height: H }),
    { images: new ImageLibrary(ck), fonts },
    limits,
  );
const render = (layers: Obj[]): RasterImage => compositeReference(plan(layers));
const at = (x: number, y: number) => transform({ position: prop([x, y]) });

/** Composition-space ink box `[left, top, right, bottom)` of the plan's one text layer. */
const ink = (p: FramePlan): [number, number, number, number] => {
  expect(p.layers).toHaveLength(1);
  const l = p.layers[0];
  if (l?.type !== "text") throw new Error("expected a text layer");
  return [l.x, l.y, l.x + l.raster.width, l.y + l.raster.height];
};

/** Ink box of a rendered frame (any alpha), for layers that plan to several pieces. */
const inkOf = (r: RasterImage, x0 = 0, x1 = r.width): [number, number, number, number] | null => {
  let box: [number, number, number, number] | null = null;
  for (let y = 0; y < r.height; y++)
    for (let x = x0; x < x1; x++)
      if ((r.pixels[(y * r.width + x) * 4 + 3] ?? 0) > 0)
        box = box
          ? [
              Math.min(box[0], x),
              Math.min(box[1], y),
              Math.max(box[2], x + 1),
              Math.max(box[3], y + 1),
            ]
          : [x, y, x + 1, y + 1];
  return box;
};

const pixel = (r: RasterImage, x: number, y: number) => {
  const i = (y * r.width + x) * 4;
  return [r.pixels[i], r.pixels[i + 1], r.pixels[i + 2], r.pixels[i + 3]] as const;
};

const animator = (properties: Obj, selector: Obj = {}): Obj => ({
  name: "a",
  selector: {
    unit: "characters",
    start: prop(0),
    end: prop(1),
    offset: prop(0),
    shape: "square",
    easeHigh: prop(0),
    easeLow: prop(0),
    order: "forward",
    seed: 0,
    amount: prop(1),
    ...selector,
  },
  properties,
});

const big = { font: { family: "Inter", weight: 700, size: prop(80) } };
const text = (content: string, animators: Obj[], over: Obj = {}) =>
  textLayer("t", content, { ...big, transform: at(60, 150), animators, ...over });

describe("text animators", () => {
  it("draw exactly as the plain layer while nothing is selected or changed", () => {
    const plain = sha256(render([text("Kinetic", [])]).pixels);
    const none = animator({ position: prop([0, 40]) }, { end: prop(0) });
    const nothing = animator({});
    const noop = animator({ scale: prop([1, 1]), opacity: prop(1) });
    expect(sha256(render([text("Kinetic", [none])]).pixels)).toBe(plain);
    expect(sha256(render([text("Kinetic", [nothing, noop])]).pixels)).toBe(plain);
  });

  it("moves the selected characters and leaves the rest where the layout put them", () => {
    const plain = ink(plan([text("II", [])]));
    const moved = plan([text("II", [animator({ position: prop([0, -50]) }, { end: prop(0.5) })])]);
    const [, top, , bottom] = inkOf(compositeReference(moved)) ?? [0, 0, 0, 0];
    // The second "I" stays on the baseline; the first rose 50.
    expect(bottom).toBe(Math.round(plain[3]));
    expect(top).toBeLessThanOrEqual(plain[1] - 49);
    // Right half: unchanged ink; left half: shifted by exactly 50.
    const half = Math.floor((plain[0] + plain[2]) / 2);
    const right = inkOf(compositeReference(moved), half);
    const left = inkOf(compositeReference(moved), 0, half);
    expect(right?.[1]).toBe(plain[1]);
    expect(left?.[1]).toBe(plain[1] - 50);
  });

  it("applies a partial window as a partial weight", () => {
    // End at 0.5 selects the first character of two.
    const full = inkOf(
      render([text("II", [animator({ position: prop([0, -60]) }, { end: prop(0.5) })])]),
    );
    // End at 0.25 selects the first character half: it rises 30.
    const half = inkOf(
      render([text("II", [animator({ position: prop([0, -60]) }, { end: prop(0.25) })])]),
    );
    const base = inkOf(render([text("II", [])]));
    expect(full?.[1]).toBe((base?.[1] ?? 0) - 60);
    expect(half?.[1]).toBe((base?.[1] ?? 0) - 30);
  });

  it("scales about the middle of each character on the baseline", () => {
    const plain = inkOf(render([text("I", [])])) ?? [0, 0, 0, 0];
    const doubled = inkOf(render([text("I", [animator({ scale: prop([2, 2]) })])])) ?? [0, 0, 0, 0];
    // The baseline stays put, the cap height doubles, the stem stays centered.
    expect(doubled[3]).toBeGreaterThanOrEqual(plain[3] - 1);
    expect(doubled[3]).toBeLessThanOrEqual(plain[3] + 1);
    expect(plain[3] - doubled[1]).toBeCloseTo(2 * (plain[3] - plain[1]), -1);
    expect((doubled[0] + doubled[2]) / 2).toBeCloseTo((plain[0] + plain[2]) / 2, 0);
  });

  it("draws nothing for a character scaled to zero or faded out", () => {
    expect(plan([text("II", [animator({ scale: prop([0, 0]) })])]).layers).toHaveLength(0);
    expect(plan([text("II", [animator({ opacity: prop(0) })])]).layers).toHaveLength(0);
  });

  it("fades by opacity and tints by fill, per selected character", () => {
    const solid = render([text("II", [])]);
    const faded = render([text("II", [animator({ opacity: prop(0.5) }, { end: prop(0.5) })])]);
    const base = inkOf(solid) ?? [0, 0, 0, 0];
    const y = Math.round((base[1] + base[3]) / 2);
    const xLeft = Math.round(base[0] + (base[2] - base[0]) * 0.1);
    const xRight = Math.round(base[0] + (base[2] - base[0]) * 0.9);
    expect(pixel(faded, xRight, y)).toEqual(pixel(solid, xRight, y));
    const [, , , a] = pixel(faded, xLeft, y);
    expect(a).toBeGreaterThan(120);
    expect(a).toBeLessThan(135);

    const tinted = render([text("II", [animator({ fill: prop("#ff0000") }, { end: prop(0.5) })])]);
    expect(pixel(tinted, xLeft, y)).toEqual([255, 0, 0, 255]);
    expect(pixel(tinted, xRight, y)).toEqual([255, 255, 255, 255]);
  });

  it("tracking moves the characters after the selected ones, and keeps the ones before", () => {
    const base = inkOf(render([text("III", [])])) ?? [0, 0, 0, 0];
    const wider = render([
      // 500/1000 em of an 80-unit font after the first character only.
      text("III", [animator({ tracking: prop(500) }, { start: prop(0), end: prop(1 / 3) })]),
    ]);
    const box = inkOf(wider) ?? [0, 0, 0, 0];
    expect(box[0]).toBe(base[0]);
    expect(box[2] - base[2]).toBe(40);
    // Centered text grows around its anchor instead.
    const centered = text("III", [animator({ tracking: prop(500) }, { end: prop(1 / 3) })], {
      align: "center",
    });
    const plainCentered = inkOf(render([{ ...centered, animators: [] }])) ?? [0, 0, 0, 0];
    const grown = inkOf(render([centered])) ?? [0, 0, 0, 0];
    expect(plainCentered[0] - grown[0]).toBeGreaterThanOrEqual(19);
    expect(plainCentered[0] - grown[0]).toBeLessThanOrEqual(21);
  });

  it("selects words and lines of the laid-out text, wrapped lines included", () => {
    const box = {
      box: { mode: "box", width: prop(150), height: prop(280), autoFit: false },
      font: { family: "Inter", weight: 700, size: prop(40) },
      transform: at(10, 10),
    };
    // Each word fills its own line at 150 wide: five lines, and 0.2..0.4 is exactly the second.
    const lines = (animators: Obj[]) => text("aaaa bbbb cccc dddd eeee", animators, box);
    const base = render([lines([])]);
    const moved = render([
      lines([
        animator({ position: prop([25, 0]) }, { unit: "lines", start: prop(0.2), end: prop(0.4) }),
      ]),
    ]);
    expect(sha256(moved.pixels)).not.toBe(sha256(base.pixels));
    const rows = (r: RasterImage, y0: number, y1: number) => {
      let left = r.width;
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < r.width; x++)
          if ((r.pixels[(y * r.width + x) * 4 + 3] ?? 0) > 0 && x < left) left = x;
      return left;
    };
    // First line untouched, second line 25 to the right, from line height 48 (leading 1.2).
    expect(rows(moved, 10, 50)).toBe(rows(base, 10, 50));
    expect(rows(moved, 60, 95) - rows(base, 60, 95)).toBe(25);
  });

  it("rotates about each character's baseline center", () => {
    const rotated = inkOf(render([text("I", [animator({ rotation: prop(90) })])])) ?? [0, 0, 0, 0];
    const plain = inkOf(render([text("I", [])])) ?? [0, 0, 0, 0];
    const pivot = (plain[0] + plain[2]) / 2;
    const cap = plain[3] - plain[1];
    // A quarter turn clockwise lays the stem on the baseline pivot, pointing right.
    expect(rotated[2] - rotated[0]).toBeGreaterThan(cap - 3);
    expect(rotated[3] - rotated[1]).toBeLessThan(cap / 2);
    expect(Math.abs(rotated[0] - pivot)).toBeLessThan(plain[2] - plain[0]);
    expect(rotated[2]).toBeGreaterThan(pivot + cap - 3);
  });

  it("is deterministic across fresh CanvasKit instances", async () => {
    const scene = [
      text(
        "Kinetic type",
        [
          animator(
            {
              position: prop([0, 30]),
              rotation: prop(-12),
              opacity: prop(0.2),
              fill: prop("#33aaff"),
            },
            { shape: "round", order: "random", seed: 9, end: prop(0.7), easeHigh: prop(0.5) },
          ),
        ],
        { transform: transform({ position: prop([40.4, 140.6]), rotation: prop(4) }) },
      ),
    ];
    const first = sha256(render(scene).pixels);
    expect(sha256(render(scene).pixels)).toBe(first);
    const other = await freshCanvasKit();
    const again = compositeReference(
      rasterizeFrame(other, frameOf(scene, { width: W, height: H }), {
        images: new ImageLibrary(other),
        fonts: await bundledFonts(other),
      }),
    );
    expect(sha256(again.pixels)).toBe(first);
  });

  it("reports blur as accepted but not drawn", () => {
    const p = plan([text("Hi", [animator({ blur: prop(6) })])]);
    expect(p.warnings.map((w) => w.kind)).toEqual(["animator-blur"]);
    expect(p.layers).toHaveLength(1);
    expect(plan([text("Hi", [animator({ opacity: prop(0.5) })])]).warnings).toEqual([]);
  });

  it("refuses more animated glyphs than a layer or a frame may draw, before shaping them", () => {
    const long = "x".repeat(MAX_ANIMATED_CLUSTERS + 1);
    const opacity = animator({ opacity: prop(0.5) });
    expect(() => plan([text(long, [opacity])])).toThrow(RenderError);
    expect(() => plan([text(long, [opacity])])).toThrow(/at most 1000/);
    expect(() => plan([text("abcdef", [opacity])], { maxAnimatedGlyphs: 5 })).toThrow(
      /more than 5 glyphs/,
    );
    // Unanimated text is not charged.
    expect(() => plan([text("abcdef", [])], { maxAnimatedGlyphs: 5 })).not.toThrow();
  });

  describe("layout does not move when an animator becomes active", () => {
    // A fill that differs by one level from white: the animator is active, nothing visibly changes.
    const nearWhite = animator({ fill: prop("#fffffe") });
    const alpha = (r: RasterImage) => {
      const a = new Uint8Array(r.width * r.height);
      for (let i = 0; i < a.length; i++) a[i] = r.pixels[i * 4 + 3] ?? 0;
      return a;
    };
    const same = (over: Obj, content = "Tracked Café\nÜber ÅB") => {
      const plain = render([text(content, [], over)]);
      const active = render([text(content, [nearWhite], over)]);
      expect(Array.from(alpha(active))).toEqual(Array.from(alpha(plain)));
    };

    it.each(["left", "center", "right"])("with tracking, %s aligned", (align) => {
      same({ align, tracking: prop(200), transform: at(100.4, 120.3) });
      same({ align, tracking: prop(-50), transform: at(200, 120) });
    });

    it("on multi-line non-ASCII text, with \r\n line breaks", () => {
      same({ align: "left" }, "é\r\nB\nÜber");
      same({ align: "left" }, "日本\nB");
    });

    it("in box text, wrapped and with hidden lines", () => {
      same(
        {
          box: { mode: "box", width: prop(150), height: prop(100), autoFit: false },
          align: "left",
        },
        "Café one two three four five six",
      );
    });
  });

  it("counts lines the box hides, so a lines range keeps its meaning", () => {
    const box = {
      box: { mode: "box", width: prop(120), height: prop(100), autoFit: false },
      font: { family: "Inter", weight: 700, size: prop(40) },
      align: "left",
      transform: at(10, 10),
    };
    const content = "aaaa bbbb cccc dddd";
    // Four lines, two fit. 0.25..0.5 is the second line.
    const moved = render([
      text(
        content,
        [
          animator(
            { position: prop([30, 0]) },
            { unit: "lines", start: prop(0.25), end: prop(0.5) },
          ),
        ],
        box,
      ),
    ]);
    const base = render([text(content, [], box)]);
    expect(inkOf(moved, 0, W)).not.toBeNull();
    expect((inkOf(moved)?.[0] ?? 0) - (inkOf(base)?.[0] ?? 0)).toBe(0);
    expect((inkOf(moved)?.[2] ?? 0) - (inkOf(base)?.[2] ?? 0)).toBe(30);
  });

  it("does not leave the per-glyph path, or its budget, for blur alone", () => {
    const long = "x".repeat(MAX_ANIMATED_CLUSTERS + 500);
    expect(() => plan([text(long, [animator({ blur: prop(5) })])])).not.toThrow();
    expect(plan([text("Hi", [animator({ blur: prop(5) })])]).warnings.map((w) => w.kind)).toEqual([
      "animator-blur",
    ]);
  });
});
