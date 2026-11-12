import { type ComponentHost, evaluateFrame } from "@kynimo/engine";
import { AssetSchema, CompositionSchema, LayerSchema } from "@kynimo/scene";
import { beforeAll, describe, expect, it } from "vitest";
import type { CanvasKit } from "./canvaskit.js";
import {
  bundledFonts,
  canvasKit,
  encodeImage,
  freshCanvasKit,
  pixel,
  sha256,
} from "./canvaskit.test-util.js";
import { LAYER_SUPPORT } from "./capabilities.js";
import { compositeReference } from "./compositor/reference.js";
import { RenderError } from "./errors.js";
import {
  composition,
  ellipse,
  fill,
  frameOf,
  group,
  layer,
  type Obj,
  project,
  prop,
  rect,
  repeater,
  roundCorners,
  shapeLayer,
  solidPaint,
  stroke,
  textLayer,
  transform,
  trim,
} from "./fixtures.test-util.js";
import type { FontLibrary } from "./fonts.js";
import { MAX_FRAME_RASTER_PIXELS, rasterizeFrame } from "./frame.js";
import {
  type ImageAsset,
  ImageAssetError,
  ImageLibrary,
  type VideoAsset,
  VideoFrameLibrary,
} from "./images.js";
import type { FramePlan, PlannedLayer, RasterImage } from "./raster.js";

let ck: CanvasKit;
let fonts: FontLibrary;
beforeAll(async () => {
  ck = await canvasKit();
  fonts = await bundledFonts(ck);
});

const res = (images = new ImageLibrary(ck)) => ({ images, fonts });

const plan = (layers: Obj[], images?: ImageLibrary, assets: ImageAsset[] = []): FramePlan =>
  rasterizeFrame(ck, frameOf(layers, {}, { assets }), res(images));

/** Within `tolerance` per channel: gradients are sampled at pixel centers, not exact stops. */
const near = (actual: number[], expected: number[], tolerance = 3) => {
  expect(actual.every((v, i) => Math.abs(v - (expected[i] ?? Number.NaN)) <= tolerance)).toBe(true);
};

const render = (layers: Obj[], images?: ImageLibrary): RasterImage =>
  compositeReference(plan(layers, images));

const only = (p: FramePlan): PlannedLayer => {
  expect(p.layers).toHaveLength(1);
  return p.layers[0] as PlannedLayer;
};

const RED = [255, 0, 0, 255];
const CLEAR = [0, 0, 0, 0];

