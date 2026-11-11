import { evaluateFrame, type ResolvedComponentLayer } from "@kynimo/engine";
import { keynote, playfulSaas, scaleFor } from "@kynimo/guidelines";
import type { ComponentLayer } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { type ComponentDefinition, type ComponentEvalContext, defineComponent } from "./define.js";
import {
  audioAsset,
  badge,
  imageAsset,
  instance,
  kf,
  layer,
  type Obj,
  project,
  prop,
  solid,
} from "./fixtures.test-util.js";
import { createComponentHost } from "./host.js";
import { createComponentRegistry } from "./registry.js";

const ctx = (
  over: Partial<Parameters<ReturnType<typeof createComponentHost>["evaluate"]>[1]> = {},
) => ({
  frame: 0,
  fps: { num: 30, den: 1 },
  durationFrames: 90,
  width: 1920,
  height: 1080,
  seed: 1234,
  depth: 1,
  ...over,
});

/** Defines a component whose evaluate is `fn`, with the given props, id "probe". */
const probe = (
  fn: (props: Record<string, unknown>, ctx: ComponentEvalContext) => unknown,
  props: ComponentDefinition["props"] = {},
) =>
  defineComponent({
    id: "probe",
    version: "1.0.0",
    title: "Probe",
    description: "Test component.",
    props,
    evaluate: fn as ComponentDefinition["evaluate"],
  });

const inst = (over: Obj = {}, props: Obj = {}) =>
  instance("inst", props, { componentId: "probe", ...over });

const hostFor = (def: ComponentDefinition, layers: Obj[] = [inst()], docOver: Obj = {}) => {
  const doc = project(layers, docOver);
  const host = createComponentHost(doc, createComponentRegistry([def]));
  const target = doc.compositions[0]?.layers.find((l) => l.id === "inst") as ComponentLayer;
  return { doc, host, target };
};

const empty = { width: 100, height: 100, layers: [] };

