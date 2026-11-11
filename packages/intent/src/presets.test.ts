import { keynote } from "@kynimo/guidelines";
import { describe, expect, it } from "vitest";
import { IntentError } from "./errors.js";
import {
  animator,
  applied,
  doc,
  layerOf,
  lid,
  prop,
  rect,
  shape,
  solid,
  text,
} from "./fixtures.test-util.js";
import { applyPreset, PRESETS, presetCatalog, typedCharacters } from "./presets.js";

const sha = "a".repeat(64);
const imageAsset = {
  id: "img",
  name: "img",
  type: "image",
  uri: "assets/img.png",
  sha256: sha,
  width: 640,
  height: 360,
};
const videoAsset = {
  ...imageAsset,
  id: "vid",
  type: "video",
  uri: "assets/vid.json",
  width: 1280,
  height: 720,
  fps: { num: 30, den: 1 },
  frameCount: 90,
};
const image = (id: string) => ({ ...solid(id), type: "image", assetId: "img" });
const video = (id: string) => ({ ...solid(id), type: "video", assetId: "vid" });
const delete_ = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) delete o[k];
  return o;
};
const asImage = (id: string) => delete_(image(id), "width", "height", "color");
const asVideo = (id: string) => delete_(video(id), "width", "height", "color");

const fixtures = (id: string): Record<string, Record<string, unknown>> => ({
  solid: solid(id),
  text: text(id, { box: { mode: "box", width: prop(300), height: prop(80), autoFit: false } }),
  shape: shape(id, [rect("r")]),
  image: asImage(id),
  video: asVideo(id),
  null: delete_(
    { ...solid(id), type: "null" },
    "width",
    "height",
    "color",
    "blendMode",
    "matte",
    "masks",
  ),
});

const project = (layers: Record<string, unknown>[]) =>
  doc(layers, { assets: [imageAsset, videoAsset] });

const FIXTURE_TYPES_BY_PRESET = (p: (typeof PRESETS)[number]) =>
  presetCatalog()
    .find((c) => c.id === p.id)
    ?.layerTypes.filter((t) => t in fixtures("x")) ?? [];

describe("preset catalog", () => {
  it("has stable ids in order", () => {
    expect(presetCatalog().map((p) => p.id)).toEqual([
      "fade-in",
      "fade-up",
      "scale-in",
      "slide-in",
      "pop",
      "mask-reveal",
      "typewriter",
      "word-by-word",
      "draw-on",
      "fade-out",
      "fade-down",
      "scale-out",
      "slide-out",
    ]);
  });

  it("is JSON-serializable with a JSON Schema per preset", () => {
    const catalog = presetCatalog();
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
    for (const p of catalog) {
      expect(p.params).toMatchObject({ type: "object", additionalProperties: false });
      expect(Object.keys((p.params as { properties: object }).properties)).toEqual(
        expect.arrayContaining(["start", "duration", "easing"]),
      );
    }
  });
});

describe("every preset expands and applies on each allowed layer type", () => {
  for (const preset of PRESETS) {
    for (const type of FIXTURE_TYPES_BY_PRESET(preset)) {
      it(`${preset.id} on ${type}`, () => {
        const d = project([fixtures("a")[type] as Record<string, unknown>]);
        const params =
          preset.id === "mask-reveal" && type === "shape"
            ? { box: { x: 0, y: 0, width: 200, height: 100 } }
            : {};
        if (type === "null") return;
        const { ops, resolved } = applyPreset(d, { layers: lid("a"), preset: preset.id, params });
        expect(ops.length).toBeGreaterThan(0);
        expect(resolved.preset).toBe(preset.id);
        applied(d, ops);
      });
    }
    it(`${preset.id} is refused on a disallowed layer type`, () => {
      const allowed = presetCatalog().find((c) => c.id === preset.id)?.layerTypes ?? [];
      const wrong = ["solid", "text", "shape"].find((t) => !allowed.includes(t as never));
      const layer = wrong ?? "null";
      const d = project([fixtures("a")[layer] as Record<string, unknown>]);
      try {
        applyPreset(d, { layers: lid("a"), preset: preset.id });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(IntentError);
        expect((e as IntentError).path).toEqual(["layers"]);
        expect((e as IntentError).message).toContain(`'a' is a ${layer} layer`);
      }
    });
  }
});