describe("shape layers", () => {
  it("fill a rectangle in composition space, cropped to its bounds", () => {
    const p = plan([shapeLayer("s", [rect([50, 50], [20, 10]), fill()])]);
    const l = only(p);
    expect(l.space).toBe("composition");
    if (l.space !== "composition") return;
    // Bounds 40..60 × 45..55, plus one pixel of anti-aliasing room.
    expect([l.x, l.y, l.raster.width, l.raster.height]).toEqual([39, 44, 22, 12]);
    const out = compositeReference(p);
    expect(pixel(out, 50, 50)).toEqual(RED);
    expect(pixel(out, 39, 50)).toEqual(CLEAR);
    expect(pixel(out, 61, 50)).toEqual(CLEAR);
  });

  it("keeps vectors sharp under layer scale: the raster is drawn at composition size", () => {
    const p = plan([
      shapeLayer("s", [rect([0, 0], [10, 10]), fill()], {
        transform: transform({ position: prop([100, 50]), scale: prop([8, 8]) }),
      }),
    ]);
    const l = only(p);
    if (l.space !== "composition") throw new Error("expected composition space");
    // 80×80 at (60..140, 10..90), plus a pixel of anti-aliasing room on each side.
    expect([l.raster.width, l.raster.height]).toEqual([82, 82]);
    // Edges stay one-pixel crisp: an integer-aligned edge has no partial coverage.
    const out = compositeReference(p);
    expect(pixel(out, 59, 50)).toEqual(CLEAR);
    expect(pixel(out, 60, 50)).toEqual(RED);
  });

  it("leaves out layers that draw nothing inside the composition", () => {
    expect(plan([shapeLayer("off", [rect([1000, 1000], [10, 10]), fill()])]).layers).toEqual([]);
    expect(plan([shapeLayer("nopaint", [rect([50, 50], [10, 10])])]).layers).toEqual([]);
    expect(
      plan([shapeLayer("thin", [rect([50, 50], [10, 10]), stroke(solidPaint("#ffffff"), 0)])])
        .layers,
    ).toEqual([]);
    expect(
      plan([
        shapeLayer("faded", [
          rect([50, 50], [10, 10]),
          fill(solidPaint("#ff0000"), { opacity: prop(0) }),
        ]),
      ]).layers,
    ).toEqual([]);
  });

  it("rasterizes offscreen vector pixels when a blur can spread them into view", () => {
    const source = shapeLayer("outside", [rect([-4, 40], [4, 24]), fill()]);
    expect(pixel(render([source]), 0, 40)).toEqual(CLEAR);
    const blurred = render([
      {
        ...source,
        effects: [{ type: "gaussian-blur", id: "blur", radius: prop(12) }],
      },
    ]);
    const edge = pixel(blurred, 0, 40);
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[0]).toBe(edge[3]);
    expect(pixel(blurred, 15, 40)).toEqual(CLEAR);
  });

  it("honors the fill rule across the paths of one fill", () => {
    const rings = (rule: string) => [
      shapeLayer("s", [
        rect([50, 50], [40, 40]),
        rect([50, 50], [10, 10]),
        fill(undefined, { rule }),
      ]),
    ];
    expect(pixel(render(rings("nonzero")), 50, 50)).toEqual(RED);
    expect(pixel(render(rings("evenodd")), 50, 50)).toEqual(CLEAR);
    expect(pixel(render(rings("evenodd")), 35, 50)).toEqual(RED);
  });

  it("draws a stroke listed above a fill on top of it", () => {
    const out = render([
      shapeLayer("s", [rect([50, 50], [40, 40]), stroke(solidPaint("#0000ff"), 6), fill()]),
    ]);
    expect(pixel(out, 30, 50)).toEqual([0, 0, 255, 255]);
    expect(pixel(out, 50, 50)).toEqual(RED);
  });

  it("crops to the stroke outline, not just the fill", () => {
    const p = plan([
      shapeLayer("s", [rect([50, 50], [40, 40]), stroke(solidPaint("#0000ff"), 6), fill()]),
    ]);
    const l = only(p);
    if (l.space !== "composition") throw new Error("expected composition space");
    // Outline 27..73 on both axes, plus one pixel of anti-aliasing room.
    expect([l.x, l.y, l.raster.width, l.raster.height]).toEqual([26, 26, 48, 48]);
    expect(pixel(compositeReference(p), 28, 50)).toEqual([0, 0, 255, 255]);
  });

  it("keeps the caps of dashes that end at a beveled corner inside the crop", () => {
    const tip = Math.hypot(50, 100);
    const vertex = (x: number, y: number) => ({
      point: [x, y],
      inTangent: [0, 0],
      outTangent: [0, 0],
    });
    const contents = (dashes: number[]) => [
      {
        id: "v",
        name: "v",
        type: "path",
        path: prop({
          closed: false,
          vertices: [vertex(50, 150), vertex(100, 50), vertex(150, 150)],
        }),
      },
      stroke(solidPaint("#ffffff"), 20, { join: "bevel", cap: "square", dashes }),
    ];
    const top = (dashes: number[]) => {
      const p = rasterizeFrame(
        ck,
        frameOf([shapeLayer("s", contents(dashes))], { width: 200, height: 200 }),
        res(),
      );
      const l = only(p);
      if (l.space !== "composition") throw new Error("expected composition space");
      return l.y;
    };
    // Undashed, the bevel's top edge sits near y≈44; the square cap of a dash ending at the tip
    // reaches y≈36.6.
    expect(top([])).toBeGreaterThan(40);
    expect(top([tip, 1000])).toBeLessThanOrEqual(36);
  });

  it("applies group opacity to the paints inside the group", () => {
    const faded = (opacity: number) => [
      shapeLayer("s", [
        group([rect([50, 50], [20, 20]), fill()], transform({ opacity: prop(opacity) })),
      ]),
    ];
    expect(pixel(render(faded(0.5)), 50, 50)).toEqual([128, 0, 0, 128]);
    expect(plan(faded(0)).layers).toEqual([]);
  });

  it("scales a group's stroke with the group but not an enclosing stroke", () => {
    const widthAt = (contents: Obj[]) => {
      const out = render([shapeLayer("s", contents)]);
      let covered = 0;
      for (let x = 0; x < out.width; x++) if ((pixel(out, x, 50)[3] ?? 0) > 128) covered++;
      return covered;
    };
    const scaled = (items: Obj[]) =>
      group(items, transform({ position: prop([100, 50]), scale: prop([2, 2]) }));
    // A 4-wide stroke inside the 2× group → 8 px per side; the outer stroke stays 4 px.
    expect(widthAt([scaled([rect([0, 0], [20, 20]), stroke(solidPaint("#ffffff"), 4)])])).toBe(16);
    expect(widthAt([scaled([rect([0, 0], [20, 20])]), stroke(solidPaint("#ffffff"), 4)])).toBe(8);
  });

  it("dashes strokes, shifted by the offset", () => {
    const line = (dashOffset: number) =>
      render([
        shapeLayer("s", [
          {
            id: "line",
            name: "line",
            type: "path",
            path: prop({
              closed: false,
              vertices: [
                { point: [0, 50], inTangent: [0, 0], outTangent: [0, 0] },
                { point: [200, 50], inTangent: [0, 0], outTangent: [0, 0] },
              ],
            }),
          },
          stroke(solidPaint("#ffffff"), 4, { dashes: [10, 10], dashOffset: prop(dashOffset) }),
        ]),
      ]);
    const solidAt = (out: RasterImage, x: number) => pixel(out, x, 50)[3] === 255;
    expect([5, 15, 25].map((x) => solidAt(line(0), x))).toEqual([true, false, true]);
    expect([5, 15, 25].map((x) => solidAt(line(10), x))).toEqual([false, true, false]);
  });

  it("paints linear and radial gradients in the paint's space", () => {
    const linear = render([
      shapeLayer("s", [
        rect([100, 50], [200, 100]),
        fill({
          type: "linear-gradient",
          start: prop([0, 0]),
          end: prop([200, 0]),
          stops: prop([
            { offset: 0, color: "#ff0000" },
            { offset: 1, color: "#0000ff" },
          ]),
        }),
      ]),
    ]);
    near(pixel(linear, 0, 50), [255, 0, 0, 255]);
    near(pixel(linear, 199, 50), [0, 0, 255, 255]);
    const mid = pixel(linear, 100, 50);
    expect(mid[0]).toBeGreaterThan(100);
    expect(mid[2]).toBeGreaterThan(100);

    const radial = render([
      shapeLayer("s", [
        ellipse([100, 50], [80, 80]),
        fill({
          type: "radial-gradient",
          center: prop([100, 50]),
          radius: prop(40),
          stops: prop([
            { offset: 0, color: "#ffffff" },
            { offset: 1, color: "#00000000" },
          ]),
        }),
      ]),
    ]);
    expect(pixel(radial, 100, 50)[3]).toBeGreaterThan(240);
    expect(pixel(radial, 100, 50)[0]).toBeGreaterThan(240);
    expect(pixel(radial, 138, 50)[3]).toBeLessThan(20);
  });
});