describe("component host: lookup", () => {
  it("lists available ids for an unknown component", () => {
    const { host, target } = hostFor(
      probe(() => empty),
      [inst({ componentId: "nope" })],
    );
    expect(() => host.evaluate(target, ctx())).toThrow(
      new RangeError("layer 'inst': no component 'nope'; available: probe"),
    );
  });

  it("says none are available for an empty registry", () => {
    const doc = project([inst()]);
    const host = createComponentHost(doc, createComponentRegistry([]));
    expect(() => host.evaluate(doc.compositions[0]?.layers[0] as ComponentLayer, ctx())).toThrow(
      /no component 'probe'; available: none/,
    );
  });

  it("lists the versions of a known component for an unknown version", () => {
    const { host, target } = hostFor(
      probe(() => empty),
      [inst({ componentVersion: "2.0.0" })],
    );
    expect(() => host.evaluate(target, ctx())).toThrow(
      /component 'probe' has no version '2\.0\.0'; available versions: 1\.0\.0/,
    );
  });

  it("limits the listed versions and ids", () => {
    const versions = Array.from({ length: 8 }, (_, i) =>
      defineComponent({ ...probe(() => empty), version: `1.${i}.0` }),
    );
    const doc = project([inst({ componentVersion: "9.0.0" })]);
    const host = createComponentHost(doc, createComponentRegistry(versions));
    expect(() => host.evaluate(doc.compositions[0]?.layers[0] as ComponentLayer, ctx())).toThrow(
      /available versions: 1\.3\.0, 1\.4\.0, 1\.5\.0, 1\.6\.0, 1\.7\.0, \.\.\./,
    );
    const many = Array.from({ length: 12 }, (_, i) =>
      defineComponent({ ...probe(() => empty), id: `c${String(i).padStart(2, "0")}` }),
    );
    const host2 = createComponentHost(doc, createComponentRegistry(many));
    expect(() => host2.evaluate(doc.compositions[0]?.layers[0] as ComponentLayer, ctx())).toThrow(
      /available: c00, c01, c02, c03, c04, c05, c06, c07, c08, c09, \.\.\./,
    );
  });

  it("names a pinned style pack this build doesn't have", () => {
    const { host, target } = hostFor(
      probe(() => empty),
      [inst()],
      {
        style: { packId: "ghost", version: "9.9.9" },
      },
    );
    expect(() => host.evaluate(target, ctx())).toThrow(/ghost@9\.9\.9, which isn't in this build/);
  });
});

describe("component host: evaluate", () => {
  it("wraps every error thrown by evaluate, bounded", () => {
    const wrapped = (thrown: unknown): string => {
      const h = hostFor(
        probe(() => {
          throw thrown;
        }),
      );
      let message = "";
      expect(() => {
        try {
          h.host.evaluate(h.target, ctx());
        } catch (e) {
          expect(e).toBeInstanceOf(RangeError);
          message = (e as Error).message;
          throw e;
        }
      }).toThrow();
      return message;
    };
    expect(wrapped(new TypeError("x is undefined"))).toBe(
      "component 'probe@1.0.0' on layer 'inst' failed: x is undefined",
    );
    expect(wrapped(new RangeError("mine"))).toBe(
      "component 'probe@1.0.0' on layer 'inst' failed: mine",
    );
    expect(wrapped("plain string")).toBe(
      "component 'probe@1.0.0' on layer 'inst' failed: plain string",
    );
    expect(wrapped(new Error("z".repeat(1000))).length).toBeLessThan(300);
    const huge = wrapped(new RangeError("r".repeat(100_000)));
    expect(huge.length).toBeLessThan(400);
    expect(huge).toMatch(/component 'probe@1\.0\.0' on layer 'inst'/);
  });

  it("bounds the error for a huge unknown prop key", () => {
    const { host, target } = hostFor(
      probe(() => empty),
      [inst({}, { ["k".repeat(1_000_000)]: 1 })],
    );
    let message = "";
    expect(() => {
      try {
        host.evaluate(target, ctx());
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    }).toThrow(/not a prop/);
    expect(message.length).toBeLessThan(400);
  });

  it("gives the same random sequence for the same seed, in [0, 1)", () => {
    const runs: number[][] = [];
    const { host, target } = hostFor(
      probe((_p, c) => {
        runs.push(Array.from({ length: 20 }, () => c.random()));
        return empty;
      }),
    );
    host.evaluate(target, ctx());
    host.evaluate(target, ctx());
    host.evaluate(target, ctx({ seed: 99 }));
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]).not.toEqual(runs[2]);
    for (const v of runs[0] ?? []) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("passes the engine context through and resolved props", () => {
    let seen: ComponentEvalContext | undefined;
    let seenProps: Record<string, unknown> = {};
    const { host, target } = hostFor(
      probe(
        (p, c) => {
          seen = c;
          seenProps = p;
          return empty;
        },
        { n: { type: "number", description: "n", default: 3 } },
      ),
      [inst({}, {})],
    );
    host.evaluate(target, ctx({ frame: 7, depth: 2 }));
    expect(seen).toMatchObject({ frame: 7, depth: 2, seed: 1234, width: 1920, height: 1080 });
    expect(seenProps).toEqual({ n: 3 });
  });

  it("reports bad props with the instance named", () => {
    const { host, target } = hostFor(
      probe(() => empty, { n: { type: "number", description: "n", default: 3, max: 5 } }),
      [inst({}, { n: 9 })],
    );
    expect(() => host.evaluate(target, ctx())).toThrow(
      /^component 'probe@1\.0\.0' on layer 'inst': props\.n must be a number of at most 5/,
    );
  });
});

describe("component host: style helpers", () => {
  const sample = (width: number, height: number, pack = keynote) => {
    let style: ComponentEvalContext["style"] | undefined;
    const { host, target } = hostFor(
      probe((_p, c) => {
        style = c.style;
        return empty;
      }),
      [inst()],
      pack === keynote ? {} : { style: { packId: pack.id, version: pack.version } },
    );
    host.evaluate(target, ctx({ width, height }));
    return style as ComponentEvalContext["style"];
  };

  it("scales pixel tokens by the shorter side", () => {
    const wide = sample(1920, 1080);
    const tall = sample(1080, 1920);
    expect(wide.scale).toBe(1);
    expect(tall.scale).toBe(1);
    expect(wide.type("title").size).toBe(keynote.type.title.size);
    const small = sample(960, 540);
    expect(small.scale).toBe(scaleFor({ width: 960, height: 540 }));
    expect(small.type("title").size).toBe(keynote.type.title.size * 0.5);
    expect(small.type("title").family).toBe(keynote.type.title.family);
    expect(small.spacing("m")).toBe(keynote.layout.spacing.m * 0.5);
    expect(small.distance("base")).toBe(keynote.motion.distance.base * 0.5);
    expect(sample(2160, 3840).spacing("m")).toBe(keynote.layout.spacing.m * 2);
  });

  it("resolves motion tokens at the frame rate and colors from the pack", () => {
    const style = sample(1920, 1080);
    expect(style.frames("base")).toBe(Math.round((keynote.motion.durations.base * 30) / 1000));
    expect(style.stagger("base")).toBeGreaterThan(0);
    expect(style.easing("enter")).toEqual(keynote.motion.easings.enter);
    expect(style.easing("gentle")).toEqual({ type: "spring", ...keynote.motion.springs.gentle });
    expect(style.color("accent")).toBe(keynote.color.accent);
    expect(style.pack).toBe(keynote);
    expect(sample(1920, 1080, playfulSaas).color("accent")).toBe(playfulSaas.color.accent);
  });
});

describe("component host: assetSize", () => {
  it("returns the pixel size of image and video assets, null otherwise", () => {
    const seen: Record<string, unknown> = {};
    const { host, target } = hostFor(
      probe((_p, c) => {
        for (const id of ["pic", "clip", "song", "ghost"]) seen[id] = c.assetSize(id);
        return empty;
      }),
      [inst()],
      {
        assets: [
          { ...imageAsset("pic"), width: 640, height: 360 },
          {
            id: "clip",
            name: "clip",
            type: "video",
            uri: "assets/clip.mp4",
            sha256: "0".repeat(64),
            width: 1280,
            height: 720,
            fps: { num: 30, den: 1 },
            frameCount: 30,
          },
          audioAsset("song"),
        ],
      },
    );
    host.evaluate(target, ctx());
    expect(seen).toEqual({
      pic: { width: 640, height: 360 },
      clip: { width: 1280, height: 720 },
      song: null,
      ghost: null,
    });
  });
});

describe("component host: output validation", () => {
  const outputOf = (output: unknown) => {
    const { host, target } = hostFor(probe(() => output));
    return () => host.evaluate(target, ctx());
  };

  it("parses a valid subtree into a composition with defaults filled", () => {
    const comp = outputOf({ ...empty, layers: [solid("a")] })();
    expect(comp).toMatchObject({
      width: 100,
      height: 100,
      background: null,
      fps: { num: 30, den: 1 },
    });
    expect(comp.durationFrames).toBe(90);
    expect(comp.layers[0]).toMatchObject({ id: "a", type: "solid", effects: [] });
  });

  it("keeps the subtree long enough for the frame", () => {
    const { host, target } = hostFor(probe(() => empty));
    expect(host.evaluate(target, ctx({ frame: 200, durationFrames: 10 })).durationFrames).toBe(201);
  });

  it("rejects a bad layer field with its path", () => {
    expect(outputOf({ ...empty, layers: [solid("a", { color: "red" })] })).toThrow(
      /^component 'probe@1\.0\.0' on layer 'inst' returned an invalid subtree: layers\[0\]\.color: /,
    );
  });

  it("rejects a bad size", () => {
    expect(outputOf({ width: 0, height: 100, layers: [] })).toThrow(/invalid subtree: width: /);
  });

  it("rejects precomp layers", () => {
    expect(
      outputOf({ ...empty, layers: [layer("p", "precomp", { compositionId: "main" })] }),
    ).toThrow(/layers\[0\]\.type: components cannot output precomp layers/);
  });

  it("rejects audio layers", () => {
    expect(
      outputOf({ ...empty, layers: [layer("a", "audio", { assetId: "song", volume: prop(1) })] }),
    ).toThrow(/layers\[0\]\.type: components cannot output audio layers/);
  });

  it("rejects duplicate layer ids", () => {
    expect(outputOf({ ...empty, layers: [solid("a"), solid("a")] })).toThrow(
      /invalid subtree: layers\[1\]\.id: /,
    );
  });

  it("rejects output that is not an object, and bad layers lists", () => {
    expect(outputOf(null)).toThrow(/invalid subtree: output: /);
    expect(outputOf({ width: 1, height: 1, layers: "no" })).toThrow(/invalid subtree: layers: /);
  });

  it("truncates long messages", () => {
    const run = outputOf({ ...empty, layers: [solid("a", { color: "x".repeat(2000) })] });
    expect(run).toThrow(RangeError);
    try {
      run();
    } catch (e) {
      expect((e as Error).message.length).toBeLessThanOrEqual(300);
    }
  });

  it("lets image layers use the project's assets and rejects unknown ones", () => {
    const withAsset = hostFor(
      probe(() => ({ ...empty, layers: [layer("img", "image", { assetId: "logo" })] })),
      [inst()],
      { assets: [imageAsset("logo"), audioAsset("song")] },
    );
    expect(withAsset.host.evaluate(withAsset.target, ctx()).layers[0]).toMatchObject({
      assetId: "logo",
    });
    const without = hostFor(
      probe(() => ({ ...empty, layers: [layer("img", "image", { assetId: "ghost" })] })),
    );
    expect(() => without.host.evaluate(without.target, ctx())).toThrow(/layers\[0\]\.assetId: /);
  });

  it("allows nested component layers in the output", () => {
    const comp = outputOf({
      ...empty,
      layers: [instance("deeper", {}, { componentId: "probe" })],
    })();
    expect(comp.layers[0]).toMatchObject({ type: "component" });
  });
});

describe("component host with evaluateFrame", () => {
  const doc = (style: Obj | null = null, props: Obj = {}) =>
    project(
      [
        instance("inst", props, {
          startFrame: 0,
          outFrame: 60,
        }),
      ],
      { style },
    );
  const run = (project: ReturnType<typeof doc>, frame: number) =>
    evaluateFrame(project, frame, undefined, {
      components: createComponentHost(project, createComponentRegistry([badge])),
    });
  const inner = (project: ReturnType<typeof doc>, frame: number) =>
    (run(project, frame).layers[0] as ResolvedComponentLayer).composition;

  it("evaluates the same document identically twice", () => {
    const d = doc(null, { label: "Hello", scale: { keyframes: [kf(0, 0.5), kf(30, 2)] } });
    expect(run(d, 12)).toEqual(run(d, 12));
    expect(JSON.stringify(run(d, 12))).toBe(JSON.stringify(run(d, 12)));
  });

  it("samples animatable props at the layer's frame", () => {
    const d = doc(null, { scale: { keyframes: [kf(0, 1), kf(30, 2)] } });
    const plate = (frame: number) =>
      inner(d, frame)?.layers.find((l) => l.id === "plate")?.transform.scale;
    expect(plate(0)).toEqual([1, 1]);
    expect(plate(15)).toEqual([1.5, 1.5]);
    expect(plate(45)).toEqual([2, 2]);
  });

  it("restyles when the project switches built-in pack", () => {
    const colorOf = (d: ReturnType<typeof doc>) => {
      const plate = inner(d, 0)?.layers.find((l) => l.id === "plate");
      return plate?.type === "solid" ? plate.color : undefined;
    };
    const keynoteColor = colorOf(doc());
    expect(keynoteColor).toEqual(colorOf(doc({ packId: keynote.id, version: keynote.version })));
    const saasColor = colorOf(doc({ packId: playfulSaas.id, version: playfulSaas.version }));
    expect(saasColor).not.toEqual(keynoteColor);
  });

  it("sizes type from the pack and the composition", () => {
    const text = inner(doc(), 0)?.layers.find((l) => l.id === "label");
    expect(text?.type === "text" && text.font.size).toBe(keynote.type.title.size);
  });

  it("surfaces prop errors from evaluateFrame", () => {
    expect(() => run(doc(null, { scale: 9 }), 0)).toThrow(
      /props\.scale must be a number from 0\.5 to 2/,
    );
  });

  it("does not call the host before the instance starts", () => {
    const d = project([instance("inst", {}, { startFrame: 20, inFrame: 0, outFrame: 90 })]);
    expect((run(d, 5).layers[0] as ResolvedComponentLayer).composition).toBeNull();
  });
});
