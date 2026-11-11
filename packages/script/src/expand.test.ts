import { animate, mulberry32, stagger } from "@kynimo/intent";
import { applyOps, MAX_BATCH_OPS, type Op, type Project, withLayerDefaults } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { opNames } from "./declarations.js";
import { type ExpandResult, expandScript, replayEntries } from "./expand.js";
import { baseDoc, HELPERS } from "./fixtures.test-util.js";

const expand = (source: string, doc: Project = baseDoc(), seed?: number): Promise<ExpandResult> =>
  expandScript(
    doc,
    { source: `${HELPERS}\n${source}`, ...(seed === undefined ? {} : { seed }) },
    { idCounter: 0 },
  );

const okOf = (r: ExpandResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r;
};
const errOf = (r: ExpandResult) => {
  if (r.ok) throw new Error(`expected an error, got ${r.ops.length} ops`);
  return r.error;
};
/** The line of `needle` in the full source (helpers included). */
const lineOf = (source: string, needle: string): number =>
  `${HELPERS}\n${source}`.split("\n").findIndex((l) => l.includes(needle)) + 1;

const applyAll = (doc: Project, ops: Op[]): Project => {
  const r = applyOps(doc, ops);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
};

describe("expandScript", () => {
  it("expands builders, intent calls and handles into ops the scene accepts", async () => {
    const source = `
const comp = kynimo.composition();
const headline = comp.add("text", textProps("Headline", "Hello"));
const card = comp.add("shape", shapeProps("Card"));
headline.set("position", [960, 300]);
card.keyframes("opacity", [
  { frame: 0, value: 0, interpolation: { type: "linear" } },
  { frame: 30, value: 1, interpolation: { type: "linear" } },
]);
headline.animate({ property: "scale", from: 0.8, to: 1, duration: "base", easing: "enter" });
kynimo.preset({ layers: [headline, card], preset: "fade-in", stagger: { offset: "tight" } });
kynimo.stagger({ layers: [headline, card], offset: "base" });
`;
    const doc = baseDoc();
    const r = okOf(await expand(source, doc));
    expect(r.layersCreated).toEqual(["layer-1", "layer-2"]);
    expect(r.entries).toBe(7);
    // The whole batch applies on the original document.
    const final = applyAll(doc, r.ops);
    expect(final.compositions[0]?.layers.map((l) => l.id)).toEqual([
      "layer-2",
      "layer-1",
      "title",
      "bg",
    ]);

    // Entry 4 (headline.animate) equals the intent package's own expansion on the doc so far.
    const afterEdits = applyAll(doc, r.ops.slice(0, 4));
    const expected = animate(afterEdits, {
      layers: "layer-1" as never,
      property: "scale",
      from: 0.8,
      to: 1,
      duration: "base",
      easing: "enter",
    });
    expect(r.ops.slice(4, 4 + expected.ops.length)).toEqual(expected.ops);
  });

  it("fills the shared layer fields of a minimal add like add_layer, and applies", async () => {
    const asset = (id: string, over: Record<string, unknown>) => ({
      id,
      name: id,
      uri: `assets/${id}.bin`,
      sha256: "a".repeat(64),
      ...over,
    });
    const doc = baseDoc({
      assets: [
        asset("img", { type: "image", width: 8, height: 8 }),
        asset("aud", { type: "audio", durationMs: 1000 }),
      ],
    });
    const minimal: Record<string, Record<string, unknown>> = {
      text: {
        name: "T",
        content: { value: "Hi" },
        box: { mode: "point" },
        font: { family: "Inter", weight: 400, size: { value: 48 } },
        tracking: { value: 0 },
        leading: { value: 1.2 },
        align: "left",
        textCase: "none",
        fill: { value: "#ffffff" },
      },
      solid: { name: "S", width: 10, height: 10, color: "#ff0000" },
      shape: { name: "Sh", contents: [] },
      null: { name: "N" },
      image: { name: "I", assetId: "img" },
      adjustment: { name: "Adj" },
      audio: { name: "A", assetId: "aud" },
    };
    for (const [type, props] of Object.entries(minimal)) {
      const source = `kynimo.composition().add("${type}", ${JSON.stringify(props)});`;
      const r = okOf(await expand(source, doc));
      const op = r.ops[0] as Extract<Op, { op: "addLayer" }>;
      expect(op.layer).toEqual(
        withLayerDefaults({ type, ...props }, doc.compositions[0]) as typeof op.layer,
      );
      const layer = applyAll(doc, r.ops).compositions[0]?.layers[0];
      expect(layer?.type).toBe(type);
      expect(layer?.outFrame).toBe(300);
    }
  });

  it("keeps what a minimal add sets and merges a partial transform per property", async () => {
    const r = okOf(
      await expand(`kynimo.composition().add("solid", {
  name: "S", width: 10, height: 10, color: "#ff0000", outFrame: 30, parent: "bg",
  transform: { opacity: { value: 0.5 } },
});`),
    );
    const layer = (r.ops[0] as Extract<Op, { op: "addLayer" }>).layer as unknown as {
      outFrame: number;
      parent: string;
      transform: { opacity: unknown; position: unknown };
    };
    expect(layer.outFrame).toBe(30);
    expect(layer.parent).toBe("bg");
    expect(layer.transform.opacity).toEqual({ value: 0.5 });
    expect(layer.transform.position).toEqual({ value: [960, 540] });
  });

  it("uses the size of the composition the layer is added to", async () => {
    const r = okOf(
      await expand(
        `kynimo.composition("other").add("solid", { name: "S", width: 1, height: 1, color: "#ff0000" });`,
      ),
    );
    const layer = (r.ops[0] as Extract<Op, { op: "addLayer" }>).layer as unknown as {
      outFrame: number;
      transform: { position: unknown };
    };
    expect(layer.outFrame).toBe(48);
    expect(layer.transform.position).toEqual({ value: [400, 300] });
  });

  it("hands back the operations of a rejected entry", async () => {
    const e = errOf(await expand(`kynimo.op({ op: "removeLayer", layer: "missing" });`));
    expect(e).toMatchObject({ kind: "invalid", ops: [{ op: "removeLayer", layer: "missing" }] });
  });

  it("leaves kynimo.op raw: no defaults are filled", async () => {
    const e = errOf(
      await expand(
        `kynimo.op({ op: "addLayer", composition: "main", id: "raw", layer: { type: "null", name: "N" } });`,
      ),
    );
    expect(e.kind).toBe("invalid");
  });

  it("matches direct intent expansion for the stagger step", async () => {
    const source = `
const a = kynimo.layer("title");
a.animate({ property: "position", from: [0, 0], to: [10, 0], duration: 500 });
kynimo.layer("bg").animate({ property: "position", from: [0, 0], to: [10, 0], duration: 500 });
kynimo.stagger({ layers: ["title", "bg"], offset: "base" });
`;
    const doc = baseDoc();
    const r = okOf(await expand(source, doc));
    const entryOps = r.ops;
    // Re-derive: apply the first two animates by hand, then stagger by hand.
    let work = doc;
    const manual: Op[] = [];
    for (const id of ["title", "bg"]) {
      const a = animate(work, {
        layers: id as never,
        property: "position",
        from: [0, 0],
        to: [10, 0],
        duration: 500,
      });
      work = applyAll(work, a.ops);
      manual.push(...a.ops);
    }
    manual.push(...stagger(work, { layers: ["title", "bg"] as never, offset: "base" }).ops);
    expect(entryOps).toEqual(manual);
  });

  it("is deterministic in the seed and kynimo.random() is mulberry32 / 2**32", async () => {
    const source = `
const values = [kynimo.random(), kynimo.random(), kynimo.random()];
const x = Math.floor(values[0] * 1000);
kynimo.layer("bg").set("position", [x, Math.floor(values[1] * 1000)]);
kynimo.layer("bg").set("rotation", Math.floor(values[2] * 360));
`;
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const a = okOf(await expand(source, baseDoc(), seed));
      const b = okOf(await expand(source, baseDoc(), seed));
      expect(JSON.stringify(a.ops)).toBe(JSON.stringify(b.ops));
      const next = mulberry32(seed);
      const v = [next() / 2 ** 32, next() / 2 ** 32, next() / 2 ** 32] as [number, number, number];
      expect(a.ops[0]).toMatchObject({
        track: { value: [Math.floor(v[0] * 1000), Math.floor(v[1] * 1000)] },
      });
      expect(a.ops[1]).toMatchObject({ track: { value: Math.floor(v[2] * 360) } });
      seen.add(JSON.stringify(a.ops));
    }
    expect(seen.size).toBeGreaterThan(15);
  });

  it("exposes the first random values exactly", async () => {
    const probe = okOf(
      await expand(
        `kynimo.layer("bg").update({ name: String(kynimo.random()) });`,
        baseDoc(),
        12345,
      ),
    );
    const next = mulberry32(12345);
    expect(probe.ops[0]).toMatchObject({ set: { name: String(next() / 2 ** 32) } });
  });

  it("reads the snapshot: layers, tokens, assets, scale and frames()", async () => {
    const source = `
const comp = kynimo.composition();
const other = kynimo.composition("other");
kynimo.layer("bg").update({
  name: [
    comp.layers.map((l) => l.id).join(","),
    comp.scale, other.scale, comp.frames(1000), other.frames(1000), comp.frames(0), comp.frames(1),
    kynimo.tokens.pack.id, kynimo.tokens.pack.pinned, kynimo.tokens.motion.durations.base,
    kynimo.layer("title").text, kynimo.layer({ name: "Back*" }).id, kynimo.layer("title").animated.join("+"),
    comp.find({ type: "solid" }).length, kynimo.assets.length,
    Object.isFrozen(kynimo), Object.isFrozen(kynimo.tokens.motion), Object.isFrozen(comp),
  ].join("|"),
});
`;
    const r = okOf(await expand(source));
    const name = (r.ops[0] as { set: { name: string } }).set.name;
    expect(name).toBe(
      [
        "title,bg",
        1,
        600 / 1080,
        30,
        24,
        0,
        1,
        "keynote",
        false,
        600,
        "Hi",
        "bg",
        "opacity",
        1,
        0,
        true,
        true,
        true,
      ].join("|"),
    );
  });

  it("makes composition(unknown) and ambiguous or missing layers runtime errors with a line", async () => {
    const source = `
kynimo.composition("main");
kynimo.composition("nope");
`;
    const e = errOf(await expand(source));
    expect(e).toMatchObject({ kind: "runtime", line: lineOf(source, '"nope"') });
    expect(e.message).toMatch(/available: main, other/);

    const ambiguous = errOf(await expand(`kynimo.layer({ type: "solid" });`));
    expect(ambiguous.message).toMatch(/2 layers match/);
    const missing = errOf(await expand(`kynimo.layer("ghost");`));
    expect(missing.message).toMatch(/no layer matches "ghost"/);
  });

  it("cannot rebind or reach the SDK internals", async () => {
    const source = `
const g = globalThis as any;
const result: unknown[] = [];
try { g.kynimo.op = () => {}; } catch (e) {}
try { g.kynimo = {}; } catch (e) {}
try { delete g.kynimo; } catch (e) {}
try { g.kynimo.tokens.motion.durations.base = 1; } catch (e) {}
result.push(typeof g.kynimo, typeof g.kynimo.animate, g.kynimo.tokens.motion.durations.base);
result.push(Object.getOwnPropertyDescriptor(g, "kynimo").configurable, typeof g.__out, typeof g.entries);
kynimo.layer("bg").update({ name: result.join(",") });
`;
    const r = okOf(await expand(source));
    expect((r.ops[0] as { set: { name: string } }).set.name).toBe(
      "object,function,600,false,undefined,undefined",
    );
  });
});