describe("path operators", () => {
  const bar = () => ({
    id: "bar",
    name: "bar",
    type: "path",
    path: prop({
      closed: false,
      vertices: [
        { point: [20, 50], inTangent: [0, 0], outTangent: [0, 0] },
        { point: [180, 50], inTangent: [0, 0], outTangent: [0, 0] },
      ],
    }),
  });

  it("strokes only the trimmed part of a path", () => {
    const out = render([shapeLayer("s", [bar(), stroke(solidPaint("#ffffff"), 10), trim(0, 0.5)])]);
    expect(pixel(out, 60, 50)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 140, 50)).toEqual(CLEAR);
    // An offset of 180° moves the kept half to the other end.
    const moved = render([
      shapeLayer("s", [
        bar(),
        stroke(solidPaint("#ffffff"), 10),
        trim(0, 0.5, { offset: prop(180) }),
      ]),
    ]);
    expect(pixel(moved, 60, 50)).toEqual(CLEAR);
    expect(pixel(moved, 140, 50)).toEqual([255, 255, 255, 255]);
  });

  it("rounds a rectangle's corners away", () => {
    const corner = (contents: Obj[]) => pixel(render([shapeLayer("s", contents)]), 31, 31);
    const square = () => rect([50, 50], [40, 40]);
    expect(corner([square(), fill()])).toEqual(RED);
    expect(corner([square(), roundCorners(10), fill()])).toEqual(CLEAR);
  });

  it("shares one path work budget across the frame's shape layers", () => {
    // Each layer costs about 1200 units: 100 copies of a rectangle, filled.
    const repeated = (id: string) =>
      shapeLayer(id, [rect([20, 20], [4, 4]), fill(), repeater(100, { position: prop([1, 0]) })]);
    const budgeted = (layers: Obj[]) =>
      rasterizeFrame(ck, frameOf(layers), res(), { maxShapeWork: 3000 });
    expect(budgeted([repeated("a"), repeated("b")]).layers).toHaveLength(2);
    expect(() => budgeted([repeated("a"), repeated("b"), repeated("c")])).toThrow(RenderError);
    expect(() => budgeted([repeated("a"), repeated("b"), repeated("c")])).toThrow("3000");
  });

  it("draws a repeater's copies, faded from start to end opacity", () => {
    const out = render([
      shapeLayer("s", [
        rect([20, 50], [10, 10]),
        fill(),
        repeater(3, {
          position: prop([30, 0]),
          startOpacity: prop(1),
          endOpacity: prop(0),
        }),
      ]),
    ]);
    expect(pixel(out, 20, 50)).toEqual(RED);
    expect(pixel(out, 50, 50)).toEqual([128, 0, 0, 128]);
    expect(pixel(out, 80, 50)).toEqual(CLEAR);
    expect(pixel(out, 35, 50)).toEqual(CLEAR);
  });
});

