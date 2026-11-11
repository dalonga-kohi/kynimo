import { type ComponentLayer, type Composition, CompositionSchema } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import {
  COMPONENT_COST_WEIGHT,
  type ComponentContext,
  type ComponentHost,
  MAX_COMPONENT_DEPTH,
} from "./component.js";
import { evaluateFrame, MAX_EVALUATION_UNITS } from "./evaluate.js";
import { composition, layer, type Obj, project, prop, solid } from "./fixtures.test-util.js";
import { hashWords } from "./hash.js";
import type { ResolvedComponentLayer, ResolvedComposition } from "./resolved.js";

const instance = (id: string, over: Obj = {}) =>
  layer(id, "component", {
    componentId: "badge",
    componentVersion: "1.0.0",
    props: { title: "Hi" },
    ...over,
  });

const out = (layers: Obj[], over: Obj = {}) =>
  composition("component", layers, { durationFrames: 90, background: null, ...over }) as Obj;

/** A fake host: records calls and returns `make(layer, ctx)` (validated as a composition by the caller's fixtures). */
function fakeHost(make: (layer: ComponentLayer, ctx: ComponentContext) => Obj) {
  const calls: { layer: ComponentLayer; ctx: ComponentContext }[] = [];
  const host: ComponentHost = {
    evaluate(l, ctx) {
      calls.push({ layer: l, ctx });
      return CompositionSchema.parse(make(l, ctx));
    },
  };
  return { host, calls };
}

const only = (resolved: ResolvedComposition, index = 0) =>
  resolved.layers[index] as ResolvedComponentLayer;