describe("layer ids", () => {
  it("generates layer-<n>, skipping ids in the project and ones the script made", async () => {
    const taken = baseDoc({}, "layer-2");
    const source = `
const c = kynimo.composition();
const a = c.add("solid", solidProps("A"));
const b = c.add("solid", solidProps("B"), { id: "layer-3" });
const d = c.add("solid", solidProps("D"));
const e = c.add("solid", solidProps("E"), { id: "custom" });
kynimo.layer("title").update({ name: [a, b, d, e].map((l) => l.id).join(",") });
`;
    const first = okOf(await expand(source, taken));
    const second = okOf(await expand(source, taken));
    expect(first.layersCreated).toEqual(["layer-1", "layer-3", "layer-4", "custom"]);
    expect((first.ops.at(-1) as { set: { name: string } }).set.name).toBe(
      "layer-1,layer-3,layer-4,custom",
    );
    expect(JSON.stringify(first.ops)).toBe(JSON.stringify(second.ops));
  });

  it("throws at the call for a taken or malformed explicit id", async () => {
    const taken = `
const c = kynimo.composition();
c.add("solid", solidProps("A"), { id: "bg" });
`;
    const e = errOf(await expand(taken));
    expect(e).toMatchObject({ kind: "runtime", line: lineOf(taken, '{ id: "bg" }') });
    expect(e.message).toMatch(/'bg' is already in use/);

    const twice = errOf(
      await expand(`
const c = kynimo.composition();
c.add("solid", solidProps("A"), { id: "dup" });
c.add("solid", solidProps("B"), { id: "dup" });
`),
    );
    expect(twice.message).toMatch(/'dup' is already in use/);

    const bad = errOf(
      await expand(`kynimo.composition().add("solid", solidProps("A"), { id: "Bad Id" });`),
    );
    expect(bad.message).toMatch(/must be 1-64 characters/);
  });
});