const track = (d: ReturnType<typeof doc>, id: string, property: string) =>
  (layerOf(d, id) as unknown as { transform: Record<string, unknown> }).transform[property];

describe("enter and exit timing", () => {
  it("enters at the layer's in frame, exits so they end at the out frame", () => {
    const d = project([solid("a", { inFrame: 10, startFrame: 10, outFrame: 100 })]);
    const enter = applyPreset(d, { layers: lid("a"), preset: "fade-in" });
    expect(enter.resolved).toMatchObject({ start_frames: [10], duration_frames: [18] });
    expect(enter.resolved.easing).toEqual(keynote.motion.easings.enter);
    const exit = applyPreset(d, { layers: lid("a"), preset: "fade-out" });
    expect(exit.resolved).toMatchObject({ start_frames: [82], duration_frames: [18] });
    expect(track(applied(d, exit.ops), "a", "opacity")).toMatchObject({
      keyframes: [
        { frame: 72, value: 1, interpolation: keynote.motion.easings.exit },
        { frame: 90, value: 0, interpolation: { type: "hold" } },
      ],
    });
  });

  it("honors start, duration and easing params", () => {
    const d = project([solid("a")]);
    const { resolved } = applyPreset(d, {
      layers: lid("a"),
      preset: "fade-in",
      params: { start: 20, duration: 500, easing: { type: "linear" } },
    });
    expect(resolved).toMatchObject({
      start_frames: [20],
      duration_frames: [15],
      easing: { type: "linear" },
    });
  });

  it("pop springs and refuses an explicit duration", () => {
    const d = project([solid("a")]);
    const { resolved, ops } = applyPreset(d, { layers: lid("a"), preset: "pop" });
    expect(resolved.easing).toEqual({ type: "spring", ...keynote.motion.springs.bouncy });
    expect(track(applied(d, ops), "a", "scale")).toMatchObject({
      keyframes: [{ value: [0, 0] }, { value: [1, 1] }],
    });
    expect(() =>
      applyPreset(d, { layers: lid("a"), preset: "pop", params: { duration: 300 } }),
    ).toThrow(expect.objectContaining({ path: ["params", "duration"] }));
    // a bezier easing makes the default duration apply
    expect(
      applyPreset(d, { layers: lid("a"), preset: "pop", params: { easing: "enter" } }).resolved
        .duration_frames,
    ).toEqual([18]);
  });
});

describe("transform presets", () => {
  it("fade-up writes opacity and position as separate ops that animate from current", () => {
    const d = project([solid("a", { transform: { position: prop([100, 200]) } })]);
    const { ops } = applyPreset(d, { layers: lid("a"), preset: "fade-up" });
    expect(ops.map((o) => (o as { property: string }).property)).toEqual(["opacity", "position"]);
    const out = applied(d, ops);
    expect(track(out, "a", "position")).toMatchObject({
      keyframes: [{ value: [100, 200 + keynote.motion.distance.base] }, { value: [100, 200] }],
    });
  });

  it("scale-in multiplies the current scale by the style's enter scale", () => {
    const d = project([solid("a", { transform: { scale: prop([2, 2]) } })]);
    const { ops } = applyPreset(d, { layers: lid("a"), preset: "scale-in" });
    const n = keynote.motion.enterScale;
    expect(track(applied(d, ops), "a", "scale")).toMatchObject({
      keyframes: [{ value: [2 * n, 2 * n] }, { value: [2, 2] }],
    });
  });

  it("slide-in and slide-out travel in the direction given", () => {
    const d = project([solid("a")]);
    const dist = keynote.motion.distance.large;
    const into = applyPreset(d, {
      layers: lid("a"),
      preset: "slide-in",
      params: { direction: "left" },
    });
    expect(track(applied(d, into.ops), "a", "position")).toMatchObject({
      keyframes: [{ value: [960 + dist, 540] }, { value: [960, 540] }],
    });
    const out = applyPreset(d, {
      layers: lid("a"),
      preset: "slide-out",
      params: { direction: "up", distance: 50 },
    });
    expect(track(applied(d, out.ops), "a", "position")).toMatchObject({
      keyframes: [{ value: [960, 540] }, { value: [960, 490] }],
    });
  });

  it("scale-out shrinks to the enter scale and fades", () => {
    const d = project([solid("a")]);
    const { ops } = applyPreset(d, { layers: lid("a"), preset: "scale-out" });
    const out = applied(d, ops);
    const n = keynote.motion.enterScale;
    expect(track(out, "a", "scale")).toMatchObject({
      keyframes: [{ value: [1, 1] }, { value: [n, n] }],
    });
    expect(track(out, "a", "opacity")).toMatchObject({ keyframes: [{ value: 1 }, { value: 0 }] });
  });

  it("refuses separate position tracks at the target", () => {
    const d = project([
      solid("a", { transform: { position: { separate: { x: prop(1), y: prop(2) } } } }),
    ]);
    expect(() => applyPreset(d, { layers: lid("a"), preset: "slide-in" })).toThrow(
      expect.objectContaining({ path: ["layers"] }),
    );
  });
});