describe("evaluateFrame: component layers", () => {
  it("passes instances through with composition null when there is no host", () => {
    const doc = project([composition("main", [instance("cmp")])]);
    expect(only(evaluateFrame(doc, 3))).toMatchObject({
      type: "component",
      componentId: "badge",
      props: { title: "Hi" },
      composition: null,
    });
  });

  it("calls the host with the layer-local context and resolves the subtree at that frame", () => {
    const { host, calls } = fakeHost(() =>
      out([
        solid("inner", {
          transform: {
            anchorPoint: prop([0, 0]),
            position: prop([0, 0]),
            scale: prop([1, 1]),
            rotation: prop(0),
            skew: prop(0),
            opacity: {
              keyframes: [
                { frame: 0, value: 0, interpolation: { type: "linear" } },
                { frame: 10, value: 1, interpolation: { type: "linear" } },
              ],
            },
          },
        }),
      ]),
    );
    const doc = project([
      composition("main", [instance("cmp", { startFrame: 5, inFrame: 5, outFrame: 65 })], {
        width: 1280,
        height: 720,
        fps: { num: 30, den: 1 },
      }),
    ]);
    const resolved = only(evaluateFrame(doc, 10, undefined, { components: host }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ctx).toMatchObject({
      frame: 5,
      fps: { num: 30, den: 1 },
      durationFrames: 60,
      width: 1280,
      height: 720,
      depth: 1,
    });
    expect(resolved.layerFrame).toBe(5);
    expect(resolved.composition?.frame).toBe(5);
    expect(resolved.composition?.layers[0]?.transform.opacity).toBeCloseTo(0.5, 12);
  });

  it("derives a stable seed from the layer id", () => {
    const seeds: Record<string, number[]> = {};
    const { host } = fakeHost((l, ctx) => {
      seeds[l.id] = [...(seeds[l.id] ?? []), ctx.seed];
      return out([]);
    });
    const doc = project([composition("main", [instance("a"), instance("b")])]);
    evaluateFrame(doc, 0, undefined, { components: host });
    evaluateFrame(doc, 7, undefined, { components: host });
    expect(seeds.a?.[0]).toBe(seeds.a?.[1]);
    expect(seeds.b?.[0]).toBe(seeds.b?.[1]);
    expect(seeds.a?.[0]).not.toBe(seeds.b?.[0]);
    expect(Number.isInteger(seeds.a?.[0])).toBe(true);
  });

  it("chains seeds through nesting, leaving root instances on the plain derivation", () => {
    const seen: { id: string; depth: number; seed: number }[] = [];
    const { host } = fakeHost((l, ctx) => {
      seen.push({ id: l.id, depth: ctx.depth, seed: ctx.seed });
      return ctx.depth === 1 ? out([instance("i1")]) : out([]);
    });
    const doc = project([composition("main", [instance("a"), instance("b")])]);
    evaluateFrame(doc, 0, undefined, { components: host });
    const inner = seen.filter((c) => c.id === "i1");
    expect(inner).toHaveLength(2);
    expect(inner[0]?.seed).not.toBe(inner[1]?.seed);
    // A root instance's seed is hashWords(0, code units of its id).
    expect(seen.find((c) => c.id === "a")?.seed).toBe(hashWords(0, [97]));
    expect(seen.find((c) => c.id === "b")?.seed).toBe(hashWords(0, [98]));
    expect(inner[0]?.seed).toBe(hashWords(hashWords(0, [97]), [105, 49]));
  });

  it("returns null without calling the host before the instance has started", () => {
    const { host, calls } = fakeHost(() => out([]));
    const doc = project([
      composition("main", [instance("cmp", { startFrame: 20, inFrame: 0, outFrame: 90 })]),
    ]);
    // inFrame 0 < startFrame 20: the layer is active at frame 10 but its local frame is -10.
    expect(only(evaluateFrame(doc, 10, undefined, { components: host })).composition).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("recurses into nested instances and counts depth", () => {
    const depths: number[] = [];
    const { host } = fakeHost((_l, ctx) => {
      depths.push(ctx.depth);
      return ctx.depth < 3 ? out([instance(`inner-${ctx.depth}`)]) : out([solid("leaf")]);
    });
    const doc = project([composition("main", [instance("cmp")])]);
    const resolved = only(evaluateFrame(doc, 0, undefined, { components: host }));
    expect(depths).toEqual([1, 2, 3]);
    const level2 = only(resolved.composition as ResolvedComposition);
    const level3 = only(level2.composition as ResolvedComposition);
    expect(level3.composition?.layers[0]?.id).toBe("leaf");
  });

  it("throws past the nesting limit and names the chain", () => {
    const { host } = fakeHost((_l, ctx) => out([instance(`n${ctx.depth}`)]));
    const doc = project([composition("main", [instance("cmp")])]);
    expect(() => evaluateFrame(doc, 0, undefined, { components: host })).toThrow(
      new RegExp(
        `component layer 'n${MAX_COMPONENT_DEPTH}' nests components deeper than ${MAX_COMPONENT_DEPTH} levels \\(via cmp > n1 > n2 > n3 > n4\\)`,
      ),
    );
  });

  it("rejects a subtree at another frame rate", () => {
    const { host } = fakeHost(() => out([], { fps: { num: 24, den: 1 } }));
    const doc = project([composition("main", [instance("cmp")])]);
    expect(() => evaluateFrame(doc, 0, undefined, { components: host })).toThrow(
      /'cmp'.*24\/1 fps.*30\/1/,
    );
  });

  it("rejects a subtree too short for the local frame", () => {
    const { host } = fakeHost(() => out([], { durationFrames: 5 }));
    const doc = project([composition("main", [instance("cmp")])]);
    expect(() => evaluateFrame(doc, 4, undefined, { components: host })).not.toThrow();
    expect(() => evaluateFrame(doc, 5, undefined, { components: host })).toThrow(
      /'cmp'.*5 frames.*local frame 5/,
    );
  });

  it("charges component output against the evaluation budget", () => {
    // 33 x 33 = 1089 leaf instances, each a subtree of 1000 layers: 1.089M units. Hidden layers keep
    // the test fast: they cost budget but are not resolved.
    const hidden = CompositionSchema.parse(
      out(Array.from({ length: 1000 }, (_, i) => solid(`s${i}`, { hidden: true }))),
    );
    const fan = CompositionSchema.parse(
      out(Array.from({ length: 33 }, (_, i) => instance(`c${i}`))),
    );
    const host: ComponentHost = {
      evaluate: (_l, ctx) => (ctx.depth < 3 ? fan : hidden),
    };
    const doc = project([composition("main", [instance("cmp")])]);
    expect(() => evaluateFrame(doc, 0, undefined, { components: host })).toThrow(
      /more than 1000000 units of work.*component layer 'c\d+'/,
    );
    const shallow: ComponentHost = { evaluate: () => hidden };
    expect(() => evaluateFrame(doc, 0, undefined, { components: shallow })).not.toThrow();
  });

  it("charges a prop-driven component by its output size, weighted by COMPONENT_COST_WEIGHT", () => {
    const outputs = new Map<number, Composition>();
    const host: ComponentHost = {
      evaluate(l) {
        const count = l.props.count as number;
        let c = outputs.get(count);
        if (c === undefined) {
          c = CompositionSchema.parse(
            out(Array.from({ length: count }, (_, i) => solid(`s${i}`, { hidden: true }))),
          );
          outputs.set(count, c);
        }
        return c;
      },
    };
    // Unweighted, 100 x 1000 layers is 100k units; weighted by 16 it is 1.6M and exceeds the budget.
    const place = (n: number, count: number) =>
      project([
        composition(
          "main",
          Array.from({ length: n }, (_, i) => instance(`c${i}`, { props: { count } })),
        ),
      ]);
    expect(() => evaluateFrame(place(100, 1000), 0, undefined, { components: host })).toThrow(
      new RegExp(`more than ${MAX_EVALUATION_UNITS} units of work.*${COMPONENT_COST_WEIGHT} times`),
    );
    expect(() => evaluateFrame(place(10, 1000), 0, undefined, { components: host })).not.toThrow();
  });
});