describe("errors", () => {
  it("names the entry and script line of an op the scene rejects", async () => {
    const source = `
kynimo.layer("bg").set("opacity", 0.5);
kynimo.layer("bg").set("opacity", 5);
`;
    const e = errOf(await expand(source));
    expect(e.kind).toBe("invalid");
    if (e.kind !== "invalid") return;
    expect(e.entry).toBe(1);
    expect(e.line).toBe(lineOf(source, 'opacity", 5'));
    expect(e.message).toMatch(new RegExp(`^entry 1 \\(line ${e.line}\\): `));
    expect(e.errors[0]?.path.slice(0, 2)).toEqual(["entries", 1]);
  });

  it("names the entry and line of an intent call on a missing layer", async () => {
    const source = `
kynimo.layer("bg").set("opacity", 0.5);
kynimo.animate({ layers: "ghost", property: "opacity", to: 1 });
`;
    const e = errOf(await expand(source));
    expect(e).toMatchObject({ kind: "invalid", entry: 1, line: lineOf(source, "ghost") });
    if (e.kind === "invalid") {
      expect(e.errors[0]?.path).toEqual(["entries", 1, "input", "layers"]);
      expect(e.message).toMatch(/no layer matches/);
    }
  });

  it("rejects intent input that fails its schema", async () => {
    const e = errOf(await expand(`kynimo.animate({ layers: "bg", property: "nope" } as any);`));
    expect(e).toMatchObject({ kind: "invalid", entry: 0 });
  });

  it("reports an intent expansion error of a later entry against the earlier entries' state", async () => {
    // The layer exists only because the first entry added it.
    const r = await expand(`
const c = kynimo.composition();
const l = c.add("solid", solidProps("A"));
l.animate({ property: "opacity", from: 0, to: 1 });
`);
    expect(okOf(r).ops).toHaveLength(2);
  });

  it("rejects 501 raw ops as too_many_ops without replaying", async () => {
    const e = errOf(
      await expand(
        `for (let i = 0; i <= ${MAX_BATCH_OPS}; i++) kynimo.op({ op: "updateLayer", layer: "bg", set: { hidden: true } });`,
      ),
    );
    expect(e.kind).toBe("too_many_ops");
    expect(e.message).toBe(
      "the script produced 501 operations; one run applies at most 500 — split the work into several runs",
    );
    // Exactly the limit still passes.
    const ok = okOf(
      await expand(
        `for (let i = 0; i < ${MAX_BATCH_OPS}; i++) kynimo.op({ op: "updateLayer", layer: "bg", set: { hidden: true } });`,
      ),
    );
    expect(ok.ops).toHaveLength(MAX_BATCH_OPS);
  });

  it("rejects raw junk ops and unknown op names", async () => {
    const nope = errOf(await expand(`kynimo.op({ op: "nope" } as any);`));
    expect(nope).toMatchObject({ kind: "invalid", entry: 0 });
    const notObject = errOf(await expand(`kynimo.op("bg" as any);`));
    expect(notObject).toMatchObject({ kind: "invalid", entry: 0 });
  });

  it("passes script errors through with their own kind", async () => {
    expect(errOf(await expand(`throw new Error("boom");`)).kind).toBe("runtime");
    expect(errOf(await expand(`const x: number = ;`)).kind).toBe("syntax");
    expect(errOf(await expand(`enum E { A }`)).kind).toBe("unsupported_typescript");
    const big = await expandScript(
      baseDoc(),
      { source: "x".repeat(100) },
      { idCounter: 0, limits: { sourceBytes: 10 } },
    );
    expect(errOf(big).kind).toBe("source_too_large");
  });

  it("uses a unique id counter for ops that generate ids", async () => {
    const r = await expandScript(
      baseDoc(),
      { source: `kynimo.op({ op: "precompose", layers: ["bg"] });` },
      { idCounter: 7 },
    );
    expect(okOf(r).layersCreated.length).toBe(1);
  });
});