describe("stagger", () => {
  it("adds each layer's delay to its start", () => {
    const d = project([solid("a"), solid("b"), solid("c")]);
    const { resolved, ops } = applyPreset(d, {
      layers: [lid("a"), lid("b"), lid("c")],
      preset: "fade-in",
      params: { start: 10 },
      stagger: { offset: 100 },
    });
    expect(resolved.start_frames).toEqual([10, 13, 16]);
    expect(resolved.layer_ids).toEqual(["a", "b", "c"]);
    applied(d, ops);
  });
});

describe("params validation", () => {
  const d = project([solid("a")]);
  const fail = (preset: string, params: Record<string, unknown>) => {
    try {
      applyPreset(d, { layers: lid("a"), preset, params });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IntentError);
      return e as IntentError;
    }
  };

  it("points at the offending param", () => {
    expect(fail("slide-in", { direction: "sideways" }).path).toEqual(["params", "direction"]);
    expect(fail("fade-in", { start: 1.5 }).path).toEqual(["params", "start"]);
  });

  it("rejects unknown params naming them", () => {
    const e = fail("fade-in", { cps: 3 });
    expect(e.path).toEqual(["params", "cps"]);
    expect(e.message).toContain("takes start, duration, easing");
  });

  it("lists ids for an unknown preset", () => {
    expect(() => applyPreset(d, { layers: lid("a"), preset: "wobble" })).toThrow(
      expect.objectContaining({ path: ["preset"], message: expect.stringContaining("fade-in") }),
    );
  });
});

describe("typewriter and word-by-word", () => {
  it("counts code points without whitespace", () => {
    expect(typedCharacters("a b\nc")).toBe(3);
    expect(typedCharacters("😀 😀")).toBe(2);
  });

  it("derives its duration from cps", () => {
    const d = project([text("a", { content: prop("Hello world!") })]); // 11 characters
    const def = applyPreset(d, { layers: lid("a"), preset: "typewriter" });
    expect(def.resolved.duration_frames).toEqual([17]); // 550 ms at 30 fps
    expect(def.resolved.easing).toEqual({ type: "linear" });
    const fast = applyPreset(d, { layers: lid("a"), preset: "typewriter", params: { cps: 11 } });
    expect(fast.resolved.duration_frames).toEqual([30]);
    const set = applyPreset(d, {
      layers: lid("a"),
      preset: "typewriter",
      params: { duration: 1000 },
    });
    expect(set.resolved.duration_frames).toEqual([30]);
    const animators = (layerOf(applied(d, def.ops), "a") as unknown as { animators: unknown[] })
      .animators;
    expect(animators).toHaveLength(1);
    expect(animators[0]).toMatchObject({
      selector: {
        unit: "characters",
        start: {
          keyframes: [
            { frame: 0, value: 0 },
            { frame: 17, value: 1 },
          ],
        },
      },
      properties: { opacity: { value: 0 } },
    });
  });

  it("is at least one frame for empty text", () => {
    const d = project([text("a", { content: prop(" ") })]);
    expect(
      applyPreset(d, { layers: lid("a"), preset: "typewriter" }).resolved.duration_frames,
    ).toEqual([1]);
  });

  it("appends to existing animators and refuses at the maximum", () => {
    const d = project([
      text("a", { animators: [animator()] }),
      text("b", { animators: Array.from({ length: 8 }, () => animator()) }),
    ]);
    const out = applied(d, applyPreset(d, { layers: lid("a"), preset: "word-by-word" }).ops);
    expect(
      (layerOf(out, "a") as unknown as { animators: { name: string }[] }).animators.map(
        (x) => x.name,
      ),
    ).toEqual(["Fade", "Word by word"]);
    expect(() => applyPreset(d, { layers: lid("b"), preset: "typewriter" })).toThrow(
      expect.objectContaining({
        path: ["layers"],
        message: expect.stringContaining("8 text animators"),
      }),
    );
  });
});