describe("solid layers", () => {
  it("rasterize in layer space and are placed by their matrix", () => {
    const p = plan([
      layer("bg", "solid", {
        width: 20,
        height: 10,
        color: "#00ff0080",
        transform: transform({ position: prop([30, 40]) }),
      }),
    ]);
    const l = only(p);
    expect(l.type).toBe("solid");
    if (l.type !== "solid") return;
    expect([l.raster.width, l.raster.height]).toEqual([20, 10]);
    expect(l.matrix).toEqual([1, 0, 0, 1, 30, 40]);
    // Premultiplied: 50% green.
    expect(pixel(l.raster, 0, 0)).toEqual([0, 128, 0, 128]);
    const out = compositeReference(p);
    expect(pixel(out, 35, 45)).toEqual([0, 128, 0, 128]);
    expect(pixel(out, 29, 45)).toEqual(CLEAR);
  });

  it("carries layer opacity to the compositor instead of baking it in", () => {
    const p = plan([
      layer("bg", "solid", {
        width: 200,
        height: 100,
        color: "#ff0000",
        transform: transform({ opacity: prop(0.5) }),
      }),
    ]);
    const l = only(p);
    expect(l.opacity).toBe(0.5);
    if (l.type !== "solid") return;
    expect(pixel(l.raster, 0, 0)).toEqual(RED);
    expect(pixel(compositeReference(p), 0, 0)).toEqual([128, 0, 0, 128]);
  });

  it("draws top-first layers bottom-up over the composition background", () => {
    const p = rasterizeFrame(
      ck,
      frameOf(
        [
          layer("top", "solid", { width: 10, height: 10, color: "#0000ff" }),
          layer("under", "solid", { width: 20, height: 20, color: "#ff0000" }),
        ],
        { background: "#ffffff" },
      ),
      res(),
    );
    const out = compositeReference(p);
    expect(pixel(out, 5, 5)).toEqual([0, 0, 255, 255]);
    expect(pixel(out, 15, 15)).toEqual(RED);
    expect(pixel(out, 50, 50)).toEqual([255, 255, 255, 255]);
  });
});

describe("image layers", () => {
  const checker = (x: number, y: number): [number, number, number, number] =>
    (x + y) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255];

  const imageAsset = (bytes: Uint8Array, overrides: Obj = {}): ImageAsset =>
    AssetSchema.parse({
      id: "img",
      name: "img",
      type: "image",
      uri: "assets/img.png",
      sha256: sha256(bytes),
      width: 4,
      height: 2,
      ...overrides,
    }) as ImageAsset;

  it("decode PNG and JPEG with CanvasKit's codecs and draw in layer space", async () => {
    for (const format of ["png", "jpeg"] as const) {
      const bytes = await encodeImage(4, 2, checker, format);
      const images = new ImageLibrary(ck);
      const asset = imageAsset(bytes, { uri: `assets/img.${format}` });
      await images.add(asset, bytes);
      const raster = images.get("img");
      expect([raster?.width, raster?.height]).toEqual([4, 2]);
      const p = plan(
        [
          layer("pic", "image", {
            assetId: "img",
            transform: transform({ position: prop([10, 10]) }),
          }),
        ],
        images,
        [asset],
      );
      const l = only(p);
      expect(l.type).toBe("image");
      if (l.type !== "image") continue;
      expect(l.raster).toBe(raster);
      if (format === "png") {
        expect(pixel(l.raster, 0, 0)).toEqual([255, 255, 255, 255]);
        expect(pixel(l.raster, 1, 0)).toEqual([0, 0, 0, 255]);
        expect(pixel(compositeReference(p), 10, 10)).toEqual([255, 255, 255, 255]);
      }
    }
  });

  it("reject bytes that do not match the document's pin", async () => {
    const bytes = await encodeImage(4, 2, checker, "png");
    const images = new ImageLibrary(ck);
    await expect(images.add(imageAsset(bytes, { sha256: "0".repeat(64) }), bytes)).rejects.toThrow(
      /pins 0000/,
    );
    await expect(images.add(imageAsset(bytes, { width: 5 }), bytes)).rejects.toThrow(
      /decodes to 4×2/,
    );
    await expect(images.add(imageAsset(bytes, { width: 9000 }), bytes)).rejects.toThrow(
      /at most 8192/,
    );
  });

  it("reject formats other than PNG and JPEG by signature", async () => {
    const gif = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000");
    await expect(new ImageLibrary(ck).add(imageAsset(gif), gif)).rejects.toThrow(ImageAssetError);
  });

  it("fail the frame clearly when an asset was not loaded", () => {
    const declared = imageAsset(new Uint8Array(0));
    expect(() => plan([layer("pic", "image", { assetId: "img" })], undefined, [declared])).toThrow(
      /not loaded into the ImageLibrary/,
    );
  });
});