// One snippet per op literal. A new op without an entry fails the "covers every op" test.
const MASK = `{ name: "m", mode: "add", inverted: false, path: prop({ closed: true, vertices: [[0, 0], [10, 0], [10, 10]].map((point) => ({ point, inTangent: [0, 0], outTangent: [0, 0] })) }), feather: prop([0, 0]), opacity: prop(1), expansion: prop(0) }`;
const ASSET = `{ type: "image", name: "Logo", uri: "assets/${"a".repeat(64)}.png", sha256: "${"a".repeat(64)}", width: 64, height: 32 }`;
const WIGGLE = `{ property: "position", type: "wiggle", frequency: prop(2), amplitude: prop([20, 0]), octaves: 2, seed: 7, linked: false }`;
const OP_SNIPPETS: Record<string, string> = {
  addLayer: `kynimo.composition().add("solid", solidProps("New"), { index: 1 });`,
  updateLayer: `kynimo.layer("bg").update({ hidden: true, name: "Back" });`,
  removeLayer: `kynimo.layer("bg").remove();`,
  setTransformTrack: `kynimo.layer("bg").set("opacity", 0.5);`,
  reorderLayer: `kynimo.op({ op: "reorderLayer", layer: kynimo.layer("bg"), index: 0 });`,
  setParent: `kynimo.layer("bg").parent("title");`,
  addMarker: `kynimo.op({ op: "addMarker", target: { composition: "main" }, marker: { frame: 3, durationFrames: 0, name: "hit" } });`,
  removeMarker: `kynimo.op({ op: "addMarker", target: { layer: "bg" }, id: "m1", marker: { frame: 3, durationFrames: 0, name: "hit" } });
kynimo.op({ op: "removeMarker", marker: "m1" });`,
  addMask: `kynimo.op({ op: "addMask", layer: "bg", mask: ${MASK} });`,
  updateMask: `kynimo.op({ op: "addMask", layer: "bg", id: "mk", mask: ${MASK} });
kynimo.op({ op: "updateMask", layer: "bg", mask: "mk", set: { inverted: true } });`,
  removeMask: `kynimo.op({ op: "addMask", layer: "bg", id: "mk", mask: ${MASK} });
kynimo.op({ op: "removeMask", layer: "bg", mask: "mk" });`,
  setEffects: `kynimo.op({ op: "setEffects", layer: "bg", effects: [
  { type: "gaussian-blur", id: "blur", radius: prop(12) },
] });`,
  setGenerator: `kynimo.composition().add("generator", { name: "Sky", width: 100, height: 100, generator: {
  type: "noise",
  seed: 1,
  scale: prop(64),
  octaves: 2,
  evolution: prop(0),
  offset: prop([0, 0]),
  low: prop("#000000"),
  high: prop("#ffffff"),
} }, { id: "gen" });
kynimo.op({ op: "setGenerator", layer: "gen", generator: {
  type: "aurora",
  seed: 3,
  colors: [prop("#ff0000"), prop("#0000ff")],
  evolution: prop(0),
  softness: prop(0.5),
} });`,
  addBehavior: `kynimo.layer("bg").behavior(${WIGGLE}, { id: "w" });`,
  updateBehavior: `kynimo.layer("bg").behavior(${WIGGLE}, { id: "w" });
kynimo.op({ op: "updateBehavior", layer: "bg", behavior: "w", set: { octaves: 3 } });`,
  removeBehavior: `kynimo.layer("bg").behavior(${WIGGLE}, { id: "w" });
kynimo.op({ op: "removeBehavior", layer: "bg", behavior: "w" });`,
  setTextAnimators: `kynimo.op({ op: "setTextAnimators", layer: "title", animators: [{
  name: "Fade",
  selector: { unit: "characters", start: prop(0), end: prop(1), offset: prop(0), shape: "square", easeHigh: prop(0), easeLow: prop(0), order: "forward", seed: 0, amount: prop(1) },
  properties: { opacity: prop(0) },
}] });`,
  setShapeContents: `const s = kynimo.composition().add("shape", shapeProps("S"));
kynimo.op({ op: "setShapeContents", layer: s, contents: [
  { type: "rect", id: "r1", name: "r1", position: prop([0, 0]), size: prop([200, 100]), cornerRadius: prop(0) },
  { type: "fill", id: "f1", name: "f1", paint: { type: "solid", color: prop("#ff3366") }, opacity: prop(1), rule: "nonzero" },
] });`,
  setMatte: `const c = kynimo.composition();
const src = c.add("solid", solidProps("Src"));
kynimo.op({ op: "setMatte", layer: "title", matte: { layer: src, mode: "alpha" } });`,
  precompose: `kynimo.op({ op: "precompose", layers: ["bg", "title"] });`,
  addAsset: `kynimo.op({ op: "addAsset", asset: ${ASSET} });`,
  removeAsset: `kynimo.op({ op: "addAsset", id: "logo", asset: ${ASSET} });
kynimo.op({ op: "removeAsset", asset: "logo" });`,
};