describe("mask-reveal", () => {
  const maskOf = (d: ReturnType<typeof doc>, id: string) =>
    (
      layerOf(d, id) as unknown as {
        masks: { path: { keyframes: { value: { vertices: { point: number[] }[] } }[] } }[];
      }
    ).masks[0];

  it("defaults the box to a solid's size and sweeps from the left edge", () => {
    const d = project([solid("a")]);
    const mask = maskOf(
      applied(d, applyPreset(d, { layers: lid("a"), preset: "mask-reveal" }).ops),
      "a",
    );
    const [from, to] = (mask?.path.keyframes ?? []).map((k) =>
      k.value.vertices.map((v) => v.point),
    );
    expect(from).toEqual([
      [0, 0],
      [0, 0],
      [0, 100],
      [0, 100],
    ]);
    expect(to).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
  });

  it("reveals from the right edge going left", () => {
    const d = project([solid("a")]);
    const mask = maskOf(
      applied(
        d,
        applyPreset(d, { layers: lid("a"), preset: "mask-reveal", params: { direction: "left" } })
          .ops,
      ),
      "a",
    );
    expect(mask?.path.keyframes[0]?.value.vertices.map((v) => v.point)).toEqual([
      [100, 0],
      [100, 0],
      [100, 100],
      [100, 100],
    ]);
  });

  it("uses image, video and text box sizes", () => {
    const d = project([asImage("i"), asVideo("v"), fixtures("t").text as Record<string, unknown>]);
    const end = (id: string) => {
      const out = applied(d, applyPreset(d, { layers: lid(id), preset: "mask-reveal" }).ops);
      return maskOf(out, id)?.path.keyframes[1]?.value.vertices[2]?.point;
    };
    expect(end("i")).toEqual([640, 360]);
    expect(end("v")).toEqual([1280, 720]);
    expect(end("t")).toEqual([300, 80]);
  });

  it("takes an explicit box", () => {
    const d = project([text("a")]);
    const out = applied(
      d,
      applyPreset(d, {
        layers: lid("a"),
        preset: "mask-reveal",
        params: { box: { x: 5, y: 6, width: 70, height: 20 } },
      }).ops,
    );
    expect(maskOf(out, "a")?.path.keyframes[1]?.value.vertices[2]?.point).toEqual([75, 26]);
  });

  it("refuses point text and shape layers without a box", () => {
    for (const layer of [text("a"), shape("a", [rect("r")])]) {
      const d = project([layer]);
      expect(() => applyPreset(d, { layers: lid("a"), preset: "mask-reveal" })).toThrow(
        expect.objectContaining({
          path: ["params", "box"],
          message: expect.stringContaining("pass params.box"),
        }),
      );
    }
  });
});

describe("draw-on", () => {
  it("appends a trim item with a unique id", () => {
    const d = project([
      shape("a", [
        rect("r"),
        {
          type: "trim",
          id: "draw-on",
          name: "t",
          start: prop(0),
          end: prop(1),
          offset: prop(0),
          mode: "simultaneous",
        },
      ]),
    ]);
    const out = applied(d, applyPreset(d, { layers: lid("a"), preset: "draw-on" }).ops);
    const contents = (
      layerOf(out, "a") as unknown as { contents: { id: string; type: string; end: unknown }[] }
    ).contents;
    expect(contents.map((c) => c.id)).toEqual(["r", "draw-on", "draw-on-2"]);
    expect(contents[2]?.end).toMatchObject({
      keyframes: [
        { frame: 0, value: 0 },
        { frame: 27, value: 1 },
      ],
    });
  });
});