describe("precomps and unsupported layers", () => {
  const nested = composition(
    "inner",
    [layer("dot", "solid", { width: 10, height: 10, color: "#ff0000" })],
    {
      width: 20,
      height: 20,
    },
  );

  it("composite the nested composition on its own, then place it with the layer matrix", () => {
    const doc = project([
      composition("main", [
        layer("a", "precomp", {
          compositionId: "inner",
          transform: transform({ position: prop([100, 0]) }),
        }),
        layer("b", "precomp", {
          compositionId: "inner",
          transform: transform({ position: prop([0, 50]) }),
        }),
      ]),
      nested,
    ]);
    const p = rasterizeFrame(ck, evaluateFrame(doc, 0), res());
    expect(p.layers).toHaveLength(2);
    const [a, b] = p.layers;
    if (a?.type !== "precomp" || b?.type !== "precomp") throw new Error("expected precomps");
    expect(a.frame).toBe(b.frame);
    expect([a.frame.width, a.frame.height, a.frame.background]).toEqual([20, 20, null]);
    const out = compositeReference(p);
    expect(pixel(out, 105, 5)).toEqual(RED);
    expect(pixel(out, 5, 55)).toEqual(RED);
    expect(pixel(out, 115, 5)).toEqual(CLEAR);
  });
});

describe("component layers", () => {
  const dot = layer("dot", "solid", { width: 10, height: 10, color: "#ff0000" });
  const nested = composition("inner", [dot], { width: 20, height: 20 });
  const placed = transform({ position: prop([100, 30]) });
  const instance = (id: string, over: Obj = {}) =>
    layer(id, "component", {
      componentId: "badge",
      componentVersion: "1.0.0",
      props: {},
      transform: placed,
      ...over,
    });
  // The host returns the same subtree the precomp tests show, as a component's output.
  const host: ComponentHost = {
    evaluate: () =>
      CompositionSchema.parse({ ...composition("component", [dot], { width: 20, height: 20 }) }),
  };
  const asPlan = (layers: Obj[], components?: ComponentHost) =>
    rasterizeFrame(
      ck,
      evaluateFrame(
        project([composition("main", layers), nested]),
        0,
        undefined,
        components === undefined ? {} : { components },
      ),
      res(),
    );

  it("plans an evaluated instance exactly like a precomp showing the same composition", () => {
    const viaComponent = asPlan([instance("c", { blendMode: "screen" })], host);
    const viaPrecomp = asPlan([
      layer("c", "precomp", { compositionId: "inner", transform: placed, blendMode: "screen" }),
    ]);
    expect(viaComponent).toEqual(viaPrecomp);
    expect(compositeReference(viaComponent).pixels).toEqual(compositeReference(viaPrecomp).pixels);
    expect(pixel(compositeReference(viaComponent), 105, 35)).toEqual(RED);
  });

  it("skips an instance evaluated without a host, saying why", () => {
    const p = asPlan([instance("c")]);
    expect(p.layers).toEqual([]);
    expect(p.skipped).toEqual([
      {
        id: "c",
        type: "component",
        reason: "component layer was not evaluated (no component host)",
      },
    ]);
  });

  it("draws an instance as a track matte source", () => {
    const p = asPlan(
      [
        layer("t", "solid", {
          width: 200,
          height: 100,
          color: "#00ff00",
          matte: { layerId: "c", mode: "alpha" },
        }),
        instance("c", { hidden: true }),
      ],
      host,
    );
    expect(p.skipped).toEqual([]);
    const out = compositeReference(p);
    expect(pixel(out, 105, 35)).toEqual([0, 255, 0, 255]);
    expect(pixel(out, 5, 5)).toEqual(CLEAR);
  });
});