describe("every op is reachable from the SDK", () => {
  const names = opNames();

  it("covers every op literal of OpSchema", () => {
    expect(names.length).toBeGreaterThanOrEqual(20);
    expect(names).toContain("setTransformTrack");
    expect(names.filter((n) => !(n in OP_SNIPPETS))).toEqual([]);
    expect(Object.keys(OP_SNIPPETS).filter((n) => !names.includes(n))).toEqual([]);
  });

  it.each(Object.keys(OP_SNIPPETS))("%s", async (name) => {
    const doc = baseDoc();
    const r = okOf(await expand(OP_SNIPPETS[name] as string, doc));
    expect(r.ops.some((o) => o.op === name)).toBe(true);
    applyAll(doc, r.ops);
  });
});

describe("replay passes", () => {
  const hide = (layer: string) => ({
    kind: "op",
    op: { op: "updateLayer", layer, set: { hidden: true } },
    line: 1,
  });
  const animateEntry = { kind: "animate", input: { layers: "bg", property: "opacity", to: 0.5 } };
  /** An `applyOps` that counts the full-document passes it is asked for. */
  const counting = () => {
    const calls: number[] = [];
    const fn: typeof applyOps = (doc, ops, idCounter) => {
      calls.push(Array.isArray(ops) ? ops.length : 0);
      return applyOps(doc, ops, idCounter);
    };
    return { calls, fn };
  };

  it("applies 500 raw entries in one pass", async () => {
    const { calls, fn } = counting();
    const entries = Array.from({ length: MAX_BATCH_OPS }, () => hide("bg"));
    const r = await replayEntries(baseDoc(), entries, 0, 50, fn);
    expect(okOf(r).ops).toHaveLength(MAX_BATCH_OPS);
    expect(calls).toEqual([MAX_BATCH_OPS]);
  });

  it("takes at most 2 x intent calls + 1 passes for alternating raw and intent entries", async () => {
    const { calls, fn } = counting();
    const entries: unknown[] = [];
    for (let i = 0; i < 10; i++) entries.push(hide("bg"), hide("title"), animateEntry);
    entries.push(hide("bg"));
    const r = await replayEntries(baseDoc(), entries, 0, 50, fn);
    expect(r.ok).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(2 * 10 + 1);
    expect(calls.length).toBe(21);
  });

  it("refuses more than maxIntentCalls intent calls without replaying anything", async () => {
    const { calls, fn } = counting();
    const entries = [hide("bg"), ...Array.from({ length: 51 }, () => animateEntry)];
    const r = await replayEntries(baseDoc(), entries, 0, 50, fn);
    const e = errOf(r);
    expect(e.kind).toBe("too_many_intent_calls");
    expect(e.message).toMatch(/51 intent calls.*at most 50.*arrays of layers|stagger/s);
    expect(calls).toEqual([]);
    // Through a script, with the default limit.
    const viaScript = errOf(
      await expand(
        `for (let i = 0; i < 51; i++) kynimo.animate({ layers: "bg", property: "opacity", to: 0.5 });`,
      ),
    );
    expect(viaScript.kind).toBe("too_many_intent_calls");
  });

  it("maps a rejection inside a grouped batch back to its entry, line and op path", async () => {
    const entries = [
      hide("bg"),
      { kind: "op", op: { op: "updateLayer", layer: "ghost", set: { hidden: true } }, line: 7 },
      hide("title"),
    ];
    const e = errOf(await replayEntries(baseDoc(), entries, 0, 50, applyOps));
    expect(e).toMatchObject({
      kind: "invalid",
      entry: 1,
      line: 7,
      ops: [{ op: "updateLayer", layer: "ghost" }],
    });
    if (e.kind === "invalid") {
      expect(e.errors[0]?.path.slice(0, 3)).toEqual(["entries", 1, "op"]);
      expect(e.errors.every((x) => x.path[1] === 1)).toBe(true);
    }
  });

  it("reports the earlier entry when a later entry is also invalid", async () => {
    const entries = [{ kind: "op", op: { op: "removeLayer", layer: "ghost" } }, { kind: "nope" }];
    const e = errOf(await replayEntries(baseDoc(), entries, 0, 50, applyOps));
    expect(e).toMatchObject({ kind: "invalid", entry: 0 });
  });

  it("stops with too_many_ops before an apply that would pass the cap", async () => {
    const { calls, fn } = counting();
    // 450 raw ops, then an intent call that expands to more than the 50 left.
    const entries: unknown[] = Array.from({ length: 450 }, () => hide("bg"));
    entries.push({
      kind: "animate",
      input: {
        layers: ["bg", "title"],
        property: "position",
        from: [0, 0],
        to: [1, 1],
        duration: 10,
        easing: "linear",
      },
    });
    const long = Array.from({ length: 60 }, () => animateEntry);
    const r = await replayEntries(baseDoc(), [...entries, ...long], 0, 100, fn);
    expect(errOf(r).kind).toBe("too_many_ops");
    expect(calls.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_BATCH_OPS);
  });

  it("does not list layers a later entry removed", async () => {
    const r = okOf(
      await expand(`
const c = kynimo.composition();
const a = c.add("solid", solidProps("A"));
const b = c.add("solid", solidProps("B"));
a.remove();
`),
    );
    expect(r.layersCreated).toEqual(["layer-2"]);
  });

  it("fills defaults from a composition created earlier in the same run", async () => {
    const doc = baseDoc();
    const r = await replayEntries(
      doc,
      [
        { kind: "op", op: { op: "precompose", layers: ["bg", "title"], id: "inner" } },
        {
          kind: "op",
          defaults: true,
          op: {
            op: "addLayer",
            composition: "inner",
            id: "n1",
            layer: { type: "null", name: "N" },
          },
        },
      ],
      0,
      50,
      applyOps,
    );
    expect(r.ok).toBe(true);
  });
});
