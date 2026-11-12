import { evaluateFrame } from "@kynimo/engine";
import { AssetSchema, BUNDLED_FONT_FAMILIES, FALLBACK_FONT_FAMILY } from "@kynimo/scene";
import { beforeAll, describe, expect, it } from "vitest";
import type { CanvasKit } from "./canvaskit.js";
import {
  bundledFontBytes,
  bundledFonts,
  canvasKit,
  freshCanvasKit,
  sha256,
} from "./canvaskit.test-util.js";
import { compositeReference } from "./compositor/reference.js";
import { RenderError } from "./errors.js";
import {
  composition,
  frameOf,
  layer,
  type Obj,
  project,
  prop,
  textLayer,
  transform,
} from "./fixtures.test-util.js";
import {
  BUNDLED_FONTS,
  type FontAsset,
  FontAssetError,
  FontLibrary,
  MAX_FONT_BYTES,
  matchWeight,
  sniffFontFormat,
} from "./fonts.js";
import { rasterizeFrame } from "./frame.js";
import { ImageLibrary } from "./images.js";
import type { FramePlan, PlannedVectorLayer, RasterImage } from "./raster.js";
import { applyCase, MIN_FIT_SCALE, trimTransparent } from "./text.js";

let ck: CanvasKit;
let fonts: FontLibrary;
beforeAll(async () => {
  ck = await canvasKit();
  fonts = await bundledFonts(ck);
});

const W = 400;
const H = 300;
const plan = (layers: Obj[], library = fonts): FramePlan =>
  rasterizeFrame(ck, frameOf(layers, { width: W, height: H }), {
    images: new ImageLibrary(ck),
    fonts: library,
  });
const render = (layers: Obj[]): RasterImage => compositeReference(plan(layers));

/** The single text layer of a plan. */
const only = (p: FramePlan): PlannedVectorLayer => {
  expect(p.layers).toHaveLength(1);
  const l = p.layers[0];
  if (l?.type !== "text" || l.space !== "composition") throw new Error("expected a text layer");
  return l;
};

/** Composition-space ink box `[left, top, right, bottom)` of a plan's text layer. */
const ink = (l: PlannedVectorLayer): [number, number, number, number] => [
  l.x,
  l.y,
  l.x + l.raster.width,
  l.y + l.raster.height,
];

const alphaSum = (r: RasterImage) => {
  let sum = 0;
  for (let i = 3; i < r.pixels.length; i += 4) sum += r.pixels[i] ?? 0;
  return sum;
};

const at = (x: number, y: number) => transform({ position: prop([x, y]) });

describe("bundled fonts", () => {
  it("ship the files they pin, one per bundled family, the fallback among them", () => {
    for (const f of BUNDLED_FONTS) expect(sha256(bundledFontBytes(f.file)), f.file).toBe(f.sha256);
    expect(BUNDLED_FONTS.map((f) => f.family).sort()).toEqual([...BUNDLED_FONT_FAMILIES].sort());
    expect(BUNDLED_FONT_FAMILIES).toContain(FALLBACK_FONT_FAMILY);
  });
});