describe("3D layers (not drawn yet)", () => {
  it("are skipped with a reason and left out of the plan; 2D layers still draw", () => {
    const solid3d = layer("deep", "solid", {
      width: 10,
      height: 10,
      color: "#00ff00",
      threeD: true,
      transform: transform({ position: prop([20, 20]) }),
    });
    const flat = shapeLayer("flat", [rect([50, 50], [20, 10]), fill()]);
    const p = plan([solid3d, flat]);
    expect(p.skipped).toEqual([
      { id: "deep", type: "solid", reason: "3D layers are not drawn yet" },
    ]);
    expect(p.layers.map((l) => l.id)).toEqual(["flat"]);
  });
});

describe("generator layers", () => {
  const stripes = (thickness = 1) => ({
    type: "pattern",
    kind: "stripes",
    size: prop(4),
    thickness: prop(thickness),
    angle: prop(0),
    offset: prop([0, 0]),
    foreground: prop("#ff0000"),
    background: prop("#0000ff"),
  });

  it("plan as layer-space layers without a raster, placed by their matrix", () => {
    const p = plan([
      layer("g", "generator", {
        width: 20,
        height: 10,
        generator: stripes(),
        transform: transform({ position: prop([30, 40]) }),
      }),
    ]);
    const l = only(p);
    expect(p.skipped).toEqual([]);
    expect(l.type).toBe("generator");
    if (l.type !== "generator") return;
    expect(l.space).toBe("layer");
    expect([l.width, l.height]).toEqual([20, 10]);
    expect(l.matrix).toEqual([1, 0, 0, 1, 30, 40]);
    expect(l.generator.type).toBe("pattern");
    expect("raster" in l).toBe(false);
    const out = compositeReference(p);
    expect(pixel(out, 35, 45)).toEqual(RED);
    expect(pixel(out, 29, 45)).toEqual(CLEAR);
  });

  it("carry only the look effects that change pixels", () => {
    const vignette = (amount: number) => ({
      id: "v",
      type: "vignette",
      amount: prop(amount),
      radius: prop(0.5),
      feather: prop(0.5),
      color: prop("#000000"),
    });
    const withLook = (effects: Obj[]) =>
      only(plan([layer("g", "generator", { width: 8, height: 8, generator: stripes(), effects })]));
    expect(withLook([vignette(0.5)]).effects).toHaveLength(1);
    expect(withLook([vignette(0)]).effects).toBeUndefined();
  });
});

