import { type Effect, EffectSchema, type Generator, GeneratorSchema } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { resolveEffects } from "./effect.js";
import { evaluateFrame } from "./evaluate.js";
import { composition, layer, project } from "./fixtures.test-util.js";
import { resolveGenerator } from "./generator.js";

const fps = { num: 30, den: 1 };
const prop = <T>(value: T) => ({ value });
const ease = { type: "bezier", x1: 0.5, y1: -2, x2: 0.5, y2: 3 };
const kf = (frame: number, value: unknown, interpolation: unknown = { type: "linear" }) => ({
  frame,
  value,
  interpolation,
});
const gen = (body: unknown): Generator => GeneratorSchema.parse(body);
const fx = (body: Record<string, unknown>): Effect => EffectSchema.parse({ id: "e", ...body });

const aurora = (evolution: number, over: Record<string, unknown> = {}) =>
  gen({
    type: "aurora",
    seed: 42,
    colors: [prop("#ff0000"), prop("#00ff00"), prop("#0000ff")],
    evolution: prop(evolution),
    softness: prop(0.5),
    ...over,
  });

describe("resolveGenerator", () => {
  it("resolves a gradient with sampled stops and points", () => {
    const g = gen({
      type: "gradient",
      kind: "radial",
      start: { keyframes: [kf(0, [0, 0]), kf(10, [100, 50])] },
      end: prop([200, 0]),
      stops: prop([
        { offset: 0, color: "#000000" },
        { offset: 1, color: "#ffffff80" },
      ]),
    });
    const r = resolveGenerator(g, 5, fps, 400, 300);
    expect(r).toMatchObject({ type: "gradient", kind: "radial", start: [50, 25], end: [200, 0] });
    if (r.type !== "gradient") throw new Error("kind");
    expect(r.stops).toEqual([
      { offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
      { offset: 1, color: { r: 1, g: 1, b: 1, a: 128 / 255 } },
    ]);
  });

  it("clamps eased gradient points to the point bound", () => {
    const g = gen({
      type: "gradient",
      kind: "linear",
      start: { keyframes: [kf(0, [0, 0], ease), kf(10, [65536, -65536])] },
      end: prop([100, 0]),
      stops: prop([
        { offset: 0, color: "#000000" },
        { offset: 1, color: "#ffffff" },
      ]),
    });
    for (let f = 0; f <= 10; f++) {
      const r = resolveGenerator(g, f, fps, 10, 10);
      if (r.type !== "gradient") throw new Error("kind");
      for (const v of [...r.start, ...r.end]) expect(Math.abs(v)).toBeLessThanOrEqual(65536);
    }
  });

  it("keeps eased stop offsets in 0..1 and non-decreasing", () => {
    const stops = (a: number, b: number) => [
      { offset: a, color: "#000000" },
      { offset: b, color: "#ffffff" },
    ];
    const g = gen({
      type: "gradient",
      kind: "linear",
      start: prop([0, 0]),
      end: prop([1, 0]),
      stops: { keyframes: [kf(0, stops(0.2, 0.9), ease), kf(10, stops(0.9, 1))] },
    });
    for (let f = 0; f <= 10; f++) {
      const r = resolveGenerator(g, f, fps, 10, 10);
      if (r.type !== "gradient") throw new Error("kind");
      const [a, b] = r.stops;
      expect(a?.offset).toBeGreaterThanOrEqual(0);
      expect(b?.offset).toBeLessThanOrEqual(1);
      expect(b?.offset).toBeGreaterThanOrEqual(a?.offset ?? 0);
    }
  });

  it("resolves noise and clamps eased overshoot to the field ranges", () => {
    const g = gen({
      type: "noise",
      seed: 9,
      scale: { keyframes: [kf(0, 8, ease), kf(10, 4096)] },
      octaves: 2,
      evolution: { keyframes: [kf(0, -1000, ease), kf(10, 1000)] },
      offset: { keyframes: [kf(0, [-8192, 8192], ease), kf(10, [8192, -8192])] },
      low: prop("#000000"),
      high: prop("#ffffff"),
    });
    let sawEdge = false;
    for (let f = 0; f <= 10; f++) {
      const r = resolveGenerator(g, f, fps, 100, 100);
      if (r.type !== "noise") throw new Error("kind");
      expect(r).toMatchObject({ seed: 9, octaves: 2 });
      expect(r.scale).toBeGreaterThanOrEqual(8);
      expect(r.scale).toBeLessThanOrEqual(4096);
      expect(Math.abs(r.evolution)).toBeLessThanOrEqual(1000);
      for (const v of r.offset) expect(Math.abs(v)).toBeLessThanOrEqual(8192);
      if (r.scale === 8 || r.scale === 4096) sawEdge = true;
    }
    expect(sawEdge).toBe(true);
  });

  it("resolves a pattern rotation as [cos, sin] of the angle", () => {
    const g = (angle: number) =>
      gen({
        type: "pattern",
        kind: "grid",
        size: prop(16),
        thickness: prop(0.25),
        angle: prop(angle),
        offset: prop([1, 2]),
        foreground: prop("#ffffff"),
        background: prop("#000000"),
      });
    for (const angle of [0, 30, 90, -45, 3600]) {
      const r = resolveGenerator(g(angle), 0, fps, 64, 64);
      if (r.type !== "pattern") throw new Error("kind");
      const rad = (angle * Math.PI) / 180;
      expect(r.rotation).toEqual([Math.cos(rad), Math.sin(rad)]);
      expect(r).toMatchObject({ kind: "grid", size: 16, thickness: 0.25, offset: [1, 2] });
    }
  });

  it("clamps pattern thickness and size after easing", () => {
    const g = gen({
      type: "pattern",
      kind: "dots",
      size: { keyframes: [kf(0, 2, ease), kf(10, 2048)] },
      thickness: { keyframes: [kf(0, 0, ease), kf(10, 1)] },
      angle: prop(0),
      offset: prop([0, 0]),
      foreground: prop("#ffffff"),
      background: prop("#000000"),
    });
    for (let f = 0; f <= 10; f++) {
      const r = resolveGenerator(g, f, fps, 64, 64);
      if (r.type !== "pattern") throw new Error("kind");
      expect(r.size).toBeGreaterThanOrEqual(2);
      expect(r.size).toBeLessThanOrEqual(2048);
      expect(r.thickness).toBeGreaterThanOrEqual(0);
      expect(r.thickness).toBeLessThanOrEqual(1);
    }
  });
});

describe("resolveGenerator: aurora", () => {
  it("is deterministic and puts one point per color", () => {
    const a = resolveGenerator(aurora(0.3), 0, fps, 640, 360);
    const b = resolveGenerator(aurora(0.3), 0, fps, 640, 360);
    expect(a).toEqual(b);
    if (a.type !== "aurora") throw new Error("kind");
    expect(a.points).toHaveLength(3);
    expect(a.colors).toHaveLength(3);
    expect(a.sigma).toBeCloseTo((0.1 + 0.4 * 0.5) * 640, 9);
  });

  it("moves points with evolution and with the seed", () => {
    const p = (r: ReturnType<typeof resolveGenerator>) => (r.type === "aurora" ? r.points : []);
    const a = p(resolveGenerator(aurora(0), 0, fps, 640, 360));
    const b = p(resolveGenerator(aurora(0.25), 0, fps, 640, 360));
    const c = p(resolveGenerator(aurora(0, { seed: 43 }), 0, fps, 640, 360));
    expect(b).not.toEqual(a);
    expect(c).not.toEqual(a);
  });

  it("loops: evolution e and e + 1 give identical points", () => {
    const p = (e: number) => {
      const r = resolveGenerator(aurora(e), 0, fps, 640, 360);
      return r.type === "aurora" ? r.points : [];
    };
    for (const e of [0, 0.37, -0.6, 12.25]) {
      const a = p(e);
      const b = p(e + 1);
      a.forEach((point, i) => {
        expect(b[i]?.[0]).toBeCloseTo(point[0], 6);
        expect(b[i]?.[1]).toBeCloseTo(point[1], 6);
      });
    }
  });

  it("scales sigma with softness and the larger side", () => {
    const sigma = (softness: number, w: number, h: number) => {
      const r = resolveGenerator(aurora(0, { softness: prop(softness) }), 0, fps, w, h);
      return r.type === "aurora" ? r.sigma : Number.NaN;
    };
    expect(sigma(0, 200, 100)).toBeCloseTo(20, 9);
    expect(sigma(1, 200, 100)).toBeCloseTo(100, 9);
    expect(sigma(0, 100, 400)).toBeCloseTo(40, 9);
  });

  it("keeps the points near the layer", () => {
    const r = resolveGenerator(aurora(0.77), 0, fps, 1000, 500);
    if (r.type !== "aurora") throw new Error("kind");
    for (const [x, y] of r.points) {
      expect(x).toBeGreaterThanOrEqual(500 - 0.5 * 1000);
      expect(x).toBeLessThanOrEqual(500 + 0.5 * 1000);
      expect(y).toBeGreaterThanOrEqual(250 - 0.5 * 500);
      expect(y).toBeLessThanOrEqual(250 + 0.5 * 500);
    }
  });
});

describe("resolveEffects: looks", () => {
  const vignette = {
    type: "vignette",
    amount: prop(0.5),
    radius: prop(0.7),
    feather: prop(0.4),
    color: prop("#00000080"),
  };
  const grain = (over: Record<string, unknown> = {}) => ({
    type: "grain",
    amount: prop(0.3),
    size: 2,
    seed: 5,
    animated: true,
    monochrome: true,
    ...over,
  });
  const scan = (over: Record<string, unknown> = {}) => ({
    type: "scanlines",
    amount: prop(0.5),
    spacing: prop(8),
    thickness: prop(0.5),
    offset: prop(0),
    color: prop("#000000"),
    ...over,
  });

  it("resolves a vignette", () => {
    expect(resolveEffects([fx(vignette)], 0, fps)).toEqual([
      {
        type: "vignette",
        amount: 0.5,
        radius: 0.7,
        feather: 0.4,
        color: { r: 0, g: 0, b: 0, a: 128 / 255 },
      },
    ]);
  });

  it("clamps vignette and aberration after easing", () => {
    const fxs = [
      fx({
        ...vignette,
        amount: { keyframes: [kf(0, 0, ease), kf(10, 1)] },
        radius: { keyframes: [kf(0, 0, ease), kf(10, 2)] },
        feather: { keyframes: [kf(0, 0.01, ease), kf(10, 2)] },
      }),
      fx({
        type: "chromatic-aberration",
        amount: { keyframes: [kf(0, 0, ease), kf(10, 32)] },
      }),
    ];
    for (let f = 0; f <= 10; f++) {
      const [v, c] = resolveEffects(fxs, f, fps);
      if (v?.type !== "vignette" || c?.type !== "chromatic-aberration") throw new Error("kind");
      expect(v.amount).toBeGreaterThanOrEqual(0);
      expect(v.amount).toBeLessThanOrEqual(1);
      expect(v.radius).toBeGreaterThanOrEqual(0);
      expect(v.radius).toBeLessThanOrEqual(2);
      expect(v.feather).toBeGreaterThanOrEqual(0.01);
      expect(v.feather).toBeLessThanOrEqual(2);
      expect(c.amount).toBeGreaterThanOrEqual(0);
      expect(c.amount).toBeLessThanOrEqual(32);
    }
  });

  it("grain uses floor(frame) when animated and 0 otherwise", () => {
    const [a] = resolveEffects([fx(grain())], 7, fps);
    const [b] = resolveEffects([fx(grain({ animated: false }))], 7, fps);
    const [c] = resolveEffects([fx(grain())], 7.9, fps);
    expect(a).toEqual({
      type: "grain",
      amount: 0.3,
      size: 2,
      seed: 5,
      frame: 7,
      monochrome: true,
    });
    expect(b).toMatchObject({ frame: 0 });
    expect(c).toMatchObject({ frame: 7 });
  });

  it("posterize rounds the levels", () => {
    const levels = (v: number) =>
      resolveEffects([fx({ type: "posterize", levels: prop(v) })], 0, fps)[0];
    expect(levels(4.4)).toEqual({ type: "posterize", levels: 4 });
    expect(levels(4.6)).toEqual({ type: "posterize", levels: 5 });
    expect(levels(2)).toEqual({ type: "posterize", levels: 2 });
    expect(
      resolveEffects(
        [fx({ type: "posterize", levels: { keyframes: [kf(0, 2, ease), kf(10, 32)] } })],
        3,
        fps,
      )[0],
    ).toMatchObject({ levels: expect.any(Number) });
  });

  it("scanline offset is reduced into [0, spacing), negative offsets included", () => {
    const offset = (spacing: number, scroll: number) => {
      const [e] = resolveEffects(
        [fx(scan({ spacing: prop(spacing), offset: prop(scroll) }))],
        0,
        fps,
      );
      if (e?.type !== "scanlines") throw new Error("kind");
      return e.offset;
    };
    expect(offset(8, 0)).toBe(0);
    expect(offset(8, 3)).toBe(3);
    expect(offset(8, 8)).toBe(0);
    expect(offset(8, 19)).toBe(3);
    expect(offset(8, -3)).toBe(5);
    expect(offset(8, -8)).toBe(0);
    expect(offset(8, -19)).toBe(5);
    expect(offset(2.5, 7.25)).toBeCloseTo(2.25, 12);
    expect(offset(2.5, -0.25)).toBeCloseTo(2.25, 12);
    expect(offset(64, -1e-20)).toBeLessThan(64);
    for (const scroll of [-8192, -4097.3, -0.001, 0.001, 8192]) {
      const o = offset(7, scroll);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(7);
    }
  });

  it("skips disabled effects", () => {
    const out = resolveEffects(
      [
        fx({ ...scan(), enabled: false }),
        fx({ type: "posterize", levels: prop(4) }),
        fx({ ...grain(), enabled: false }),
      ],
      0,
      fps,
    );
    expect(out.map((e) => e.type)).toEqual(["posterize"]);
  });
});

describe("evaluateFrame: generator layers", () => {
  it("resolves the generator at the layer's frame with the layer's size", () => {
    const body = {
      type: "aurora",
      seed: 1,
      colors: [prop("#ff0000"), prop("#0000ff")],
      evolution: { keyframes: [kf(0, 0), kf(10, 1)] },
      softness: prop(0),
    };
    const doc = project([
      composition("main", [
        layer("g", "generator", { width: 200, height: 100, startFrame: 4, generator: body }),
      ]),
    ]);
    const [resolved] = evaluateFrame(doc, 9).layers;
    expect(resolved).toMatchObject({ type: "generator", width: 200, height: 100, layerFrame: 5 });
    if (resolved?.type !== "generator") throw new Error("kind");
    expect(resolved.generator).toEqual(
      resolveGenerator(gen(body), 5, { num: 30, den: 1 }, 200, 100),
    );
  });
});