describe("FontLibrary", () => {
  const inter = () => bundledFontBytes("inter.ttf");
  const brand = (overrides: Obj = {}): FontAsset =>
    AssetSchema.parse({
      id: "brand",
      type: "font",
      name: "Brand",
      uri: "assets/brand.ttf",
      sha256: sha256(inter()),
      family: "Brand Sans",
      weight: { min: 100, max: 900 },
      ...overrides,
    }) as FontAsset;

  it("checks the pin, the format and the size", async () => {
    const lib = new FontLibrary(ck);
    await expect(lib.addBundled("Inter", new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /hash to .* but the pin is/,
    );
    const refuse = async (bytes: Uint8Array, message: RegExp) =>
      expect(lib.add(brand({ sha256: sha256(bytes) }), bytes)).rejects.toThrow(message);
    const ascii = (t: string) => new Uint8Array([...t].map((c) => c.charCodeAt(0)));
    await expect(lib.addBundled("Inter", new Uint8Array([1]))).rejects.toBeInstanceOf(
      FontAssetError,
    );
    await refuse(ascii("wOF2...."), /WOFF2 fonts are not supported/);
    await refuse(ascii("wOFF...."), /WOFF fonts are not supported/);
    await refuse(ascii("ttcf...."), /font collections/);
    await refuse(ascii("GIF89a.."), /not a TrueType or OpenType/);
    await refuse(new Uint8Array([0, 1, 0, 0, 9, 9, 9, 9]), /does not load/);
    await refuse(new Uint8Array(MAX_FONT_BYTES + 1), /at most/);
    await expect(lib.add(brand({ family: "Inter" }), inter())).rejects.toThrow(
      /bundled font family/,
    );
    await expect(lib.add(brand({ family: "noto sans" }), inter())).rejects.toThrow(
      /compared ignoring case/,
    );
    lib.delete();
  });

  it("sniffs formats from the signature", () => {
    expect(sniffFontFormat(bundledFontBytes("inter.ttf"))).toBe("truetype");
    expect(sniffFontFormat(new Uint8Array([0x4f, 0x54, 0x54, 0x4f]))).toBe("opentype");
    expect(sniffFontFormat(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBeNull();
  });

  it("loads font assets once, and refuses a second file for the same weights", async () => {
    const lib = new FontLibrary(ck);
    await lib.add(brand(), inter());
    await lib.add(brand(), inter()); // the same file again is a no-op
    expect(lib.match("Brand Sans", 700)?.family).toBe("Brand Sans");
    expect(lib.match("Other", 700)).toBeUndefined();
    const noto = bundledFontBytes("noto-sans.ttf");
    await expect(
      lib.add(brand({ id: "b2", sha256: sha256(noto), weight: { min: 700, max: 700 } }), noto),
    ).rejects.toThrow(/already has a font covering weights 100–900/);
    lib.delete();
  });

  it("matches weights in CSS order", () => {
    const files = [100, 300, 600, 900].map((w) => ({ w, weight: { min: w, max: w } }));
    const pick = (weight: number, from = files) => matchWeight(from, weight)?.w;
    expect(pick(300)).toBe(300);
    expect(pick(200)).toBe(100); // below 400: lighter first
    expect(pick(400)).toBe(300); // 400–500: heavier up to 500, then lighter
    expect(pick(700)).toBe(900); // above 500: heavier first
    expect(
      pick(
        400,
        [files[2], files[3]].filter((f) => f !== undefined),
      ),
    ).toBe(600);
    expect(pick(450, [{ w: 500, weight: { min: 500, max: 500 } }, ...files])).toBe(500);
    expect(matchWeight([{ weight: { min: 100, max: 900 } }], 650)).toBeDefined();
    expect(matchWeight([], 400)).toBeUndefined();
  });
});

describe("point text", () => {
  it("sits on its first baseline at the layer origin", () => {
    // "H" has no descender: its ink ends on the baseline and starts at the left side bearing.
    const [left, top, right, bottom] = ink(
      only(plan([textLayer("t", "H", { transform: at(100, 150) })])),
    );
    expect(left).toBeGreaterThanOrEqual(100);
    expect(left).toBeLessThanOrEqual(105);
    expect(bottom).toBeGreaterThanOrEqual(150);
    expect(bottom).toBeLessThanOrEqual(151);
    // Inter's cap height is about 0.73 em.
    expect(150 - top).toBeGreaterThan(27);
    expect(150 - top).toBeLessThan(32);
    expect(right - left).toBeGreaterThan(20);
  });

  it("aligns lines on the origin: left edge, center or right edge", () => {
    const box = (align: string) =>
      ink(only(plan([textLayer("t", "Hello\nHi", { align, transform: at(200, 100) })])));
    const [l, , r] = box("left");
    expect(l).toBeGreaterThanOrEqual(200);
    const [cl, , cr] = box("center");
    expect(Math.abs((cl + cr) / 2 - 200)).toBeLessThanOrEqual(2);
    expect(cr - cl).toBe(r - l);
    const [, , rr] = box("right");
    expect(rr).toBeLessThanOrEqual(201);
    expect(rr).toBeGreaterThanOrEqual(195);
    // Justify only applies to box text; point text treats it as left.
    expect(box("justify")).toEqual(box("left"));
  });

  it("sets baselines leading × size apart", () => {
    const one = ink(only(plan([textLayer("t", "H", { transform: at(50, 60) })])));
    const two = ink(
      only(plan([textLayer("t", "H\nH", { leading: prop(1.5), transform: at(50, 60) })])),
    );
    expect(two[1]).toBe(one[1]);
    expect(two[3] - one[3]).toBe(60); // 1.5 × 40
  });

  it("applies tracking in thousandths of an em, weight and case", () => {
    const width = (overrides: Obj, text = "HHHH") => {
      const [l, , r] = ink(
        only(plan([textLayer("t", text, { transform: at(10, 100), ...overrides })])),
      );
      return r - l;
    };
    // Three gaps of 250/1000 × 40 = 10 units each.
    expect(Math.abs(width({ tracking: prop(250) }) - width({}) - 30)).toBeLessThanOrEqual(2);
    const weight = (w: number) =>
      alphaSum(
        only(
          plan([
            textLayer("t", "Hello", {
              font: { family: "Inter", weight: w, size: prop(40) },
              transform: at(10, 100),
            }),
          ]),
        ).raster,
      );
    expect(weight(900)).toBeGreaterThan(weight(400) * 1.3);
    expect(weight(400)).toBeGreaterThan(weight(100) * 1.3);
    const upper = render([textLayer("t", "Kyn", { textCase: "upper", transform: at(10, 100) })]);
    expect(sha256(upper.pixels)).toBe(
      sha256(render([textLayer("t", "KYN", { transform: at(10, 100) })]).pixels),
    );
    expect(applyCase("ß", "upper")).toBe("SS");
    expect(applyCase("İ", "lower")).toBe("i̇");
  });

  it("breaks lines only at newlines, however long, and draws tabs as spaces", () => {
    const long = "H ".repeat(400);
    const one = ink(only(plan([textLayer("t", long, { transform: at(10, 100) })])));
    expect(one[2]).toBe(W); // runs off the composition instead of wrapping
    expect(one[3] - one[1]).toBeLessThan(40);
    const tab = render([textLayer("t", "A\tB", { transform: at(10, 100) })]);
    expect(sha256(tab.pixels)).toBe(
      sha256(render([textLayer("t", "A B", { transform: at(10, 100) })]).pixels),
    );
  });

  it("rasterizes in composition space, so scaled text stays sharp", () => {
    const small = only(plan([textLayer("t", "H", { transform: at(10, 100) })]));
    const big = only(
      plan([
        textLayer("t", "H", {
          transform: transform({ position: prop([10, 200]), scale: prop([4, 4]) }),
        }),
      ]),
    );
    expect(big.raster.height).toBeGreaterThan(small.raster.height * 3.8);
    // A sharp edge: the stem has fully opaque pixels.
    expect(Math.max(...big.raster.pixels.filter((_, i) => i % 4 === 3))).toBe(255);
  });

  it("draws nothing for empty or whitespace-only text, zero size or a clear fill", () => {
    expect(plan([textLayer("t", "")]).layers).toEqual([]);
    expect(plan([textLayer("t", "  \n ", { transform: at(50, 50) })]).layers).toEqual([]);
    expect(plan([textLayer("t", "Hi", { fill: prop("#ffffff00") })]).layers).toEqual([]);
    // Fully outside the composition.
    expect(plan([textLayer("t", "Hi", { transform: at(-500, 50) })]).layers).toEqual([]);
  });
});

describe("box text", () => {
  const boxText = (content: string, box: Obj, overrides: Obj = {}) =>
    textLayer("t", content, { box: { mode: "box", ...box }, transform: at(20, 20), ...overrides });
  const words = "Motion graphics made by agents";

  it("starts at the box's top-left corner and wraps to its width", () => {
    const l = only(plan([boxText(words, { width: prop(200), height: prop(250), autoFit: false })]));
    const [left, top, right, bottom] = ink(l);
    expect(left).toBeGreaterThanOrEqual(20);
    expect(top).toBeGreaterThanOrEqual(20);
    expect(top).toBeLessThan(40);
    expect(right).toBeLessThanOrEqual(221);
    expect(bottom - top).toBeGreaterThan(48 * 2); // wrapped onto three or more lines
  });

  it("hides lines that do not fit the box height whole", () => {
    // Lines are 48 units tall: a 100-unit box shows two of them.
    const tall = ink(
      only(plan([boxText(words, { width: prop(200), height: prop(250), autoFit: false })])),
    );
    const short = ink(
      only(plan([boxText(words, { width: prop(200), height: prop(100), autoFit: false })])),
    );
    expect(short[3]).toBeLessThan(tall[3]);
    expect(short[3]).toBeLessThanOrEqual(20 + 96 + 2);
    expect(
      plan([boxText(words, { width: prop(200), height: prop(40), autoFit: false })]).layers,
    ).toEqual([]);
  });

  it("auto-fit shrinks text until every line and word fits, and never grows it", () => {
    const fitted = ink(
      only(plan([boxText(words, { width: prop(200), height: prop(60), autoFit: true })])),
    );
    const plain = ink(
      only(plan([boxText(words, { width: prop(200), height: prop(250), autoFit: false })])),
    );
    expect(fitted[3]).toBeLessThanOrEqual(20 + 60 + 2);
    expect(fitted[3] - fitted[1]).toBeLessThan(plain[3] - plain[1]);
    // A long word shrinks until it fits on one line, instead of breaking mid-word.
    const word = ink(
      only(
        plan([
          boxText("Supercalifragilistic", { width: prop(150), height: prop(250), autoFit: true }),
        ]),
      ),
    );
    expect(word[2]).toBeLessThanOrEqual(171);
    expect(word[3] - word[1]).toBeLessThan(40);
    // Text that already fits keeps its size.
    const fits = { width: prop(300), height: prop(250) };
    expect(sha256(render([boxText("Hi", { ...fits, autoFit: true })]).pixels)).toBe(
      sha256(render([boxText("Hi", { ...fits, autoFit: false })]).pixels),
    );
  });

  it("auto-fit that cannot fit even at the smallest size draws at that size, clipped", () => {
    // No size fits a word into a 1-unit width, so it is laid out at 1/64 and broken.
    const l = only(
      plan([boxText("Supercalifragilistic", { width: prop(1), height: prop(200), autoFit: true })]),
    );
    const [, top, , bottom] = ink(l);
    expect(top).toBeGreaterThanOrEqual(20);
    expect(bottom - top).toBeLessThan(40); // about 20 lines of 0.75 units, not 48-unit lines
    expect(MIN_FIT_SCALE).toBe(1 / 64);
  });

  it("justifies all lines but the last", () => {
    const line = (align: string) =>
      ink(
        only(
          plan([
            boxText(
              "aa bb cc dd ee ff gg hh",
              { width: prop(200), height: prop(250), autoFit: false },
              { align },
            ),
          ]),
        ),
      );
    expect(line("justify")[2]).toBeGreaterThan(line("left")[2]);
  });
});

describe("fonts in frames", () => {
  it("reports characters drawn with the fallback font, and characters no font has", () => {
    const p = plan([textLayer("t", "Hɕ中ɕ\n", { transform: at(10, 100) })]);
    expect(p.layers).toHaveLength(1);
    expect(p.warnings).toEqual([
      {
        id: "t",
        kind: "font-fallback",
        codepoints: [0x255],
        message: expect.stringContaining("U+0255"),
      },
      {
        id: "t",
        kind: "missing-glyphs",
        codepoints: [0x4e2d],
        message: expect.stringContaining("U+4E2D"),
      },
    ]);
    expect(plan([textLayer("t", "Hello")]).warnings).toEqual([]);
    // The fallback family reports missing glyphs only.
    const noto = plan([
      textLayer("t", "ɕ中", { font: { family: "Noto Sans", weight: 400, size: prop(40) } }),
    ]);
    expect(noto.warnings.map((w) => w.kind)).toEqual(["missing-glyphs"]);
  });

  it("refuses to render when the family or the fallback font is not loaded", async () => {
    const empty = new FontLibrary(ck);
    expect(() => plan([textLayer("t", "Hi")], empty)).toThrow(RenderError);
    expect(() => plan([textLayer("t", "Hi")], empty)).toThrow(/'Inter'.*not loaded/);
    await empty.addBundled("Inter", bundledFontBytes("inter.ttf"));
    expect(() => plan([textLayer("t", "Hi")], empty)).toThrow(/fallback font 'Noto Sans'/);
    empty.delete();
  });

  it("draws font assets at the nearest declared weight, one file serving two ranges", async () => {
    const bytes = bundledFontBytes("noto-sans.ttf");
    const asset = (id: string, family: string, min: number, max: number) =>
      AssetSchema.parse({
        id,
        type: "font",
        name: id,
        uri: `assets/${id}.ttf`,
        sha256: sha256(bytes),
        family,
        weight: { min, max },
      }) as FontAsset;
    const assets = [
      asset("bold", "Static", 700, 700),
      asset("light", "Split", 100, 400),
      asset("heavy", "Split", 500, 900),
    ];
    const lib = new FontLibrary(ck);
    for (const f of BUNDLED_FONTS) await lib.addBundled(f.family, bundledFontBytes(f.file));
    for (const a of assets) await lib.add(a, bytes);
    const draw = (family: string, weight: number) => {
      const text = textLayer("t", "Hello", {
        font: { family, weight, size: prop(40) },
        transform: at(10, 60),
      });
      const doc = project([composition("main", [text], { width: W, height: H })], { assets });
      return sha256(
        only(
          rasterizeFrame(ck, evaluateFrame(doc, 0), { images: new ImageLibrary(ck), fonts: lib }),
        ).raster.pixels,
      );
    };
    const noto700 = draw("Noto Sans", 700);
    expect(draw("Static", 400)).toBe(noto700); // the only file is 700
    expect(draw("Split", 700)).toBe(noto700); // the second range of the same file
    expect(draw("Split", 300)).toBe(draw("Noto Sans", 300));
    lib.delete();
  });

  it("draws an uploaded font asset by its family", async () => {
    const bytes = bundledFontBytes("noto-sans.ttf");
    const asset = AssetSchema.parse({
      id: "brand",
      type: "font",
      name: "Brand",
      uri: "assets/brand.ttf",
      sha256: sha256(bytes),
      family: "Brand Sans",
      weight: { min: 100, max: 900 },
    }) as FontAsset;
    const lib = new FontLibrary(ck);
    for (const f of BUNDLED_FONTS) await lib.addBundled(f.family, bundledFontBytes(f.file));
    await lib.add(asset, bytes);
    const doc = project(
      [
        composition("main", [
          textLayer("t", "Hello", {
            font: { family: "Brand Sans", weight: 400, size: prop(40) },
            transform: at(10, 60),
          }),
        ]),
      ],
      { assets: [asset] },
    );
    const p = rasterizeFrame(ck, evaluateFrame(doc, 0), {
      images: new ImageLibrary(ck),
      fonts: lib,
    });
    const viaAsset = only(p);
    const viaBundled = only(
      plan([
        textLayer("t", "Hello", {
          font: { family: "Noto Sans", weight: 400, size: prop(40) },
          transform: at(10, 60),
        }),
      ]),
    );
    expect(ink(viaAsset)).toEqual(ink(viaBundled));
    expect(sha256(viaAsset.raster.pixels)).toBe(sha256(viaBundled.raster.pixels));
    lib.delete();
  });

  it("keeps warnings with the nested plan of a precomp", () => {
    const doc = project([
      composition("main", [layer("p", "precomp", { compositionId: "inner" })]),
      composition("inner", [textLayer("t", "中", { transform: at(10, 60) })]),
    ]);
    const p = rasterizeFrame(ck, evaluateFrame(doc, 0), { images: new ImageLibrary(ck), fonts });
    expect(p.warnings).toEqual([]);
    const nested = p.layers[0];
    if (nested?.type !== "precomp") throw new Error("expected a precomp");
    expect(nested.frame.warnings.map((w) => w.kind)).toEqual(["missing-glyphs"]);
  });

  it("counts text rasters against the frame budget before allocating", () => {
    const frame = frameOf([textLayer("t", "Hello", { transform: at(10, 100) })], {
      width: W,
      height: H,
    });
    const res = { images: new ImageLibrary(ck), fonts };
    expect(() => rasterizeFrame(ck, frame, res, { maxRasterPixels: 10 })).toThrow(/raster pixels/);
  });
});

describe("text determinism", () => {
  const scene = [
    textLayer("a", "Kinetic ÿpe ɕ", {
      transform: transform({
        position: prop([30.3, 80.7]),
        rotation: prop(-7),
        scale: prop([1.3, 1.3]),
      }),
      tracking: prop(40),
    }),
    textLayer("b", "Agents build motion", {
      box: { mode: "box", width: prop(180), height: prop(90), autoFit: true },
      align: "center",
      font: { family: "Inter", weight: 700, size: prop(50) },
      transform: at(200, 150),
    }),
  ];

  it("renders the same bytes every time, across fresh CanvasKit instances", async () => {
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
});

describe("trimTransparent", () => {
  it("crops clear edges and keeps the pixels in place", () => {
    const pixels = new Uint8Array(4 * 3 * 4);
    pixels.set([9, 9, 9, 255], (1 * 4 + 2) * 4);
    const t = trimTransparent({ width: 4, height: 3, pixels });
    expect(t).toMatchObject({ dx: 2, dy: 1, raster: { width: 1, height: 1 } });
    expect(Array.from(t?.raster.pixels ?? [])).toEqual([9, 9, 9, 255]);
    expect(trimTransparent({ width: 2, height: 2, pixels: new Uint8Array(16) })).toBeNull();
  });
});