describe("raster budget", () => {
  it("skips exactly the layer types the capability manifest marks accepted", async () => {
    const bytes = await encodeImage(4, 2, () => [255, 255, 255, 255], "png");
    const asset = AssetSchema.parse({
      id: "img",
      name: "img",
      type: "image",
      uri: "assets/img.png",
      sha256: sha256(bytes),
      width: 4,
      height: 2,
    }) as ImageAsset;
    const images = new ImageLibrary(ck);
    await images.add(asset, bytes);
    const clip = AssetSchema.parse({
      id: "clip",
      name: "clip",
      type: "video",
      uri: `assets/${"0".repeat(64)}.json`,
      sha256: "0".repeat(64),
      width: 4,
      height: 2,
      fps: { num: 30, den: 1 },
      frameCount: 90,
    }) as VideoAsset;
    const videos = new VideoFrameLibrary(ck);
    videos.add(clip, 0, bytes);
    const one: Record<string, Obj> = {
      shape: shapeLayer("shape", [rect([10, 10], [10, 10]), fill()]),
      text: textLayer("text", "Hi", { transform: transform({ position: prop([20, 60]) }) }),
      image: layer("image", "image", { assetId: "img" }),
      video: layer("video", "video", { assetId: "clip" }),
      solid: layer("solid", "solid", { width: 10, height: 10, color: "#ff0000" }),
      generator: layer("generator", "generator", {
        width: 10,
        height: 10,
        generator: {
          type: "pattern",
          kind: "stripes",
          size: prop(4),
          thickness: prop(0.5),
          angle: prop(0),
          offset: prop([0, 0]),
          foreground: prop("#ffffff"),
          background: prop("#000000"),
        },
      }),
      precomp: layer("precomp", "precomp", { compositionId: "inner" }),
      adjustment: layer("adjustment", "adjustment", {
        effects: [{ id: "fill", type: "fill", color: prop("#ff0000"), amount: prop(1) }],
      }),
      component: layer("component", "component", {
        componentId: "badge",
        componentVersion: "1.0.0",
        props: {},
      }),
      null: layer("null", "null"),
      camera: layer("camera", "null", { type: "camera", zoom: prop(2000), pointOfInterest: null }),
      audio: layer("audio", "audio", { assetId: "img", volume: prop(1) }),
    };
    expect(Object.keys(one).sort()).toEqual(
      LayerSchema.options.map((o) => o.shape.type.value).sort(),
    );
    for (const [type, fixture] of Object.entries(one)) {
      if (type === "audio") continue; // not a frame layer: the engine resolves it as sound
      const inner = composition("inner", [
        layer("dot", "solid", { width: 10, height: 10, color: "#ff0000" }),
      ]);
      const doc = project([composition("main", [fixture]), inner], { assets: [asset, clip] });
      const p = rasterizeFrame(ck, evaluateFrame(doc, 0), { ...res(images), videos });
      const support = LAYER_SUPPORT[type as keyof typeof LAYER_SUPPORT];
      const skipped = p.skipped.find((s) => s.id === type);
      // A component instance evaluated without a host is the one renderable type that is skipped.
      const expectSkipped = support.status === "accepted" || type === "component";
      expect(skipped !== undefined, type).toBe(expectSkipped);
      if (skipped !== undefined && support.status === "accepted")
        expect(skipped.reason).toBe(support.reason);
      if (type !== "null" && type !== "camera")
        expect(
          p.layers.some((l) => l.id === type),
          type,
        ).toBe(skipped === undefined);
    }
  });

  it("refuses a frame, precomps included, once it would pass the pixel limit", () => {
    const doc = project([
      composition("main", [
        layer("p", "precomp", { compositionId: "inner" }),
        layer("s", "solid", { width: 10, height: 10, color: "#ff0000" }),
      ]),
      composition("inner", [layer("t", "solid", { width: 10, height: 10, color: "#ff0000" })]),
    ]);
    const frame = evaluateFrame(doc, 0);
    const images = new ImageLibrary(ck);
    expect(rasterizeFrame(ck, frame, res(images), { maxRasterPixels: 200 }).layers).toHaveLength(2);
    expect(() => rasterizeFrame(ck, frame, res(images), { maxRasterPixels: 199 })).toThrow(
      /needs more than 199 raster pixels/,
    );
    expect(MAX_FRAME_RASTER_PIXELS).toBe(2 ** 28);
  });

  it("counts shape rasters at their cropped size, and refuses before allocating", () => {
    // A 20×10 rect crops to 22×12 = 264 pixels with the anti-aliasing pad.
    const frame = frameOf([shapeLayer("s", [rect([50, 50], [20, 10]), fill()])]);
    const images = new ImageLibrary(ck);
    expect(rasterizeFrame(ck, frame, res(images), { maxRasterPixels: 264 }).layers).toHaveLength(1);
    expect(() => rasterizeFrame(ck, frame, res(images), { maxRasterPixels: 263 })).toThrow(
      /needs more than 263 raster pixels/,
    );
  });
});

describe("generator raster budget", () => {
  const pattern = {
    type: "pattern",
    kind: "stripes",
    size: prop(4),
    thickness: prop(0.5),
    angle: prop(0),
    offset: prop([0, 0]),
    foreground: prop("#ff0000"),
    background: prop("#0000ff"),
  };
  const gen = (id: string, extra: Obj = {}) =>
    layer(id, "generator", { width: 10, height: 10, generator: pattern, ...extra });

  it("counts a generator's target against the frame's raster pixels", () => {
    const frame = frameOf([gen("a"), gen("b")]);
    const images = new ImageLibrary(ck);
    expect(rasterizeFrame(ck, frame, res(images), { maxRasterPixels: 200 }).layers).toHaveLength(2);
    expect(() => rasterizeFrame(ck, frame, res(images), { maxRasterPixels: 199 })).toThrow(
      /needs more than 199 raster pixels/,
    );
  });

  it("counts a generator used as a matte source once", () => {
    const frame = frameOf([
      layer("t", "solid", {
        width: 10,
        height: 10,
        color: "#ffffff",
        matte: { layerId: "m", mode: "alpha" },
      }),
      gen("m", { hidden: true }),
    ]);
    const images = new ImageLibrary(ck);
    expect(() => rasterizeFrame(ck, frame, res(images), { maxRasterPixels: 199 })).toThrow(
      /needs more than 199 raster pixels/,
    );
    expect(() => rasterizeFrame(ck, frame, res(images), { maxRasterPixels: 200 })).not.toThrow();
  });
});

