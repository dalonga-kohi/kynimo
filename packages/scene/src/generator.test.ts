import { describe, expect, it } from "vitest";
import { composition, type Obj, project, prop, visual } from "./fixtures.test-util.js";
import {
  type ApplyResult,
  applyBatch,
  applyOps,
  createSceneState,
  type Project,
  ProjectSchema,
  redo,
  undo,
} from "./index.js";
import { solid } from "./ops.test-util.js";

const kf = (frame: number, value: unknown): Obj => ({
  frame,
  value,
  interpolation: { type: "linear" },
});
const stops = (...offsets: number[]) =>
  offsets.map((offset, i) => ({ offset, color: i % 2 ? "#ffffff" : "#000000" }));

const gradient = (over: Obj = {}): Obj => ({
  type: "gradient",
  kind: "linear",
  start: prop([0, 0]),
  end: prop([100, 0]),
  stops: prop(stops(0, 1)),
  ...over,
});
const noise = (over: Obj = {}): Obj => ({
  type: "noise",
  seed: 1,
  scale: prop(64),
  octaves: 3,
  evolution: prop(0),
  offset: prop([0, 0]),
  low: prop("#000000"),
  high: prop("#ffffff"),
  ...over,
});
const pattern = (over: Obj = {}): Obj => ({
  type: "pattern",
  kind: "stripes",
  size: prop(32),
  thickness: prop(0.5),
  angle: prop(0),
  offset: prop([0, 0]),
  foreground: prop("#ffffff"),
  background: prop("#000000"),
  ...over,
});
const aurora = (over: Obj = {}): Obj => ({
  type: "aurora",
  seed: 7,
  colors: [prop("#ff0000"), prop("#0000ff")],
  evolution: prop(0),
  softness: prop(0.5),
  ...over,
});

const genLayer = (id: string, generator: Obj): Obj => ({
  ...visual(id),
  type: "generator",
  width: 200,
  height: 100,
  generator,
});

const docOf = (layers: Obj[]): Project =>
  ProjectSchema.parse(project({ compositions: [composition("main", layers)] }));
const parses = (layers: Obj[]) =>
  ProjectSchema.safeParse(project({ compositions: [composition("main", layers)] })).success;