describe("determinism", () => {
  const scene = [
    shapeLayer(
      "star",
      [
        {
          id: "st",
          name: "st",
          type: "star",
          position: prop([0, 0]),
          points: 5,
          outerRadius: prop(40),
          innerRadius: prop(18),
          rotation: prop(12),
        },
        stroke(solidPaint("#ffffffd0"), 3.5, {
          join: "round",
          cap: "round",
          dashes: [9, 5],
          dashOffset: prop(2.25),
        }),
        fill(
          {
            type: "linear-gradient",
            start: prop([-40, -40]),
            end: prop([40, 40]),
            stops: prop([
              { offset: 0, color: "#ff5a28" },
              { offset: 0.6, color: "#2878ff99" },
              { offset: 1, color: "#00ffaa" },
            ]),
          },
          { rule: "evenodd" },
        ),
      ],
      {
        transform: transform({
          position: prop([71.3, 48.7]),
          rotation: prop(17.5),
          scale: prop([1.13, 0.91]),
          skew: prop(6),
        }),
      },
    ),
    shapeLayer(
      "ops",
      [
        ellipse([0, 0], [30, 20]),
        {
          id: "pg",
          name: "pg",
          type: "polygon",
          position: prop([12, 6]),
          points: 5,
          radius: prop(14),
          rotation: prop(7),
        },
        roundCorners(3.3),
        stroke(solidPaint("#40e0d0"), 2.5, { cap: "round" }),
        trim(0.07, 0.83, { offset: prop(41), mode: "individual" }),
        repeater(3.6, {
          position: prop([9, 4]),
          rotation: prop(23),
          scale: prop([0.87, 0.87]),
          startOpacity: prop(1),
          endOpacity: prop(0.3),
        }),
      ],
      {
        transform: transform({ position: prop([60, 40]) }),
      },
    ),
    layer("bg", "solid", {
      width: 150,
      height: 90,
      color: "#202830",
      transform: transform({ position: prop([12.4, 4.6]), rotation: prop(3) }),
    }),
  ];

  it("renders the same bytes every time, across fresh CanvasKit instances", async () => {
    const first = sha256(render(scene).pixels);
    expect(sha256(render(scene).pixels)).toBe(first);
    const other = await freshCanvasKit();
    const again = compositeReference(
      rasterizeFrame(other, frameOf(scene), {
        images: new ImageLibrary(other),
        fonts: await bundledFonts(other),
      }),
    );
    expect(sha256(again.pixels)).toBe(first);
  });
});

describe("video layers", () => {
  const clipOf = (overrides: Obj = {}) =>
    AssetSchema.parse({
      id: "clip",
      name: "clip",
      type: "video",
      uri: `assets/${"0".repeat(64)}.json`,
      sha256: "0".repeat(64),
      width: 4,
      height: 2,
      fps: { num: 15, den: 1 },
      frameCount: 2,
      ...overrides,
    }) as VideoAsset;

  it("draw the frame the layer time maps to, exactly like an image of it, and nothing after the clip", async () => {
    const red = await encodeImage(4, 2, () => [255, 0, 0, 255], "png");
    const blue = await encodeImage(4, 2, () => [0, 0, 255, 255], "png");
    const clip = clipOf();
    const videos = new VideoFrameLibrary(ck);
    videos.add(clip, 0, red);
    videos.add(clip, 1, blue);
    const doc = project([composition("main", [layer("v", "video", { assetId: "clip" })])], {
      assets: [clip],
    });
    // 15 fps footage in a 30 fps composition: frames 0–1 show source 0, 2–3 source 1, then none.
    const raster = (frame: number) => {
      const p = rasterizeFrame(ck, evaluateFrame(doc, frame), { ...res(), videos });
      const l = p.layers[0] as (PlannedLayer & { raster?: RasterImage }) | undefined;
      return l?.raster?.pixels.slice(0, 4);
    };
    expect([0, 1, 2, 3].map((f) => [...(raster(f) ?? [])])).toEqual([
      [255, 0, 0, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [0, 0, 255, 255],
    ]);
    expect(raster(4)).toBeUndefined();
  });

  it("refuse a frame that was not loaded, and frames of the wrong size, format or index", async () => {
    const clip = clipOf();
    const doc = project([composition("main", [layer("v", "video", { assetId: "clip" })])], {
      assets: [clip],
    });
    expect(() =>
      rasterizeFrame(ck, evaluateFrame(doc, 0), { ...res(), videos: new VideoFrameLibrary(ck) }),
    ).toThrow(/frame 0 of video asset 'clip', which was not loaded/);
    const videos = new VideoFrameLibrary(ck);
    expect(() => videos.add(clip, 0, encodeImageSync())).toThrow(ImageAssetError);
    const big = await encodeImage(5, 2, () => [0, 0, 0, 255], "jpeg");
    expect(() => videos.add(clip, 0, big)).toThrow(/decodes to 5×2/);
    expect(() => videos.add(clip, 2, big)).toThrow(/frames 0 to 1/);
  });
});

const encodeImageSync = () => new TextEncoder().encode("GIF89a not a frame");