const ok = (r: ApplyResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const errors = (r: ApplyResult) => (r.ok ? [] : r.errors);
const generatorOf = (d: Project, id: string) =>
  (d.compositions[0]?.layers.find((l) => l.id === id) as Obj | undefined)?.generator;

describe("generator layers", () => {
  it.each([
    ["gradient", gradient()],
    ["radial gradient", gradient({ kind: "radial" })],
    ["conic gradient", gradient({ kind: "conic" })],
    ["noise", noise()],
    ["pattern", pattern()],
    ["aurora", aurora()],
  ])("validates a %s", (_, generator) => {
    expect(parses([genLayer("g", generator)])).toBe(true);
  });

  it.each([
    ["scale 7", noise({ scale: prop(7) })],
    ["scale 4097", noise({ scale: prop(4097) })],
    ["octaves 7", noise({ octaves: 7 })],
    ["noise evolution 1001", noise({ evolution: prop(1001) })],
    ["aurora evolution 1001", aurora({ evolution: prop(1001) })],
    ["noise offset 8193", noise({ offset: prop([8193, 0]) })],
    ["17 stops", gradient({ stops: prop(stops(...Array.from({ length: 17 }, (_, i) => i / 16))) })],
    ["1 stop", gradient({ stops: prop(stops(0)) })],
    ["5 aurora colors", aurora({ colors: Array.from({ length: 5 }, () => prop("#ffffff")) })],
    ["1 aurora color", aurora({ colors: [prop("#ffffff")] })],
    ["size 1", pattern({ size: prop(1) })],
    ["thickness 2", pattern({ thickness: prop(2) })],
    ["angle 3601", pattern({ angle: prop(3601) })],
    ["unknown kind", pattern({ kind: "waves" })],
    ["seed -1", noise({ seed: -1 })],
    ["seed 2^32", aurora({ seed: 4294967296 })],
    ["extra field", gradient({ extra: 1 })],
  ])("rejects %s", (_, generator) => {
    expect(parses([genLayer("g", generator)])).toBe(false);
  });

  it("accepts the extremes of every range", () => {
    expect(
      parses([
        genLayer(
          "a",
          noise({ scale: prop(8), octaves: 6, evolution: prop(-1000), seed: 4294967295 }),
        ),
        genLayer("b", pattern({ size: prop(2048), angle: prop(-3600), thickness: prop(0) })),
        genLayer(
          "c",
          gradient({ stops: prop(stops(...Array.from({ length: 16 }, (_, i) => i / 15))) }),
        ),
        genLayer("d", aurora({ colors: Array.from({ length: 4 }, () => prop("#ffffff")) })),
      ]),
    ).toBe(true);
  });

  it("rejects stops out of offset order", () => {
    expect(parses([genLayer("g", gradient({ stops: prop(stops(0.8, 0.2)) }))])).toBe(false);
    expect(parses([genLayer("g", gradient({ stops: prop(stops(0.5, 0.5)) }))])).toBe(true);
  });

  it("rejects keyframed stops of different lengths", () => {
    const keyed = (a: unknown, b: unknown) =>
      gradient({ stops: { keyframes: [kf(0, a), kf(30, b)] } });
    expect(parses([genLayer("g", keyed(stops(0, 1), stops(0, 0.5, 1)))])).toBe(false);
    expect(parses([genLayer("g", keyed(stops(0, 1), stops(0, 0.5)))])).toBe(true);
  });

  it("rejects bad layer sizes", () => {
    expect(parses([{ ...genLayer("g", gradient()), width: 0 }])).toBe(false);
    expect(parses([{ ...genLayer("g", gradient()), height: 8193 }])).toBe(false);
  });

  it("gets an empty effect stack by default", () => {
    const layer = docOf([genLayer("g", gradient())]).compositions[0]?.layers[0];
    expect(layer).toMatchObject({ type: "generator", effects: [] });
  });
});

describe("look effects", () => {
  const effectsOf = (effects: Obj[]) =>
    parses([{ ...solid("s"), effects: effects.map((e, i) => ({ id: `e${i}`, ...e })) }]);
  const grain = (over: Obj = {}): Obj => ({
    type: "grain",
    amount: prop(0.2),
    size: 1,
    seed: 0,
    animated: true,
    monochrome: false,
    ...over,
  });
  const scan = (over: Obj = {}): Obj => ({
    type: "scanlines",
    amount: prop(0.5),
    spacing: prop(4),
    thickness: prop(0.5),
    offset: prop(0),
    color: prop("#000000"),
    ...over,
  });

  it("validates each look", () => {
    expect(
      effectsOf([
        {
          type: "vignette",
          amount: prop(0.5),
          radius: prop(0.7),
          feather: prop(0.5),
          color: prop("#000000"),
        },
        grain(),
        { type: "chromatic-aberration", amount: prop(8) },
        { type: "posterize", levels: prop(4) },
        scan(),
      ]),
    ).toBe(true);
  });

  it.each([
    ["grain size 9", grain({ size: 9 })],
    ["grain size 0", grain({ size: 0 })],
    ["grain seed -1", grain({ seed: -1 })],
    ["chromatic 33", { type: "chromatic-aberration", amount: prop(33) }],
    ["levels 1", { type: "posterize", levels: prop(1) }],
    ["levels 33", { type: "posterize", levels: prop(33) }],
    ["spacing 1", scan({ spacing: prop(1) })],
    ["spacing 65", scan({ spacing: prop(65) })],
    [
      "feather 0",
      {
        type: "vignette",
        amount: prop(0.5),
        radius: prop(0.7),
        feather: prop(0),
        color: prop("#000000"),
      },
    ],
    [
      "radius 3",
      {
        type: "vignette",
        amount: prop(0.5),
        radius: prop(3),
        feather: prop(0.5),
        color: prop("#000000"),
      },
    ],
  ])("rejects %s", (_, effect) => {
    expect(effectsOf([effect])).toBe(false);
  });
});

describe("setGenerator", () => {
  const doc = () => docOf([genLayer("g", gradient()), solid("s")]);

  it("replaces the generator with one layer.set change", () => {
    const r = ok(applyOps(doc(), [{ op: "setGenerator", layer: "g", generator: noise() }]));
    expect(generatorOf(r.doc, "g")).toMatchObject({ type: "noise", octaves: 3 });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ type: "layer.set", layerId: "g", path: ["generator"] });
  });

  it("refuses a solid layer naming the type", () => {
    expect(
      errors(applyOps(doc(), [{ op: "setGenerator", layer: "s", generator: noise() }])),
    ).toMatchObject([{ path: ["ops", 0, "layer"], message: expect.stringContaining("solid") }]);
  });

  it("refuses an invalid generator", () => {
    expect(
      errors(
        applyOps(doc(), [{ op: "setGenerator", layer: "g", generator: noise({ octaves: 7 }) }]),
      ),
    ).not.toEqual([]);
  });

  it("undoes and redoes", () => {
    const s0 = createSceneState(doc());
    const a = applyBatch(s0, "me", [{ op: "setGenerator", layer: "g", generator: noise() }]);
    if (!a.ok) throw new Error("expected ok");
    const u = undo(a.state, "me");
    if (!u.ok) throw new Error("expected ok");
    expect(u.state.doc).toEqual(s0.doc);
    const r = redo(u.state, "me");
    expect(r.ok && generatorOf(r.state.doc, "g")).toMatchObject({ type: "noise" });
  });

  it("is reachable by a layer type selector", () => {
    const r = ok(
      applyOps(doc(), [{ op: "setGenerator", layer: { type: "generator" }, generator: aurora() }]),
    );
    expect(generatorOf(r.doc, "g")).toMatchObject({ type: "aurora" });
  });
});

describe("addLayer with a generator", () => {
  it("adds a generator layer without an effects list", () => {
    const { id: _id, effects: _effects, ...layer } = genLayer("x", pattern());
    const r = ok(
      applyOps(docOf([solid("s")]), [
        { op: "addLayer", composition: "main", layer, id: "bg" } as never,
      ]),
    );
    expect(r.doc.compositions[0]?.layers[0]).toMatchObject({
      id: "bg",
      type: "generator",
      effects: [],
    });
  });
});
